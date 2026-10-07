"""
N-ATLaS ASR sidecar (Phase C step 5).

A tiny FastAPI service that hosts the NCAIR1 whisper-small fine-tunes for
Yoruba, Hausa and Igbo and exposes them as a single POST /transcribe
endpoint for the NestJS backend (NAtlasAsrProvider).

RAM discipline (honesty note in README): whisper-small is ~1GB of RAM per
language once loaded. Models load lazily on first request per language and
a background janitor unloads any language idle for NATLAS_ASR_IDLE_UNLOAD_SECONDS.
An LRU lock per language means one generation at a time per language; the
box is sized for 2-4 concurrent streams, beyond that requests queue and the
backend's timeout degrades the student to "type instead".

Run (dev):
    python -m venv .venv
    . .venv/Scripts/activate        # or source .venv/bin/activate
    pip install -r requirements.txt
    export HF_TOKEN=hf_...          # NCAIR1 repos are gated (auto-approved)
    uvicorn app:app --host 127.0.0.1 --port 8100

Contract:
    GET  /health      -> {status, loaded, idle_unload_seconds, models}
    POST /transcribe  multipart form: file=<audio>, lang=yo|ha|ig
                      -> {text, duration} | 400 unknown lang | 503 failure
"""

from __future__ import annotations

import json
import logging
import os
import subprocess
import tempfile
import threading
import time

from fastapi import FastAPI, Form, HTTPException, UploadFile
from fastapi.responses import JSONResponse

logger = logging.getLogger("natlas-asr")
logging.basicConfig(level=logging.INFO)

MODELS: dict[str, str] = {
    "yo": os.environ.get("NATLAS_ASR_MODEL_YO", "NCAIR1/Yoruba-ASR"),
    "ha": os.environ.get("NATLAS_ASR_MODEL_HA", "NCAIR1/Hausa-ASR"),
    "ig": os.environ.get("NATLAS_ASR_MODEL_IG", "NCAIR1/Igbo-ASR"),
}

IDLE_UNLOAD_SECONDS = int(os.environ.get("NATLAS_ASR_IDLE_UNLOAD_SECONDS", "600"))
SAMPLE_RATE = 16_000

# Optional JSON dict of kwargs passed to the transformers pipeline call,
# e.g. '{"chunk_length_s": 30}'. Left empty by default: the openai/whisper-small
# tokenizer has no <|ig|> token, so language-hinted generation is unreliable —
# the fine-tune itself knows its language.
GENERATE_KWARGS: dict = json.loads(os.environ.get("NATLAS_ASR_GENERATE_KWARGS", "{}"))


class _Slot:
    """One language: its pipeline (lazily loaded), a lock so only one
    generation runs at a time for that language, and a last-used stamp the
    janitor polls."""

    def __init__(self, lang: str, model_id: str) -> None:
        self.lang = lang
        self.model_id = model_id
        self.lock = threading.Lock()
        self.pipeline = None
        self.last_used = 0.0

    def loaded(self) -> bool:
        return self.pipeline is not None

    def load(self):
        if self.pipeline is None:
            from transformers import pipeline  # imported lazily: server boots instantly

            logger.info("Loading ASR model for %s: %s", self.lang, self.model_id)
            self.pipeline = pipeline(
                "automatic-speech-recognition",
                model=self.model_id,
                token=os.environ.get("HF_TOKEN") or None,
            )
            logger.info("Loaded ASR model for %s", self.lang)
        self.last_used = time.time()
        return self.pipeline

    def unload(self) -> None:
        if self.pipeline is not None:
            logger.info("Idle unload of ASR model for %s", self.lang)
            self.pipeline = None


slots: dict[str, _Slot] = {lang: _Slot(lang, model_id) for lang, model_id in MODELS.items()}

app = FastAPI(title="n-atlas-asr", version="0.1.0")


def _janitor() -> None:
    while True:
        time.sleep(30)
        now = time.time()
        for slot in slots.values():
            with slot.lock:
                if slot.loaded() and now - slot.last_used > IDLE_UNLOAD_SECONDS:
                    slot.unload()


threading.Thread(target=_janitor, daemon=True, name="idle-unload").start()


def _decode_to_wav(audio_bytes: bytes, suffix: str) -> str:
    """Browser recordings arrive as webm/opus/m4a; transformers needs a real
    audio file. ffmpeg converts to 16kHz mono wav in a temp file."""
    src = tempfile.NamedTemporaryFile(delete=False, suffix=suffix or ".bin")
    dst_path = src.name + ".wav"
    try:
        src.write(audio_bytes)
        src.close()
        subprocess.run(
            ["ffmpeg", "-y", "-i", src.name, "-ar", str(SAMPLE_RATE), "-ac", "1", dst_path],
            check=True,
            capture_output=True,
            timeout=60,
        )
        return dst_path
    except (subprocess.CalledProcessError, subprocess.TimeoutExpired) as exc:
        raise HTTPException(status_code=400, detail="Could not decode audio") from exc
    finally:
        os.unlink(src.name)


@app.get("/health")
def health() -> dict:
    return {
        "status": "ok",
        "loaded": {lang: slot.loaded() for lang, slot in slots.items()},
        "idle_unload_seconds": IDLE_UNLOAD_SECONDS,
        "models": MODELS,
    }


@app.post("/transcribe")
async def transcribe(file: UploadFile, lang: str = Form(...)):
    slot = slots.get(lang.strip().lower())
    if slot is None:
        raise HTTPException(
            status_code=400,
            detail=f"Unsupported language: {lang} (supported: {', '.join(MODELS)})",
        )

    audio_bytes = await file.read()
    if not audio_bytes:
        raise HTTPException(status_code=400, detail="Empty audio file")

    suffix = os.path.splitext(file.filename or "")[1]
    wav_path = _decode_to_wav(audio_bytes, suffix)

    try:
        import soundfile as sf

        audio, sr = sf.read(wav_path, dtype="float32")
        duration = len(audio) / float(sr)
    finally:
        os.unlink(wav_path)

    try:
        with slot.lock:
            pipe = slot.load()
            result = pipe({"array": audio, "sampling_rate": sr}, **GENERATE_KWARGS)
    except HTTPException:
        raise
    except Exception as exc:  # model load or generation failure
        logger.exception("Transcription failed for %s", lang)
        return JSONResponse(
            status_code=503,
            content={"detail": f"Transcription failed for {lang}: {exc}"},
        )
    finally:
        slot.last_used = time.time()

    text = result.get("text", "") if isinstance(result, dict) else str(result)
    return {"text": text.strip(), "duration": duration}

# n-atlas-asr — local vernacular ASR sidecar (Phase C step 5)

FastAPI sidecar that hosts the NCAIR1 whisper-small fine-tunes for
**Yoruba (yo)**, **Hausa (ha)** and **Igbo (ig)** behind one endpoint.
The NestJS backend calls it through `NAtlasAsrProvider` whenever a voice
note is in a vernacular language; English and Nigerian Pidgin go to the
Groq Whisper chain instead.

```
Student voice note ──► POST /api/v1/ai/transcribe (NestJS)
                          │ language = forced ?? student.preferredLanguage
                          ├─ en  → provider chain (Groq Whisper)
                          ├─ pcm → provider chain (Whisper auto-detect; no pcm hint)
                          └─ yo/ha/ig → NAtlasAsrProvider ──► this sidecar
                                                              POST /transcribe
```

## Spike: NCAIR1 org ASR enumeration (2026-10-06)

| Repo | Language | Downloads | Checkpoint | Gate |
| --- | --- | --- | --- | --- |
| [`NCAIR1/Yoruba-ASR`](https://huggingface.co/NCAIR1/Yoruba-ASR) | Yoruba (yo, youtube/yo data) | 2,644 | whisper-small FT | auto-approved |
| [`NCAIR1/Hausa-ASR`](https://huggingface.co/NCAIR1/Hausa-ASR) | Hausa (ha, hausa data) | 1,936 | whisper-small FT | auto-approved |
| [`NCAIR1/Igbo-ASR`](https://huggingface.co/NCAIR1/Igbo-ASR) | Igbo (ig, igbo/ibo data) | 2,086 | whisper-small FT | auto-approved |
| [`NCAIR1/NigerianAccentedEnglish`](https://huggingface.co/NCAIR1/NigerianAccentedEnglish) | English (en) | 910 | whisper-small FT | auto-approved |

All four are `automatic-speech-recognition`, library `transformers`,
fine-tuned from `openai/whisper-small`; access is gated with automatic
approval — downloading requires a Hugging Face account and `HF_TOKEN`,
which this sidecar reads from the environment. The English checkpoint is
**not** served here: English rides Groq Whisper large-v3-turbo, which
outperforms whisper-small and costs nothing extra in the chain.
(`NCAIR1/N-ATLaS`, the fifth org repo, is the LLM used by the
understanding lane in step 4, not ASR.)

## Run

Requires Python 3.10+, **ffmpeg on PATH** (decodes browser webm/opus), and
a Hugging Face token for the gated repos.

```bash
cd services/n-atlas-asr
python -m venv .venv
. .venv/Scripts/activate        # Windows Git Bash; use source .venv/bin/activate on Linux
pip install -r requirements.txt
export HF_TOKEN=hf_...
uvicorn app:app --host 127.0.0.1 --port 8100
```

Then in the backend `.env`:

```
NATLAS_ASR_BASE_URL=http://127.0.0.1:8100
NATLAS_ASR_TIMEOUT_MS=60000
```

Per deployment, run it as a systemd unit (`uvicorn` under a dedicated
user) — see the deployment doc delivered in Phase C step 9; the VPS is
sized for **2–4 concurrent ASR streams**.

## Environment

| Variable | Default | Purpose |
| --- | --- | --- |
| `NATLAS_ASR_MODEL_YO` / `_HA` / `_IG` | `NCAIR1/{Yoruba,Hausa,Igbo}-ASR` | checkpoint override per language |
| `NATLAS_ASR_IDLE_UNLOAD_SECONDS` | `600` | unload a language idle this long (RAM discipline) |
| `NATLAS_ASR_GENERATE_KWARGS` | `{}` | JSON dict of extra pipeline kwargs |
| `HF_TOKEN` | — | gated-repo download token |

## API

```
GET /health
→ {"status":"ok","loaded":{"yo":false,"ha":false,"ig":false},
   "idle_unload_seconds":600,"models":{...}}

POST /transcribe   (multipart)
  file=<audio/webm|wav|m4a|...>   lang=yo|ha|ig
→ {"text":"...","duration":3.42}
  400 unknown lang / undecodable audio · 503 model load or generation failure
```

## RAM & capacity honesty

- whisper-small is ~1 GB of RAM **per loaded language**; three languages
  warm ≈ 3 GB plus torch overhead. Models load lazily on first request per
  language (~10–30 s cold) and the janitor unloads idle languages, so an
  overnight deployment settles back to near-zero residency.
- One generation at a time **per language** (`threading.Lock`); different
  languages can run concurrently. The box serves ~2–4 parallel streams;
  beyond that requests queue and the backend's `NATLAS_ASR_TIMEOUT_MS`
  degrades the student to the friendly "type your message instead" 503.
- Text chat (including vernacular text) is unaffected by ASR capacity —
  text has no practical concurrency ceiling here.

## License / attribution

The NCAIR1 checkpoints are research fine-tunes of `openai/whisper-small`
(MIT). NCAIR1 is Nigeria's National Centre for Artificial Intelligence and
Robotics; credit them and their training data sources in the deployment
doc and any user-facing "how Natlas hears Nigerian languages" material.

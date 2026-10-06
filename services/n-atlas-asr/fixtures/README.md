# ASR fixtures (Phase C step 5)

Real 10-second spoken samples per vernacular language, recorded by native
speakers as part of the step-9 end-to-end pilot run. They are **not
committed** (voice is sensitive data and the files churn); this folder
defines the convention.

## Recording checklist

- 10 seconds, natural pace, one speaker, quiet room.
- One file per language, plain speech about a school day (no clinical
  content — fixtures may end up in QA screenshots).
- Convert to the sidecar-friendly shape:

```bash
ffmpeg -i take-yo.m4a -ar 16000 -ac 1 fixture-yo.wav
```

## Naming

```
fixture-yo.wav   Yoruba — expected: text contains "ẹ" or "ọ" diacritics
fixture-ha.wav   Hausa  — expected: text contains "ƙ" or "ɗ"
fixture-ig.wav   Igbo   — expected: text contains "ị", "ọ", "ụ" or "ṅ"
```

## How they are used

- **Sidecar smoke test (manual):**

```bash
curl -s -F "file=@fixture-yo.wav" -F "lang=yo" http://127.0.0.1:8100/transcribe
```

- **Step 9 E2E (env-gated):** when the pilot harness runs with
  `NATLAS_ASR_E2E=1`, each fixture is posted through
  `POST /api/v1/ai/transcribe` and asserted to (a) return non-empty text,
  (b) echo the routed language, and (c) finish within the 3 s local
  latency budget after warm-up. Without the env flag the harness skips
  these — CI has no sidecar and no models.

# N-ATLaS Documentation — Integration in Natlas

**Submission item 02 — N-ATLAS Integration Evidence.**
Companion document: [Technical Documentation](TECHNICAL-DOCUMENTATION.md) (item 04).

This document describes how Natlas uses the N-ATLaS model (`NCAIR1/N-ATLaS`)
and the NCAIR1 vernacular speech models, what the integration depends on, what
fallbacks exist, and what we measured against the live endpoint.

---

## 1. Summary

Natlas uses N-ATLaS for the **language work** of the platform, and a general
model (OpenAI, with Groq as fallback) for the **conversational reply**:

| # | Use | N-ATLaS role | Where | Fallback |
|---|---|---|---|---|
| 1 | **Language identification** | Reads the language of a student message when the offline heuristics are silent | `src/ai/language/language-detector.service.ts` | OpenAI, then "no signal" |
| 2 | **Reply rendering** | Renders the English reply into Pidgin, Yoruba, Hausa or Igbo | `src/ai/language/reply-renderer.service.ts` | OpenAI, then a scripted in-language line |
| 3 | **Understanding (translation)** | Translates a vernacular message to English for the second safety sweep | `src/ai/providers/natlas/natlas.provider.ts` | OpenAI |
| 4 | **Speech recognition (voice notes)** | Yoruba, Hausa and Igbo ASR via the NCAIR1 sidecar | `services/n-atlas-asr/`, `src/ai/providers/natlas/natlas-asr.provider.ts` | Groq Whisper |

N-ATLaS is **not** used to generate the English reply and does not decide
safeguarding on its own. Safety flags come from rules and keywords that run
whether or not N-ATLaS is available.

---

## 2. Endpoint and configuration

N-ATLaS is served as an OpenAI-compatible chat endpoint (`POST /v1/chat/completions`)
on a Hugging Face Inference Endpoint.

| Setting | Variable | Notes |
|---|---|---|
| Base URL | `NATLAS_LLM_BASE_URL` | Endpoint root; the client appends `/v1/chat/completions` |
| API key | `NATLAS_LLM_API_KEY` | Sent as a Bearer token; never logged or exposed through the config endpoint |
| Model name | `NATLAS_LLM_MODEL` | `NCAIR1/N-ATLaS` |
| Generation budget for translation | `NATLAS_LLM_TIMEOUT_MS` | 45 s |
| Render budget | `NATLAS_RENDER_TIMEOUT_MS` | 12 s |
| Identify budget | `NATLAS_IDENTIFY_TIMEOUT_MS` | 4 s |
| ASR sidecar | `NATLAS_ASR_BASE_URL`, `NATLAS_ASR_TIMEOUT_MS` | Local FastAPI sidecar, 60 s |

If `NATLAS_LLM_BASE_URL` is empty, the N-ATLaS language lanes are switched off
and the OpenAI lanes take over. The system still runs.

Sampling temperatures are low and set per use: identification 0, translation
(understanding) 0.1, and rendering 0.2. Identification is deterministic for a
given model version. Rendering is not, which is why its output is checked (§3.2).

---

## 3. Integration points

### 3.1 Language identification

**Purpose.** Decide the language of a student message when heuristics cannot,
for example Hausa typed without diacritics.

**Prompt contract** (`src/ai/language/identify.prompt.ts`, version `v2`). The
model is asked for two lines:

```
Language: <English | Nigerian Pidgin | Yoruba | Hausa | Igbo | Other>
Meaning: <English meaning of the message>
```

The parser reads only the `Language:` line. The `Meaning:` line is ignored for
the decision, because it can contain stray codes. An `Other` answer is an
explicit "no signal".

**When it runs.** Only when every offline stage is silent and the text is at
least 8 characters long with letters in it.

**Why this contract.** v1 asked for a bare code and N-ATLaS echoed the legend
or answered `en` for Hausa. The translation-style header scored higher in our
test sentences (see §6).

### 3.2 Reply rendering

**Purpose.** The English reply is written by the generation model, then
rendered into the student's language. The render keeps names, pronouns and
the student's situation intact (context lines are sent with the reply).

**Prompt** (`render.prompt.ts`): the render must translate literally, including
any safety or distress wording; it must not soften or euphemise; it must return
only the reply.

**Acceptance.** A render is used only if it passes every check below. A
render that fails a check is treated as a failed lane, and the next lane is tried.

| Check | Why |
|---|---|
| Not the English reply, and not containing it | N-ATLaS sometimes returns the English unchanged or behind a label |
| Length at most 2.5× the English plus 40 characters | Guards against runaway output |
| No 4-word phrase repeated three or more times | Guards against looping output |
| Target-language evidence (below) | Guards against a render in the wrong language |
| No other local language's exclusive diacritics | Guards against Yoruba text for an Igbo reply, and similar |
| Not read as English by franc (Yoruba, Hausa, Igbo only) | Guards against English prose |

Target-language evidence:
- **Pidgin:** at least two Pidgin markers, and no strong Yoruba, Hausa or Igbo lexicon reading.
- **Yoruba, Hausa, Igbo:** at least one diacritic or lexicon word of that language.

A leading label such as `Nigerian Pidgin reply:` is removed before the checks.

### 3.3 Understanding (translation)

**Purpose.** A vernacular student message is translated to English, and the
English is checked by the same intent rules as English text. This is a second
safety sweep for messages the first pass could not read.

**Contract.** A JSON reply with the English translation, tone and key facts,
validated against a schema. Runs as an async `VERNACULAR` job after the reply is saved.

### 3.4 Speech recognition (voice notes)

**Purpose.** Voice notes in Yoruba, Hausa and Igbo are transcribed by the NCAIR1
whisper-small fine-tunes, hosted in the sidecar `services/n-atlas-asr`.

**Routing.** Yoruba, Hausa and Igbo go to the sidecar. English and Pidgin go to
Groq Whisper, because Pidgin is lexified on English and Whisper detects it.

**Sidecar contract.**

```
GET  /health       -> { status, loaded, idle_unload_seconds, models }
POST /transcribe   multipart: file=<audio>, lang=yo|ha|ig
                   -> { text, duration }   | 400 unknown language | 503 failure
```

The models are `NCAIR1/Yoruba-ASR`, `NCAIR1/Hausa-ASR` and `NCAIR1/Igbo-ASR`.
They load on first use and are unloaded after an idle period. One generation
runs per language at a time.

---

## 4. Fallback behaviour

Every N-ATLaS lane has a defined fallback. Nothing in the chain can leave the
student without a reply.

```
Identify:  heuristics → keyword → N-ATLaS → OpenAI → no signal (keep the conversation's language)
Render:    N-ATLaS (validated) → OpenAI (validated) → scripted in-language line
Understand:N-ATLaS → OpenAI → job retried later
Voice:     N-ATLaS sidecar → Groq Whisper → student is asked to type
```

Safeguarding is independent of N-ATLaS:
- keyword flags run on the raw student message;
- acute flags create the staff alert in English;
- acute safety copy is the pre-approved in-language line, never a live translation.

When N-ATLaS is unreachable, the system logs a warning and continues on the
next lane. Each lane's failure is visible in the reply's `notes`.

---

## 5. Prompts and parameters

| Use | Temperature | Max output | Timeout |
|---|---|---|---|
| Identify | 0 | 64 tokens | 4 s |
| Render | 0.2 | 400 tokens | 12 s |
| Understanding | 0.1 | 120 tokens | 45 s |

Prompt sources: `identify.prompt.ts`, `render.prompt.ts`, `understanding.prompt.ts`.
Each prompt has a version constant so changes are traceable.

---

## 6. Evidence

These results come from runs against the live endpoint during development. They
are not a clinical evaluation.

### 6.1 Availability and latency

| Check | Result |
|---|---|
| `GET /v1/models` | HTTP 200, 0.8–1.7 s |
| `GET /health` | HTTP 200, 0.8–1.7 s |
| Identify (warm), six samples | 1.3–2.1 s |
| Render English → Hausa / Yoruba | 2.7–3.5 s |

Identify fits inside its 4 s budget with a narrow margin. If the endpoint
cools down, the budget can be exceeded, and the OpenAI lane takes over.

### 6.2 Identification accuracy

Six clearly marked or clearly written samples (live probe):

| Expected | Result |
|---|---|
| Hausa (suicidal phrase) | Hausa ✓ |
| Hausa (thanks) | Hausa ✓ |
| Yoruba (abuse disclosure) | Yoruba ✓ |
| Igbo (bullying) | **Yoruba ✗** |
| Pidgin (panic) | Pidgin ✓ |
| English | English ✓ |

Eight unmarked samples (no diacritics), probed directly on the model:

| Expected | Result |
|---|---|
| Igbo `achoro m inwu` | **Hausa ✗** (the keyword layer catches it first in the product) |
| Igbo ×3 | Igbo ✓ |
| Yoruba ×2 | Yoruba ✓ |
| Hausa `ina so in mutu` | **Yoruba ✗** (fixed: a keyword now catches it first) |
| Hausa `ina jin tsoron komawa gida` | Hausa ✓ |

**Finding.** N-ATLaS confuses Igbo with Yoruba and sometimes Hausa with Yoruba
on short text. The product does not rely on the model for those cases: diacritics,
the lexicon and the keyword layer all run first. The model is consulted only when
those are silent, and its answer is not trusted without the keyword layer.

### 6.3 Conversation eval against the live endpoint

The eval runs 51 multi-turn conversation sets through the real pipeline. Live
mode uses the real N-ATLaS identify and render. Generation is stubbed, so the
English reply is a fixed text.

The first live run was **not** a valid measurement: a bug in the test harness
sent the N-ATLaS calls to the OpenAI stub, so it is excluded. Valid live runs
came after that fix, and the pass count rose as the render checks were added:

| Live run (valid) | Result | What changed before this run |
|---|---|---|
| 1 | 44 of 51 | Harness fixed; failures were echoed and wrong-language renders |
| 2 | 45 of 51 | Realistic English reply used for rendering |
| 3 | 47 of 51 | Render validation rules added (echo, evidence, label) |
| 4 | 51 of 51 | Degenerate-output and Pidgin-evidence rules added |
| 5 | 51 of 51 | Same code as run 4 |
| 6 | 49 of 51 | Same code as run 4; ES-13 and ES-42 failed |

Runs 4 to 6 are the same code, so the spread between 49 and 51 is run-to-run
variation from the live model. Stub mode (no network) gives 50 of 51, with
ES-16 a known gap. A longer series on the final code is still pending.

### 6.4 Failure modes found and mitigations

| Observed from the live endpoint | Mitigation (implemented) |
|---|---|
| Returned the English reply unchanged for a Pidgin target | Echo check: rejected; next lane tried; scripted line if none |
| Returned `Nigerian Pidgin reply:` followed by the English | Echo check catches the English behind the label |
| Returned Yoruba text for a Pidgin target | Evidence rule for Pidgin: two markers and no strong local reading |
| Returned Igbo text with no diacritics for a Pidgin target | Pidgin evidence rule (markers required) |
| Returned a looping, repetitive output | Repeated-phrase check; length check |
| Returned a single "e don" with Yoruba words for a Pidgin target | Two-marker requirement |
| Identified Igbo as Yoruba (§6.2) | Heuristics and keywords run first; model result is advisory for safety |
| Identified Hausa safety phrase as Yoruba (§6.2) | Keyword added for the phrase variant; keyword layer decides |

### 6.5 What the checks do not prove

- They confirm that a render is in the target language by evidence, not by a
  human reading it. Native-speaker review of rendered replies is still needed.
- They do not measure whether the rendered reply is clinically appropriate.

---

## 7. How to verify

### 7.1 Health check

```bash
curl -s -o /dev/null -w "%{http_code}\n" "$NATLAS_LLM_BASE_URL/v1/models" \
  -H "Authorization: Bearer $NATLAS_LLM_API_KEY"
```

### 7.2 Conversation eval against the live endpoint

```bash
# .env in the project root must contain NATLAS_LLM_BASE_URL, NATLAS_LLM_API_KEY, NATLAS_LLM_MODEL
NATLAS_LIVE=1 npx vitest run src/ai/eval --testTimeout=300000
```

The API key is read from `.env` and is never printed.

### 7.3 Offline eval (no network)

```bash
npx vitest run src/ai/eval
```

### 7.4 Unit tests for the integration

```bash
npx vitest run src/ai/language
```

Covers identification parsing, the OpenAI identify fallback, render acceptance,
label stripping, looping detection and the scripted fallback.

---

## 8. Limitations and risks

- **Identification on short unmarked text** is unreliable (§6.2). Safety does not depend on it, but the reply language can be wrong for a turn when no keyword matches.
- **Render quality** is checked for language and structure, not for meaning or tone. Renders can be imperfect even when accepted.
- **Latency** of identify is close to its budget. A cold endpoint falls through to OpenAI.
- **Model updates** change the outputs. The eval should be re-run after any endpoint or model change.
- **Clinical review** of the local-language crisis lines and vocabulary is pending. These are used in code only after that review.

---

## 9. Ownership and status

| Item | Status |
|---|---|
| Integration in code | Implemented |
| Unit tests for the integration | Passing (see [Technical Documentation §12](TECHNICAL-DOCUMENTATION.md#12-testing-and-evaluation)) |
| Live eval | Passing in most runs; final measurement after the last change pending |
| Real-world validation with students | Not yet done |
| Native-speaker and clinical review | Pending |

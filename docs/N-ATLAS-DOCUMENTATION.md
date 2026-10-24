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
| 1 | **Language identification** | Reads the language of a student message when the offline heuristics are silent | `src/ai/language/language-detector.service.ts` | OpenAI (same prompt), then "no signal" |
| 2 | **Reply rendering** | Renders the English reply into Pidgin, Yoruba, Hausa or Igbo | `src/ai/language/reply-renderer.service.ts` | scripted in-language line — **OpenAI never renders** |
| 3 | **Understanding (translation)** | Translates a vernacular message to English, both to draft the reply from and for the second safety sweep | `src/ai/providers/natlas/natlas.provider.ts` | none — **OpenAI never translates**; the reply drafts from the student's own words and the job retries later |
| 4 | **Speech recognition (voice notes)** | Yoruba, Hausa and Igbo ASR (hosted endpoints, or the local sidecar) | `src/ai/providers/natlas/natlas-asr.provider.ts`, `services/n-atlas-asr/` | none for vernacular — a friendly 503 asks the student to type |

N-ATLaS is **not** used to generate the English reply and does not decide
safeguarding on its own. Safety flags come from rules and keywords that run
whether or not N-ATLaS is available. Since `NATLAS_TRANSLATE_ONLY_001` the split
is deliberate and total: **N-ATLaS is the only translator and the only renderer;
OpenAI does the reasoning.**

---

## 2. Endpoint and configuration

N-ATLaS is served as an OpenAI-compatible chat endpoint (`POST /v1/chat/completions`)
on a Hugging Face Inference Endpoint.

| Setting | Variable | Notes |
|---|---|---|
| Base URL | `NATLAS_LLM_BASE_URL` | Endpoint root; the client appends `/v1/chat/completions` |
| API key | `NATLAS_LLM_API_KEY` | Sent as a Bearer token; never logged or exposed through the config endpoint |
| Model name | `NATLAS_LLM_MODEL` | `NCAIR1/N-ATLaS`. Must equal what the server reports — on a local Ollama that means the exact `ollama list` tag; a mismatch 404s every request and the lane falls through **silently**, which reads as "N-ATLaS is not working" with no error anywhere |
| Translation budget | `NATLAS_TRANSLATE_TIMEOUT_MS` | **10 s** — the translation lane, both its synchronous and its worker half |
| Render budget | `NATLAS_RENDER_TIMEOUT_MS` | 12 s |
| Identify budget | `NATLAS_IDENTIFY_TIMEOUT_MS` | 4 s |
| Provider default budget | `NATLAS_LLM_TIMEOUT_MS` | 45 s — the deadline `completeJson` uses when a caller passes none. No lane relies on it today, so changing it has no visible effect; use the per-lane knobs |
| ASR endpoints | `NATLAS_ASR_URL_YO` / `_HA` / `_IG`, `NATLAS_ASR_API_KEY` | Per-language hosted Hugging Face endpoints (the production shape) |
| ASR sidecar | `NATLAS_ASR_BASE_URL`, `NATLAS_ASR_TIMEOUT_MS` | Self-hosted FastAPI sidecar, used when a per-language URL is unset; 60 s |

If `NATLAS_LLM_BASE_URL` is empty, the N-ATLaS lanes switch off: identification
goes straight to OpenAI, translation is unavailable (the reply drafts from the
student's own words), a vernacular render falls to the scripted in-language line,
and the student is still answered. The system still runs.

The production endpoint **scales to zero after 15 idle minutes**, and a cold boot
costs roughly 8–16 minutes of billed GPU time before the first request answers. A
lane timeout does not wait for that wake — it fails open — so a check that must
show `via: 'n-atlas-local'` needs the endpoint re-warmed about 15 minutes first.

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

**Acceptance.** A render is used only if it passes every check below. A render
that fails a check is a failed lane: `render()` returns `null`, OpenAI is **not**
asked to render, and the student gets the pre-approved scripted line in their own
language (`SCRIPTED_GENERIC_REPLY`, §4). Rendering is an enhancement, never a
blocker — the lane never throws.

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

**Purpose.** A vernacular student message is translated to English, and that
English is what the reasoning model works with. Two moments of one turn use the
same call:

- **Synchronously**, before generation: when the reply language is vernacular,
  `AiService.generateAndApply` translates first and drafts the reply from the
  English (`src/ai/ai.service.ts:262`), sanitized again. The raw text still goes
  to the keyword intent floor, so safety never depends on the translation.
- **Asynchronously**, after the reply is saved: the `VERNACULAR` job
  (`src/ai/ai-worker.service.ts:201`) re-runs the translation, stores it on the
  message as `aiPayload.understanding` (carrying `via`, the acceptance signal that
  the lane genuinely served the turn), and runs the intent engine over the
  **English** as a second safety sweep — a crisis phrase invisible to the keyword
  floor in its original language then surfaces as an `AI_CANDIDATE` flag with a
  `safety_flag.lang_refine` audit. Every non-English turn gets the sweep,
  including a message whose detection was silent but whose conversation is running
  in a vernacular.

**Contract.** A JSON reply with the English translation, tone and key facts
(`englishTranslation`, `tone`, `keyFacts`), validated against a schema
(`src/ai/language/understanding.schema.ts`); `response_format: json_object`,
120 output tokens, temperature 0.1. The prompt's safety-critical instruction is to
translate risk meaning **literally** — never soften or euphemise it.

**No second member.** OpenAI never translates. If N-ATLaS cannot answer, the
synchronous half notes "Translation unavailable; drafted from the original
message" and the async half retries on the worker ladder (5 s / 30 s / 2 min),
ending in an `ai_generation.exhausted` audit rather than a silent drop.

### 3.4 Speech recognition (voice notes)

**Purpose.** Voice notes in Yoruba, Hausa and Igbo are transcribed by the NCAIR1
whisper-small fine-tunes — `NCAIR1/Yoruba-ASR`, `NCAIR1/Hausa-ASR`,
`NCAIR1/Igbo-ASR`.

**Routing.** Yoruba, Hausa and Igbo go to N-ATLaS ASR: `src/ai/providers/natlas/
natlas-asr.provider.ts` resolves each language from its hosted endpoint
(`NATLAS_ASR_URL_YO`/`_HA`/`_IG`) and falls back to the self-hosted sidecar
(`services/n-atlas-asr`) behind `NATLAS_ASR_BASE_URL`. English and Pidgin go to
Groq Whisper, because Pidgin is lexified on English and Whisper detects it. The
transcript then re-enters the text lanes, so detection, translation and render all
apply to spoken turns.

**No vernacular fallback.** Audio has no second member: an unconfigured, down or
slow vernacular endpoint answers one friendly 503 ("Voice notes in Yoruba are not
available right now — please type your message instead."), never a raw error and
never silence.

**Sidecar contract** (when `NATLAS_ASR_BASE_URL` is the route in use):

```
GET  /health       -> { status, loaded, idle_unload_seconds, models }
POST /transcribe   multipart: file=<audio>, lang=yo|ha|ig
                   -> { text, duration }   | 400 unknown language | 503 failure
```

The models load on first use and are unloaded after an idle period. One
generation runs per language at a time.

### 3.5 What the model re-reads (history_en)

Every stored turn that reaches the system again reaches it in English
(`src/ai/language/history-pivot.ts`): USER turns pivot from
`aiPayload.understanding.englishTranslation`, ASSISTANT turns from
`aiPayload.render.englishSource` — the model's own pre-render wording, so the
pivot is exact rather than re-translated — and either falls back to the raw text
when no pivot exists (English turns, renders that never happened, rows predating
the lanes). Both consumers of history use it: the model's context window
(`src/ai/context/ai-context.service.ts`, which budgets on the pivoted text) and the
session-summary transcript. A vernacular conversation therefore costs the reasoning
model the same characters an English one does, and no summary is written from
untranslated text.

---

## 4. Fallback behaviour

Every N-ATLaS lane has a defined fallback. Nothing in the chain can leave the
student without a reply.

```
Identify:  heuristics → keyword → N-ATLaS → OpenAI → no signal (keep the conversation's language)
Render:    N-ATLaS (validated) → scripted in-language line
Understand:N-ATLaS only → synchronous: draft from the student's own words / async: worker retry → exhausted audit
Voice:     N-ATLaS ASR (hosted endpoint → sidecar) → friendly 503 asking the student to type
```

Only identification has a second member — it is detection, not translation, so
OpenAI may answer the same prompt. Translation, rendering and vernacular ASR are
N-ATLaS or the documented fallback, by the `NATLAS_TRANSLATE_ONLY_001` decision:
a frontier model must not be silently substituting Nigerian-language judgement.

Safeguarding is independent of N-ATLaS:
- keyword flags run on the raw student message;
- acute flags create the staff alert in English;
- acute safety copy is the pre-approved in-language line (`SCRIPTED_SAFETY` per
  intent in `src/ai/language/scripted-copy.ts`), never a live translation;
- the second safety sweep runs on the English translation, so a phrase the keyword
  floor cannot read in the original language still surfaces as a flag.

When N-ATLaS is unreachable, the system logs a warning and continues on the
documented fallback. Each lane's failure is visible in the reply's `notes`.

---

## 5. Prompts and parameters

| Use | Temperature | Max output | Timeout |
|---|---|---|---|
| Identify | 0 | 64 tokens | 4 s |
| Render | 0.2 | 400 tokens | 12 s |
| Understanding | 0.1 | 120 tokens (`json_object`) | 10 s |

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

**Endpoint migration, 2026-10-24.** The chat endpoint moved to an AWS L4
($0.80/hr, same URL, 15-minute scale-to-zero). A cold wake answered after ~14
minutes, then `POST /v1/chat/completions` returned HTTP 200 from `vllm-0.23.0`
with a Yoruba rendering of "you matter, and it is okay to say this privately"
(67 prompt / 39 completion tokens). Warm latency is what the budgets above were
measured against; a wake is not a slow request, it is a lane that fails open.

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
label stripping, looping detection, the scripted fallback, the history pivot and
every lane timeout in the env contract.

### 7.5 Manual browser pass

`test/language-harness/` — a zero-dependency page plus its same-origin `:5050`
proxy, run against a local backend. It shows, per turn: the detected language, the
reply language, the `render` block, the `boundary` marker and the async
`understanding` once the VERNACULAR lane lands it. Setup and expectations:
[API testing handbook §5.6](API-TESTING-HANDBOOK.md#56-manual-browser-harness-testlanguageharness).

---

## 8. Limitations and risks

- **Identification on short unmarked text** is unreliable (§6.2). Safety does not depend on it, but the reply language can be wrong for a turn when no keyword matches.
- **Render quality** is checked for language and structure, not for meaning or tone. Renders can be imperfect even when accepted.
- **Latency** of identify is close to its budget. A cold endpoint falls through to OpenAI.
- **Model updates** change the outputs. The eval should be re-run after any endpoint or model change.
- **Clinical review** of the local-language crisis lines and vocabulary is
  **outstanding, and the code already uses them**: every line in
  `src/ai/language/scripted-copy.ts` is marked `PENDING_CLINICAL_REVIEW`, and
  `GET /api/v1/ai/config` publishes the keyword packs' status as
  `vernacularReviewStatus`. A vernacular crisis turn therefore ships wording that
  no native speaker or clinical reviewer has signed off yet — the pilot's clinical
  sign-off is the gate, not the code.
- **A failed render is a generic reply, not the tailored one**: when N-ATLaS
  cannot produce an accepted render the student gets the scripted in-language line
  instead of the reply written for them, so render availability is a quality
  question, not only an aesthetic one.

---

## 9. Ownership and status

| Item | Status |
|---|---|
| Integration in code | Implemented |
| Unit tests for the integration | Passing (see [Technical Documentation §12](TECHNICAL-DOCUMENTATION.md#12-testing-and-evaluation)) |
| Live eval | Passing in most runs; final measurement after the last change pending |
| Real-world validation with students | Not yet done |
| Native-speaker and clinical review | Pending |

---

## 10. License, attribution and integration history

Per the N-ATLaS license obligations (restated in [DEPLOYMENT.md §1](DEPLOYMENT.md)):

- **Attribution is displayed verbatim in the product footer** (frontend
  `src/components/AppFooter.tsx`): *"N-ATLaS is an initiative of the Federal
  Ministry of Communications, Innovation and Digital Economy, powered by Awarri
  Technologies."* Do not remove or reword it.
- §1 of the runbook additionally requires the same string on
  `GET /api/v1/ai/config`. That endpoint today publishes the language block, the
  reply mode and `vernacularReviewStatus`, but **no attribution field** — the web
  footer is currently the only place it appears, so any other client of the API
  has no attribution to show. Closing that is a one-field change.
- The **1000 active end-users / 30 days** cap is an operational constraint. The
  pilot cohort is far below it; enrolment is checked before any scaling step
  (pilot analytics, `src/analytics/`).
- The gated NCAIR1 repositories are accessed with an account that has accepted the
  model terms.

| Change | Date | What changed |
|---|---|---|
| `NATLAS_SIDECAR_001` | 2026-10-08 | Local Ollama (CPU Q4_K_M) served the async understanding lane on the VPS at ~2 tokens/s; the hardcoded 15 s understanding budget proved unwinnable — the lesson that became the per-lane timeout ladder. |
| `NATLAS_LLM_014` | 2026-10-09 | The VPS Ollama gave way to a **hosted HF Inference Endpoint** (vLLM, GPU, scale-to-zero): OpenAI chat shape, env-only `NATLAS_LLM_API_KEY`, model default `NCAIR1/N-ATLaS`, every failure path collapsed into `NatlasUnavailableError`. |
| `VERNACULAR_REPLY_015` | 2026-10-09 | Per-message language following: yo/ha/ig lexicon detection replaces franc for the local languages, and `n-atlas-translate` became the default reply mode. |
| `LANG_ID_016` | 2026-10-09 | The detector's last resort became N-ATLaS itself — translation-anchor prompt v2 under a strict 4 s fail-open cap — and the client-supplied `language` left the contract end to end. |
| `NATLAS_TRANSLATE_ONLY_001` | 2026-10-12 | **N-ATLaS became the only translator and renderer.** The OpenAI translation and render lanes were removed; OpenAI does the reasoning only. `NATLAS_TRANSLATE_TIMEOUT_MS` (10 s) replaced the shared 45 s budget for the translation call, and a failed render now falls to a scripted in-language line rather than an OpenAI render. |
| `ASR_HF_001` | 2026-10-12 | Vernacular ASR gained per-language hosted HF endpoints (`NATLAS_ASR_URL_YO/HA/IG`, T4, scale-to-zero), with the self-hosted sidecar kept behind `NATLAS_ASR_BASE_URL`. |
| AWS L4 migration | 2026-10-22 | The chat endpoint moved to an AWS L4 under the same URL, 15-minute scale-to-zero; verified serving 2026-10-24 (§6.1). |
| `NATLAS_RESCUE_001` | 2026-10-24 | The stale-branch rescue: the history pivot (§3.5) now feeds the model context as well as the summary, the manual browser harness (§7.5) landed, and the dead `language.understandingTimeoutMs` field was deleted — it was read by nothing, and `NATLAS_TRANSLATE_TIMEOUT_MS` is the knob that actually governs the translation lane. This document was re-verified against the code and corrected: the OpenAI render/translation fallbacks and the 45 s understanding budget it previously described had already been removed. |

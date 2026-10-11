# N-ATLaS Integration — Soul Nurture AI

How Soul Nurture AI (this repository) integrates with **N-ATLaS**, the multilingual
Nigerian LLM family released by **NCAIR / Awarri Technologies under the Federal
Ministry of Communications, Innovation and Digital Economy**. N-ATLaS is the
product's **language layer**: it is what lets a Nigerian secondary-school student
type or speak in Yoruba, Hausa, Igbo or Nigerian Pidgin and be understood — and be
answered in their own language.

- Model: `NCAIR1/N-ATLaS` (Llama-3-8B multilingual fine-tune; the family also ships
  four ASR models — Yoruba, Hausa, Igbo, Nigerian-accented English).
- Companion code: the ASR sidecar lives in this repo at `services/n-atlas-asr`
  (FastAPI service wrapping the NCAIR1 whisper-small fine-tunes).

---

## 1. Where N-ATLaS sits in the architecture

The realtime student chat deliberately rides an OpenAI → Groq provider chain
(`AI_PROVIDER_CHAIN`, `src/ai/providers/chain.provider.ts`) — frontier reasoning
with full guardrail and budget controls. N-ATLaS owns everything that chain
cannot do: **Nigerian-language comprehension and production**. It is wired as four
dedicated lanes behind one thin OpenAI-compatible client
(`src/ai/providers/natlas/natlas-llm.provider.ts`):

```
student message (typed or spoken)
        │
        ▼
[1] LANGUAGE ID ── synchronous, per message ── N-ATLaS names the language
        │            when every offline heuristic is silent
        ▼
[2] REPLY RENDER ── synchronous, same request ── N-ATLaS renders the finished
        │             English reply into the student's language
        ▼
student reads the reply in their language
        │
        └──► [3] UNDERSTANDING ── async worker, per vernacular message ──
        │        N-ATLaS translates to English JSON (feeds safeguarding)
        │
        └──► [4] VERNACULAR ASR ── voice notes in yo/ha/ig ── N-ATLaS
                 whisper-small sidecar transcribes to text (lane 1 then applies)
```

Every lane degrades gracefully (§4). A turn written in English never touches
N-ATLaS at all — the lanes only fire for vernacular turns.

## 2. Model and serving shape

N-ATLaS is served through an **OpenAI-compatible chat API** (`POST /v1/chat/completions`),
so one client shape covers every environment:

| Environment | Endpoint | Notes |
|---|---|---|
| Production | Hosted **Hugging Face Inference Endpoint** (vLLM, GPU) | URL held in `NATLAS_LLM_BASE_URL` (server env, never committed); authenticated with a Hugging Face access token in `NATLAS_LLM_API_KEY`. The endpoint scales to zero when idle — see the timeout rationale in §3. |
| Development | Local Ollama `/v1` route | `NATLAS_LLM_BASE_URL=http://127.0.0.1:11434/v1`, no key; Ollama serves the same `NCAIR1/N-ATLaS` GGUF quantisation. |
| Absent | Unset / empty `NATLAS_LLM_BASE_URL` | Every lane falls through to its OpenAI fallback; the product works fully in English-only mode. |

The NCAIR1 model repositories are gated on Hugging Face; access requires accepting
the NCAIR1 terms on the account whose token is used.

## 3. Configuration contract

All knobs are environment variables (see `.env.example` for the annotated block;
defaults are compiled in `src/ai/config/ai.config.ts`). Nothing secret is ever
compiled into the exposed config — `GET /api/v1/ai/config` returns the whole
non-secret `AiConfig` (including the language block) so staff can always explain
current behaviour, while `NATLAS_LLM_API_KEY` is read directly by the provider and
never leaves the server.

| Variable | Default | Purpose |
|---|---|---|
| `NATLAS_LLM_BASE_URL` | *(empty)* | OpenAI-compatible base URL of the N-ATLaS endpoint. Empty = all lanes use their OpenAI fallback. |
| `NATLAS_LLM_MODEL` | `NCAIR1/N-ATLaS` | Model id sent on every request. |
| `NATLAS_LLM_API_KEY` | *(empty)* | HF access token (`Authorization: Bearer …`). Optional for unauthenticated local servers. |
| `NATLAS_LLM_TIMEOUT_MS` | `45000` | Async **understanding** lane budget. Generous on purpose: the hosted endpoint scales to zero and cold starts queue, and this lane runs on the worker (retry ladder 5 s / 30 s / 2 min absorbs the rest). |
| `NATLAS_RENDER_TIMEOUT_MS` | `12000` | Synchronous **reply render** budget. The student is waiting on this turn, so a cold endpoint must fall through to the OpenAI render quickly. |
| `NATLAS_IDENTIFY_TIMEOUT_MS` | `4000` | Synchronous **language-ID** budget — the strictest of the three: it runs inside `sendMessage` before the reply lane starts, so on timeout the offline verdict simply stands. |
| `AI_VERNACULAR_REPLY_MODE` | `n-atlas-translate` | Reply-lane switch. `n-atlas-translate`: generation stays English (full guardrails), N-ATLaS renders the finished reply. `openai-native`: rollback — the frontier model replies in the vernacular directly. |
| `NATLAS_ASR_BASE_URL` | *(empty)* | Local ASR sidecar (`services/n-atlas-asr`) base URL. Empty = vernacular voice notes degrade to a friendly 503 asking the student to type instead. |
| `NATLAS_ASR_TIMEOUT_MS` | `60000` | ASR budget (cold starts load whisper checkpoints). |

Prompt budgets (compiled, not env): understanding 120 output tokens as
`json_object`; render 400 tokens free text; identify 64 tokens at temperature 0.

## 4. The four lanes

### 4.1 Language identification (synchronous)

`src/ai/language/language-detector.service.ts` resolves the language of every
student message. The offline stack runs first — diacritic scan → Pidgin marker
words → Yoruba/Hausa/Igbo lexicon wordlists → franc trigrams for long English only
(franc cannot separate yo/ha/ig, so its vernacular verdicts are discarded). Only
when **every** heuristic is silent, and the trimmed message is at least
`IDENTIFY_MIN_CHARS` (8) characters, does the detector ask N-ATLaS itself
(`src/ai/language/identify.prompt.ts`, prompt version `v2`):

> *"You translate messages written by Nigerian secondary-school students into
> English. For every message reply in exactly this format, with two lines:
> Language: … / Meaning: …"*

Prompt v2 is a translation anchor, not a classification legend — classification is
out-of-distribution for this fine-tune (v1's code-word legend was echoed back or
answered "en" for Hausa in live testing), while translation is exactly what the
model was trained for. The caller parses the `Language:` header line and ignores
the meaning line; an explicit `Other` header parses to "no answer", never a
back-filled guess. Live-validated: **11/12** on the test sentence set (the one miss
was diacritic-marked Igbo, which the earlier diacritics stage settles), byte-stable
across re-runs at temperature 0. The stage is **fail-open**: any timeout, empty or
unparsable response leaves the student's standing preference in charge, exactly as
before. This is the LANG_ID_016 contract — the detected language, `en` included,
always wins for the turn it was detected on; the preference only fills detection
silence.

### 4.2 Vernacular understanding (asynchronous worker)

Every non-English student message is queued to the worker's VERNACULAR lane, which
calls `NatlasTranslationProvider.understand`
(`src/ai/providers/natlas/natlas.provider.ts`). The understanding prompt
(`src/ai/language/understanding.prompt.ts`, version `v1`) asks N-ATLaS for a single
JSON object — `englishTranslation`, `tone` (CALM / DISTRESSED / PANICKED /
HOPELESS / ANGRY / NEUTRAL), `keyFacts` (up to five short factual phrases) — with
one safety-critical instruction: **translate risk meaning literally, never soften
or euphemise it**. The translation feeds a second safeguarding sweep: the intent
engine re-runs on the English translation, so a crisis phrase invisible to the
keyword floor in its original language still surfaces as a flag (`lang_refine`
audit). The strict JSON is validated against a schema
(`src/ai/language/understanding.schema.ts`); a `via: 'n-atlas-local'` marker is
persisted on the message's `aiPayload` — this is the acceptance signal that the
N-ATLaS lane genuinely served the turn. Chain: **N-ATLaS → OpenAI** (OpenAI uses
guided `json_schema` decoding on the same prompt). Both lanes are usage-metered.

### 4.3 Vernacular reply render (synchronous)

With `AI_VERNACULAR_REPLY_MODE=n-atlas-translate` (the default), the reply
generation lane always writes in **English** — full context, guardrails and intent
directives stay on the frontier model. The finished, guardrailed English reply is
then handed to `ReplyRendererService.render`
(`src/ai/language/reply-renderer.service.ts`), which asks N-ATLaS
(`src/ai/language/render.prompt.ts`, version `v1`) to render it into the turn's
language in the same request. The prompt's contract is faithfulness: keep meaning,
tone and warmth; never add advice, questions or facts; **translate safety, distress
and crisis wording literally — never soften it**. Chain: **N-ATLaS → OpenAI render
→ keep the English reply**. The lane never throws — rendering is an enhancement,
not a requirement, so total failure still leaves the student with the correct
English reply. Scripted safety copy is never rendered. A `render` block with its
own `via` marker is persisted on `aiPayload` for audit.

### 4.4 Vernacular speech recognition (voice notes)

Voice input is routed by language (`POST /api/v1/ai/transcribe`,
`src/ai/ai.controller.ts`): English and Nigerian Pidgin ride the Groq Whisper
chain (Pidgin is auto-detected; the NCAIR1 ASR family has no Pidgin checkpoint);
**Yoruba, Hausa and Igbo go to the N-ATLaS ASR sidecar**
(`src/ai/providers/natlas/natlas-asr.provider.ts` → `services/n-atlas-asr`, a
FastAPI service serving the NCAIR1 whisper-small fine-tunes per language, chosen
for its honest capacity statement on our 12 GB CPU-only VPS). Unlike the text
lanes, audio has **no fallback member**: an unconfigured, down or slow sidecar
yields one friendly 503 — "Voice notes in Yoruba are not available right now —
please type your message instead." — never a raw error, never silence. The sidecar
is phase-2 of the deployment (unit + contract tested; not yet on the production
VPS) — see `docs/DEPLOYMENT.md` §5 for the systemd bring-up.

## 5. Failover architecture

Every N-ATLaS failure mode — unconfigured, unreachable, non-2xx, non-JSON body,
empty content — collapses to one typed error (`NatlasUnavailableError`,
`src/ai/providers/natlas/natlas-llm.provider.ts`), and each lane catches it:

| Lane | On N-ATLaS failure | Last resort |
|---|---|---|
| Identify | offline verdict / standing preference stands (fail-open) | — |
| Understanding | OpenAI translation on the same prompt | retryable job error (worker ladder) |
| Render | OpenAI render on the same prompt | the English reply (never throws) |
| ASR | friendly 503, student types instead | — |

Two deliberate design decisions hold across all lanes:

1. **N-ATLaS is not a chat-chain member.** `NatlasLlmProvider` implements a
   single-shot JSON/text contract for the vernacular lanes, not the chat contract
   the OpenAI → Groq chain implements (`src/ai/providers/ai-provider.interface.ts`).
   Keeping it out of the hot path protects student-facing latency and spend caps.
2. **Timeouts are per-lane, not global.** The student-facing lanes (identify,
   render) get short budgets so a cold scaled-to-zero endpoint falls through fast;
   the worker lane (understanding) gets a generous budget plus the retry ladder.

## 6. License and attribution

Per the N-ATLaS license obligations (restated in `docs/DEPLOYMENT.md` §1 and
`docs/HANDOFF.md`):

- **Attribution is displayed verbatim in the product footer**
  (`frontend/src/components/AppFooter.tsx`): *"N-ATLaS is an initiative of the
  Federal Ministry of Communications, Innovation and Digital Economy, powered by
  Awarri Technologies."*
- The **1000 active end-users / 30 days** cap is tracked as an operational
  constraint — the pilot cohort is far below it, and enrolment is monitored
  before any scaling step (pilot analytics dashboard, `src/analytics/`).
- The gated NCAIR1 repositories are accessed with an account that has accepted the
  model terms.

## 7. Verification and evidence

- **Unit specs** (543-test suite, `npm test`): `natlas-llm.provider.spec.ts`
  (client, auth, error mapping), `natlas.provider.spec.ts` (understanding chain +
  fallback), `natlas-asr.provider.spec.ts` (sidecar contract + 503 degradation),
  `reply-renderer.service.spec.ts` (render chain, quote cleaning, never-throws),
  `language-detector.service.spec.ts` (offline stack + identify header parsing,
  fail-open), `ai.config.spec.ts` (env contract incl. every timeout).
- **Live endpoint validation (2026-10-09):** identify prompt v2 scored 11/12 on
  test sentences and re-ran byte-identical at temperature 0; a Yoruba conversation
  against production persisted `via: 'n-atlas-local'` understanding and a
  vernacular `render` block (`conversation_inspector` read-back via
  `GET /api/v1/conversations/:id`).
- **E2E scripts** (`npm run test:e2e:journey`, `test:e2e:school-chat`,
  `test:e2e:dashboards`) exercise the full journey against a live server.
- **Ops:** N-ATLaS lanes are observable through the app logs and the
  `n-atlas-local` usage metering rows (`AiUsageDaily`), surfaced in Grafana
  (`docs/MONITORING.md`).

## 8. Integration history

| Change | Date | What changed |
|---|---|---|
| `NATLAS_SIDECAR_001` | 2026-10-08 | Local Ollama (CPU-quantised Q4_K_M) serves the async understanding lane on the VPS; the hardcoded 15 s understanding timeout proved too tight at ~2 tokens/s on shared vCPUs — the lesson that became the per-lane timeout ladder. |
| `NATLAS_LLM_014` | 2026-10-09 | The vernacular lane trades the VPS Ollama for the **hosted HF Inference Endpoint** (vLLM, GPU, scale-to-zero): OpenAI chat shape, env-only `NATLAS_LLM_API_KEY`, `NATLAS_LLM_TIMEOUT_MS` default 45 s, model default `NCAIR1/N-ATLaS`, every failure path throws `NatlasUnavailableError`. Deployed to production. |
| `VERNACULAR_REPLY_015` | 2026-10-09 | Per-message language following: yo/ha/ig lexicon detection replaces franc for the local languages, and the default `n-atlas-translate` reply mode renders the finished English reply into the turn's language within the same request. |
| `LANG_ID_016` | 2026-10-09 | The detector's last resort becomes N-ATLaS itself — translation-anchor identify prompt v2, strict 4 s fail-open cap — so Hausa/Igbo typed without diacritics is followed too; client-supplied language removed from the contract end to end. |

## 9. Related documentation

- `docs/DEPLOYMENT.md` — §5 N-ATLaS bring-up (Ollama + ASR sidecar systemd units), §6 env reference.
- `docs/PHASE-C-PLAN.md` — the approved design decisions for the language layer.
- `docs/API-TESTING-HANDBOOK.md` — §5.3 language ID, §9.5/§9.6 voice routing + N-ATLaS probes.
- `docs/MONITORING.md` — Grafana/Prometheus panels incl. AI usage metering.
- `docs/HANDOFF.md` — strategic context: N-ATLaS as the flagship language layer.

# Natlas — Technical Documentation

**Submission item 04 — Architecture, setup and usage.**
Companion document: [N-ATLAS Documentation](N-ATLAS-DOCUMENTATION.md) (item 02).

> **Status.** The backend is implemented and tested. The local-language crisis
> lines and the local-language safeguarding vocabulary are **drafts pending
> native-speaker and clinical review** (marked `PENDING_CLINICAL_REVIEW` in
> `src/ai/language/scripted-copy.ts` and `src/ai/intents/vernacular-keywords.ts`).
> They must not be relied on with students until that review is complete.

---

## 1. What the system does

Natlas is a school wellbeing platform for secondary-school students. A student
completes a short check-in and talks with an AI guide in English, Nigerian
Pidgin, Yoruba, Hausa or Igbo. The guide:

- replies in the language of the student's **current message**;
- gives basic emotional support inside a tightly bounded scope;
- **flags safeguarding concerns in the background** (suicidal ideation, self-harm,
  abuse, panic, threats, prolonged low mood) and notifies school professionals
  with an English summary and the student's verbatim message;
- can hand the student to a human support request.

The AI is a capability inside the wellbeing journey, not a general chatbot. The
safety layer does not depend on the language model being available.

---

## 2. Architecture

```
            ┌─────────────────────── Client (web / mobile) ───────────────────────┐
            │  REST (cookie session)  ·  Socket.IO (push-only)                    │
            └───────────────┬───────────────────────────────┬─────────────────────┘
                            │                               │
┌───────────────────────────▼──────────── NestJS 12 / Fastify (src/) ─────────────────────────────┐
│ auth · users · schools · students · check-ins · consent · privacy · audit · notifications      │
│                                                                                                │
│  conversations ──► AI service (src/ai) ──────────────────────────────────────────────────────┐ │
│      │               ├─ language layer   (detector, turn language, render, scripted copy)   │ │
│      │               ├─ intent engine    (keywords, AI categories, severity)                 │ │
│      │               ├─ guardrails       (input/output filters, rate windows)                │ │
│      │               ├─ context builder  (history, check-in, memory, resources)              │ │
│      │               └─ providers        (OpenAI → Groq chain; N-ATLaS for language)         │ │
│      │                                                                                       │ │
│      ├─ support-flags + alerts  (background flags → staff notification + support request)     │ │
│      └─ AI worker  (DB queue: deferred replies, vernacular understanding, summaries)           │ │
│                                                                                                │
│ support-requests · follow-ups · dashboard · analytics · resources · journal · activities       │
└───────┬──────────────────────────────┬──────────────────────────────┬──────────────────────────┘
        │                              │                              │
   PostgreSQL 16 (Prisma 7)     N-ATLaS endpoint                 OpenAI / Groq APIs
   (Prisma ORM, pgvector)        (chat completions: identify,     (generation, summaries,
                                 render, understanding)          fallback language work)
                                        │
                              N-ATLaS ASR sidecar (services/n-atlas-asr)
                              FastAPI · NCAIR1 whisper-small for yo / ha / ig
```

### 2.1 Module map

| Area | Location | Responsibility |
|---|---|---|
| Conversations | `src/conversations/` | Sending a message, the turn budget, the holding lane, closing a conversation |
| AI service | `src/ai/ai.service.ts` | One turn: context → prompt → model → intent verdict → render → result |
| Language layer | `src/ai/language/` | Detection, per-turn language rule, reply rendering and its validation, scripted copy |
| Intent engine | `src/ai/intents/` | Keyword and AI-category matching, severity, executors (flag, scripted safety, resources) |
| Context | `src/ai/context/` | Conversation history, check-in, memory summaries, approved resources |
| Providers | `src/ai/providers/` | `openai`, `groq`, `natlas` (LLM, translation, ASR), embeddings, usage meter |
| Support flags | `src/support-flags/` | Flag records, staff alert copy, notifications and support requests |
| Worker | `src/ai/ai-worker.service.ts` | DB-backed queue for deferred replies, vernacular understanding and summaries |
| Eval | `src/ai/eval/` | 51 end-to-end conversation sets, deterministic and live modes |

---

## 3. A conversation turn, step by step

Implemented in `ConversationsService.sendMessage` and `AiService.generateAndApply`.

1. **Consent gate.** The student must have accepted the current AI disclosure.
2. **Status and rate gates.** Closed conversations are read-only. Per-student rate windows apply.
3. **Language detection** of the message (see §4).
4. **Turn language.** `resolveTurnLanguage`: the detected language; else the
   conversation's last confident language; else the student's preference; else English.
   A confident detection is saved as the conversation's language. A low-confidence
   read (code-switched text) replies in that language for this turn only.
5. **Save the student message** (with its language), so it is stored once.
6. **Build context**: the last messages excluding the current one and excluding
   queued placeholders, the newest messages kept if the budget is tight, and
   each non-English turn tagged with its language (§6).
7. **Prompt** to the model, English-only when the render lane is active.
8. **Generation** via the provider chain (OpenAI, then Groq). If generation
   fails, the **holding lane** runs (§7.3).
9. **Output guardrail**, then **intent engine** on the raw student text. Keyword
   matches are never downgraded by the model.
10. **Verdict execution**: a safeguarding flag (deduplicated per conversation), an
    immediate staff alert for acute flags, scripted safety copy in the turn language,
    approved resource and activity recommendations.
11. **Render** the English reply into the turn language (§4.3). Acute copy is not
    translated; it uses the pre-approved line.
12. **Save the reply** with its language. For non-English turns, queue the
    vernacular understanding job (translation plus a second safety sweep).

---

## 4. Language layer

### 4.1 Detection order (`language-detector.service.ts`)

The first confident signal wins:

| # | Stage | Notes |
|---|---|---|
| 1 | Diacritics | Yoruba `ẹ ọ ṣ ń`, Hausa `ƙ ɓ ɗ`, Igbo `ị ụ ṅ` (`ọ` is shared with Yoruba and not counted alone) |
| 2 | Pidgin markers | Two markers, or one strong marker (`dey`, `wetin`, `wey`, `abeg`, …) in a sentence of 4+ words |
| 3 | Lexicon | Weighted word lists for Yoruba, Hausa and Igbo; the leader must clear a minimum score |
| 4 | Safety keywords | A vernacular safety phrase names its own language |
| 5 | franc (English) | Only for English-looking text. A code-switched read (≥10% local lexicon words) returns the local language at **low** confidence |
| 6 | N-ATLaS identify | Only when all heuristics are silent and the text is at least 8 characters |
| 7 | OpenAI identify | Only when N-ATLaS is unconfigured or fails; same prompt and parser |
| 8 | Fallback | `null`: the conversation's language or the preference is used |

### 4.2 Per-turn rule

Strict priority, implemented in `turn-language.ts`:

1. this message's confident detection, English included;
2. the conversation's last confident language (so `ok` after Hausa stays Hausa);
3. the student's stored preference, only on the first silent turn;
4. English.

### 4.3 Rendering and its checks (`reply-renderer.service.ts`)

The model writes in English. When the turn language is not English, the English
reply is rendered into that language. The lanes are tried in order:
N-ATLaS (`n-atlas-local`), then OpenAI, then the scripted in-language fallback.

A render is **accepted only if** it passes all of these:

- it is not the English reply, and does not contain it (echo, including behind a label);
- it is not more than 2.5× the length of the English reply plus 40 characters;
- no phrase of 4 words appears three or more times (looping);
- it has evidence of the target language: for Pidgin, two markers and no strong
  Yoruba/Hausa/Igbo lexicon reading; for Yoruba, Hausa or Igbo, a diacritic or lexicon word of that language;
- it carries no other local language's exclusive diacritics;
- for Yoruba, Hausa and Igbo, franc does not read it as English.

A leading language label (for example `Nigerian Pidgin reply:`) is stripped.
If no lane produces an accepted render, the student receives a **scripted reply
in their language**, never the English text.

### 4.4 Scripted copy (`scripted-copy.ts`)

Acute safety lines and the holding reply exist in Pidgin, Yoruba, Hausa and
Igbo for the four safety intents (suicidal ideation, self-harm, abuse disclosure,
threat or coercion). Acute copy is **never live-translated**, so a crisis line
does not depend on a translation service.

---

## 5. Safeguarding

### 5.1 Intents and severity

| Intent | Severity | Flag category |
|---|---|---|
| `SUICIDAL_IDEATION` | TIER_3_ACUTE (IMMEDIATE) | Suicidal ideation |
| `SELF_HARM` | TIER_3_ACUTE (IMMEDIATE) | Self-harm |
| `ABUSE_DISCLOSURE` | TIER_3_ACUTE (IMMEDIATE) | Abuse or neglect |
| `THREAT_OR_COERCION` | TIER_3_ACUTE (IMMEDIATE) | Threat or coercion |
| `ACUTE_PANIC` | TIER_2_HIGH (HIGH) | Acute panic |
| `PROLONGED_LOW_MOOD` | TIER_1_MODERATE (MONITOR) | Prolonged low mood |

Labels in the professional-facing summary: MONITOR (TIER_1), HIGH (TIER_2),
IMMEDIATE (TIER_3). The stored severity keeps the TIER names.

### 5.2 Decision rules

- **Server keywords always run**, on the raw student text, with whole-phrase
  matching after normalisation (case, curly apostrophes, diacritics ignored).
- The **model can add a flag but never downgrade** a keyword match.
- Idioms are not flagged ("he will kill me" about a parent, "this homework is killing me").
- Keyword and AI-category matches are severity-locked; a model candidate without
  a rule binding is kept as a triage flag.

### 5.3 What professionals receive

- A **flag record** per conversation (deduplicated while active), with an
  English summary: student and class, the intent, the risk label, the message
  language, matched phrases with their English meaning, the student's message
  (first 180 characters, verbatim), and the actions taken.
- For IMMEDIATE flags, a **notification** to every active professional at the
  student's school and a **support request** in the review queue. Staff alert
  copy is always English, with the verbatim student quote and the language label.

### 5.4 When the model is down

Keyword flags, scripted safety copy and the staff alert all run without the
model. The holding reply is written in the turn language, and the real reply is
queued for the worker.

---

## 6. Context and memory

- **History**: the last 12 messages of the conversation, excluding the current
  student message (sent once, as the current turn) and queued placeholders.
  Newest messages are kept when the character budget (12,000) is tight.
- **Language tags**: non-English turns are tagged, for example `[Hausa] …`.
- **Check-in**: the feeling, intensity and description of the linked check-in.
- **Resources**: up to 8 approved, active resources. The model may only
  recommend a resource from this list; any other id is stripped.
- **Memory**: session summaries (written when a conversation closes) and
  follow-up hooks are carried into later conversations.
- **Open flag**: while a safeguarding flag is open on a conversation, the guided
  directives are replaced by a flag directive.

---

## 7. Providers, fallbacks and the worker

### 7.1 Chain

| Role | Primary | Fallback |
|---|---|---|
| Generation (English reply, summaries) | OpenAI | Groq |
| Language identify | N-ATLaS | OpenAI |
| Render into the turn language | N-ATLaS | scripted line in the turn language |
| Understanding (translation for the second safety sweep) | N-ATLaS | — |
| Voice transcription, Yoruba / Hausa / Igbo | N-ATLaS ASR sidecar | Groq Whisper |
| Voice transcription, English / Pidgin | Groq Whisper | — |

Details of the N-ATLaS integration are in [N-ATLAS Documentation](N-ATLAS-DOCUMENTATION.md).
N-ATLaS is the only translator and the only renderer; OpenAI reasons and, as the
last resort of the language-ID stage, identifies. A render that is unavailable or
rejected ships the scripted line, so no turn is ever blocked on it.

### 7.2 Budgets

Timeouts are set per call: N-ATLaS identify 4 s (`NATLAS_IDENTIFY_TIMEOUT_MS`),
N-ATLaS render 12 s (`NATLAS_RENDER_TIMEOUT_MS`), N-ATLaS understanding
(translation) 10 s (`NATLAS_TRANSLATE_TIMEOUT_MS`). Generation's first synchronous attempt
has a 20 s budget before the reply is queued.

### 7.3 Holding lane and worker

If generation fails, the student gets an immediate holding reply in their
language. Acute safeguarding still runs on the message (flag, staff alert and
scripted safety line). The real reply is queued as an `AiGenerationJob` and the
worker writes it into the message later.

The worker also runs `VERNACULAR` jobs (understanding and the second safety
sweep) and `SUMMARY` jobs (session summaries on close). Stale claims are
reclaimed, and failures are retried with backoff.

---

## 8. Data model (main tables)

| Model | Purpose |
|---|---|
| `School`, `User`, `StudentProfile`, `ProfessionalProfile` | Tenancy, accounts, roles |
| `Conversation` | One AI chat; `language` is the last confident language |
| `ConversationMessage` | Turns; `language` per turn; `aiPayload` holds the structured reply and notes |
| `AiGenerationJob` | Deferred replies, vernacular understanding and summaries |
| `SupportFlag` | Safeguarding flag: intent, severity, status, summary, source |
| `SupportRequest` | Human-support request and staff review tray |
| `Notification` | Per-user feed (acute alerts, chat requests) |
| `AuditLog` | Sensitive-event trail (flags, alerts, language refinements) |
| `AiUsageDaily` | Daily provider usage and estimated cost |
| `SessionSummary` | Summary written on close, feeding memory |
| `WellbeingResource`, `WellbeingActivity` | Approved catalogue |

Migrations live in `prisma/migrations/`. The two most recent add the conversation
language and the per-message language columns. The memory migration needs the
`vector` extension (pgvector).

---

## 9. API reference (selected)

All routes are under `/api/`. Responses use the envelope
`{ success, statusCode, message, data, path, timestamp }`. Authentication is
cookie-based (Better Auth). The full OpenAPI document is served at `/api/docs`.

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/v1/ai/config` | Current AI configuration (non-secret) |
| POST | `/api/v1/ai/transcribe` | Voice note transcription (routed by language) |
| GET | `/api/v1/ai/disclosure/status` | AI disclosure acceptance status |
| POST | `/api/v1/ai/disclosure/acknowledge` | Accept the AI disclosure |
| POST | `/api/v1/conversations` | Start a conversation |
| GET | `/api/v1/conversations` | List the student's conversations |
| GET | `/api/v1/conversations/:id` | One conversation with messages |
| POST | `/api/v1/conversations/:id/messages` | Send a message (returns the reply and any language offer) |
| POST | `/api/v1/conversations/:id/close` | Close and queue the summary |
| POST | `/api/v1/check-ins` | Emotional check-in (Journey step 1) |
| GET | `/api/v1/support-requests/queue` | Staff review queue |
| POST | `/api/v1/support-requests` | Ask for a human |
| GET | `/api/v1/support-flags` | Safeguarding flags (professionals) |
| POST | `/api/v1/support-flags/:id/acknowledge` | Acknowledge a flag |
| POST | `/api/v1/support-flags/:id/in-review` | Mark a flag under review |
| GET | `/api/v1/notifications` | Notification feed |
| GET | `/api/v1/dashboard/counsellor` | Counsellor review aggregates |

---

## 10. Setup and running

### 10.1 Requirements

- Node.js (the project is developed and tested on Node 24; the package does not declare a minimum), npm
- PostgreSQL 17 with the pgvector extension (see `docs/DEPLOYMENT.md`; the image `pgvector/pgvector:pg17`)
- SMTP credentials (verification and reset emails)
- Optional: N-ATLaS endpoint, OpenAI and Groq keys, the ASR sidecar

### 10.2 Install and configure

```bash
npm install
cp .env.example .env          # then edit: DATABASE_URL, BETTER_AUTH_URL, SMTP_*, MAIL_FROM
```

Key variables (full list in `.env.example`):

| Variable | Purpose |
|---|---|
| `DATABASE_URL` | PostgreSQL connection string |
| `BETTER_AUTH_URL`, `ALLOWED_ORIGINS` | Auth base URL and CORS origins |
| `OPENAI_API_KEY`, `OPENAI_CHAT_MODEL` | Generation and fallback |
| `GROQ_API_KEY`, `GROQ_CHAT_MODEL` | Generation fallback and Whisper |
| `AI_PROVIDER_CHAIN` | Generation order, default `openai,groq` |
| `AI_VERNACULAR_REPLY_MODE` | `n-atlas-translate` (default) or `openai-native` |
| `NATLAS_LLM_BASE_URL`, `NATLAS_LLM_API_KEY`, `NATLAS_LLM_MODEL` | N-ATLaS endpoint, key and model |
| `NATLAS_RENDER_TIMEOUT_MS`, `NATLAS_IDENTIFY_TIMEOUT_MS` | Latency budgets |
| `NATLAS_ASR_BASE_URL` | Sidecar URL for Yoruba, Hausa and Igbo voice notes |
| `AI_CONTEXT_MESSAGE_LIMIT`, `AI_CONTEXT_CHARACTER_LIMIT` | History budget |
| `STAFF_BOOTSTRAP_KEY` | Enrolment key for staff (leave empty in shared environments) |

### 10.3 Database

```bash
npx prisma generate --config prisma7.config.ts
npx prisma migrate deploy --config prisma7.config.ts   # production
npx prisma migrate dev --config prisma7.config.ts      # development
npm run seed                                            # approved resources and trusted support people
```

### 10.4 Run

```bash
npm run build
npm run start:prod            # node dist/main.js
# development: npm run start:dev
```

The API listens on `PORT` (default 3000). Swagger UI is at `/api/docs`.

### 10.5 ASR sidecar (optional)

```bash
cd services/n-atlas-asr
python -m venv .venv && . .venv/bin/activate
pip install -r requirements.txt
export HF_TOKEN=hf_...          # NCAIR1 repositories are gated
uvicorn app:app --host 127.0.0.1 --port 8100
```

Set `NATLAS_ASR_BASE_URL=http://127.0.0.1:8100` in the backend environment.

---

## 11. Usage examples

### 11.1 Send a message

```http
POST /api/v1/conversations/{id}/messages
Content-Type: application/json

{ "content": "Ina jin kamar in kashe kaina" }
```

The reply is in Hausa. The response includes the stored assistant message, a
`languageOffer` when the message language differs from the student's preference,
and the `aiPending` flag when the reply was queued.

### 11.2 Read the AI configuration

```http
GET /api/v1/ai/config
```

Returns the non-secret configuration: prompt version, models, chain order,
language and timeout settings, and the registered intents.

---

## 12. Testing and evaluation

| Suite | Command | What it covers |
|---|---|---|
| Unit and integration | `npx vitest run` | About 1,325 tests across 63 files, including the language, intent, context, renderer and conversation layers |
| Conversation eval (stub) | `npx vitest run src/ai/eval` | 51 multi-turn sets through the real pipeline; N-ATLaS and OpenAI simulated |
| Conversation eval (live) | `NATLAS_LIVE=1 npx vitest run src/ai/eval --testTimeout=300000` | Same sets with the real N-ATLaS endpoint for identify and render |
| Lint | `npx oxlint src/ai src/conversations` | Static checks |
| Types | `npx tsc -p tsconfig.json --noEmit` | Type checks (spec files have pre-existing type issues) |

**Known status.** In stub mode, 50 of 51 sets pass. ES-16 (a two-word Hausa
greeting) is a known gap: the lexicon threshold is not met. In live mode the
results depend on the endpoint; see [N-ATLAS Documentation §6](N-ATLAS-DOCUMENTATION.md#6-evidence) for the measured results and known failure modes.

---

## 13. Operations

- **Logs.** Provider failures and fallbacks are logged as warnings. The usage meter records token counts and estimated cost per provider per day (`AiUsageDaily`).
- **Budgets.** `OPENAI_DAILY_REQUEST_CAP` moves generation to Groq once the day's cap is reached.
- **Holding reply and safety copy.** Override the English holding copy with `AI_ASYNC_HOLDING_MESSAGE`. Local-language copy is in code and goes through review before change.
- **Audit.** Flags, alerts, language refinements and sensitive reads are written to `AuditLog`.

---

## 14. Limitations and open items

- **Clinical review pending.** Local-language crisis lines and vocabulary need native-speaker and clinical sign-off.
- **Real-world validation pending.** No evaluation with real students has been run yet.
- **Short Hausa greetings.** Two-word greetings are not detected as Hausa.
- **Local-language rendering quality.** N-ATLaS renders are checked, but a render that passes the checks can still be imperfect. Scripted fallbacks cover failures.
- **Model dependence.** Generation depends on OpenAI or Groq. Safeguarding does not, but the conversational reply does.

---

## 15. Repository layout

```
src/                 application code (see §2.1)
prisma/              schema, migrations, seed
services/n-atlas-asr ASR sidecar (Python, FastAPI)
test/                manual probes and e2e scripts
docs/                this document, N-ATLAS documentation, handoff, deployment, monitoring
```

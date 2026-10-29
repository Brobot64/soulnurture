# Natlas Phase C — AI Provider Chain + Guardrails + Activities + Session Memory + **N-ATLaS Vernacular Layer** (the showcase)

> This document mirrors the approved implementation plan (source: `~/.commandcode/plans/natlas-phase-c-openai-chain-activities-memory.md`). It is the working contract for Phase C.

Inputs: user requirements + OpenAI NGO guide + plan-review comment: **N-ATLaS is a flagship to showcase — the system must understand Nigerians in Yoruba/Hausa/Igbo/Pidgin (typed or spoken), ask about language preference once, use N-ATLaS to understand context, let OpenAI/Groq do the heavy reasoning/recommendations, and reply in the user's language. Session context persists.**

Decisions (user): **pgvector** (not Chroma) · **guide posture** (OpenAI primary, hard $20/mo, ~20 msgs/student/day, capped outputs, Groq fallback) · **capacity hard-verified via load probe** (50 launch users is reality; 500 the integrity design) · **explicit close + idle auto-close** for sessions · **OpenAI replies natively in the user's language in the realtime turn** (N-ATLaS does the async understanding/localisation work) · **N-ATLaS ASR sidecar added now** for vernacular voice.

---

## Flow review (user's proposed pipeline — optimized)

Proposed: vernacular input → N-ATLaS understands → first-time language ask → OpenAI refines context/recommends/acts → response returns in the user's language → context saved.

What I changed and why (the flaws identified):

1. **"N-ATLaS understands his context" synchronously is a latency trap.** On the 12GB CPU-only VPS, an 8B model generates ~5–10 tok/s: a per-message translate+understand call costs **15–40s inline** — unusable in chat. Fix: realtime understanding comes for free from three cheap layers — (a) language detection in milliseconds (`franc` + wordlists), (b) **vernacular crisis keyword packs** added to the server-side intent floor (safety coverage in-language, invisible to the old English-only keywords), and (c) the primary chain (gpt-5.6-class reads multilingual input directly). N-ATLaS then runs **async** (the existing DB-queue worker, where latency irrelevant) per vernacular message: English translation + tone → persisted in `aiPayload.understanding` → **intent engine re-runs on the translation as a second safety pass** — closes a real false-negative hole: the old keyword layer NEVER saw vernacular content end-to-end.
2. **"Get the response back in Yoruba" has two honest paths.** Async N-ATLaS translation per message would deliver ~20–60s replies — heavy on chat UX. Chosen: **OpenAI reasons and replies natively in-language in the realtime turn** (prompt-directed, no extra hop), while N-ATLaS localizes the **session-summary follow-up hook** (native-quality "How did the exam go?" next time the student opens the app) — the most culturally sensitive moment gets native N-ATLaS output, turns stay fast. An `AI_VERNACULAR_REPLY_MODE='n-atlas-translate'` switch is documented (not built) for after-pilot comparison.
3. **"First-time ask if he prefers Yoruba"**: zero-AI-cost mechanism — detection result rides the response as `languageOffer` metadata; the frontend shows the preference chip and calls the EXISTING `PATCH /api/v1/students/me {preferredLanguage}`. No prompt gymnastics, no ambiguity.
4. **Voice is two pipelines**: spoken Yoruba/Hausa/Igbo → **N-ATLaS ASR sidecar** (Python, lazy-loaded, ~1–2 GB RAM) — the flagship demo; spoken English → free Groq Whisper. At the 50-user launch this is comfortable; at a 500-voiced-burst the vernacular path queues and degrades honestly (the deployment doc states the cap — language ASR is the CPU-bound frontier. Text vernacular is unlimited).
5. **Context saving**: unchanged — plus translations now enrich it (summaries learn from `understanding`, and hooks localize).

### The showcase — three demoable moments
1. Student **types** "mo ti eat a ru fun ọ̀nà ọ̀run mi" (any Yoruba wording) → detected, asked once about preference → AI answers in flowing Yoruba within ~6s.
2. Student **speaks Yoruba** → N-ATLaS ASR → same native conversation.
3. Student returns a day later → greeted with a **native-language follow-up hook** (N-ATLaS-localized from the saved summary): "Báwo ni ọ́gọ́rọ́ iyàrá iṣẹ́ ọ̀nà rẹ?"

---

## Phase A — Provider chain: OpenAI primary → Groq fallback (+N-ATLaS head)

- `AI_PROVIDER` token resolves to a **`ChainedAiProvider`** (`src/ai/providers/chain.provider.ts`): delegates ordered from env `AI_PROVIDER_CHAIN=openai,groq` (comma-separated; `n-atlas` appendable later); try order → catch `AiGenerationError` → next → exhausted → throw (the existing async queue takes over). Records the serving provider in `usage.provider` (explainability + `GET /api/v1/ai/config`).
- **`src/ai/providers/openai/openai.provider.ts`** (fetch, mirrors the Groq provider discipline): `POST /v1/chat/completions` with `response_format: { type: 'json_schema', json_schema: { name:'ai_generation_result', strict:true } }` built via `zod-to-json-schema` from the Zod contract minus server-owned keys (`usage` etc.); attempt budget 20s; errors/timeouts/429 → `AiGenerationError` → chain falls over. `OPENAI_CHAT_MODEL` default `gpt-5.6-luna` (per the guide). No `temperature` unless explicitly set (reasoning models may reject it).
- **Embeddings** (`AI_EMBEDDING_PROVIDER`): OpenAI `text-embedding-3-small` (1536d, cents); failure → memory degrades to recency-only (no throw).
- **Budget meter**: `AiUsageDaily` (day × provider unique; requests, in/out tokens, `estimatedUsdCents`) upserted per generation. App-side daily cap `OPENAI_DAILY_REQUEST_CAP` (default 400): crossed → chain starts at Groq for the rest of the day + audit `ai_budget.paused`. Ops side (deployment doc): OpenAI org/project **hard spend limit $20 + alert at 80%**.

## Phase B — Strict, configurable guardrails

`src/ai/guardrails/guardrails.config.ts` (single declarative reviewer surface) + `guardrail.service.ts`:

- **input**: `maxMessageChars=1200` (guide) with truncation + note; `injectionPatterns[]` (model-override probes) → one-line prompt hardening + aiPayload note;
- **output**: `bannedClaims[]` (diagnosis / medication advice / safety-promises / certification claims) → severe matches replace the reply with scripted copy, soft matches strip the sentence; `maxReplyChars=700`;
- **rate**: `perStudentDaily=120` (`AI_RATE_LIMIT_DAILY`), `perStudentPerMinute=6`, exceeded → 429 envelope; **the human-support pathway always stays reachable** (the gate guards only AI messages);
- **budget**: `openaiDailyRequestCap` (see Phase A).
- Wiring order: gate → validate → **filterOutput** → intent engine → resource whitelist (server safety layer still overrides guardrails).
- **Eval corpus** (guide §evaluate-safety): `src/ai/guardrails/__fixtures__/eval-set.ts` — 20 normal / 20 boundary (therapy/diagnosis/dependence) / 20 crisis / 10 privacy probes; specs assert crisis recall (INTENTS, unchanged), boundary enforcement on canned violating outputs (proving our filters, not model luck), privacy probesnotes.

## Phase C — N-ATLaS vernacular language layer (the flagship)

`src/ai/language/` + `services/n-atlas-asr/`:

1. **`language.config.ts`** — canonical languages `en | pcm | yo | ha | ig` (Pidgin included: N-ATLaS trained on BBC Pidgin), display names, franc hints (yor/haa/ibo), pcm bag-of-words, `AI_LANGUAGE_OFFER_ENABLED=true`.
2. **Realtime detection** (`language-detector.service.ts`): `franc` (new dep, free/offline/ms-fast) + custom pcm wordlist + diacritics heuristics → `{lang, confidence}`; **no local LLM in the realtime lane** (latency law). Ambiguous text → treat as current preference (offer UI avoids hard claims).
3. **Vernacular keyword floor** (`src/ai/intents/vernacular-keywords.ts`): Yoruba/Hausa/Igbo/Pidgin starter keyword sets for suicidality/self-harm/panic/prolonged-low-mood, each term canned with an English gloss, clearly marked **pending clinical review** (ships in the reviewer packet). `intents.config` merges the packs into `serverSignals.keywords` so the keyword layer covers ALL user languages from day one.
4. **Async understanding** (worker, `AiJobKind.VernacularRefine` — enum `REPLY|SUMMARY|VERNACULAR`): for messages detected non-English, N-ATLaS (local Ollama, free; fallback OpenAI translate on dev/when local down — translation chain `n-atlas-local,openai`) produces `{englishTranslation, tone, keyFacts[]}` (strict small JSON, ≤120 tokens) → stored `aiPayload.understanding` → intent engine re-evaluates the translation → **language-refine escalation**: a missed crisis phrase becomes an `AI_CANDIDATE`/second-pass flag + audit `safety_flag.lang_refine`.
5. **Native replies (realtime)**: the system prompt's `Language:` line becomes `{name} — REPLY FULLY in {name}` + "natural, culturally grounded {language} (never machine-literal)" + "keep the student's vocabulary"; the raw vernacular message is sent as-is alongside the English directives (chain members read multilingual input directly). `AI_VERNACULAR_REPLY_MODE='openai-native'` (built) vs `'n-atlas-translate'` (pre-wired, post-pilot only).
6. **First-time language ask**: response metadata `languageOffer: {detected, current}` when preference is `'en'` and detection flags a vernacular language; frontend chip → `PATCH /api/v1/students/me {preferredLanguage:'yo'}` (UpdateStudentDto value list updated to the canonical set; audited via existing pipeline).
7. **Voice**: `services/n-atlas-asr/` (in-repo Python sidecar; systemd/uvicorn per the deployment doc): FastAPI `POST /transcribe` (multipart, `lang=yo|ha|ig`) → `{text, duration}`; `/health`; per-language **lazy load + idle unload** (RAM discipline). **Spike first task**: enumerate `NCAIR1` org ASR model repos (4 models on HF; exact names/paths + gates) + a 10s fixture per language. Node side: `NAtlasAsrProvider` — `POST /api/v1/ai/transcribe` routes by `preferredLanguage` (English → Groq Whisper; vernacular → local sidecar; sidecar down → friendly "type it instead" degradation). Client may force `language`.
8. **Latency budget (realtime lane)**: detection <100ms · vernacular ASR ≤3s (local) / English ASR ≤2s (remote) · intent eval <5ms · context/memory fetch ≤50ms · chain reply 2–6s · guardrail filters <5ms → **≤ ~8s end-to-end vernacular turns**.

## Phase D — Activities: backend-orchestrated emotional support activities

Backend **records and orchestrates**, frontend renders.

```prisma
model WellbeingActivity { id, slug @unique, title, description, category ResourceCategory,
  steps Json,                       // renderer contract: breath-pacing | timer | prompt-list | body-scan
  durationSeconds Int, active Boolean @default(true), approved Boolean @default(false),
  tags String[], createdAt, updatedAt }
model ActivitySession { id, studentId, activityId, conversationId?, intentId?, recommendedBy String?,
  startedAt DateTime @default(now()), completedAt DateTime?, feelingAfter FeelingLabel?, noteAfter VarChar(500)?,
  @@index([studentId, startedAt]) }
```

- `GET /api/v1/activities` (+`?category=`), `GET /:slug` — active+approved only;
- `POST /api/v1/activities/:slug/sessions` `{conversationId?, intentId?}` → opens session, returns full renderer `steps`; 404 on inactive/unapproved;
- `PATCH /api/v1/activity-sessions/:id` `{feelingAfter, noteAfter?}` — owner-only, idempotent completion → **feel-after data**;
- `GET /api/v1/activities/me/sessions` — history;
- `src/ai/activities/activities.config.ts` — reviewer-readable starter catalog: box-breathing, 478-breathing, five-senses-grounding (5-4-3-2-1), mindful-body-scan, thought-recap, worry-slot (all approved, tagged);
- intents gain `RECOMMEND_ACTIVITY` (ACUTE_PANIC → box-breathing; PROLONGED_LOW_MOOD → thought-recap/body-scan; SUICIDAL/SELF_HARM → five-senses-grounding); new executor validates slug against the approved catalogue; conversation response gains `recommendedActivity` (parallel to `recommendedResource` — resources ≠ activities).

## Phase E — Session summaries → pgvector memory → follow-up carry-over

```prisma
enum AiJobKind { REPLY SUMMARY VERNACULAR }        // AiGenerationJob.kind @default(REPLY)
model SessionSummary { id, studentId, conversationId, summary VarChar(400), topics String[],
  followUpHook VarChar(140)?, emotionalTrend String?,
  summaryLocalized String?, followUpHookLocalized String?,
  embedding Unsupported("vector(1536)")?,          // pgvector, raw-SQL owned
  createdAt, @@index([studentId, createdAt]) }
```

- `AiService.summarizeConversation(...)` — primary chain (small JSON, ≤200 tokens): `{summary ≤400, topics ≤6 canonical (exam/family/friendship/money/health/sleep/loneliness/bullying/identity/other), followUpHook ≤140, emotionalTrend CALMER|HEAVIER|UNCHANGED}` → Zod + guardrail filter (low-sensitivity rule: no diagnoses, no secrets, no verbatim trauma) → persist. Vernacular conversations summaries consume `aiPayload.understanding` (translations).
- Triggers: `POST /api/v1/conversations/:id/close` (student → CLOSED + SUMMARY job) and **worker idle-scan** — conversations ACTIVE with `updatedAt < NOW() - idleMinutes` (`AI_SESSION_IDLE_MINUTES=3`, i.e. the check-in expires 180 s after the student's last message) and no summary → close + enqueue (batch 10/scan). Both triggers push `conversation.closed` on the student's realtime socket; a check-in has no turn cap, so that push is what ends a live chat.
- **Language integration**: when the student's preferred language is vernacular, **N-ATLaS localizes summary + hook** (`summaryLocalized`, `followUpHookLocalized` — one cheap async call per session) → the carry-over prompt block + `carriedContext` use them on the student's next session (showcase moment 3).
- **Memory** (`src/ai/memory/memory.repository.ts` — the raw-SQL owner of everything pgvector): recency (last 2 summaries/30d) + pending hooks (14d) + **vector top-2** (embed current message; cosine ≥ 0.8, 30d); embedding failures degrade to recency-only (graceful, tested). Migration pair `phase_c_memory`: `CREATE EXTENSION vector` + vector DDL.

## Phase F — Concurrency: 50 real now, 500 designed + verified

- Per-student daily/minute gates (Phase B) + Prisma pool (`connection_limit=25`) + nginx `limit_req`/`worker_connections` in the deployment doc.
- Worker discipline: OpenAI/Groq are remote; Ollama stays `num_parallel=1`, batch 5 — the queue absorbs bursts.
- **`test/load-probe.mjs`** (`npm run verify:load`, `LOAD_USERS=100|500`, `LOAD_SECONDS=60`, `AI_LOAD_MOCK=1`): pre-seed synthetic students via SQL (cleaned after), simulate text journeys at a controlled arrival rate through the REAL nginx→Fastify→Postgres stack with a `mock` chain head (canned valid AI JSON, zero AI spend — proves server capacity, not OpenAI's). Assert error rate < 0.5%, p95 < 1.5s; print report table → the "500 verified" claim.
- ASR concurrency honesty: vernacular voice ≈ 2–4 parallel streams on this box — queue + degrade (documented).

## Phase G — E2E + docs

- `test/e2e-journey.mjs` new acts: **vernacular** (Jude types Yoruba → `languageOffer` → PATCH preference → next turn language-directed via aiPayload → VERNACULAR job processed → `aiPayload.understanding.englishTranslation` present; dev-without-Ollama → translation falls to OpenAI — both paths accepted); **voice** (env-gated when `NATLAS_ASR_BASE_URL` reachable: 1s wav fixture → transcript sane); **activities** (catalog → start → complete → history); **summary carry-over** (close → summary → next conversation carries the localized hook for vernacular preference); **rate-limit** (429 after low cap; human pathway still 200); **chain failover**.
- `README.md`: AI chain, guardrails, activities, language showcase flow + memory, sidecar dev instructions. `docs/DEPLOYMENT.md`: sidecar deployment (systemd unit; 12GB RAM budget: model 5–6GB + ASR lazy 1–2GB + pg 1.5GB + obs ~1.5GB), pgvector image swap (`pgvector/pgvector:pg17`) + extension migration, OpenAI outbound + spend-cap Grafana panel (`estimatedUsdCents/day` via postgres-exporter), nginx burst-limits, N-ATLaS license/attribution reminder.

---

## Files

- **New**: `src/ai/language/{language.config.ts, language-detector.service.ts}`, `src/ai/intents/vernacular-keywords.ts`, `services/n-atlas-asr/{app.py, requirements.txt, README.md}`, `src/ai/providers/openai/openai.provider.ts`, `src/ai/providers/chain.provider.ts`, `src/ai/providers/natlas/{natlas.provider.ts (ASR client), natlas-llm.provider.ts (local Ollama)}`, `src/ai/providers/embedding/embedding.provider.ts`, `src/ai/guardrails/{guardrails.config.ts, guardrail.service.ts, __fixtures__/eval-set.ts}`, `src/ai/memory/memory.repository.ts`, `src/ai/activities/activities.config.ts`, `src/activities/{controller, service, dto}`, `test/load-probe.mjs`; specs: detection, chain, openai, embedding, guardrails, memory, summarize + SUMMARY worker branch, vernacular refine worker branch, activities service + executor, ASR provider (fetch-mocked).
- **Edited**: `ai.config.ts` (chain/openai/price/guardrails/language blocks), `ai.module.ts`, `ai.service.ts` (filterOutput + language prompt + summarize + understanding), `ai-worker.service.ts` (SUMMARY + VERNACULAR branches + idle scan), `intents.config.ts` (keyword packs + RECOMMEND_ACTIVITY + canonical topics), `intent-executors.ts` (+RECOMMEND_ACTIVITY), `ai-context.service.ts` (memory + localized carry-over), `conversations.{controller,service}.ts` (gate, close, carriedContext, recommendedActivity, languageOffer), `students/dto/update-student.dto.ts` (canonical language validation), `prisma/schema.prisma` (+AiUsageDaily, WellbeingActivity, ActivitySession, SessionSummary, +language on ConversationMessage, +AiJobKind), migrations `phase_c_*` (+vector extension), `.env/.env.example`, `package.json` (franc, zod-to-json-schema, verify:load script), `README.md`, `docs/DEPLOYMENT.md`.

## Implementation order

1. Chain + OpenAI + usage/budget + specs → 2. Guardrails + eval corpus + wiring → 3. pgvector spike → SessionSummary/close/idle/worker-SUMMARY + memory → **4. Language layer: detection + keyword packs + prompt language + VERNACULAR worker branch + languageOffer** → 5. ASR sidecar spike (org enumeration) + provider routing → 6. Activity modules + executor + seed → 7. Localized summary hooks → 8. Load probe + concurrency tuning docs → 9. README/DEPLOYMENT updates + E2E extension + full green rounds.

## Verification

1. `npm run build` clean; `npm run lint` 0 issues; `npm run test` green (111 existing + new suites + eval-set incl. all 4 vernacular languages).
2. `npm run test:e2e:journey` ×2 idempotent — new acts green.
3. `npm run verify:load` at 100 and 500 virtual users (mock AI) — printed p95/error budgets pass.
4. Chain failover + budget-pause drills green; showcase-moment smoke for all three demoable moments.
5. Cost sanity: pilot-month estimate ≤ $20 — a full month of pilot usage fits within the org cap (Grafana panel math shown).
6. Clinical packet v2 printout: intents (incl. vernacular keywords w/ glosses), guardrails config, eval-set results — reviewer sign-off before launch.

## Parked (unchanged + additions)

Referral board (claim/transfer) · professional conversation viewer · activity-effectiveness aggregation (feeling-before/after dashboard) · `n-atlas-translate` realtime reply mode (post-pilot decision, config pre-wired) · N-ATLaS LLM as the primary realtime reasoner (revisit after GPU/reality changes).

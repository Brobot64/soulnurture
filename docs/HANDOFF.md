# Natlas — Agent / Developer Handoff Document

> **Purpose**: a cold-takeover brain for whoever picks this work up next — a human developer or an AI agent. It captures what the system is, everything that happened in the build-up session, *why* every decision was made (including the debugging thought-processes), the exact current state, the traps that will bite you, and the ordered next actions. Product/ops docs live elsewhere; this file is the **working memory**.

---

## 1. Who we are building (30-second orientation)

**Soul Nurture AI (repo: `natlas`, project codename "Natlas")** — a school-based emotional-wellbeing backend for an NGO (PN Africa context), in week 3–4 of an 8-week MVP. Students (e.g. "Jude", 300-level Sociology at Miva University, Nigeria) walk a **4-step journey**: Check-in → Reflect (AI conversation) → Resources → Human Support. Professionals (counsellors/psychologists/support staff) triage via a dashboard: safeguarding flags **with reasons**, support requests, follow-ups, audit trail.

Strategic positioning:
- **N-ATLaS** (Awarri Technologies / NCAIR / Federal Ministry — the Llama-3-8B multilingual Nigerian model family: 1 LLM + 4 ASR models for Yoruba/Hausa/Igbo/Nigerian-accented English) is the **flagship showcase and the language layer** — NOT the primary reasoner. NGN-language comprehension is the differentiator.
- **OpenAI + Groq** do the heavy realime reasoning/recommendations ( ngo cost discipline: hard $20/mo org cap per the OpenAI NGO guide).
- The AI is **never trusted**: Zod-validated structured output, resource whitelist, server-side intent keyword layers (incl. vernacular packs), scripted safety messages, human escalation — defense-in-depth is a house rule.
- The system targets ~50 real waitlist users at launch; is integrity-**designed for 500 concurrent** (load-probe verified), on a **12GB RAM / 6 vCPU / no-GPU Contabo VPS**. NGO budget: free/cheap; self-hosted N-ATLaS runs quantized on CPU (async/vernacular only).

Key references (read in this order when resuming):
1. `README.md` — product + stack + endpoints current state
2. `docs/PHASE-C-PLAN.md` — the **approved, paused** Phase C plan (OpenAI chain + guardrails + activities + memory + N-ATLaS language layer)
3. `docs/DEPLOYMENT.md` — VPS production runbook (security/Postgres/MinIO/observability/Ollama)
4. `src/ai/intents/intents.config.ts` — safeguarding rules (the clinical reviewer's file)
5. `~/.commandcode/plans/natlas-phase-b-intent-engine-async-ai.md` + `...-openai-chain-activities-memory.md` — canonical plans (Phase B done; Phase C paused at Step 1)
6. `C:\Users\USER\Downloads\Soul_Nurture_AI_Design_Dev_Coordination_Report_Week3.pdf` — PM coordination report (MoSCoW scope, sprint plan, Sprint-1 checkpoint end of week 4)

---

## 2. Decision ledger (what was decided, by whom, and the why)

| # | Decision | Rationale / note |
|---|---|---|
| D1 | NestJS 12 + Fastify + Prisma 7/Postgres + Better Auth + Zod + vitest + oxlint | predates session; stable |
| D2 | Self sign-up always `STUDENT` (Better Auth `role` field `input:false`) | role-based access is release-critical (report §9) |
| D3 | First-staff entry = secret-gated `POST /api/v1/staff/bootstrap` (`STAFF_BOOTSTRAP_KEY`, staff roles only, hashed credential account, Better Auth verification flow) | open role-pickers are an RBAC hole; chicken-and-egg for the first professional; audited |
| D4 | Intent engine replaces `SafetyPolicyService`: declarative `intents.config.ts`, server-keyword layer authoritative, model only confirms/escalates | "highly configurable in my code", explainable, clinical-reviewer-facing; SUPPORT_FLAG executor finally persists flags (pre-existing gap: `supportFlag.create` was called NOWHERE — dashboard was dead) |
| D5 | Async AI: in-app **DB queue** (AiGenerationJob), DB-clock scheduling, worker rewrites placeholder messages in place | user chose over Redis/BullMQ; restart-safe; window-close-independent; scheduling MUST use DB NOW() (see trap T5) |
| D6 | AI config = single file `src/ai/config/ai.config.ts` (non-secret) + `GET /api/v1/ai/config` | user's "clear, concise, very explainable" requirement; clinical packet surface |
| D7 | Phase C decisions (user): **pgvector** (not Chroma — zero extra services on 12GB box), OpenAI primary/Groq fallback with **$20/mo hard cap** + ~20 msgs/student/day, capacity **verified via load probe now**, session end = **explicit close + 2h idle auto-close**, OpenAI **replies natively in-language in realtime** with N-ATLaS working async (understanding + localized summary hooks), **N-ATLaS ASR sidecar approved** for vernacular voice | see `docs/PHASE-C-PLAN.md` flow-review section for full reasoning |
| D8 | Vernacular pipeline optimization (agent design, user-informed): realtime = franc detection + vernacular keyword packs + chain reading multilingual input; N-ATLaS = async translation/understanding + second safety pass + hook localization | synchronous 8B-on-CPU = 15–40s/message latency trap; async lane already exists (worker) so understanding lands later, safely |
| D9 | E2E verification links in dev via `GET /api/verification/dev-links/:email` (production turns it off) | Better Auth 1.7 verification tokens are JWTs existing ONLY inside the emailed link; server stdout unclear in harness; inbox scraping avoided |
| D10 | Parked (post-MVP): referral board (claim/transfer + student visibility — **decision recorded: claim hides from board, student sees assigned professional, everything audited**), activities effectiveness aggregation, professional conversation viewer, `n-atlas-translate` realtime mode, N-ATLaS as primary reasoner | user's phased-scope choice; opens as separate plan |
| D11 | Deployment: Docker Compose for stateful infra (pg/minio/prom/grafana/loki/exporters) + native systemd for Node + Ollama; everything but nginx on 127.0.0.1 | 12GB budget discipline; documented in `docs/DEPLOYMENT.md` |

---

## 3. The debugging stories (thought-processes worth keeping)

These were real walls solved in the build-up session. If you touch auth, scheduling, models, or the E2E journey, read the relevant story first.

### S1 — "AI says it can't understand me" (user's first complaint)
**Symptom**: every manual AI test returned canned filler. **Trace**: `GROQ_API_KEY=""` in `.env.local` explained a stub, but a REAL key existed in `.env`... → the true cause was **`GROQ_MAX_OUTPUT_TOKENS=400`**: gpt-oss-20b is a reasoning model — thinking budget consumed before JSON; truncated `json_object` → `JSON.parse` fail/un-validated → provider swallowed → canned fallback. **Fix**: bump to 1000; and later, the provider no longer swallows errors at all (throws `AiGenerationError` → async retry lane). Lesson: with reasoning models, token budget is a FIRST-CLASS config item; `ai.config.ts` documents it.

### S2 — Better Auth 1.7 email verification is a JWT, not a table row
Hand-built `Verification` rows failed with `INVALID_TOKEN` (401). Read `node_modules/better-auth/dist/api/routes/email-verification.mjs`: tokens are **HS256 JWTs signed with BETTER_AUTH_SECRET**; the `verification` table is not consulted for this flow in v1.7. **Fix**: verification always via Better Auth itself — `AuthService.resendVerificationEmail()` (internal `sendVerificationEmail` API → JWT + configured mail hook). For E2E, dev-only links endpoint (D9). Lesson: never hand-craft Better Auth's protocol artifacts; go through `auth.service.ts` wrappers.

### S3 — Provisioned staff could never sign in
`POST /api/v1/users` (pre-existing) stored **plaintext** passwords. Fix: `hashPassword` from `better-auth/crypto`... and STILL 401s. Second discovery: Better Auth credential lookup expects **`providerId='credential'` + `accountId=<user id>`** (verified empirically: read `account` rows — a REAL signup wrote `credential`+uuid; our rows said `email`+email-address). **Fix** in both `provisionAdmin` + `bootstrapStaff`: user row created first, then `account.create({providerId:'credential', accountId: user.id, password: hash})`. Lesson: when fighting a provider SDK, print its own rows and reverse its conventions.

### S4 — RolesGuard 403 "Role not resolvable" while `/users/me` showed the role
Guard-time `request.user = null` ⇒ **the library's auth guard ran AFTER our `RolesGuard`** (registration-order assumption was wrong). Fix: `RolesGuard` is now **self-sufficient** — when `req.session?.user` is absent, it resolves the session itself via `AuthService.getSession(new Headers(req.headers))` (401 if unresolvable), caches on the request, then enforces roles. Lesson: multi-guard ordering in this stack is NOT guaranteed; don't rely on "another guard ran first".

### S5 — The one-hour clock skew (the worker never retried)
Queued jobs stayed PAST-due-but-never-claimed: pg reported `NOW()` one hour behind node (`07:27Z` vs `08:27Z` on the SAME machine), and Prisma's `DateTime` maps to **naive `timestamp(3)`** — round trips shift instants depending on which clock family writes/reads. **Fix (architectural, keep forever)**: the worker's due/retry math uses **Postgres's own `NOW()` + `interval` arithmetic via raw SQL** (`$queryRaw`/`$executeRaw`), never JS `Date` for scheduling. CLIringing note: display timestamps remain relative-to-schema defaults fine; only DURATION math is protected.

### S6 — Mock introspection of tagged templates
Worker tests failed reading `call.strings` — `$queryRaw` receives `(strings, ...values)`; a composed `Prisma.sql` inside `${}` arrives as a **nested `Prisma.Sql` value (call[1])** with its own `.sql`. Assert on the nested `.sql`.

### S7 — Seed approved=false (the dead catalogue + a mojibake habit)
Seeded resources had `approved=false` (`Where active+approved` => student catalogue invisible). Fixed; also fixed the seed's profile-existence check needing `include: { studentProfile: true }`. Same session exposed the encoding-corruption habit (CJK fragments like "低扩展" appear in files written by the agent under load — **grep `\\p{Han}` after big writes**), now a standard check in the finish-line routine.

### S8 — E2E cookie-jar mechanics (Better Auth)
Three eats: (1) sign-in/verify cookies were being absorbed onto a **null actor** (make verify+signin run through the OWNING actor's jar), (2) the verify link carries `callbackURL=%2F` — follow redirects manually (`redirect:'manual'`) or the auto-sign-in 302 walks into a 404 Spa root, (3) always send `Origin: http://localhost:3000` (Better Auth CSRF). Split-cookie jar handling + `getSetCookie()` included in the journey's helpers — reuse them.

### S9 — Intent-engine reasoning rules (locked behavior)
Keyword hits > AI-category confirms; severity = max(intent, model) (never downgrade); multi-match = highest severity wins; uncategorised model candidates → `MODEL_CANDIDATE` triage flags (persist, source `AI_CANDIDATE`) unless config-disabled; verdict mirrors into `aiResult.supportFlag` so every consumer sees coherent state; executors are registry functions (add one = whole new action class); SUPPORT_FLAG dedupes on (conversationId, intentId, active status) so async retries never double-flag.

### S10 — "Fail safe, surface reasons" (transcription/mail paths)
SMTP failure during signup/bootstrap: logged + `verificationEmailSent:false` returned (row treatment: resend possible) — enrollment must not 500. Transcription: provider throws typed exceptions; controller translates into clean 503s. AI generation failure: instant holding reply + PENDING job + **intent evaluation still runs server-side** (safeguarding state never waits on the model).

---

## 4. Current state (precise, as of handoff)

**Shipped & green (Phase B):**
- Provider: Groq (real key in `.env`; throws `AiGenerationError` now), `AI_CONFIG` surface + `GET /api/v1/ai/config`, staff bootstrap endpoint, AI disclosure (+ acknowledge), intent engine + executors (flags persist w/ `intentId`), async worker (DB-clock scheduling; REPLY lane), conversations sync/holding lanes, disclosure ack, classLabel on student PATCH, review endpoints for support-requests + follow-up create/update, bootstrap/user provisioning (hashed + `credential` accounts), roles guard self-resolution.
- Schema/migrations: `ai_intent_and_async` (SupportFlag.intentId + AiGenerationJob + AiJobStatus), `counsellor_ops_review_note` (SupportRequest.reviewNote). Prisma client regenerated.
- **Verification standing**: `npm run build` clean; `npm run lint` **0 issues**; unit **111/111** (incl. escalation corpus 11 rows + worker claim/retry/FAILED/reclaim/race + bootstrap 6); seed 5/5 approved resources + 2 support people; **E2E journey 90/90 twice (idempotent reruns)**; outage drill validated holding+queue+FAILED path.

**Paused (Phase C) — nothing built:**
- `docs/PHASE-C-PLAN.md` (approved by user) covers: provider chain (OpenAI primary / Groq fallback / `n-atlas` slot), `AiUsageDaily` + $20 discipline, guardrails config/service + eval corpus (20/20/20/10), N-ATLaS vernacular layer (language config/detector/keyword packs/VERNACULAR worker branch/languageOffer/ASR sidecar `services/n-atlas-asr/`), activities (catalog + orchestration + feeling-after), session summaries → pgvector memory → localized carry-over hooks, load probe (`verify:load`), E2E/doc extensions.
- **No Phase C code exists. No new dependencies installed** (the first `npm install zod-to-json-schema` was denied/withheld — user paused). `package.json` is untouched from Phase B.

**Repository state:**
- Branch `master`; **zero commits** — 23 untracked paths (ALL code, `.env` local files, docs). `/docs/DEPLOYMENT.md` + `docs/PHASE-C-PLAN.md` + `docs/HANDOFF.md` present. `.env` and `.env.local` are git-ignored local files containing REAL secrets (Groq API key, HF/Awarri token, SMTP creds) — **never echo these into code/docs/commits; the handoff (this file) deliberately references variable names only.**

---

## 5. Traps & invariants (non-negotiables for the next agent)

1. **Never schedule on JS `Date` against Prisma DateTime columns** — use DB `NOW()`/intervals (trap S5). Same-clock-family rule.
2. **Never trust the model**: Zod first, intent floor second, config whitelist for resources/activities third; scripted copies (SAFETY_MESSAGE) override model wording for acute risk.
3. **Human pathway beats everything else** — rate limits/budget pauses must never block support-request/flag-ack/follow-up flows.
4. Better Auth conventions (S2/S3): verification via service wrapper; manual credential accounts = `providerId='credential'` + `accountId=user.id`; JWT tokens live in the mail, not the tables; Origin header required; `update-user` for name/phone.
5. **Guard ordering is not guaranteed** (S4): new guards must be self-sufficient like `RolesGuard`.
6. Reasoning-model token budget (`>=1000` for gpt-oss-20b; gpt-5.6-class likewise) — set BEFORE blaming quality.
7. `.env.local` wins over `.env` (envFilePath order) — validateEnv still gates required vars.
8. E2E journey rules (S8): per-actor cookie jars, `redirect:'manual'` on verify, Origin header, DB cleanup at act 0; run against a staging DB for real hosts.
9. grep `\\p{Han}` (plus "YNC"/"carcinogenic") over any big agent-written file before declaring done (S7 mojibake).
10. N-ATLaS license: attribute the line in product + `/ai/config`; 1000-active-user cap awareness on every rollout step.
11. Run `node dist/main.js` (not `nest start`) when you need visible server logs in this harness.
12. Stay in `.env.local` (user convention) for local values; `.env.example` documents knobs.

---

## 6. When work resumes — ordered next actions

1. **Commit everything** first (`master` has no history): review `git status` (23 untracked), make sure `.env`/`.env.local` are ignored, then an initial commit + a `phase-b-complete` commit. This is the top reliability risk until fixed: one bad `rm` loses 100% of the work.
2. `npm install zod-to-json-schema franc` (Phase C deps; the denied install resumes here).
3. Follow `docs/PHASE-C-PLAN.md` **Implementation order** (§1..9). Step 1 = chain provider + OpenAI provider + `AiUsageDaily` + specs; the AI_PROVIDER token moves to `ChainedAiProvider` (useExisting); keep `usage.provider` in aiPayload for explainability; `.env.example` additions (`OPENAI_*`, `AI_PROVIDER_CHAIN`, `OPENAI_DAILY_REQUEST_CAP`).
4. After every phase: `npm run build` + `npm run lint` + `npm run test` (report counts) and extend `test/e2e-journey.mjs` acts per plan Phase G; clinical packet printouts for the reviewer once vernacular keywords exist (they are NOT to ship un-reviewed).
5. N-ATLaS sidecar spike (Phase C step 5): enumerate `NCAIR1` org ASR repos on HF (exact names/paths/gates) before wiring `NAtlasAsrProvider`; keep ASR English path on Groq Whisper meanwhile.
6. Deployment doc updates per plan Phase G (RAM table, pgvector image swap, OpenAI spend panel, nginx burst limits, sidecar unit) land AFTER code phases; keep `README` reflecting reality.

---

## 7. Working with the product owner (collaboration manual)

- **Ask at genuine forks** (max ~3 options, recommended-first): they want to weigh in on product/architecture forks but not trivia. Every major thread so far got an explicit multi-choice decision before design restructured (see D7/D8).
- **Report finish lines with counts**: "build ok, lint 0, 111/111 tests, 90/90×2 e2e" — their standing preference.
- **Communicate in first person, brief, no ceremony**; explain before tools; checkpoints between acts; keep the final summary tight (bold + bullets).
- **Positioning matters**: emotional support, NOT therapy/diagnosis/emergency-care framing; crisis flows are product workflows (intent → flag+reason+human path), never prompt-only. Any new AI surface should ship with its eval-able guardrails and reach the counsellor/safeguarding reviewer early (defer to clinical sign-off; hospital-grade wording is a red flag the reviewer catches).
- **ngo reality**: prefer free/self-hostable; state AI/budget implications openly; never let safety degrade silently ("pause intake instead of degraded safety" per the guide).
- **Docs are deliverables**: README stays current; deployment/phase/handoff docs in `docs/` are part of done.

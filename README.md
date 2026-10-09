# Soul Nurture AI / Natlas

School-based emotional wellbeing platform. Students move through a 4-step **Wellbeing Journey** (Check-in → Reflect → Resources → Human Support), supported by a tightly controlled AI guide. Professionals review cases via a dedicated dashboard.

This is **not a generic chatbot** — the AI is a backend capability embedded inside the wellbeing journey.

## Stack

- NestJS 12 + Fastify · TypeScript (ESM)
- Prisma 7 + PostgreSQL
- Better Auth (email/password + verification + sessions)
- Socket.IO — push-only realtime (chat pool, notifications, unread badges)
- Nodemailer + Handlebars email templates
- Groq (LLM + Whisper) — fully abstracted behind `AIProvider`
- Vitest (unit + e2e), oxlint, Prettier

## Project structure

```text
src/
├── auth/            # Better Auth integration, session helpers, verification, first-password change
├── users/           # current-user endpoint, provisioning, STAFF bootstrap enrolment
├── schools/         # school tenancy: school-scoped user management + default password
├── admin/           # platform owner console (schools CRUD, overview, global user list)
├── chat/            # human chat: request pool → claim → messages → close
├── notifications/   # per-user notification feed (chat request/claimed/reply, suspension)
├── realtime/        # Socket.IO gateway — push-only broadcasts to per-user rooms
├── students/        # student profile, Sanctuary home aggregate, vibe/language
├── professionals/   # professional profile
├── consent/         # consent version records
├── check-ins/       # Journey Step 1 — emotional check-in
├── conversations/   # Journey Reflect + AI chat messages (sync + async lanes)
├── ai/              # provider, context, orchestrator, prompts, intents, worker
│   ├── config/ai.config.ts            # the single AI knob surface (explained above)
│   ├── intents/intents.config.ts      # declarative safeguarding intents (see below)
│   ├── intents/intent-engine.service.ts
│   ├── intents/intent-executors.ts    # flag/message/grounding/resource actions
│   ├── intents/escalation-corpus.ts   # executable rules-dataset guard
│   ├── disclosure/                    # AI capabilities & limits + acknowledgement
│   ├── ai-worker.service.ts           # DB-queue worker for deferred AI replies
│   ├── prompts/ · providers/ · schemas/
├── resources/       # approved resource catalogue, toolbox
├── journal/         # private student reflections
├── support-requests/# Journey Step 4 — human support requests + professional review
├── support-flags/   # server-policy + AI-candidate safeguarding flags
├── follow-ups/      # professional follow-up tracking (create/complete)
├── dashboard/       # counsellor review portal aggregates
├── audit/           # sensitive-event audit log
├── privacy/         # self-referral & privacy controls
├── mailer/          # SMTP transport + Handlebars templates
├── prisma/          # PrismaService wrapper
├── common/          # validation pipe, response interceptor, exception filter, RolesGuard, TenantGuard
└── docs/            # OpenAPI/Swagger setup
```

## Setup

```bash
cp .env.example .env.local
# edit .env.local for your Postgres + SMTP + Groq keys
npm install
npx prisma generate --config prisma7.config.ts
npx prisma migrate dev --name init
npm run build
npm start
```

OpenAPI docs: `http://localhost:3000/api/docs` (Swagger UI) and `http://localhost:3000/api/docs-json` (raw JSON).

**Production deployment** (Contabo VPS runbook: security baseline, Docker infra, PostgreSQL, RustFS uploads, N-ATLaS/Ollama, systemd, Nginx/TLS, Prometheus + Grafana + Loki monitoring, backups): see [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md).

**Agent/dev handoff** (full working memory: decisions ledger, debugging stories, traps, resume steps): see [docs/HANDOFF.md](docs/HANDOFF.md). Phase C plan (approved, paused): [docs/PHASE-C-PLAN.md](docs/PHASE-C-PLAN.md).

### Seed data

```bash
npm run seed
```

Seeds approved resources and trusted support people.

## API

All Nest routes are under `/api/`. Better Auth owns `/api/auth/*`.

Response envelope (Nest-handled routes):

```json
{ "success": true, "statusCode": 200, "message": "Request successful", "data": {}, "path": "...", "timestamp": "..." }
```

### Auth (via Better Auth)

| Method | Path |
|--------|------|
| POST | `/api/auth/sign-up/email` |
| POST | `/api/auth/sign-in/email` |
| POST | `/api/auth/sign-out` |
| POST | `/api/auth/update-user` (rename/phone) |
| GET | `/api/auth/get-session` |
| POST | `/api/auth/forget-password` |
| POST | `/api/auth/reset-password` |
| GET | `/api/auth/verify-email` |
| POST | `/api/verification/resend` |

Email verification is required before full access. Use `credentials: "include"` from the browser — sessions are cookie-based. Verification emails are school-branded (the student's school name in the copy). Sign-in is rejected (403 `SCHOOL_SUSPENDED` / `ACCOUNT_DEACTIVATED`) for users whose school is suspended or whose account is deactivated.

**Roles:** `STUDENT`, `COUNSELLOR`, `PSYCHOLOGIST`, `SUPPORT_STAFF`, `SCHOOL_ADMIN`, `PLATFORM_ADMIN`. The school-onboarding path is the primary one: a PLATFORM_ADMIN provisions schools (`POST /api/v1/schools`), then school-scoped routes onboard students and professionals with the school's shared **default password** (plaintext never stored; the precomputed hash lives on `School`). Onboarded users sign in with the default password and are forced through `POST /api/v1/auth/first-password` before any other route works (`PASSWORD_CHANGE_REQUIRED` 403). Direct staff enrolment is also possible:
- `POST /api/v1/staff/bootstrap` — public with the shared enrolment key (`STAFF_BOOTSTRAP_KEY`); roles `COUNSELLOR | PSYCHOLOGIST | SUPPORT_STAFF` only; requires email verification before sign-in.
- `POST /api/v1/users` — staff-to-staff provisioning (password stored hashed).

**School tenancy enforcement:** a global `TenantGuard` (after `RolesGuard`) re-checks every `/api/v1` request: deactivated account → `ACCOUNT_DEACTIVATED`; suspended school → `SCHOOL_SUSPENDED`; pending first password change → `PASSWORD_CHANGE_REQUIRED` (allowlist: `GET /api/v1/users/me`, `POST /api/v1/auth/first-password`). Suspension also revokes live sessions and hard-disconnects live sockets.

### Domain routes (`/api/v1/...`)

| Resource | Routes |
|----------|--------|
| Users | `GET /users/me`, `POST /users` (staff, provision) |
| Staff enrolment | `POST /staff/bootstrap` (secret-gated) |
| Students | `GET /students/me`, `PATCH /students/me`, `GET /students/me/sanctuary` |
| Professionals | `GET /professionals/me`, `PATCH /professionals/me` |
| Check-ins | `POST /check-ins`, `GET /check-ins`, `GET /check-ins/:id` |
| Conversations | `POST /conversations`, `GET /conversations`, `GET /conversations/:id`, `POST /conversations/:id/messages` |
| AI | `POST /ai/transcribe` (multipart, field `audio`), `GET /ai/config` (professionals), `GET /ai/disclosure` (public), `POST /ai/disclosure/acknowledge` (student) |
| Resources | `GET /resources`, `GET /resources/tailored`, `GET /resources/toolbox`, `POST /resources/toolbox` |
| Journal | `GET /journal`, `POST /journal`, `GET/PATCH/DELETE /journal/:id` |
| Support | `GET /support-requests/people`, `POST /support-requests`, `GET /support-requests`, `GET /support-requests/:id`, `PATCH /support-requests/:id` (professional review: status + review note) |
| Flags | `GET /support-flags`, `POST /support-flags/:id/acknowledge`, `POST /support-flags/:id/in-review` |
| Dashboard | `GET /dashboard/counsellor` |
| Follow-ups | `GET /follow-ups`, `POST /follow-ups` (professional), `PATCH /follow-ups/:id` (owner: status + notes) |
| Consent | `GET /consent/me`, `POST /consent/accept` |
| Privacy | `GET /privacy/preferences`, `PATCH /privacy/preferences` |
| Audit | `GET /audit` |
| Platform console | `POST/GET /schools`, `PATCH /schools/:id`, `POST /schools/:id/suspend`, `POST /schools/:id/reactivate`, `GET /admin/overview`, `GET /admin/users` (PLATFORM_ADMIN) |
| School management | `GET /schools/:id/overview`, `GET /schools/:id/users`, `POST /schools/:id/students`, `POST /schools/:id/professionals`, `PATCH /schools/:id/users/:userId`, `DELETE /schools/:id/users/:userId`, `POST .../reactivate`, `PATCH /schools/:id/settings` (PLATFORM_ADMIN any school; SCHOOL_ADMIN own school) |
| Human chat | `POST /chat/threads`, `GET /chat/threads`, `GET /chat/inbox`, `POST /chat/threads/:id/claim`, `GET /chat/threads/:id`, `POST /chat/threads/:id/messages`, `GET /chat/unread`, `POST /chat/threads/:id/read`, `POST /chat/threads/:id/close` |
| Notifications | `GET /notifications`, `GET /notifications/unread-count`, `POST /notifications/:id/read`, `POST /notifications/read-all` |
| First password | `POST /auth/first-password` (session; no old password — school default → own password) |

### Realtime (Socket.IO, push-only)

Path `/api/socket.io`. Auth via session cookie at handshake (re-verified against the DB — suspended/deactivated/must-change-password users are disconnected). Rooms: `user:<id>` (personal pushes) and `school-professionals:<schoolId>` (request pool). No anonymous sockets; cross-school sockets receive nothing. REST stays the transport for every write — WebSockets only push.

| Event | Target | Meaning |
|---|---|---|
| `chat.request.created` | school professionals | new pool request `{threadId, student{firstName, classLabel}, pendingCount}` |
| `chat.thread.claimed` | student + school professionals | a professional took the thread |
| `chat.message.new` | both participants | new human-chat message |
| `chat.thread.closed` | both participants | thread closed |
| `chat.unread.updated` | affected user | `{total, byThread}` true counts (99+ cap is client-side) |
| `notification.new` | target user | notification row `{id, type, title, body, data}` |
| `notification.unread.updated` | target user | `{count}` |

### AI contract highlights

- Frontend **never** calls Groq directly
- Structured JSON output validated by a Zod schema before persistence; invalid output → the async retry queue (never a silent wrong answer)
- Supported actions: `NONE | REFLECTION | GROUNDING | RESOURCE | HUMAN_SUPPORT`
- Context is bounded (`AI_CONTEXT_MESSAGE_LIMIT`, `AI_CONTEXT_CHARACTER_LIMIT`)
- Resource IDs from the model are validated against the approved catalogue; intent-driven recommendations are further constrained by category
- **Safeguarding intents** (see below) persist tiered `SupportFlag`s with a written reason (`aiContextSummary`) so counsellors see *flag plus reason*; server keyword detection works even if the model is down
- Works without `GROQ_API_KEY` (deterministic self-holding reflection)
- Timeout: first attempt 20s, then the async DB queue (`AI_ASYNC_POLL_MS` worker, retries 5s/30s/2m, then FAILED)

### The intent engine (configurable safeguarding rules)

`src/ai/intents/intents.config.ts` is the one file clinical reviewers sign off. Each intent declares:

```ts
{
  id, label, description,        // surfaces in GET /api/v1/ai/config
  severity,                      // TIER_1_MODERATE | TIER_2_HIGH | TIER_3_ACUTE
  serverSignals: { keywords, aiCategories },
  actions,                       // executed in listed order
}
```

Available actions: `SUPPORT_FLAG` (persists the flag + audit), `HUMAN_SUPPORT_PROMPT` (user-facing pathway), `SAFETY_MESSAGE` (scripted reply; model wording never trusted for acute risk), `GROUNDING` (attaches an exercise), `RECOMMEND_RESOURCE` (category-constrained approved pick). Adding an intent is a new array entry — engine + executors are generic.

Resolution rules: server keyword hits can never be downgraded by the model; multiple matches resolve to the highest severity; uncategorised model candidates still persist as `AI_CANDIDATE` flags for triage. Every acted intent is audited (`support_flag.auto_created`).

`src/ai/intents/escalation-corpus.ts` holds the executable false-positive/negative guard from the BA's high-escalation rules dataset — `npm test` re-asserts every row.

### Async AI replies (respond now, land later)

When the model is unavailable inside the first-attempt budget, `POST /conversations/:id/messages` returns instantly with a warm holding reply (`aiPayload.asyncState = "PENDING_AI"`, `aiPending: true`) and queues an `AiGenerationJob`. The in-app worker (same process, DB-backed) re-runs the full orchestration — including intent evaluation — and rewrites the placeholder **in place** (`asyncState` → `COMPLETE`), even hours later or after the student closed the window; clients just refetch the conversation. Exhausted retries end in `FAILED` with the holding text kept. Retry schedule, staleness reclaim, and the holding message live in `AI_CONFIG.async`.

### AI configuration — `src/ai/config/ai.config.ts`

The single knob surface (env-driven, non-secret; exposed to professionals via `GET /api/v1/ai/config`):

| Env var | Effect | Default |
|---|---|---|
| `GROQ_API_KEY` | Enables real generation (secret; never exposed) | — |
| `GROQ_CHAT_MODEL` | Chat model | `openai/gpt-oss-20b` |
| `GROQ_MAX_OUTPUT_TOKENS` | ≥1000 recommended: reasoning models spend thinking budget before JSON | 1000 |
| `GROQ_TEMPERATURE` | Reply determinism | 0.2 |
| `AI_CONTEXT_MESSAGE_LIMIT` / `AI_CONTEXT_CHARACTER_LIMIT` | Replay bounds | 12 / 12000 |
| `AI_ASYNC_POLL_MS` | Worker scan interval (0 = disabled) | 5000 |
| `AI_ASYNC_HOLDING_MESSAGE` | What students see instantly when AI is down | in config |
| `STAFF_BOOTSTRAP_KEY` | Enrolment secret; unset/empty closes `POST /api/v1/staff/bootstrap` | — |

### AI module

```text
src/ai/
├── ai.controller.ts               # POST /v1/ai/transcribe + GET /v1/ai/config
├── ai.service.ts                  # orchestration: context → provider → validate → intents → whitelist
├── ai-worker.service.ts           # DB-queue worker (rewrites placeholder messages in place)
├── ai.errors.ts                   # AiGenerationError (async-lane trigger)
├── ai.module.ts
├── config/
│   └── ai.config.ts               # single knob surface (env → validated defaults)
├── intents/
│   ├── intents.config.ts          # declarative intents (clinical-review surface)
│   ├── intent-engine.service.ts   # pure classification
│   ├── intent-executors.ts        # action registry (flag/message/grounding/resource)
│   ├── escalation-corpus.ts       # dataset-driven FP/FN rows
│   └── escalation-corpus.spec.ts  # asserted on every npm test
├── disclosure/
│   ├── ai-disclosure.ts           # versioned capabilities & limits text
│   └── disclosure.controller.ts
├── context/
│   └── ai-context.service.ts      # bounded, sanitized context built from Prisma
├── prompts/
│   └── system.prompt.ts           # versioned system prompt (v2)
├── providers/
│   ├── ai-provider.interface.ts   # AI_PROVIDER token + interface
│   └── groq/
│       ├── groq.constants.ts
│       └── groq.provider.ts       # throws AiGenerationError → async lane
└── schemas/
    ├── ai-response.schema.ts      # Zod contract for structured output
    └── validate-ai-response.ts    # validator (throws → retry queue)
```

## Development

```bash
npm start:dev
npm test              # unit + escalation corpus
npm run lint
npm run build
```

### End-to-end journey (live backend)

`test/e2e-journey.mjs` walks the whole system: a psychologist bootstrap-enrols + verifies + signs in + updates profile, provisions a SUPPORT_STAFF (hash-proof sign-in), a student (Miva University Nigeria) runs check-in → AI reflection (with a real crisis-escalation turn) → async worker proof → resources/toolbox/journal → support request → counsellor dashboard/flags/follow-ups/audit → RBAC negatives → sign-out. Cookie sessions managed per actor; DB cleanup makes repeated runs idempotent.

```bash
# with the server running on :3000
npm run test:e2e:journey
```

In dev the backend stores and serves the latest verification links at `GET /api/verification/dev-links/:email` (production turns this off completely) so the journey can verify accounts without an inbox.

### End-to-end school tenancy + human chat (live backend)

`test/e2e-school-chat.mjs` walks the school-centric surface: platform owner console (create schools → short codes → default password → suspend/reactivate), school-scoped onboarding of students/professionals, the forced first-password flow, Socket.IO room targeting (anonymous sockets rejected, cross-school sockets silent), the chat request pool (PENDING → race-safe claim → messages both ways → close), unread badges, notifications, and suspension side effects (sessions revoked, sockets dropped, sign-in blocked). Uses the same cookie-jar actor pattern + DB cleanup as the journey.

```bash
# with the server running on :3000
npm run test:e2e:school-chat
```

## License

UNLICENSED — Soul Nurture AI.

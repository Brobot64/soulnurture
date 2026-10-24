# Natlas API Manual Testing Handbook

Step-by-step API walkthrough for manual testing, covering every user type and
the full feature surface: auth + email verification, school tenancy (platform
owner console, school default passwords, forced first-password change),
professional onboarding, student profile, consent/privacy, AI disclosure,
check-ins, conversations with AI (sync + async retry lane), voice
transcription, resources, journal, human chat (request → pool → claim →
messages → close, Socket.IO push), support requests → professional assignment,
flag triage, follow-ups, dashboard, audit, notifications, and the RBAC
negative matrix.

> **Keep this handbook in sync.** When an endpoint, payload, enum, or flow
> changes, update the affected chapter in the same branch/commit. Do not add
> endpoints here that are not live in code — mirror the API, never the plan.
>
> **Last synced:** `DOCS_008` (school tenancy + human chat) — new Chapter 13
> covers the platform console, school-scoped user management, the forced
> first-password flow, human chat, notifications, and the Socket.IO push
> surface; Appendices A/B extended with the new enums and placeholders.

---

## 0. Conventions

### 0.1 Base URL & clients

- Base URL: `http://localhost:3000` (dev server must be running: `npm run start:dev`)
- Any HTTP client works (Postman, Insomnia, curl) **as long as it stores and
  resends cookies** — sessions are cookie-based.
- The examples use `curl` with one cookie jar per persona:
  `-c jude.jar -b jude.jar` (save + send cookies).
- Mutating requests **must** send the Origin header or Better Auth rejects them:
  `-H "origin: http://localhost:3000"`.
- Session cookie name: `better-auth.session_token` (Better Auth default). A
  working jar contains exactly this cookie after sign-in; it is the only
  credential every authenticated chapter below relies on.

### 0.2 Response envelope

App routes (`/api/v1/...`) respond with:

```json
{
  "success": true,
  "statusCode": 200,
  "message": "Request successful",
  "data": { },
  "path": "/v1/check-ins",
  "timestamp": "2026-10-06T12:00:00.000Z"
}
```

Successful creates return `201` inside the envelope (`statusCode: 201`).
Better Auth routes (`/api/auth/...`) respond with Better Auth's own shape
(usually `{ "user": { ... } }`, sometimes a redirect/empty body). Throughout
this handbook, **"assert"** lists the fields to check inside `data` (or `user`).

Errors:

```json
{
  "success": false,
  "statusCode": 400,
  "message": "Validation failed",
  "error": "Bad Request",
  "path": "/v1/check-ins",
  "timestamp": "2026-10-06T12:00:00.000Z"
}
```

The global validation pipe whitelists DTO fields — any unknown key in a JSON
body is rejected with `400`. Path parameters are UUIDs (invalid → `400`).

### 0.3 Email verification (dev only)

Better Auth 1.7 verification tokens live only in the emailed link. In dev, the
backend exposes the last dispatched link so you can verify without an inbox:

```
GET /api/verification/dev-links/:email
→ 200 { "success": true, "data": { "url": "https://.../api/auth/verify-email?token=...&callbackURL=..." } }
```

Then consume the token by requesting **only the path + query string** of that
URL, as the persona being verified, **without following redirects**
(redirect-following lands on the SPA root). The response sets the session
cookie (auto sign-in) and is `200` or `302`. In production this route 404s.

If the link expires before you use it, request a fresh one (no auth needed):

```http
POST /api/verification/resend
```

```json
{ "email": "jude.michael@miva.edu.ng" }
```

Then re-read the dev link. Note: `requireEmailVerification: true` in the Better
Auth config — **signing in before verifying the email is rejected**, so always
verify (or re-verify) before the sign-in step.

### 0.4 Secrets you need

| Secret | Where it lives | Default (local) |
| --- | --- | --- |
| Staff enrollment key | `.env` → `STAFF_BOOTSTRAP_KEY` | `natlas-boot-2026-local` |
| Dev verification links | enabled by `NODE_ENV=development` | — |

### 0.5 Personas (consistent throughout this handbook)

| Persona | Role | Email | Password | Phone |
| --- | --- | --- | --- | --- |
| **Jude Michael** | STUDENT | `jude.michael@miva.edu.ng` | `JudeSafe123#` | `+2348098765432` |
| **Grace Adeyemi** | COUNSELLOR | `grace.adeyemi@soulnurture.ng` | `GraceSafe123#` | `+2348031112222` |
| **Ibrahim Musa** | PSYCHOLOGIST | `ibrahim.musa@soulnurture.ng` | `IbrahimSafe123#` | `+2348053334444` |
| **Tunde Balogun** | SUPPORT_STAFF | `tunde.balogun@soulnurture.ng` | `TundeSafe123#` | `+2348075556666` |

Jude's profile: class `Sociology 300 Level` (Miva University), display name
`Jude M.`, preferred language `en`, vibe `quiet, thoughtful`.

The support-person directory lists **Dr. Ibrahim Musa** (see Chapter 2 — seed,
no admin CRUD exists yet). Jude's support request goes to him.

### 0.6 Fresh-run cleanup (run first, re-runnable)

Before a full pass, clean leftovers from the previous run (SQL):

```sql
DELETE FROM "user" WHERE email = ANY(ARRAY[
  'jude.michael@miva.edu.ng',
  'grace.adeyemi@soulnurture.ng',
  'ibrahim.musa@soulnurture.ng',
  'tunde.balogun@soulnurture.ng'
]::text[]);
DELETE FROM support_person WHERE name = 'Dr. Ibrahim Musa';
DELETE FROM verification WHERE identifier = ANY(ARRAY[
  'jude.michael@miva.edu.ng',
  'grace.adeyemi@soulnurture.ng',
  'ibrahim.musa@soulnurture.ng',
  'tunde.balogun@soulnurture.ng'
]::text[]);
```

---

## 1. Preflight

**1.1** `GET /api` — assert `200`, `success: true`.
**1.2** `GET /api/health/auth` — assert `data.service === 'auth'`.
**1.3** Confirm Postgres is reachable (the API won't boot without it, so 1.1 passing implies it).

---

## 2. Professionals onboarding (Grace, COUNSELLOR)

### 2.1 Staff bootstrap sign-up (secret-gated)

**Request**

```http
POST /api/v1/staff/bootstrap
```

```json
{
  "name": "Grace Adeyemi",
  "email": "grace.adeyemi@soulnurture.ng",
  "password": "GraceSafe123#",
  "phone": "+2348031112222",
  "role": "COUNSELLOR",
  "enrollmentKey": "natlas-boot-2026-local"
}
```

**Expected** `201`. Assert:
- `data.user.email === "grace.adeyemi@soulnurture.ng"`
- `data.user.emailVerified === false` (account still needs verification)
- `data.user.role === "COUNSELLOR"`
- `data.verificationEmailSent === true` (`false` only after an SMTP outage —
  enrolment still succeeds)

**Negative probes (run all):**

| Probe | Payload change | Expected |
| --- | --- | --- |
| Wrong key | `"enrollmentKey": "wrong-key"` | `403` "Invalid enrollment key" |
| Student via bootstrap | `"role": "STUDENT"` | `400` |
| Duplicate email | same body again | `422` or `409` |
| Key not configured | (server-side: `STAFF_BOOTSTRAP_KEY` unset) | `403` "Staff enrolment is not enabled" |

### 2.2 Verify email + sign in (as Grace, save cookies to `grace.jar`)

**Request** — see §0.3:

```
GET /api/verification/dev-links/grace.adeyemi@soulnurture.ng
→ take data.url, then GET only its path+query (no redirect follow), cookie jar = grace.jar
```

**Request**

```http
POST /api/auth/sign-in/email
```

```json
{
  "email": "grace.adeyemi@soulnurture.ng",
  "password": "GraceSafe123#"
}
```

**Expected** `200`, `user` present. Then:

**Request** `GET /api/users/me` — assert `data.role === "COUNSELLOR"`.

### 2.3 Professional profile (auto-created, then completed)

**Request** `GET /api/v1/professionals/me` — assert `200`, `data.id` present
(profile is auto-provisioned on first access).

**Request**

```http
PATCH /api/v1/professionals/me
```

```json
{
  "title": "School Counsellor",
  "department": "Counselling & Psychological Services",
  "available": true,
  "imageUrl": "https://example.org/grace.png"
}
```

**Expected** `200`. Assert `data.title === "School Counsellor"`. All fields are
optional; `imageUrl` must be a valid URL (`@IsUrl`).

### 2.4 Account rename / phone change (Better Auth)

**Request**

```http
POST /api/auth/update-user
```

```json
{
  "name": "Grace Adeyemi",
  "phone": "+2348039998888"
}
```

**Expected** `200`. Re-run `GET /api/users/me` — assert the new phone sticks.

### 2.5 Session & password utilities (Better Auth, any persona)

- `GET /api/auth/get-session` — the raw Better Auth session (`{ "user": {...},
  "session": {...} }`); handy to confirm a jar is alive.
- `GET /api/users/session` — the app's own session echo (`data.user`,
  `data.session`); used by the frontend bootstrap.
- `POST /api/auth/forget-password` `{ "email": "grace.adeyemi@soulnurture.ng",
  "redirectTo": "http://localhost:3000/reset-password" }` → `200`; assert the
  response is identical for a known and an unknown email (no enumeration).
  The reset email uses the `reset-password` template; in dev, delivery is
  logged like the verification link.
- `POST /api/auth/reset-password` `{ "newPassword": "GraceSafe124#",
  "token": "<from the emailed link>" }` → `200`; the old password stops working
  at the next sign-in.

---

## 3. Provisioning staff + support-person directory

### 3.1 Grace provisions Tunde (SUPPORT_STAFF)

**Request** (as Grace)

```http
POST /api/v1/users
```

```json
{
  "name": "Tunde Balogun",
  "email": "tunde.balogun@soulnurture.ng",
  "role": "SUPPORT_STAFF",
  "phone": "+2348075556666",
  "password": "TundeSafe123#"
}
```

**Expected** `201`, `data.email === "tunde.balogun@soulnurture.ng"`.

Tunde signs in exactly like Grace did (§2.2 → `/api/auth/sign-in/email`, jar
`tunde.jar`), and can then `GET /api/v1/dashboard/counsellor` (`200`).

### 3.2 Seed the support-person directory (documented gap: no admin CRUD yet)

The directory that students see is seeded by SQL. This example links
**Dr. Ibrahim Musa** to his professional profile:

```sql
INSERT INTO support_person (id, "professionalId", name, type, title, "availabilityLabel", "availableToday", active, "createdAt", "updatedAt")
VALUES (
  gen_random_uuid(),
  (SELECT p.id FROM professional_profile p JOIN "user" u ON u.id = p."userId" WHERE u.email = 'ibrahim.musa@soulnurture.ng'),
  'Dr. Ibrahim Musa', 'PSYCHOLOGIST', 'Visiting Clinical Psychologist',
  'Available Today', true, true, now(), now()
)
ON CONFLICT (name, type) DO UPDATE SET
  "professionalId" = EXCLUDED."professionalId", active = true, "availableToday" = true;
```

> If Ibrahim has not signed up yet, run Chapter 2 for him first (role
> `PSYCHOLOGIST`, his details from §0.5), then run the seed.

---

## 4. Student Jude Michael — account → consent → disclosure

### 4.1 The sign-up door is closed

**Request** (anonymous)

```http
POST /api/auth/sign-up/email
```

```json
{
  "name": "Jude Michael",
  "email": "jude.michael@miva.edu.ng",
  "password": "JudeSafe123#",
  "phone": "+2348098765432"
}
```

**Expected** `400` with `code === "EMAIL_PASSWORD_SIGN_UP_DISABLED"`. The
error is uniform whether or not the email exists — sign-up can no longer be
used to probe which accounts are real.

Accounts therefore enter only by **provisioning**. For a student that is
school onboarding (§13.3): a school admin creates Jude with his school's
default password, and his first sign-in is forced through a personal-password
change (§13.4) before any other route works. Provision Jude now if you have
not already — `jude.michael@miva.edu.ng`, class label
`Sociology 300 Level`, phone `+2348098765432` — then continue.

### 4.2 Verify email + sign in

Same flow as §2.2, with Jude's email and `jude.jar`, except that the password
is the **personal one Jude just chose** during the forced change (§13.4), not
a self-chosen sign-up password. (Confirm the verify-first rule: a sign-in
attempt made *before* verification is rejected.)

**Request** `GET /api/users/me` — assert `data.role === "STUDENT"` and
`data.school.name` matches the onboarding school.

### 4.3 Student profile

**Request** `GET /api/v1/students/me` — auto-provisioned on first access;
assert `200` and `data.id`. Then:

**Request**

```http
PATCH /api/v1/students/me
```

```json
{
  "displayName": "Jude M.",
  "classLabel": "Sociology 300 Level",
  "preferredLanguage": "en",
  "vibe": "quiet, thoughtful"
}
```

**Expected** `200`. Assert `data.displayName === "Jude M."`.

`preferredLanguage` accepts only the canonical set `en | pcm | yo | ha | ig`
(400 otherwise); the four vernacular codes are Yoruba, Hausa, Igbo and
Nigerian Pidgin — the languages the AI is expected to reply in. Changing the
preference is audited (`student.language_changed` with `from`/`to` in `meta`).

**Request** `GET /api/v1/students/me/sanctuary` — assert `data.greeting` is a
string and `data.sosAvailable === true`.

### 4.4 Consent + privacy preferences

**Request**

```http
POST /api/v1/consent/accept
```

```json
{ "version": "v1" }
```

**Expected** `200`, `data.accepted === true`.

**Request** `GET /api/v1/consent/me` — assert `data` is an array with ≥ 1 entry.

**Request** `GET /api/v1/privacy/preferences` — assert
`data.shareAiCopingHubNotes === false` (safe defaults).

**Request**

```http
PATCH /api/v1/privacy/preferences
```

```json
{ "shareAiCopingHubNotes": true }
```

**Expected** `200`, `data.shareAiCopingHubNotes === true`.

All three preferences are independent booleans defaulting to `false`:
`shareAiCopingHubNotes`, `allowParentGuardianNotification`,
`requestPeerSupportCompanion`.

### 4.5 AI capabilities & limits disclosure

**Request** (anonymous — no cookie) `GET /api/v1/ai/disclosure` — assert `200`,
`data.text` mentions what the AI **cannot** do.

**Request** (as Jude — `@Roles('STUDENT')`: staff personas get `403` here)

```http
POST /api/v1/ai/disclosure/acknowledge
```

**Expected** `200`, `data.acknowledged === true`.

---

## 5. Jude's wellbeing journey — check-in → conversation → crisis intent

### 5.1 Check-in

**Request**

```http
POST /api/v1/check-ins
```

```json
{
  "feeling": "SAD_LOW",
  "intensity": "A_LOT",
  "description": "Two exams in two days. The hostel is loud, course mates are far, and I have not eaten well.",
  "triggers": ["exam pressure", "loneliness", "poor sleep"]
}
```

**Expected** `201`. Assert `data.id` present, `data.feeling === "SAD_LOW"`.
Save `checkInId = data.id` for the next chapters.

Feeling values: `OVERWHELMED | ANXIOUS | TIRED | SAD_LOW | CALM | HOPEFUL |
GREAT | HAPPY | PEACEFUL | STRESSED | DOWN | ANGRY` · Intensity: `A_LITTLE |
SOMEWHAT | A_LOT`.

**Request** `GET /api/v1/check-ins` — assert `data.items[0].id === checkInId`.
**Request** `GET /api/v1/check-ins/<checkInId>` — assert `200`,
`data.id === checkInId` (single-record read).

### 5.2 Open a conversation rooted in the check-in

**Request**

```http
POST /api/v1/conversations
```

```json
{
  "checkInId": "<checkInId>",
  "source": "chat"
}
```

**Expected** `201`. Assert `data.id` present and `data.checkInId` matches.
Save `conversationId = data.id`.

**Request** `GET /api/v1/conversations` — assert `data.items` contains the new
conversation (list endpoint; most recent first). Conversations stay `ACTIVE`
until the student closes one (§5.5) or the worker closes it as idle.

### 5.3 Send messages

Each message gets a synchronous AI reply (`content` is 1–4000 chars;
`language` optional, defaults to the student's `preferredLanguage`).

**Guardrails on every AI turn** (configurable via `GET /api/v1/ai/config` →
`data.guardrails`):

- **Input**: student content over `AI_MAX_MESSAGE_CHARS` (default 1200) is
  truncated before it reaches the model — the safeguarding review (intent
  engine) still evaluates the **full original text**, so crisis wording is
  never lost. Injection probes (e.g. "ignore all previous instructions")
  are not blocked; they add a prompt-hardening line for the model and a
  `notes` entry on the assistant turn's `aiPayload`.
- **Output**: replies over `AI_MAX_REPLY_CHARS` (default 700) are cut with a
  reviewer note; banned-claim output (diagnosis, medication advice, safety
  promises, certification claims, human impersonation) is replaced with
  scripted safe copy — severe matches rewrite the whole reply, soft matches
  strip only the violating sentence.
- **Rate**: AI chat turns are capped per student — `AI_RATE_LIMIT_PER_MINUTE`
  (default 6/minute) and `AI_RATE_LIMIT_DAILY` (default 20/day). A turn past
  the cap returns **429** with a body of `{ "message", "retryAfterSeconds" }`;
  a rejected turn consumes no budget. The gate guards **AI messages only** —
  the Support (human) pathway is never rate-limited and stays reachable.

**Request** (×3, as Jude):

```http
POST /api/v1/conversations/<conversationId>/messages
```

```json
{
  "content": "Good morning. I am a 300 level Sociology student at Miva University, Nigeria. Today was rough — lectures, then assignments back to back.",
  "language": "en"
}
```

Message 1 — assert `201`/`200`; reply is a warm reflection, `data.activeIntent === null`.

Message 2 (content: *"Lately everything feels heavier. Deadlines are close and the hostel is too loud to rest."*) — assert `data.activeIntent === null`.

Message 3 — **crisis wording** (content: *"Honestly, some nights I feel there is no reason to live. I keep thinking I want to end it all."*) — assert:

- `data.activeIntent.id === "SUICIDAL_IDEATION"`
- `data.activeIntent.severity === "TIER_3_ACUTE"`
- `data.assistantMessage.content` contains a scripted safety message (e.g. includes "matter")
- `data.humanCareRecommendation.show === true` (human pathway always reachable)
- `data.recommendedActivity.slug === "five-senses-grounding"` (the intent
  engine attached a startable activity; requires the seeded catalogue — §7.3)

The response envelope's `data` always carries the full turn:
`userMessage`, `assistantMessage`, `humanCareRecommendation`,
`recommendedResource` (null unless the AI recommends one), `recommendedActivity`
(null unless an intent attached one — carries `slug` + `title`; the client
fetches the renderer steps via the activities API, §7.3), `activeIntent`
(null unless the intent engine fired), `aiPending` (true when the sync
attempt failed and the async lane took over — see Chapter 6), and
`languageOffer` (null unless the message was detected as vernacular while the
preference is still `"en"` — see below).

**Vernacular messages (language layer).** Every message is language-detected
synchronously: offline heuristics first — marked letters (Yoruba ẹ/ọ/ṣ, Hausa
ƙ/ɓ/ɗ, Igbo ị/ọ/ụ/ṅ), Pidgin marker words, then Yoruba/Hausa/Igbo lexicon
wordlists; franc only classifies long English text (it cannot separate the
Nigerian languages — "mi o ti jeun lati aaro" reads as Igbo to franc). When
every heuristic is silent the detector asks N-ATLaS itself to name the
language (LANG_ID_016) — a strict 4s cap (`NATLAS_IDENTIFY_TIMEOUT_MS`) and
fail-open in every direction: text under 8 characters, a missing/cold
endpoint or any error leaves the preference fallback standing exactly as
before, so the turn is never delayed more than the cap. Detection does three
things: when the student's preference is still `"en"`, the response carries
`languageOffer: { detected, current }`; the reply for **this turn** follows
the detected language — `"en"` included, so whoever types English is answered
in English — generation stays English (context, guardrails and the intent
floor all run on the English lane) and a vernacular turn's finished reply is
rendered by local N-ATLaS **within the same request**, whatever the standing
preference (per-message following; a voice note follows the same rule once
its transcript is sent). The forced `dto.language` and then the preference
fill in only when the message text itself yields no signal. Render fallback
chain: N-ATLaS → OpenAI render → the English reply (total render failure
never blocks the turn); scripted safety copy is never rendered — that wording
is approved verbatim. Finally a `VERNACULAR` job (see §6.6) is queued to
translate the message and run a second safeguarding sweep on the English
translation.

**Vernacular probe** (optional — run after §5.4 so the 6-message assertion
above stays valid). Send (omit `language`):

```json
{ "content": "Mo ti rẹ̀ rẹ̀ lónìí" }
```

Assert:

- `data.languageOffer === { "detected": "yo", "current": "en" }`
- `data.activeIntent === null` (benign text; the keyword floor still ran on
  the raw text synchronously)
- the assistant reply comes back **in Yoruba** (rendered in-request; with
  neither `NATLAS_LLM_BASE_URL` nor `OPENAI_API_KEY` configured it stays
  English — the turn is never blocked); the assistant turn's `aiPayload`
  gains `render: { language: "yo", via: "n-atlas-local" | "openai",
  englishSource }`

Then within ~1 worker poll cycle (translation requires `OPENAI_API_KEY` or
`NATLAS_LLM_BASE_URL`; see §9.5):

```sql
SELECT kind, status, attempts FROM ai_generation_job
WHERE kind = 'VERNACULAR' ORDER BY "createdAt" DESC LIMIT 3;
```

Assert the job flips `SUCCEEDED`; the probe USER message's `aiPayload` gains
`understanding` (`englishTranslation`, `tone`, `keyFacts`, `via`) — fetch the
conversation as in §5.4 to see it; and the audit trail contains
`ai_understanding.queued` (§9.4). With no translation provider configured the
job retries then lands `FAILED` (audit `ai_generation.exhausted`, entity
`ConversationMessage`) — detection, the offer, and the synchronous keyword
sweep are unaffected either way.

### 5.4 Inspect the persisted conversation

**Request** `GET /api/v1/conversations/<conversationId>` — assert:

- `data.messages` has 6 entries (3 user + 3 assistant)
- last message `aiPayload.asyncState === "COMPLETE"`
- last message `aiPayload.supportFlag.candidate === true` and
  `aiPayload.supportFlag.category === "SUICIDAL_IDEATION"`

### 5.5 Close the conversation → session summary (memory)

**Request** (as Jude):

```http
POST /api/v1/conversations/<conversationId>/close
```

**Expected** `200`. Assert `data.conversation.status === "CLOSED"` and
`data.summaryQueued === true` (the conversation has messages and no summary
yet). Closing is idempotent — repeat the call and assert `summaryQueued ===
false` with no new job.

The close queues a `SUMMARY` job (`kind = "SUMMARY"`, see §6.6) for the AI
worker; within ~1 poll cycle it writes the session summary that feeds
long-term memory recall. Verify:

```sql
SELECT summary, topics, "followUpHook", "emotionalTrend"
FROM session_summary WHERE "conversationId" = '<conversationId>';
```

Assert `summary` is non-empty and `topics` ⊆ the canonical set (`exam`,
`family`, `friendship`, `money`, `health`, `sleep`, `loneliness`, `bullying`,
`identity`, `other`). Summaries pass a low-sensitivity guard before storage —
diagnosis/medication/secrecy/crisis wording never persists; if the guard drops
every sentence, fallback copy is stored instead.

> The `embedding` column (pgvector) is best-effort: with `OPENAI_API_KEY`
> unset it stays `NULL` and memory still works via recency. Recall for the
> **next** conversation = last 2 summaries (30 days) + follow-up hooks (14
> days) + top-2 vector-similar summaries when embeddings exist — carried into
> the model context as `carriedContext`.

> Vernacular USER messages are summarized from their stored English
> `understanding.englishTranslation` (written by the §5.3 worker lane) when
> present, never from the untranslated raw text.

> Idle close: any `ACTIVE` conversation with at least one message, untouched
> for `AI_SESSION_IDLE_MINUTES` (default 120 min), is closed automatically by
> the worker with a SUMMARY job — no endpoint call needed.

---

## 6. Async AI lane (worker retry)

When the first synchronous generation attempt fails, the API returns a holding
message instantly and a DB worker regenerates it. Simulate the outage by
enqueueing a job directly (SQL), exactly as the automated journey does.

**6.1** Send another message ("If I keep being honest — how do I manage exam
week without spiralling?") and `GET /api/v1/conversations/<conversationId>`;
save the last message id as `<placeholderId>`.

**6.2** Resolve Jude's student profile id:

```sql
SELECT id FROM student_profile WHERE "userId" =
  (SELECT id FROM "user" WHERE email = 'jude.michael@miva.edu.ng');
```

**6.3** Enqueue the regeneration (substitute the three ids):

```sql
INSERT INTO ai_generation_job (id, "conversationMessageId", input, status, "nextRetryAt", "createdAt", "updatedAt")
VALUES (gen_random_uuid(), '<placeholderId>', '{
  "studentId": "<judeProfileId>",
  "conversationId": "<conversationId>",
  "checkInId": "<checkInId>",
  "userContent": "If I keep being honest — how do I manage exam week without spiralling?",
  "language": "en",
  "studentRef": "Jude M.",
  "classLabel": "Sociology 300 Level"
}'::jsonb, 'PENDING', now(), now(), now());
```

**6.4** Poll `GET /api/v1/conversations/<conversationId>` every ~2s (≤ 30s).
Assert the target message flips to `aiPayload.asyncState === "COMPLETE"` and
`aiPayload.viaAsyncRetry === true`.

**6.5** Exhaustion probe: repeat with a fresh conversation/message and an insert
that starts exhausted (`"attempts": 3`). Poll again — the placeholder must end
at `aiPayload.asyncState === "FAILED"` (holding message kept).

**6.6** SUMMARY jobs ride the same queue: `POST /close` (§5.5) and the idle
scan enqueue jobs with `kind = "SUMMARY"` and a null
`conversationMessageId`. The worker routes them to the summary writer instead
of reply regeneration (no message rewrite); success flips the job to
`SUCCEEDED`, and after exhausted retries it lands `FAILED` with an audit entry
(`ai_generation.exhausted`, entity `SessionSummary`).

**6.7** VERNACULAR jobs ride it too: each detected non-English USER message
(§5.3) enqueues one with `kind = "VERNACULAR"` and
`conversationMessageId` = that user message. The worker loads the raw message
content, translates it (local N-ATLaS first when `NATLAS_LLM_BASE_URL` is
set, OpenAI fallback, both lanes metered), stores the understanding onto the
message's `aiPayload`, and — when the synchronous pass did not already flag —
re-runs the intent engine on the **English translation** as a second safety
sweep. A hit persists an `AI_CANDIDATE` support flag and audits
`safety_flag.lang_refine` (entity `ConversationMessage`). Terminal failure
audits `ai_generation.exhausted` with entity `ConversationMessage`.

```sql
SELECT kind, status, attempts FROM ai_generation_job
ORDER BY "createdAt" DESC LIMIT 5;
```

---

## 7. Resources, toolbox, journal, activities

### 7.1 Resource catalogue (as Jude)

**Request** `GET /api/v1/resources` — assert `data.items.length >= 5` (seed).
Optional query params: `?category=GROUNDING&type=EXERCISE&search=breath&
savedOnly=true` (`category`/`type` are enums, `search` matches
title/description case-insensitively, `savedOnly=true` restricts to the
student's toolbox).
**Request** `GET /api/v1/resources/tailored` — assert at least 1 item.
Pick a `GROUNDING` resource and save its id as `<resourceId>`.

**Request**

```http
POST /api/v1/resources/toolbox
```

```json
{ "resourceId": "<resourceId>" }
```

**Request** `GET /api/v1/resources/toolbox` — assert `data.count === 1`.

### 7.2 Journal

Limits: `title` ≤ 200 chars (optional), `content` ≤ 5000, `prompt` ≤ 500
(optional — a reflection prompt the student answered).

**Request**

```http
POST /api/v1/journal
```

```json
{
  "title": "Rough day",
  "content": "Long notes about the exam-week haze and the loud hostel.",
  "prompt": "good news"
}
```

**Expected** `201`, save `data.id` as `<entryId>`.

**Request**

```http
PATCH /api/v1/journal/<entryId>
```

```json
{ "content": "Updated: tomorrow gets steadier." }
```

**Expected** `200`, `data.content` contains "steadier".

**Request** `GET /api/v1/journal` — assert `data.items` includes `<entryId>`
(student-private list).

**Request** `DELETE /api/v1/journal/<entryId>` → then `GET /api/v1/journal/<entryId>` → assert `404`.

### 7.3 Wellbeing activities (backend-orchestrated)

The backend records and orchestrates; the frontend renders. The catalogue is
seeded approved + active by `prisma/seed.ts` from
`src/ai/activities/activities.config.ts`; only approved + active rows are
listable, startable, or recommendable — a reviewer un-approving a row in the
DB takes effect without a deploy. Requires the `phase_c_activities` migration
applied.

**Request** `GET /api/v1/activities` — assert `data.items.length >= 6`; cards
carry no `steps` (list is card-only). Optional `?category=GROUNDING`.

**Request** `GET /api/v1/activities/five-senses-grounding` — assert
`data.steps` is the renderer contract: an ordered array of typed steps
(`breath-pacing` / `timer` / `prompt-list` / `body-scan`, Appendix A) and
`data.approved === true`. An unknown or unapproved slug → `404`
`Activity not found`.

**Request** (start a self-directed run, as Jude):

```http
POST /api/v1/activities/box-breathing/sessions
```

```json
{}
```

**Expected** `201`; `data.session.recommendedBy === "SELF"`, and
`data.activity` carries the full steps. Save `data.session.id` as
`<activitySessionId>`. Starting from an AI recommendation passes provenance
instead — same endpoint with
`{ "conversationId": "<conversationId>", "intentId": "ACUTE_PANIC" }` →
`recommendedBy === "AI"`; a `conversationId` that is not Jude's → `404`
`Conversation not found`.

**Request**

```http
PATCH /api/v1/activity-sessions/<activitySessionId>
```

```json
{ "feelingAfter": "CALM", "noteAfter": "Timed it with the hostel lights out." }
```

**Expected** `200`, `data.completedAt` set, `data.feelingAfter === "CALM"`.
The feel-after signal is measurement data: repeat the same PATCH (e.g. with a
different feeling) and assert the record comes back **unchanged** (idempotent,
no overwrite). A session belonging to another student → `404`.

**Request** `GET /api/v1/activities/me/sessions` — assert `data.count >= 1`
and the item includes the activity card (`slug`, `title`, `category`,
`durationSeconds`).

---

## 8. Support request → assignment to a professional

### 8.1 Jude sees the directory and asks for Dr. Ibrahim Musa

**Request** `GET /api/v1/support-requests/people` — assert the array contains a
person named **Dr. Ibrahim Musa**; save `data[i].id` as `<supportPersonId>`.

**Request**

```http
POST /api/v1/support-requests
```

```json
{
  "supportPersonId": "<supportPersonId>",
  "personType": "PSYCHOLOGIST",
  "timing": "TODAY_STUDY_PERIOD",
  "note": "Please, I would like to talk today.",
  "checkInId": "<checkInId>",
  "conversationId": "<conversationId>"
}
```

**Expected** `201`. Assert `data.id` present, `data.status === "PENDING"`.
Save `supportRequestId = data.id`.

> Urgency probe: with `"timing": "URGENT_UNSAFE"` the service creates the
> request directly as `ESCALATED` (system-managed — see §8.2). If you run this
> probe, clean up that row or account for it in the §8.1 list assertion.

Timing values: `GENTLE_1_2_DAYS | TODAY_STUDY_PERIOD | URGENT_UNSAFE`.

**Request** `GET /api/v1/support-requests` — assert Jude sees exactly his own
request (`data.items.length === 1`).

**Request** `GET /api/v1/support-requests/<supportRequestId>` — assert `200`,
`data.id` matches (single-record read).

### 8.2 Ibrahim reviews and accepts (as Ibrahim, `ibrahim.jar`)

**Request**

```http
PATCH /api/v1/support-requests/<supportRequestId>
```

```json
{
  "status": "ACCEPTED",
  "reviewNote": "Jude, come by my office at 10am."
}
```

**Expected** `200`. Assert `data.status === "ACCEPTED"` and `data.reviewNote`
contains "10am". Professionals may only set `ACCEPTED | SCHEDULED |
IN_PROGRESS | COMPLETED | CANCELLED` — `PENDING` and `ESCALATED` are
system-managed (creation / `URGENT_UNSAFE` urgency) and a PATCH attempting
them fails validation (`400`). `reviewNote` ≤ 500 chars.

---

## 9. Professional triage — dashboard, flags, follow-ups, audit, AI config

### 9.1 Counsellor dashboard (as Grace)

**Request** `GET /api/v1/dashboard/counsellor` — assert:

- `data.flags.length >= 1`, first flag `intentId === "SUICIDAL_IDEATION"`
- flag carries `aiContextSummary` (student context for reviewers)
- `data.supportRequests` includes Jude's request
- `data.barometer.total >= 1` (recent check-in counted)

### 9.2 Flag feed + triage states

**Request** `GET /api/v1/support-flags` — assert `data.items` contains a flag
with `severity === "TIER_3_ACUTE"` and `source === "SERVER_POLICY"`;
note `data.openCount`. Save `flagId = data.items[0].id`.
Optional filters: `?severity=TIER_2_HIGH&status=OPEN`.

**Request** `POST /api/v1/support-flags/<flagId>/acknowledge` — assert `201`,
`data.message === "Flag acknowledged"`.

**Request** `POST /api/v1/support-flags/<flagId>/in-review` — assert `201`/`200`.

Flag severities: `TIER_1_MODERATE | TIER_2_HIGH | TIER_3_ACUTE` · sources:
`AI_CANDIDATE | SERVER_POLICY | PROFESSIONAL | SELF_REPORT`. A keyword match
found on a **translated** vernacular message is stamped `AI_CANDIDATE` (the
term matched the English translation, not the raw text) and is traceable by
its `safety_flag.lang_refine` audit entry.

### 9.3 Follow-ups

**Request**

```http
POST /api/v1/follow-ups
```

```json
{
  "studentId": "<judeProfileId>",
  "supportRequestId": "<supportRequestId>",
  "notes": "Booked biweekly catch-up after exams.",
  "dueAt": "2026-10-07T10:00:00.000Z"
}
```

**Expected** `201`, `data.status === "PENDING"`. Save `followUpId`.

**Request** `GET /api/v1/follow-ups` — allowed for **all four roles** (class-level
guard): staff see the follow-ups in their scope, a student sees only their own.
`POST`/`PATCH` remain staff-only (COUNSELLOR, PSYCHOLOGIST, SUPPORT_STAFF).
Assert the new follow-up appears.

**Request**

```http
PATCH /api/v1/follow-ups/<followUpId>
```

```json
{ "status": "SCHEDULED" }
```

**Expected** `200`, `data.status === "SCHEDULED"`.
Follow-up statuses: `PENDING | SCHEDULED | COMPLETED | CANCELLED`.

### 9.4 Audit trail

**Request** `GET /api/v1/audit?limit=30` — assert `data.items[].action` includes:

- `support_flag.auto_created`
- `staff.bootstrap_enrollment`
- `support_request.status_changed`
- `follow_up.created`
- `ai.disclosure_acknowledged`
- `ai_understanding.queued` (from the §5.3 vernacular probe; the follow-up
  `safety_flag.lang_refine` appears only when the second sweep escalates)

### 9.5 AI configuration explainability (as any professional role)

**Request** `GET /api/v1/ai/config` — assert:

- `data.intents` is an array containing `SUICIDAL_IDEATION`; each entry's
  `keywords` list includes the merged vernacular terms (yo/ha/ig/pcm)
- serialized body contains **no secrets** (no `GROQ_API_KEY`, no `OPENAI_API_KEY`)
- current blocks: `promptVersion`, `chain` (`{ "order": ["openai", "groq"] }`),
  `chat`, `openai`, `pricing`, `budget`, `transcription` (Groq Whisper model
  + `natlas` sub-block: sidecar `baseUrl` — `NATLAS_ASR_BASE_URL`, null when
  not deployed — `timeoutMs` — `NATLAS_ASR_TIMEOUT_MS` — and the served
  `languages`, `["yo","ha","ig"]`), `embedding`
  (model + timeout), `memory` (idle close, recall windows, max similar),
  `summaries` (summary output cap), `context`, `async`, `safeguarding`,
  `language` (canonical `supported` codes, `offerEnabled` — `AI_LANGUAGE_OFFER_ENABLED`
  — `vernacularReplyMode` — `AI_VERNACULAR_REPLY_MODE`, `n-atlas-translate`
  by default — N-ATLaS
  endpoint/model — `NATLAS_LLM_BASE_URL`/`NATLAS_LLM_MODEL` — and the
  understanding + render + language-ID output/timeout caps:
  `NATLAS_LLM_TIMEOUT_MS`, `NATLAS_RENDER_TIMEOUT_MS`,
  `NATLAS_IDENTIFY_TIMEOUT_MS`, `renderMaxOutputTokens`,
  `identifyMaxOutputTokens`), `intents`, `canonicalCategories`,
  `canonicalSeverities`, `canonicalTopics`,
  `guardrails` (`input` caps + injection probes, `output` caps + banned claims,
  `rate` per-student limits — see §5.3)
- `data.vernacularKeywords` lists every vernacular term with its language and
  English gloss, and `data.vernacularReviewStatus === "PENDING_CLINICAL_REVIEW"`
  — the clinical reviewer signs off (or amends) these terms before go-live

> With `OPENAI_API_KEY` empty in `.env`, the chain serves Groq; once a real
> key is set, chat generations serve from OpenAI and each generation stamps
> `usage.provider` on the AI payload — visible in §5.4.

### 9.6 Voice transcription

**Request** (as Jude, multipart — not JSON):

```http
POST /api/v1/ai/transcribe
```

```
form-data:
  audio: <file>   (audio/webm, audio/wav, audio/mpeg, audio/mp4, audio/ogg, video/webm; max 10MB)
  language: yo    (optional — forces the route for this request)
```

**Routing** (Phase C step 5) — no `language` field means the student profile's
`preferredLanguage` decides:

| Language | Lane | Notes |
| --- | --- | --- |
| `en` | Provider chain → Groq Whisper | explicit hint sent |
| `pcm` | Provider chain → Groq Whisper | auto-detect, no hint (Whisper has no pcm code) |
| `yo` / `ha` / `ig` | Local N-ATLaS ASR sidecar (`services/n-atlas-asr`) | NCAIR1 whisper-small fine-tunes |
| anything else | `400` | `Unsupported language: <value>` — rejected before any provider call |

**Expected** `200`. Assert `data.text` is a non-empty transcript
(`data.durationSeconds` when available).

**Vernacular without the sidecar** (default dev state — `NATLAS_ASR_BASE_URL`
empty): a `yo`/`ha`/`ig` voice note gets a friendly `503` whose message says
voice notes in that language are not available right now and asks the student
to type instead. No stack trace, no raw provider error. Text chat (including
vernacular text) is unaffected.

**Sidecar dev-run** (optional — spoken-vernacular manual test):

```bash
cd services/n-atlas-asr
python -m venv .venv && . .venv/bin/activate
pip install -r requirements.txt        # needs ffmpeg on PATH
export HF_TOKEN=hf_...                 # NCAIR1 repos are gated (auto-approved)
uvicorn app:app --host 127.0.0.1 --port 8100
```

Then set `NATLAS_ASR_BASE_URL=http://127.0.0.1:8100` (and optionally
`NATLAS_ASR_TIMEOUT_MS`, default `60000` for cold model loads) in `.env` and
re-POST. `GET http://127.0.0.1:8100/health` shows which languages are warm;
first request per language pays a ~10–30s checkpoint load. Recorded fixture
samples and the curl smoke test live in `services/n-atlas-asr/fixtures/`.

### 9.7 Budget meter check (after chat traffic)

```sql
SELECT day, provider, requests, "inputTokens", "outputTokens", "estimatedUsdCents"
FROM ai_usage_daily
WHERE day = CURRENT_DATE
ORDER BY provider;
```

Assert a row exists per provider that served generations today, and
`estimatedUsdCents` follows the pricing shown in `GET /api/v1/ai/config`.

---

## 10. RBAC negative matrix

Every row must produce exactly the stated status **with the stated actor**:

| # | Actor | Request | Expected |
| --- | --- | --- | --- |
| 1 | anonymous | `GET /api/v1/check-ins` | `401` |
| 2 | Jude | `GET /api/v1/support-flags` | `403` |
| 3 | Jude | `GET /api/v1/dashboard/counsellor` | `403` |
| 4 | Jude | `GET /api/v1/audit` | `403` |
| 5 | Jude | `GET /api/v1/ai/config` | `403` |
| 6 | Jude | `POST /api/v1/users` (any valid body) | `403` |
| 7 | Jude | `GET /api/v1/professionals/me` | `403` |
| 8 | Jude | `PATCH /api/v1/support-requests/<supportRequestId>` | `403` (students cannot review their own request) |
| 9 | Grace | `POST /api/v1/ai/disclosure/acknowledge` | `403` (STUDENT-role-only route) |
| 10 | anonymous | `GET /api/v1/ai/disclosure` | `200` (deliberately public, pre-login) |
| 11 | anonymous | `POST /api/v1/uploads/presign` (valid body) | `401` |
| 12 | Jude | `GET /api/v1/schools` | `403` (PLATFORM_ADMIN-only) |
| 13 | Jude | `GET /api/v1/admin/overview` | `403` (PLATFORM_ADMIN-only) |
| 14 | Grace | `GET /api/v1/schools/<schoolId>/overview` | `403` (SCHOOL_ADMIN/PLATFORM_ADMIN-only) |
| 15 | Grace | `POST /api/v1/chat/threads` | `403` (STUDENT-role-only route) |
| 16 | Jude | `POST /api/v1/chat/threads/<threadId>/claim` | `403` (staff-role-only route) |
| 17 | School admin | `GET /api/v1/admin/analytics` | `403` (PLATFORM_ADMIN-only) |
| 18 | School admin | `POST /api/v1/schools/<schoolId>/admins` | `403` (owner-only — school admins cannot mint peers) |
| 19 | School A admin | `GET /api/v1/schools/<schoolBId>/analytics` | `403` `SCHOOL_ACCESS_DENIED` |

---

## 11. Sign-out invalidates sessions

For each persona (Jude, Grace, Ibrahim, Tunde), in order:

**Request** `POST /api/auth/sign-out` — assert `200`.
**Request** `GET /api/users/me` with the same (now stale) cookie jar — assert `401`.

---

## 12. File uploads (object storage)

Two routes, one layout: every object lands at `uploads/<userId>/<uuid><ext>` —
the extension is derived from the declared MIME type, never from the
client-supplied filename. Both routes require the S3/RustFS block
(`S3_ENDPOINT`, `S3_REGION`, `S3_BUCKET`, `S3_ACCESS_KEY`, `S3_SECRET_KEY` —
docs/DEPLOYMENT.md §4); on a deployment without it both answer the friendly
`503` described below and nothing else changes.

Allowlisted types (both routes, max 10MB): `audio/webm`, `audio/wav`,
`audio/wave`, `audio/x-wav`, `audio/mpeg`, `audio/mp3`, `audio/mp4`,
`audio/m4a`, `audio/ogg`, `image/jpeg`, `image/png`, `image/webp`,
`application/pdf`.

### 12.1 Multipart upload (bytes transit the API)

**Request** (as Jude, multipart — not JSON):

```http
POST /api/v1/uploads
```

```
form-data:
  file: <file>   (allowlisted type; max 10MB)
```

**Expected** `201`. Assert `data.key` matches `uploads/<userId>/<uuid>.<ext>`,
`data.size` equals the uploaded byte count, and `data.contentType` echoes the
part's MIME type. The API buffered the file and forwarded it to storage in one
PUT — fine for small files, but the bytes transit Node; prefer §12.2 for
anything large.

### 12.2 Presigned direct upload

**Request** (as Jude, JSON):

```http
POST /api/v1/uploads/presign
```

```json
{ "contentType": "image/jpeg", "size": 284313 }
```

**Expected** `201`. Assert `data.key` (same shape as §12.1),
`data.expiresInSeconds === 900`, and `data.uploadUrl` pointing at the
configured `S3_ENDPOINT` (path-style: `/natlas-uploads/uploads/<userId>/...`)
with `X-Amz-SignedHeaders=content-length;host`.

Then the client PUTs the bytes **straight to storage** — same Content-Type as
declared, and **exactly** `size` bytes (the signed `content-length` means any
other byte count is rejected by storage with `403 SignatureDoesNotMatch`):

```bash
curl -sS -X PUT "<uploadUrl>" \
  -H "Content-Type: image/jpeg" \
  --data-binary @photo.jpg
```

Verify the object (RustFS console at `https://s3.<domain>`, or the AWS CLI):
`aws --endpoint-url https://s3.<domain> s3 ls s3://natlas-uploads/uploads/<userId>/ --recursive`.
The bucket is private — objects are readable only through a signed URL.

**Negatives**:

| Request | Expected |
| --- | --- |
| `POST /api/v1/uploads` with `file` type `text/plain` | `400` — `Unsupported file type: text/plain` |
| `POST /api/v1/uploads` with >10MB file | `400` — the 10MB cap (the route check or the global multipart limit, whichever fires first) |
| `POST /api/v1/uploads` without a `file` part | `400` — `file is required` |
| `POST /api/v1/uploads/presign` `{"contentType":"text/html","size":100}` | `400` — Validation failed (allowlist) |
| `POST /api/v1/uploads/presign` `{"contentType":"image/jpeg","size":0}` | `400` — Validation failed (min 1) |
| `POST /api/v1/uploads/presign` `size` > `10485760` | `400` — Validation failed (max) |
| Either route on a deployment without `S3_*` | friendly `503` — uploads "not available right now", no stack trace |

---

## 13. School tenancy & human chat (`SCHOOL_TENANCY_001` → `DOCS_008`)

The multi-tenant lane. A **School** is the tenant: every onboarded user belongs
to exactly one school, schools are created/suspended by the platform owner, and
school accounts are onboarded with a school-wide **default password** that each
account must replace at first sign-in. Students can open **human chat**
requests that pool for the school's professionals — separate from the AI
conversations in Chapter 5 and containing **no AI replies** (only the thread's
entry note is AI-composed from check-in context). REST is the transport for
every write here; Socket.IO (§13.8) is push-only.

### 13.1 Platform owner (seed bootstrap)

The owner account is created by `prisma/seed.ts` from `PLATFORM_ADMIN_EMAIL` /
`PLATFORM_ADMIN_NAME` / `PLATFORM_ADMIN_PASSWORD` (env; the bootstrap is
skipped entirely when unset). `EMAIL` and `NAME` accept comma-separated
lists — matched by position, an entry without a name falls back to a generic
one — so a single seed run enrolls several owners. Sign in normally
(`POST /api/auth/sign-in/email`, own cookie jar) and assert
`role === "PLATFORM_ADMIN"`.

### 13.2 Platform console — schools

**Request** (as the owner)

```http
POST /api/v1/schools
```

```json
{ "name": "Riverside Academy", "defaultPassword": "Riverside#2026" }
```

**Expected** `201`. Assert `data.status === "ACTIVE"` and `data.shortCode` is
6 characters from the unambiguous charset (`ABCDEFGHJKMNPQRSTUVWXYZ23456789`)
starting with up to 3 letters of the school-name acronym (`RA……` for
"Riverside Academy"). The `defaultPassword` is hashed (scrypt) on arrival —
never returned, never logged. It is optional, but a school without one cannot
onboard users until §13.3 sets it.

| Request (as owner) | Expected |
| --- | --- |
| `GET /api/v1/schools` | `200` — `data.items[]` with `id`, `name`, `shortCode`, `status`, `createdAt`, `_count.users` |
| `PATCH /api/v1/schools/<schoolId>` `{"name":"..."}` | `200` — rename; `shortCode` never changes |
| `POST /api/v1/schools/<schoolId>/suspend` | `200` — `{id, status: "SUSPENDED"}` (semantics in §13.7); idempotent |
| `POST /api/v1/schools/<schoolId>/reactivate` | `200` — `{id, status: "ACTIVE"}`; idempotent |
| `GET /api/v1/admin/overview` | `200` — `data.schools {total, active, suspended}`, `data.users {total, students, professionals, admins, newLast7d, newLast30d}`, `data.chat.pendingRequests` |
| `GET /api/v1/admin/users?limit=50` | `200` — `data.items[]` across all schools (each with `school {id, name, shortCode}`); `limit` default 50, max 100 |

### 13.3 School-scoped user management

Every route below is `SCHOOL_ADMIN` or `PLATFORM_ADMIN`; a school admin scoped
to a different school is rejected with `403`. The one exception is
`POST /api/v1/schools/<schoolId>/admins` — minting a school admin is
**owner-only** (`PLATFORM_ADMIN`); a school admin calling it gets `403`.

**Request** — set the school-wide default password:

```http
PATCH /api/v1/schools/<schoolId>/settings
```

```json
{ "defaultPassword": "Riverside#2026" }
```

**Expected** `200`, `data.defaultPasswordUpdated === true`. Applies to accounts
onboarded from now on; existing accounts keep their personal passwords.

**Request** — onboard a student:

```http
POST /api/v1/schools/<schoolId>/students
```

```json
{
  "email": "ama.mensah@e2e.natlas.test",
  "firstName": "Ama",
  "lastName": "Mensah",
  "classLabel": "JHS 2B",
  "preferredLanguage": "en"
}
```

**Expected** `201`. Assert `data.user.role === "STUDENT"`, `data.studentCode`
matches `<shortCode>-<4 digits>`, and `data.verificationEmailSent === true`
(the school-branded verification mail — **the default password is never
emailed**; the school distributes it). Negatives:

| Probe | Expected |
| --- | --- |
| onboard before the school has a default password | `422` `SCHOOL_DEFAULT_PASSWORD_REQUIRED` |
| duplicate email | `409`/`422` (email already in use) |
| unknown `role` value in the list route filter | `422` "Unknown role filter" |

**Request** — onboard a professional:

```http
POST /api/v1/schools/<schoolId>/professionals
```

```json
{
  "email": "kojo.ashanti@e2e.natlas.test",
  "name": "Dr. Kojo Ashanti",
  "role": "COUNSELLOR",
  "title": "Senior Counsellor",
  "department": "Guidance & Counselling"
}
```

`role` ∈ `COUNSELLOR | PSYCHOLOGIST | SUPPORT_STAFF`. **Expected** `201` with
`{user, verificationEmailSent}` — same default-password + verification flow as
students.

**Management routes**:

| Request | Expected |
| --- | --- |
| `GET /api/v1/schools/<schoolId>/overview` | `200` — `{students, professionals, totalUsers, pendingChatRequests}` |
| `GET /api/v1/schools/<schoolId>/users?role=STUDENT` | `200` — `data.items[]` incl. `studentProfile`/`professionalProfile` and onboarding state (`emailVerified`, `mustChangePassword`, `deactivatedAt`); filter ∈ `STUDENT | SCHOOL_ADMIN | COUNSELLOR | PSYCHOLOGIST | SUPPORT_STAFF` |
| `PATCH /api/v1/schools/<schoolId>/users/<userId>` `{name?, phone?, classLabel?, preferredLanguage?, title?, department?}` | `200` — `{updated: true}` (user + matching profile fields) |
| `DELETE /api/v1/schools/<schoolId>/users/<userId>` | `200` — `{id, deactivated: true}` — soft removal: sessions revoked at once, sign-in `403` `ACCOUNT_DEACTIVATED`, history kept |
| `POST /api/v1/schools/<schoolId>/users/<userId>/reactivate` | `200` — `{id, deactivated: false}` |

### 13.4 First sign-in — forced password change

Strict order (a skipped step breaks the rest):

1. **Verify** — read the dev link (§0.3) for the onboarded email and consume
   only its path+query with that persona's jar (auto sign-in sets the cookie).
2. **Sign in with the school default password** — `POST /api/auth/sign-in/email`
   → `200`. Sign-in is deliberately allowed while `mustChangePassword` (it is
   part of onboarding), but every app route except the allowlist below is shut.
3. **Check your standing** — `GET /api/v1/users/me` → `200`; assert
   `data.mustChangePassword === true`, `data.emailVerified === true`, and
   `data.school` = `{id, name, shortCode}`.
4. **Probe the lock** — any other `v1` route, e.g. `GET /api/v1/chat/unread`,
   → `403` `PASSWORD_CHANGE_REQUIRED`. The allowlist is exactly
   `GET /api/v1/users/me` + `POST /api/v1/auth/first-password`.
5. **Set your own password** — no old password is requested:

```http
POST /api/v1/auth/first-password
```

```json
{ "newPassword": "AmaPersonal123#" }
```

**Expected** `200`, `data.passwordChanged === true`. The current session
survives; every other session of the account is revoked. The old default now
`401`s at sign-in and all routes unlock. On an account not flagged
`mustChangePassword` the route answers `403` `PASSWORD_CHANGE_NOT_REQUIRED`.

### 13.5 Human chat (students ↔ professionals)

A thread walks `PENDING` (request, sitting in the school's shared pool) →
`ACTIVE` (claimed by exactly one professional) → `CLOSED`. REST for every
write; Socket.IO (§13.8) for live push.

**Request** (as the student) — ask to talk:

```http
POST /api/v1/chat/threads
```

```json
{ "note": "Exams are piling up and I can't sleep", "checkInId": "<checkInId>" }
```

Both fields optional — `checkInId` defaults to the student's latest check-in.
**Expected** `201`. Assert `data.status === "PENDING"`, `data.aiEntrySummary`
equals the first message's `content`, that message has `role === "SYSTEM"` and
`meta.composedByAi` (boolean), and `data.studentReadAt` is set. The entry note
is composed from check-in **context only** (name, class, feeling) — the
check-in description and the raw note never leak into it.

Negatives: a second open request → `409` `PENDING_REQUEST_EXISTS`; an account
with no school → `422` `NO_SCHOOL`; a suspended school → `403`
`SCHOOL_SUSPENDED`.

**Request** (as a professional) — the shared pool:

```http
GET /api/v1/chat/inbox
```

**Expected** `200`, `data.items[]` = the school's PENDING requests, **oldest
first**, each with `student {firstName, lastName, classLabel, studentCode}`.

**Request** — claim (first professional wins):

```http
POST /api/v1/chat/threads/<threadId>/claim
```

**Expected** `201`. Assert `data.status === "ACTIVE"` and the professional
branch populated (`title`, `department`, `user.name`). The race is safe: the
second claimer gets `409` `CHAT_THREAD_TAKEN`; a cross-school thread id is
indistinguishable from a missing one (`404`).

**Request** — send a message (either participant):

```http
POST /api/v1/chat/threads/<threadId>/messages
```

```json
{ "content": "I'm here — tell me more about your nights.", "viaVoice": false }
```

**Expected** `201`. Assert `data.role` (`STUDENT` or `PROFESSIONAL`),
`data.senderUserId`, `viaVoice`, and the stored `createdAt`. Voice replies
arrive with `viaVoice: true` — text transcribed by the app via the §9.6 voice
lane first; this route never touches audio. Negatives: before claim → `409`
`CHAT_NOT_CLAIMED`; after close → `409` `CHAT_THREAD_CLOSED`; non-participant
→ `404`; over the per-user send rate limit (`CHAT_RATE_LIMIT_PER_MINUTE`,
default 30/min — rejected sends consume no budget) → `429`.

**Remaining routes**:

| Request | Expected |
| --- | --- |
| `GET /api/v1/chat/threads` | `200` — students: own threads; staff: the ones they claimed; items carry the last message + counterpart summary |
| `GET /api/v1/chat/threads/<threadId>` | `200` — full thread, `messages` ascending; participants only (`404` otherwise) |
| `POST /api/v1/chat/threads/<threadId>/read` | `200` — `{id, read: true}`; drives the unread badge |
| `GET /api/v1/chat/unread` | `200` — `{total, byThread}` true counts (the 99+ display cap is client-side); zero-unread threads are omitted from `byThread` |
| `POST /api/v1/chat/threads/<threadId>/close` | `200` — `{id, status: "CLOSED"}`; idempotent; both sides then get `409` on send |

### 13.6 Notifications (REST side)

| Request | Expected |
| --- | --- |
| `GET /api/v1/notifications` | `200` — newest first, 50 max; `?unread=true` filters |
| `GET /api/v1/notifications/unread-count` | `200` — `{count}`; initial load / reconnect fallback for the badge |
| `POST /api/v1/notifications/<notificationId>/read` | `200` — `{id, read: true}`; idempotent |
| `POST /api/v1/notifications/read-all` | `200` — `{readAll: true}` |

Types produced by this lane: `CHAT_REQUEST` (each active professional on a new
request), `CHAT_CLAIMED` (student), `CHAT_REPLY` (the counterpart, preview
≤ 120 chars), `SCHOOL_SUSPENDED` (every school user, explaining the
suspension).

### 13.7 Suspension & deactivation semantics

`POST /api/v1/schools/<schoolId>/suspend` (as the owner), observed from inside
the school:

1. Every session under the school is revoked **immediately** — any stale jar
   now gets `401` on its next request.
2. Sign-in answers `403` `SCHOOL_SUSPENDED`.
3. Live sockets are hard-disconnected server-side (the client sees
   `disconnect`; reconnection attempts keep failing while suspended).
4. Every school user has a durable `SCHOOL_SUSPENDED` notification waiting
   (readable after reactivation).
5. `POST .../reactivate` restores sign-in and sockets; nothing else changes.

Single-user `DELETE /api/v1/schools/<schoolId>/users/<userId>` behaves the
same per-account: sessions cut, sign-in and next requests `403`
`ACCOUNT_DEACTIVATED` until reactivated.

### 13.8 Socket.IO (push-only surface)

- **Path** `/api/socket.io` (use the `websocket` transport), **auth = the
  session cookie**. Same-origin browsers send it automatically; cross-origin
  clients need credentials (`withCredentials: true` / `extraHeaders` with the
  cookie). There is no separate socket token.
- After the handshake the server re-verifies from the DB and drops clients
  whose account is deactivated, flagged `mustChangePassword`, or in a
  suspended school — a valid cookie alone is not enough.
- **Rooms** (server-side; clients never join explicitly):
  `user:<userId>` for personal pushes and `school-professionals:<schoolId>`
  for pool pushes. Every broadcast is room-targeted — a user who is not in
  the room receives nothing at all.
- Push-only: all writes stay on REST; sockets carry no acknowledgements.

**Event table**:

| Event | Room | Payload | Fired when |
| --- | --- | --- | --- |
| `chat.request.created` | `school-professionals:<schoolId>` | `{threadId, student: {firstName, classLabel}, pendingCount}` | a student creates a request |
| `chat.thread.claimed` | the student's `user:<id>` + the school pros room | `{threadId, professionalName}` | a claim wins |
| `chat.message.new` | both participants' `user:<id>` rooms | `{threadId, message: {id, role, content, viaVoice, createdAt}}` | a message is sent (the sender is echoed too) |
| `chat.thread.closed` | both participants | `{threadId}` | either side closes |
| `chat.unread.updated` | the user whose badge changed | `{total, byThread}` | on send (recipient) and on read (self) |
| `notification.new` | the recipient | `{id, type, title, body, data}` | any notification row is created |
| `notification.unread.updated` | the recipient | `{count}` | their unread count changes |

**Smoke test** (Node — `socket.io-client` is already a devDependency):

```js
import { io } from 'socket.io-client';

const socket = io('http://localhost:3000', {
  path: '/api/socket.io',
  transports: ['websocket'],
  extraHeaders: { cookie: 'better-auth.session_token=<from sign-in>', origin: 'http://localhost:3000' },
});
socket.on('connect', () => console.log('connected'));
socket.on('chat.message.new', (payload) => console.log('push', payload));
```

With two sockets (student + professional), walk §13.5 and watch: request →
school pros room; claim → student + pros room; message → both; read →
`chat.unread.updated`; close → both; then suspend the school — every school
socket in the room dies while a second school's sockets are untouched.

---

## 14. Admin & school dashboards (`ANALYTICS_009` → `DASH_DOCS_012`)

The dashboard lane: windowed analytics for the platform owner and each school,
activity feeds over the audit log, school settings, the chat-thread register,
owner-only school-admin provisioning, the reset-to-default password flow —
plus the closed sign-up door. Actors: the platform owner (§13.1) and a
**school admin** (provision one in §14.5, or reuse `<schoolAdminEmail>` from
a §13 run).

### 14.1 Platform analytics

**Request** (owner):

```http
GET /api/v1/admin/analytics
GET /api/v1/admin/analytics?days=14
GET /api/v1/admin/analytics?days=30
GET /api/v1/admin/analytics?days=90
```

**Expected** `200` for all four. `data.windowDays` echoes the normalized
window: `days` is validated against `[14, 30, 90]` and anything else (`7`,
`abc`, empty) falls back to `14` — never a `400`. Assert:

- `series` has exactly `windowDays` rows, one per **UTC day**, oldest first:
  `{date: "YYYY-MM-DD", newUsers, checkIns, chatThreads, chatMessages}`.
  The last row is today; every cell is an integer ≥ 0.
- `deltas` has exactly those four counter keys, each `{current, previous,
  pct}` — fixed **7d vs previous 7d** sums sliced from the series (every
  window is ≥ 14 days, so both segments are always complete). `pct` is
  `null` exactly when `previous === 0`; otherwise it is
  `round((current − previous) / previous × 1000) / 10`.
- `mood` = `{total, distribution}` with **all eight** student faces always
  present (zeros included): `GREAT, NORMAL, SAD, ANGRY, CONFUSED,
  INDIFFERENT, STRANGE, DISTRAUGHT`. `total` equals the distribution sum.
  The backend folds the 12 `FeelingLabel` values into the nearest face
  (`ANXIOUS → STRANGE`, `OVERWHELMED → CONFUSED`, `TIRED → INDIFFERENT`,
  `STRESSED → DISTRAUGHT`, …) so no check-in is ever dropped.
- `weekday` is exactly `[MON..SUN]` in order, each `{weekday, count}`.

Write fresh data first (a check-in §5.1, a chat request §13.5): today's
`checkIns` / `chatThreads` cells, `mood.distribution.STRANGE` (for
`ANXIOUS`) and today's weekday bar each move by ≥ 1. Buckets are UTC days —
around midnight assert `≥`, not `==`.

### 14.2 School analytics (roster + onboarding)

**Request** (school admin, own school):

```http
GET /api/v1/schools/<schoolId>/analytics?days=30
```

**Expected** `200`. Same shape as §14.1 (including the fallback ladder) plus
two school blocks:

- `roster` = `{students, professionals, admins, deactivated}` — live counts;
  professionals = COUNSELLOR + PSYCHOLOGIST + SUPPORT_STAFF; admins =
  SCHOOL_ADMIN + PLATFORM_ADMIN; `deactivated` counts `deactivatedAt`.
- `onboarding` = `{incomplete, percentComplete}` — `incomplete` counts
  accounts still on the default password (`mustChangePassword`) or
  unverified (`emailVerified: false`); `percentComplete` carries one decimal
  and a school with **no users** reports `100` (nothing left to onboard).

Onboard one student (§13.3) into a school whose only member is the admin →
`{incomplete: 1, percentComplete: 50}`; after the student verifies and
completes the forced first-password flow (§13.4) → `{incomplete: 0,
percentComplete: 100}`.

Isolation: a second school with no activity answers `roster.students = 0`,
`mood.total = 0` and all-zero series cells — nothing of school A leaks into
school B.

**Negatives**:

| Request | Expected |
| --- | --- |
| School A admin on `GET /api/v1/schools/<schoolBId>/analytics` | `403` `SCHOOL_ACCESS_DENIED` |
| Owner on a random UUID school | `404` |

### 14.3 Activity feeds

**Request** (owner / school admin):

```http
GET /api/v1/admin/activity?limit=20&kind=chat
GET /api/v1/schools/<schoolId>/activity?kind=people
```

**Expected** `200`, `data.items[]` newest first —
`{id, action, kind, entity, entityId, meta, createdAt, actor, school}`.
`actor`/`school` are label objects (`{id, name[, shortCode]}`) or `null`
(seeded/system rows; a deleted school's rows keep `school: null` — the FK is
`ON DELETE SET NULL`). Known actions render with a `kind`:

| `kind` | Actions |
| --- | --- |
| `schools` | `school.created`, `school.renamed`, `school.suspended`, `school.reactivated`, `school.settings_updated` |
| `people` | `school.student_enrolled`, `school.professional_enrolled`, `school.admin_enrolled`, `school.user_updated`, `school.user_deactivated`, `school.user_reactivated`, `school.user_password_reset`, `staff.bootstrap_enrollment` |
| `chat` | `chat.thread_created`, `chat.thread_claimed`, `chat.thread_closed` |

`kind` defaults to `all` (every listed action); an unknown value → `422`.
`limit` defaults 50, capped at 100. The school feed is school-scoped: assert
every row's `school.id` is that school (or `null` for rows whose school was
later deleted) and that a second school's events never appear. Assert by
**finding your known rows by id**, not by counting — stale audit rows from
earlier runs persist.

### 14.4 School settings

**Request** (school admin):

```http
GET /api/v1/schools/<schoolId>/settings
```

**Expected** `200` — `{id, name, shortCode, status, createdAt,
hasDefaultPassword}`. The response never contains a hash or the plaintext.

**Request** (school admin):

```http
PATCH /api/v1/schools/<schoolId>/settings
```

```json
{ "defaultPassword": "NewDefault#2026" }
```

**Expected** `200` — `{defaultPasswordUpdated: true}`. The scrypt hash is
replaced immediately and applies to every onboarding (§13.3, §14.5) and
reset (§14.6) from now on; existing accounts keep their personal passwords.
Negative: a password under 8 chars → `400` (Validation failed).

### 14.5 Provision a school admin (owner-only)

**Request** (owner):

```http
POST /api/v1/schools/<schoolId>/admins
```

```json
{ "name": "Efua Boateng", "email": "efua@school.test" }
```

**Expected** `201` — `data.user {id, name, email, role: "SCHOOL_ADMIN"}` +
`data.verificationEmailSent` (best-effort, SMTP-dependent). The account
carries the school default password and the branded verification email (the
starter password is never emailed). Verify (§0.3) → sign in with the default
→ `403` `PASSWORD_CHANGE_REQUIRED` on any route outside the allowlist →
`POST /api/v1/auth/first-password` (§13.4) → full school-admin access.

Deliberately owner-only: the same call as a school admin → `403`
(PLATFORM_ADMIN-only) — school admins cannot mint peers.

### 14.6 Reset a school user to the default password

**Request** (school admin):

```http
POST /api/v1/schools/<schoolId>/users/<userId>/reset-password
```

**Expected** `201` — `{id: "<userId>", passwordReset: true}`. Side effects:
credential password back to the **current** school default (§14.4 updates
what "current" means), `mustChangePassword` re-armed, every session revoked
(the target's next request `401`). The §14.2 onboarding tile returns to
incomplete and the next sign-in lands on the forced first-password flow.

**Negatives**:

| Request | Expected |
| --- | --- |
| School admin resets their own id | `403` `SELF_TARGET_FORBIDDEN` |
| Target user id from another school (path = own school) | `404` |
| School with no default password set | `422` `SCHOOL_DEFAULT_PASSWORD_REQUIRED` |

### 14.7 Enriched registers

`GET /api/v1/schools` (owner) carries per-school gauges beyond `_count.users`:
`students`, `professionals`, `pendingChats` (live `PENDING` threads) and
`lastActivityAt` — the newest session `updatedAt` across the school, i.e.
real sign-ins, not data writes; `null` until someone signs in.

`GET /api/v1/admin/users` (owner) returns `{items, total}` with filters:
`role` (unknown value → `422`), `schoolId`, `q` (name/email, contains, case
insensitive), `limit` (default 50, max 100) and `offset`. Rows include the
`school {id, name, shortCode}` label.

### 14.8 Sign-up lock (`SIGNUP_LOCK_011`)

`POST /api/auth/sign-up/email` with any body → **always** `400`
`EMAIL_PASSWORD_SIGN_UP_DISABLED` — the uniform answer for new and existing
emails alike, so the route cannot probe which accounts exist. Every account
enters by provisioning instead: §2.1 staff bootstrap, §13.2 platform schools,
§13.3 students/professionals, §14.5 school admins.

### 14.9 Automated coverage

`test/e2e-dashboards.mjs` (`npm run test:e2e:dashboards`, server on :3000)
walks this chapter live: the owner analytics ladder + shapes, school
provisioning → admin minting → forced first password, student onboarding
(50% → 100% tiles), check-in + chat reflected in the analytics, activity
feeds with kind filters, settings + the reset-password roundtrip, enriched
registers, and the §10 rows 17–19 fences.

### 14.10 Pilot analytics & aggregate report (`PILOT_ANALYTICS_001`)

Aggregate-first pilot view for the owner — “how is Soul Nurture performing
across the pilot?”, never at students. Every number rolls up a shared events
union (check-ins, AI turns, human chat, activities, toolbox saves, support
requests) over **active** students; spoken AI turns are split out via the new
`conversation_message.viaVoice` flag.

**Requests** (owner):

```http
GET /api/v1/admin/pilot
GET /api/v1/admin/pilot?days=30
GET /api/v1/admin/pilot?from=2026-09-01&to=2026-09-30
GET /api/v1/admin/pilot?days=90&schoolId=<schoolId>
GET /api/v1/admin/pilot/report?from=2026-09-01&to=2026-09-30
```

**Window** — `days` presets run 1–366 (default **30**, clamped; junk falls
back) and end at UTC today; a `from`/`to` pair (YYYY-MM-DD, **inclusive**)
covers custom and pilot-period ranges. The pair must be supplied together, be
calendar-valid, not invert and not span more than 366 days — violations are
`400`s before any query runs. Optional `schoolId` (UUID) scopes every block to
one school; unknown or non-UUID ids are `404`s.

**Expected** `200` envelope; `data`:

- `window` = `{from, to, days}`; `school` = `{id, name, shortCode}` or
  `null`; `suppression` = `{threshold: 5, note}`.
- `overview` KPI cards: `studentsOnboarded` (all-time), `newStudents`,
  `activeStudents`, `checkIns`, `aiInteractions`, `voiceInteractions`
  (AI + human spoken turns), `resourcesAccessed` (toolbox saves),
  `supportRequests`, `completedReferrals` (closed chat threads + completed
  follow-ups); `avgSatisfaction` = `{available: false, reason}` until survey
  data exists.
- `engagement`: `{active, dau, wau, mau, new, returning, returnRate,
  checkInsPerActiveStudent, avgSessionsPerStudent, avgSessionMinutes,
  textVsVoice: {text, voice}, series}` — DAU is the last window day, WAU/MAU
  clamp to the window; `returnRate` (%, prior actives seen again) is `null`
  without a prior baseline; `series` is one zero-filled
  `{date, activeUsers, checkIns}` row per UTC day.
- `featureUsage`: exactly seven rows (`check_in`, `ai_chat`, `voice`,
  `reflection`, `resources`, `human_support`, `profile`) carrying
  `{uses, students, suppressed}`; `profile` reports `{available: false, note}`
  (no server-side event yet).
- `wellbeingThemes`: the eight self-reported themes (`academic_pressure`,
  `social_peer`, `family`, `loneliness`, `self_confidence`, `overwhelm`,
  `relationships`, `other`) with `{mentions, students, suppressed}` folded from
  check-in triggers and summary topics — themes, never diagnoses.
- `resources`: `mostSaved` (top 8), `byCategory`, `savesSeries`, and
  `activities` `{started, completed, completionRate}`; the `note` records that
  views are not instrumented yet.
- `support`: `requests` `{total, urgent, byStatus}` (all seven statuses
  zero-filled), `referrals` `{created, claimed, closed, avgClaimHours}`,
  `followUps` `{completed, open}`, `unresolved` (not COMPLETED/CANCELLED) and
  a daily `series`.
- `safeguarding`: `flags` `{total, bySeverity, byStatus}` (zero-filled),
  `escalations`, `urgentRequests`, `followUpStatus` `{open, resolved}` and
  `avgResolutionHours`.
- `outcomes`: `{available: false, reason}` — pre/post deltas appear only once
  comparable survey baselines exist.

**Suppression** — any breakdown cell backed by **1–4 distinct students**
answers `{students: null, suppressed: true}`; `0` stays `0` and totals are
never suppressed.

**CSV export** — `GET /api/v1/admin/pilot/report` with the same query params
answers a raw `text/csv` attachment (`soul-nurture-pilot-<from>_<to>
[-<shortCode>].csv`) **bypassing the JSON envelope**: a
`Section,Metric,Value` table for Window / Pilot Reach / Engagement / Feature
Usage / Wellbeing Trends / Resources / Support / Safeguarding / Outcomes,
suppressed cells rendered `suppressed (<5)`, unavailable metrics as
`not available — …`. Aggregate only — no PII.

**Negatives**: `from` without `to` (or the reverse), inverted dates,
`2026-02-31`-style dates and > 366-day spans → `400`; unknown or malformed
`schoolId` → `404`; a school-admin session → `403` (the tree is
`@Roles('PLATFORM_ADMIN')`).

**Live note** — the voice KPIs only move once clients post spoken turns with
`viaVoice: true` (transcript in `content`; §13.5 does this for human chat, the
AI journey client sends it from the pilot build onward).

---

## 15. AI response reports, reviewer decisions and the boundary marker

Two related but separate surfaces: what a student can say about a reply they
were given, and what the server already knows about a turn that left the AI's
remit. Neither creates a support request, a flag, a notification or an AI job.

### 15.1 Student reports one assistant reply

`POST /api/v1/ai-response-reports` — `@Roles('STUDENT')`, body
`{ messageId, expectedContent, note? }` (`note` ≤ 2000 chars, omitted/blank
stores `null`).

**Expected** `200` envelope; `data` = `{ report, alreadyReported }`. `report`
is the immutable snapshot and carries **exactly** `id`, `messageId`,
`conversationId`, `responseContent`, `responseLanguage`, `note`, `createdAt` —
never a reviewer's decision.

- Only an `ASSISTANT` message in the caller's own school-linked conversation
  can be reported; `user`/`system`, foreign and missing ids → `404`.
- `expectedContent` must equal the stored message text at submit time,
  otherwise `409` with `code: RESPONSE_CHANGED` and no write. This is what
  stops a report attaching to a reply the async worker has already replaced.
- One report per message: a retry (even with different `note`, and even after
  the worker replaced the message) returns the original snapshot with
  `alreadyReported: true` and writes no second audit.
- Success writes the report plus one metadata-only `audit_log` row
  (`ai_response_report.created`, no `meta`). If the audit write fails the
  report is rolled back with it.

### 15.2 Student receipts

`GET /api/v1/ai-response-reports/mine?conversationId=<uuid>` — `STUDENT` only,
own conversation (foreign → `404`). Returns `{ items: [{ id, messageId,
createdAt }] }` — enough to show "you reported this", nothing of the note, the
text or any review.

### 15.3 Reviewer reads (same school only)

`GET /api/v1/ai-response-reports?limit&offset` and
`GET /api/v1/ai-response-reports/:id` — `COUNSELLOR` / `PSYCHOLOGIST`.
Reading records nothing. The reviewer projection adds `reviewOutcome`,
`reviewedAt` and `reviewedBy: { name, role }` (reviewer identity only — no
email, phone or school id). Tenancy follows the student's current
`User.schoolId`, so a transfer moves the report to the new school's queue and
out of the old one without any data change. Foreign/missing id → `404` (a
tenant boundary must not confirm the row exists); a non-reviewer role → `403`;
a reviewer with no school issues no tenant query and gets `404`.

### 15.4 Record-only reviewer decision

`PATCH /api/v1/ai-response-reports/:id/review` — `COUNSELLOR` /
`PSYCHOLOGIST`, body `{ outcome }` where `outcome` is
`NO_CHANGE_NEEDED | FOLLOWED_UP_WITH_STUDENT | CANNOT_ASSESS` (nothing else is
accepted; an extra `note`, `schoolId` or `status` → `400`).

**Expected** `200` envelope with the reviewer projection of the report. The
endpoint stores the decision, the reviewer and the timestamp on the report row
and writes one `audit_log` row (`ai_response_report.review_recorded`,
`meta: { outcome }`, the reviewer's school). Repeating the same outcome as the
same reviewer is idempotent — no write, no second audit; a different outcome
replaces it (last decision wins, each decision keeps its own author and audit).

Deliberately absent: no AI call, no reply rewrite, no message or `aiPayload`
change, no support request, flag, notification or follow-up, and no visibility
to the student — §15.1/§15.2 projections stay review-free even after a
decision is recorded.

### 15.5 `boundary` — the server's own record of why a turn left the AI's remit

`aiPayload.boundary` on an assistant message is `null` when the reply stayed
inside the AI's remit, and otherwise one of:

- `{ kind: 'OUT_OF_SCOPE', intentId: null }` — the guardrail output lane
  replaced the model's own words with scripted copy because it claimed
  something banned (diagnosis, medication, certification, a safety promise, a
  human identity), or stripped every sentence of the reply.
- `{ kind: 'ACUTE_SAFEGUARD_ROUTE', intentId: '<INTENT>' }` — a `TIER_3_ACUTE`
  safeguarding rule fired and the turn went to the school's professionals. When
  a turn does both, the acute referral wins: it is the louder truth.

The field is server-owned like `asyncState` — normalised to `null` and never
trusted from the model. On the async lane the holding placeholder already
carries an acute boundary, so a student sees the "not an emergency service"
notice immediately instead of after the worker finishes. `boundary` lives in
`aiPayload`, which `/review-context` excludes, so it is a student-facing notice
rather than a reviewer signal. Reviewers who want to know which rules exist at
all read them from `GET /api/v1/ai/config` (§9.5) — the banned claims and the
per-intent actions are the same data the enforcement uses.

---

## Appendix A — Enum reference

| Enum | Values |
| --- | --- |
| `UserRole` | `STUDENT`, `COUNSELLOR`, `PSYCHOLOGIST`, `SUPPORT_STAFF`, `SCHOOL_ADMIN`, `PLATFORM_ADMIN` |
| `FeelingLabel` | `OVERWHELMED`, `ANXIOUS`, `TIRED`, `SAD_LOW`, `CALM`, `HOPEFUL`, `GREAT`, `HAPPY`, `PEACEFUL`, `STRESSED`, `DOWN`, `ANGRY` |
| `FeelingIntensity` | `A_LITTLE`, `SOMEWHAT`, `A_LOT` |
| `SupportPersonType` | `COUNSELLOR`, `PSYCHOLOGIST`, `TRUSTED_TEACHER`, `PARENT_GUARDIAN` |
| `SupportTiming` | `GENTLE_1_2_DAYS`, `TODAY_STUDY_PERIOD`, `URGENT_UNSAFE` |
| `SupportRequestStatus` | `PENDING`, `ACCEPTED`, `SCHEDULED`, `IN_PROGRESS`, `COMPLETED`, `CANCELLED`, `ESCALATED` |
| `SupportFlagSeverity` | `TIER_1_MODERATE`, `TIER_2_HIGH`, `TIER_3_ACUTE` |
| `SupportFlagStatus` | `OPEN`, `IN_REVIEW`, `ACKNOWLEDGED`, `RESOLVED`, `ESCALATED` |
| `SupportFlagSource` | `AI_CANDIDATE`, `SERVER_POLICY`, `PROFESSIONAL`, `SELF_REPORT` |
| `AiJobKind` | `REPLY`, `SUMMARY`, `VERNACULAR` |
| `ActivityStepType` (renderer contract) | `breath-pacing`, `timer`, `prompt-list`, `body-scan` |
| `MoodId` (dashboard render contract) | `GREAT`, `NORMAL`, `SAD`, `ANGRY`, `CONFUSED`, `INDIFFERENT`, `STRANGE`, `DISTRAUGHT` |
| `PilotTheme` (pilot dashboard contract) | `academic_pressure`, `social_peer`, `family`, `loneliness`, `self_confidence`, `overwhelm`, `relationships`, `other` |
| `FollowUpStatus` | `PENDING`, `SCHEDULED`, `COMPLETED`, `CANCELLED` |
| `AiReportReviewOutcome` (§15.4) | `NO_CHANGE_NEEDED`, `FOLLOWED_UP_WITH_STUDENT`, `CANNOT_ASSESS` |
| `SchoolStatus` | `ACTIVE`, `SUSPENDED` |
| `ChatThreadStatus` | `PENDING`, `ACTIVE`, `CLOSED` |
| `ChatMessageRole` | `STUDENT`, `PROFESSIONAL`, `SYSTEM` |
| `NotificationType` | `CHAT_REQUEST`, `CHAT_CLAIMED`, `CHAT_REPLY`, `SCHOOL_SUSPENDED` |
| `ResourceType` / `ResourceCategory` | see `prisma/schema.prisma` (seed data in `prisma/seed.ts`) |

## Appendix B — Placeholder legend

| Placeholder | Produced by |
| --- | --- |
| `<checkInId>` | §5.1 response `data.id` |
| `<conversationId>` | §5.2 response `data.id` |
| `<resourceId>` | §7.1 catalogue |
| `<entryId>` | §7.2 journal create |
| `<activitySessionId>` | §7.3 activity start |
| `<supportPersonId>` | §8.1 people list |
| `<supportRequestId>` | §8.1 create |
| `<judeProfileId>` | §6.2 SQL |
| `<userId>` | session user id — second path segment of every upload key (§12); target of per-user school routes (§14.6) |
| `<schoolId>` | §13.2 school create / list (`data.id`) |
| `<threadId>` | §13.5 chat request create (`data.id`) |
| `<notificationId>` | §13.6 notifications list |
| `<flagId>`, `<followUpId>`, `<placeholderId>` | chapters 6 and 9 |

## Appendix C — Change log (keep current)

| Date | Change |
| --- | --- |
| 2026-10-06 | Initial handbook (Phases A/B baseline + Phase C step 1: provider chain config blocks in §9.5, budget meter §9.7). |
| 2026-10-06 | Synced against the live route map: full envelope fields (§0.2), verification resend + verify-first rule (§0.3, §4.2), auth utilities (§2.5), `verificationEmailSent` + enrolment-key negatives (§2.1), `imageUrl` (§2.3), `GET students/me` (§4.3), all privacy booleans (§4.4), disclosure acknowledge role guard (§4.5, §10), full `FeelingLabel` set + `GET check-ins/:id` (§5.1), conversation list + no-close note (§5.2), message 4000-char cap + full turn shape (§5.3), resource query params (§7.1), journal list + limits (§7.2), `URGENT_UNSAFE`→`ESCALATED` + `GET support-requests/:id` (§8.1), review-status constraint (§8.2), flag filters (§9.2), follow-up list roles (§9.3). |
| 2026-10-06 | Phase C step 2: guardrails — message/reply caps + injection probes + per-student AI rate limits (429) in §5.3, guardrails config block in §9.5. |
| 2026-10-06 | Phase C step 3: conversation close endpoint + session-summary memory — close flow §5.5, SUMMARY/idle-close worker notes §6.6, `embedding`/`memory`/`summaries` config blocks + `canonicalTopics` §9.5, `AiJobKind` in Appendix A. |
| 2026-10-06 | Phase C step 4: language layer — canonical `preferredLanguage` set + change audit (§4.3), vernacular detection + `languageOffer` + probe (§5.3), translation-based summaries (§5.5), VERNACULAR worker lane (§6.7), `AI_CANDIDATE` lang-refine note (§9.2), `ai_understanding.queued` audit (§9.4), `language`/`vernacularKeywords` config blocks + review status (§9.5). |
| 2026-10-06 | Phase C step 5: voice routing — `en`/`pcm` → Whisper chain, `yo`/`ha`/`ig` → local N-ATLaS ASR sidecar, forced `language` + `Unsupported language` 400, friendly "type instead" 503 degradation (§9.6); `transcription.natlas` config sub-block (§9.5); sidecar service `services/n-atlas-asr` (NCAIR1 spike table, capacity honesty) + fixtures convention. |
| 2026-10-06 | Phase C step 6: backend-orchestrated activities — seeded approved catalogue + list/detail/start/complete/history endpoints + renderer `steps` contract (§7.3), `recommendedActivity` on the turn shape with intent wiring (§5.3), `ActivityStepType` in Appendix A, `<activitySessionId>` placeholder (Appendix B). |
| 2026-10-06 | File uploads (object storage) — multipart route + presigned direct-PUT route with 10MB/type allowlist and `uploads/<userId>/<uuid><ext>` keys (§12), anonymous negative in §10, `<userId>` placeholder (Appendix B); friendly `503` on deployments without `S3_*`. |
| 2026-10-09 | `SCHOOL_TENANCY_001` — School (6-char short code, ACTIVE/SUSPENDED, scrypt default password), `User.schoolId`/`mustChangePassword`/`deactivatedAt`, `SCHOOL_ADMIN`/`PLATFORM_ADMIN` roles, ChatThread/ChatMessage/Notification tables, platform-admin seed bootstrap. |
| 2026-10-09 | `TENANCY_AUTH_002` — TenantGuard (coded `SCHOOL_SUSPENDED` / `ACCOUNT_DEACTIVATED` / `PASSWORD_CHANGE_REQUIRED` 403s + users/me+first-password allowlist), sign-in-time checks, forced first-password flow (§13.4; current session survives, others revoked). |
| 2026-10-09 | `PLATFORM_ADMIN_003` — platform console: schools create/list/rename/suspend/reactivate + `GET /api/v1/admin/overview` + cross-school users list (§13.2); suspension = session revocation + `SCHOOL_SUSPENDED` notifications + socket drop (§13.7). |
| 2026-10-09 | `SCHOOL_USERS_004` — school-scoped management: settings (default password), overview, users list, student/professional onboarding with school-branded verification email (default password never emailed), update, deactivate/reactivate (§13.3). |
| 2026-10-09 | `SOCKET_REALTIME_005` — Socket.IO push layer at `/api/socket.io` (cookie handshake + DB re-verification, `user:<id>` / `school-professionals:<schoolId>` rooms) + notifications REST + the 7-event table (§13.6, §13.8). |
| 2026-10-09 | `CHAT_POOL_006` — human chat: request → PENDING pool → race-safe claim → messages (`viaVoice`) → read → closable/idempotent close (§13.5); AI entry note from check-in context only; per-user send rate limit; true `{total, byThread}` unread summary. |
| 2026-10-09 | `PROFILE_007` — `GET /api/v1/users/me` gains `school {id, name, shortCode}` + `mustChangePassword` (§13.4). |
| 2026-10-09 | `DOCS_008` — Chapter 13 (this lane) + §10 rows 12–16 + Appendix A enums (SchoolStatus/ChatThreadStatus/ChatMessageRole/NotificationType) + Appendix B placeholders; `.env.example` tenancy block; DEPLOYMENT.md nginx WebSocket upgrade; README note; e2e `test/e2e-school-chat.mjs` (`npm run test:e2e:school-chat`). |
| 2026-10-09 | `ANALYTICS_009` — audit-log school scope (`audit_log.schoolId`, `ON DELETE SET NULL`) + analytics module: platform & school windowed analytics (14/30/90 ladder, UTC day series, fixed 7d deltas, 8-face mood roll-up, weekday bars; school variant adds roster + onboarding completeness) and activity feeds with kind filters (§14.1–14.3, Appendix A `MoodId`). |
| 2026-10-09 | `ADMIN_API_010` — dashboard admin APIs: school settings read/update (§14.4), owner-only school-admin provisioning (§14.5), reset-to-default password (§14.6), enriched `GET /schools` gauges + `GET /admin/users` filters, chat-thread register (§14.7, §14.3). |
| 2026-10-09 | `SIGNUP_LOCK_011` — public sign-up closed with a uniform 400 `EMAIL_PASSWORD_SIGN_UP_DISABLED` (§14.8). |
| 2026-10-09 | `DASH_DOCS_012` — Chapter 14 (this lane) + §10 rows 17–19 + Appendix B placeholder note; README dashboard routes; e2e `test/e2e-dashboards.mjs` (`npm run test:e2e:dashboards`). |
| 2026-10-09 | `PLATFORM_ADMIN_013` — seed bootstrap accepts comma-separated `PLATFORM_ADMIN_EMAIL`/`PLATFORM_ADMIN_NAME` lists (positional names, generic fallback) so one seed run enrolls several owners; §13.1 + `.env.example` updated. |
| 2026-10-09 | `NATLAS_LLM_014` — the vernacular lane trades the VPS Ollama for the hosted N-ATLaS endpoint: OpenAI chat shape + env-only `NATLAS_LLM_API_KEY` (never in `GET /api/v1/ai/config`), every failure path throws `NatlasUnavailableError` so the n-atlas-local→openai chain is untouched, `NATLAS_LLM_TIMEOUT_MS` (45s default), model default `NCAIR1/N-ATLaS`. |
| 2026-10-09 | `VERNACULAR_REPLY_015` — per-message language following: lexicon detection replaces franc for yo/ha/ig (franc only classifies long English), and the `n-atlas-translate` reply mode renders the finished English reply into the turn's language within the same request (N-ATLaS → OpenAI render → English fallback; scripted safety copy never rendered); `aiPayload.render`, `NATLAS_RENDER_TIMEOUT_MS`; §5.3 + §9.5 + `.env.example` updated. |
| 2026-10-09 | `LANG_ID_016` — language from the input itself: when every heuristic is silent the detector asks N-ATLaS to name the turn's language (`IDENTIFY_MIN_CHARS` 8, strict `NATLAS_IDENTIFY_TIMEOUT_MS` 4s, fail-open to the standing preference on cold/unparsable), and the detected language — `en` included — always beats the preference for that turn; §5.3 + §9.5 + `.env.example` updated. |
| 2026-10-10 | `PILOT_ANALYTICS_001` — owner pilot analytics: aggregate-first payload (reach KPIs, DAU/WAU/MAU + return rate, 7-row feature usage, 8 self-reported wellbeing themes, resources, support, safeguarding, outcomes placeholder) with 1–4-student breakdown suppression, preset/custom window + school scope, and a CSV report export that bypasses the JSON envelope; `conversation_message.viaVoice` flag splits spoken AI turns; §14.10 + Appendix A `PilotTheme` row. |
| 2026-10-24 | `AI_RESPONSE_REPORT_REVIEW_001` — §15 (new chapter): the AI-response-report lane end to end (submit + 409 `RESPONSE_CHANGED` + duplicate returns the original §15.1, student receipts §15.2, reviewer reads §15.3) and the record-only reviewer decision `PATCH /api/v1/ai-response-reports/:id/review` (§15.4) — `reviewOutcome`/`reviewedById`/`reviewedAt` on `ai_response_report` (`SET NULL` on staff removal, `AiReportReviewOutcome` in Appendix A) + metadata-only audit in the same transaction, with the student/reviewer projections split so a submission or retry can never reveal that a report was reviewed, by whom, or what was concluded; tenancy resolves through the student's current school, foreign or missing rows answer 404; §15.5 documents the server-owned `aiPayload.boundary` marker (`OUT_OF_SCOPE` / `ACUTE_SAFEGUARD_ROUTE`, acute wins, present on the async placeholder, excluded from `/review-context`). Migration `20261024090000_ai_response_report_review`. |

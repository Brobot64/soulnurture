# Natlas API Manual Testing Handbook

Step-by-step API walkthrough for manual testing, covering every user type and
the full feature surface: auth + email verification, professional onboarding,
student profile, consent/privacy, AI disclosure, check-ins, conversations with
AI (sync + async retry lane), voice transcription, resources, journal, support
requests → professional assignment, flag triage, follow-ups, dashboard, audit,
and the RBAC negative matrix.

> **Keep this handbook in sync.** When an endpoint, payload, enum, or flow
> changes, update the affected chapter in the same branch/commit. Do not add
> endpoints here that are not live in code — mirror the API, never the plan.
>
> **Last synced:** Phase C step 1 (`AI_PROVIDER_CHAIN_001`) — `GET /api/v1/ai/config`
> now exposes `chain`, `openai`, `pricing`, and `budget` blocks (Chapter 9.7).

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

### 4.1 Public sign-up

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

**Expected** `200`, `user.email` matches.

### 4.2 Verify email + sign in

Same flow as §2.2, with Jude's email and `jude.jar`. (Confirm the
verify-first rule: a sign-in attempt made *before* verification is rejected.)
Then:

**Request** `GET /api/users/me` — assert `data.role === "STUDENT"`.

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

The response envelope's `data` always carries the full turn:
`userMessage`, `assistantMessage`, `humanCareRecommendation`,
`recommendedResource` (null unless the AI recommends one), `activeIntent`
(null unless the intent engine fired), `aiPending` (true when the sync
attempt failed and the async lane took over — see Chapter 6), and
`languageOffer` (null unless the message was detected as vernacular while the
preference is still `"en"` — see below).

**Vernacular messages (language layer).** Every message is language-detected
synchronously with offline heuristics — marked letters (Yoruba ẹ/ọ/ṣ, Hausa
ƙ/ɓ/ɗ, Igbo ị/ọ/ụ/ṅ), Pidgin marker words, then franc — no model call sits in
the realtime path, so the reply is never delayed. Detection does three things:
when the student's preference is still `"en"`, the response carries
`languageOffer: { detected, current }`; the reply itself continues in
`dto.language ?? preferredLanguage` (a detected Yoruba message still gets an
English reply until the preference changes); and a `VERNACULAR` job (see §6.6)
is queued to translate the message and run a **second safeguarding sweep** on
the English translation.

**Vernacular probe** (optional — run after §5.4 so the 6-message assertion
above stays valid). Send (omit `language`):

```json
{ "content": "Mo ti rẹ̀ rẹ̀ lónìí" }
```

Assert:

- `data.languageOffer === { "detected": "yo", "current": "en" }`
- `data.activeIntent === null` (benign text; the keyword floor still ran on
  the raw text synchronously)
- the assistant reply is in English (preference unchanged)

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

## 7. Resources, toolbox, journal

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
  — `vernacularReplyMode` — `AI_VERNACULAR_REPLY_MODE` — N-ATLaS
  endpoint/model — `NATLAS_LLM_BASE_URL`/`NATLAS_LLM_MODEL` — and the
  understanding output/timeout caps), `intents`, `canonicalCategories`,
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

---

## 11. Sign-out invalidates sessions

For each persona (Jude, Grace, Ibrahim, Tunde), in order:

**Request** `POST /api/auth/sign-out` — assert `200`.
**Request** `GET /api/users/me` with the same (now stale) cookie jar — assert `401`.

---

## Appendix A — Enum reference

| Enum | Values |
| --- | --- |
| `UserRole` | `STUDENT`, `COUNSELLOR`, `PSYCHOLOGIST`, `SUPPORT_STAFF` |
| `FeelingLabel` | `OVERWHELMED`, `ANXIOUS`, `TIRED`, `SAD_LOW`, `CALM`, `HOPEFUL`, `GREAT`, `HAPPY`, `PEACEFUL`, `STRESSED`, `DOWN`, `ANGRY` |
| `FeelingIntensity` | `A_LITTLE`, `SOMEWHAT`, `A_LOT` |
| `SupportPersonType` | `COUNSELLOR`, `PSYCHOLOGIST`, `TRUSTED_TEACHER`, `PARENT_GUARDIAN` |
| `SupportTiming` | `GENTLE_1_2_DAYS`, `TODAY_STUDY_PERIOD`, `URGENT_UNSAFE` |
| `SupportRequestStatus` | `PENDING`, `ACCEPTED`, `SCHEDULED`, `IN_PROGRESS`, `COMPLETED`, `CANCELLED`, `ESCALATED` |
| `SupportFlagSeverity` | `TIER_1_MODERATE`, `TIER_2_HIGH`, `TIER_3_ACUTE` |
| `SupportFlagStatus` | `OPEN`, `IN_REVIEW`, `ACKNOWLEDGED`, `RESOLVED`, `ESCALATED` |
| `SupportFlagSource` | `AI_CANDIDATE`, `SERVER_POLICY`, `PROFESSIONAL`, `SELF_REPORT` |
| `AiJobKind` | `REPLY`, `SUMMARY`, `VERNACULAR` |
| `FollowUpStatus` | `PENDING`, `SCHEDULED`, `COMPLETED`, `CANCELLED` |
| `ResourceType` / `ResourceCategory` | see `prisma/schema.prisma` (seed data in `prisma/seed.ts`) |

## Appendix B — Placeholder legend

| Placeholder | Produced by |
| --- | --- |
| `<checkInId>` | §5.1 response `data.id` |
| `<conversationId>` | §5.2 response `data.id` |
| `<resourceId>` | §7.1 catalogue |
| `<entryId>` | §7.2 journal create |
| `<supportPersonId>` | §8.1 people list |
| `<supportRequestId>` | §8.1 create |
| `<judeProfileId>` | §6.2 SQL |
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

export const SWAGGER_TITLE = 'Soul Nurture AI / Natlas API';
export const SWAGGER_PATH = 'api/docs';
export const SWAGGER_JSON_PATH = 'api/docs-json';

export const SWAGGER_DESCRIPTION = `
# Soul Nurture AI Backend

School-based emotional wellbeing platform API for the **Natlas** frontend.

This is **not a generic chatbot API**. It powers:

- Student **Sanctuary / Home**
- 4-step **Wellbeing Journey** (Check-in → Reflect → Resources → Human Support)
- **AI Chat** with structured guidance (no diagnosis)
- **Coping Hub** resources & toolbox
- **Counsellor Review** portal (flags, barometer, drop-ins, caseload)
- Consent, privacy, authorization, and audit controls

---

## Product flow

\`\`\`
Authentication
  → Sanctuary
  → Emotional Check-in
  → AI Reflection
  → Tailored Resources
  → Support Decision
  → Optional Human Support
  → Professional Review
  → Follow-up
\`\`\`

### Wellbeing Journey steps

| Step | Name | UI purpose |
|------|------|------------|
| 1 | Check-in | Core sensation + intensity + optional description |
| 2 | Reflect | AI insight, exploration prompts, optional grounding |
| 3 | Resources / Tools | Tailored coping resources from approved catalogue |
| 4 | Human Support | Choose person, timing, optional private note |

---

## Base URL & versioning

- Nest application routes: \`/api/...\`
- Better Auth routes: \`/api/auth/...\` (owned by Better Auth; not wrapped by Nest interceptors)
- Planned domain routes in this contract use \`/api/v1/...\` as the frontend-facing stable surface

Cookie-based sessions are the primary auth mechanism for browser clients.

---

## Response envelope

All **Nest-handled** routes return:

### Success
\`\`\`json
{
  "success": true,
  "statusCode": 200,
  "message": "Request successful",
  "data": {},
  "path": "/api/...",
  "timestamp": "2026-03-24T12:00:00.000Z"
}
\`\`\`

### Error
\`\`\`json
{
  "success": false,
  "statusCode": 400,
  "message": "Validation failed",
  "error": "Bad Request",
  "path": "/api/...",
  "timestamp": "2026-03-24T12:00:00.000Z"
}
\`\`\`

**Do not assume Better Auth responses use this envelope** — auth endpoints may set cookies/headers directly.

---

## Authentication

1. Sign up / sign in via Better Auth (\`/api/auth/...\`)
2. Session cookie is set by Better Auth
3. Send cookies on subsequent requests (\`credentials: 'include'\`)
4. Protected Nest routes require a valid session

### Better Auth endpoints (frontend must call these)

| Method | Path | Purpose |
|--------|------|---------|
| POST | \`/api/auth/sign-up/email\` | Register (name, email, password, optional phone) |
| POST | \`/api/auth/sign-in/email\` | Login |
| POST | \`/api/auth/sign-out\` | Logout |
| GET | \`/api/auth/get-session\` | Current session |
| POST | \`/api/auth/forget-password\` | Request password reset email |
| POST | \`/api/auth/reset-password\` | Complete password reset |
| GET | \`/api/auth/verify-email\` | Verify email from link |
| POST | \`/api/verification/resend\` | Resend verification (Nest helper) |

Email verification is **required** before full access.

---

## Authorization roles

| Role | Typical access |
|------|----------------|
| \`STUDENT\` | Own profile, check-ins, conversations, resources, support requests |
| \`COUNSELLOR\` | Permitted caseload, flags, drop-ins (consent-scoped) |
| \`PSYCHOLOGIST\` | Specialised caseload access (consent-scoped) |
| \`SUPPORT_STAFF\` | Limited operational access per policy |

Professionals **never** get unrestricted student access. Access requires role + relationship + consent + safeguarding policy.

---

## Profiles

Every user manages their own profile by role:

| Role | Endpoint | Capability |
|------|----------|------------|
| Any user | \`GET /api/users/me\` | Read base user record (name, email, phone, role) |
| \`STUDENT\` | \`GET/PATCH /api/v1/students/me\` | Read/update student profile (name, language, vibe) |
| \`COUNSELLOR\` / \`PSYCHOLOGIST\` / \`SUPPORT_STAFF\` | \`GET/PATCH /api/v1/professionals/me\` | Read/update professional profile (title, department, availability, avatar) |

Profiles are **auto-provisioned** on first access, so a valid account always has a writable profile — no separate setup call is required.

Staff can provision new user accounts (assigning role) via \`POST /api/v1/users\`. Self sign-up always creates a \`STUDENT\` account; the role field is **not** client-selectable.

---

## AI contract (critical)

- Frontend **never** calls Groq directly
- Text: \`POST /api/v1/conversations/:id/messages\`
- Voice: \`POST /api/v1/ai/transcribe\` → returns text → send via normal chat
- AI returns **structured candidates** (resource / human support / support flag)
- Server-side policy makes final safeguarding decisions
- AI does **not** diagnose or replace a clinician
- Human support must remain available if AI fails

### AI action types (fixed enum)

\`NONE | REFLECTION | GROUNDING | RESOURCE | HUMAN_SUPPORT\`

### Structured AI payload (conceptual)

\`\`\`json
{
  "message": "string",
  "emotion": { "detected": "string|null", "confidence": 0.0 },
  "reflection": { "question": "string|null", "insight": "string|null" },
  "resource": { "recommended": false, "resourceId": "uuid|null" },
  "humanSupport": { "recommended": false, "type": "string|null", "reason": "string|null" },
  "supportFlag": { "candidate": false, "category": "string|null", "severity": "string|null" },
  "action": "GROUNDING"
}
\`\`\`

---

## UI → API map

| UI screen | Primary APIs |
|-----------|--------------|
| Sanctuary / Home | \`GET /users/me\`, check-ins, quick grounding resources, SOS, journal |
| Wellbeing Journey Step 1 | \`POST /v1/check-ins\` |
| Journey Step 2 Reflect | conversations + messages (AI insight) |
| Journey Step 3 Resources | \`GET /v1/resources\`, recommendations |
| Journey Step 4 Human Care | \`POST /v1/support-requests\` |
| AI Chat | conversations + \`POST /v1/ai/transcribe\` |
| Coping Hub | resources catalogue, toolbox save, soundscapes, reflections |
| Counsellor Review | flags, barometer, drop-ins, referrals, privacy prefs |

---

## Privacy rules for clients

- Do not log full student messages, transcripts, or journal text in analytics
- Journal reflections may be device-encrypted (UI copy); server storage policy is consent-scoped
- Support request notes are visible only to the selected support person
- Parent/guardian notification is opt-in except where safeguarding policy requires otherwise

---

## Implementation status legend

| Tag suffix | Meaning |
|------------|---------|
| **(live)** | Implemented and callable now |
| **(contract)** | Documented frontend contract; backend implementation pending |

Use **(contract)** schemas to build UI against a stable shape. Fields may gain extras later but will not silently rename without a version bump.
`.trim();

export const SWAGGER_TAGS = [
  {
    name: 'Health (live)',
    description: 'Liveness and auth service health checks.',
  },
  {
    name: 'Users & Session (live)',
    description: 'Current user and session helpers backed by Better Auth session cookies.',
  },
  {
    name: 'Verification (live)',
    description: 'Email verification helpers around Better Auth.',
  },
  {
    name: 'Better Auth (live)',
    description:
      'Authentication is owned by Better Auth at `/api/auth/*`. Documented here for frontend integration; call these paths directly.',
  },
  {
    name: 'Students (contract)',
    description: 'Student profile for Sanctuary welcome, vibe/language, and journey personalization.',
  },
  {
    name: 'Check-ins (contract)',
    description: 'Wellbeing Journey Step 1 — emotional check-in (feeling, intensity, description).',
  },
  {
    name: 'Conversations & AI (contract)',
    description:
      'AI Chat + Journey Reflect. Text messages and voice transcription. Structured AI responses with server-side policy.',
  },
  {
    name: 'Resources / Coping Hub (contract)',
    description:
      'Approved coping resources, toolkit items, soundscapes, guided exercises. AI must not invent resources.',
  },
  {
    name: 'Support Requests (contract)',
    description: 'Journey Step 4 — connect with counsellor, psychologist, teacher, or parent/guardian.',
  },
  {
    name: 'Support Flags (contract)',
    description:
      'Counsellor Review triage flags. AI candidates only; server policy owns severity and escalation.',
  },
  {
    name: 'Counsellor Dashboard (contract)',
    description: 'Barometer, drop-ins, referral tracker, caseload aggregates for professionals.',
  },
  {
    name: 'Consent & Privacy (contract)',
    description: 'Self-referral privacy controls, parent notification, peer companion, sharing preferences.',
  },
  {
    name: 'Journal (contract)',
    description: 'Daily reflection / private journal entries from Sanctuary and Coping Hub.',
  },
] as const;

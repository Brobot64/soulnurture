# Epic E — Privacy, Consent & Access: gap analysis

**Status: `ANALYSIS_ONLY — NOTHING HERE IS APPROVED OR BUILT`.**
Prepared 2026-11-04 on branch `EPIC_E_PRIVACY_AUDIT_001`. Artboards read from
`~/Downloads/PNA_Soul_Nurture/Epic E (Privacy, Consent & Access).pdf` (12 artboards, extracted with
`pdftotext -raw`). Every claim below was checked against the code in this repository and the frontend
repository at the time of writing; the file:line citations are the evidence, not decoration.

This is a **decision list**, not a build plan. Two rules governed it and should govern any follow-up:

1. **Doc A/B/C outrank the Figma artifact.** A design sentence that contradicts the clinical or
   safeguarding documents is not a requirement — it is a question.
2. **Copy the product cannot honour is never rendered as a claim.** Where an artboard says something
   the code does not do, the options are *build it* or *delete the sentence*. "Approximate it" is not
   an option, and this document does not choose on the owner's behalf.

Section 5 is the part that matters most: it lists sentences the product **already ships to students**
that are narrower or wrong compared with what the server actually does. Those are live
representations, not future gaps.

---

## 1. What Epic E asks for

The twelve artboards fall into three groups, and only the first is a student surface.

**Group A — the student consent journey (ab01–ab04)**
- ① "Read before you start": what it can help with (7 items), what AI cannot do (4), an in-danger
  block, buttons `Not now, back to wellbeing dashboard` / `Proceed to use Soul Nurture AI`, and the
  line "Opening this page does not count as agreeing. You choose when to continue."
- ② "About this chat": a six-section plain-language guide — what it does / how the AI works / what
  information may be collected / how it is protected / when information may be escalated / how to
  request human support — ending in `I understand and agree to use Soul Nurture AI`.
- ③ "Your agreement record": Status `Agreed`, date and time, Agreement version `Version 1.0`,
  `Read About this chat again`, "This is saved so your choice can be checked later", plus the
  "You're all set" receipt.
- ④ The declined state: "You can always start again", "Nothing was started and no AI conversation
  was opened", and three other ways to get support.

**Group B — the two sign-in portals (ab05–ab06)**
- ⑤ System administrator sign-in: "register school administrators and view platform-wide patterns",
  "**A one-time code is sent to your registered device after sign-in**", "every sign-in is recorded".
- ⑥ School professional sign-in: "Protected by role — access to student information is restricted to
  authorised professionals", "Never share your sign-in details".

**Group C — the administration console (ab07–ab12)**
- ⑦ Schools register + register-a-school (default password, forced first change, "set it later in
  school settings").
- ⑧ Onboard-student dialog. ⑨ Onboard-professional dialog.
- ⑩ Deactivate-school confirmation ("recorded in the access log").
- ⑪ School user registry (student code + class, states `Default password` / `Unverified` / `Active`,
  joined date, "5 of 239 users").
- ⑫ The suspended-school page ("No information about you is shown on this page").
- Recurring across ⑤–⑫: "Administrators see school and access details only, **never student wellbeing
  information**."

---

## 2. What already ships

### 2.1 The consent instrument is a versioned server artefact, not page copy

| Piece | Where |
| --- | --- |
| The instrument itself: version, two groups, ten sections, three agreement statements, confirm and decline labels | `src/ai/disclosure/ai-disclosure.ts:11` (`AI_DISCLOSURE_VERSION = 'v2'`), `:13`, `:41` (`read-before-you-start`), `:88` (`about-this-chat`), `:165/:170/:175` (the three statements), `:186`, `:188` |
| Read it, without signing in | `src/ai/disclosure/disclosure.controller.ts:31` `@AllowAnonymous` |
| Read your own agreement status | `disclosure.controller.ts:42` `@Roles('STUDENT')` → `{version, accepted, acceptedAt}` |
| Record agreement, rejecting any partial or unknown statement id **before** any write | `disclosure.controller.ts:58/:66` |
| The stored record | `prisma/schema.prisma:435-449` `ConsentRecord`, `@@unique([studentId, version])`, `metadata Json?` |
| Accept is the only write — there is no decline, no withdraw, no expiry | `src/consent/consent.service.ts:60-77` |
| The gate that makes it load-bearing | `src/conversations/conversations.service.ts:85` (`assertDisclosureAccepted`), `:111` (on create), `:257-258` (on every send, before the rate gate and before any write) |
| The 403 the student sees if it is missing | `src/consent/consent.errors.ts:4/:17` `CONSENT_REQUIRED` |

The instrument's own header comment records the contract that versioning exists so a school can prove
**what each student saw and agreed to** (`ai-disclosure.ts:1-10`), and that bumping the version
re-prompts every existing student. That fact drives PE-03, PE-04 and PE-07 below.

### 2.2 The student journey of group A is fully built — and is a four-view machine in one component

`frontend/src/components/ConsentGate.tsx` holds `start | read | record | declined`
(`:52`, labels at `:240-243`):

- **① →** the `start` view renders the group summaries and `Read about this chat` (`:336-344`, `:415`),
  under the header line "Opening this page does not count as agreeing. You choose whether to continue."
  (`:271`) — the artboard's sentence, shipped almost word for word.
- **② →** the `read` view renders every section and item of both groups, server-driven
  (`:347-369`), then requires **all three** statements ticked (`:188-189`, `:370-382`) before the
  confirm button, whose label is `AI_DISCLOSURE_CONFIRM_LABEL` (`:418`) — the artboard's exact button text.
- **③ →** the `record` view renders Status `Agreed`, Date and time as a real `<time>` element,
  **Agreement version** = `record.version`, and `Read about this chat again` (`:304-328`).
- **④ →** the `declined` view renders "Other ways to get support" with Talk-to-a-person, Wellbeing
  resources and the in-danger line (`:277-294`).

It also ships three things the artboards do not show: a guest reader (`audience: 'guest'`,
`:387`, `:420-421`), a version-race guard that refuses to record against a stale instrument
(`:119-122`, `:200-203`, `:216-218`), and a re-read path that cannot double-record (`:211-215`).

It is reached two ways: as the page `/consent` (`frontend/src/routes/_app/consent.tsx:36-43`) and as
the blocking modal over the check-in that actually creates the conversation
(`frontend/src/routes/_app/check-in/why.tsx:45-47`, `:210-215`).

### 2.3 Access control: the design's central promise holds

"Administrators see school and access details only, never student wellbeing information" is **true in
code**, and it is true structurally rather than by hiding a button:

| Fact | Evidence |
| --- | --- |
| The only staff roles that can read a conversation are COUNSELLOR, PSYCHOLOGIST, SUPPORT_STAFF — no admin role is in the set | `src/users/dto/staff-bootstrap.dto.ts:16-20` (`STAFF_ROLES`), used at `src/conversations/conversations.controller.ts:52` |
| Review context is narrower still: COUNSELLOR + PSYCHOLOGIST only | `src/common/guards/roles.decorator.ts:11` (`REVIEWER_ROLES`), `conversations.controller.ts:66` |
| Even those roles only reach students in their own school | `conversations.service.ts:136-156` (`inSchool`) |
| Consent records are readable by their owner and by internal gates — no staff or admin surface touches them | the only four `consentRecord` reads in `src/` are `consent.service.ts:21/:29/:53/:62` |
| Privacy preferences likewise | `src/privacy/privacy.service.ts:15-46` is the only reader/writer of `PrivacyPreference` |

Tenancy is enforced twice, at sign-in and mid-session:

- sign-in: the `school-status-guard` `before` hook on `/sign-in/email` throws
  `ACCOUNT_DEACTIVATED` / `SCHOOL_SUSPENDED` (`src/auth/auth.config.ts:71-111`);
- request time: `TenantGuard` re-checks both, and additionally locks a `mustChangePassword` account to
  two routes until it sets its own password (`src/common/guards/tenant.guard.ts:21-24`, `:73-93`).

Suspension is not a flag nobody reads: `src/admin/schools-admin.controller.ts:17` (`@Roles('PLATFORM_ADMIN')`),
`:66` suspend / `:82` reactivate; `src/admin/admin.service.ts:167` deletes every session of the school,
`:177` hard-disconnects each user's socket (`src/realtime/realtime.service.ts:38`), and `:182-185`
audits `school.suspended` with `meta {revokedSessionsOf}`.

### 2.4 The admin console of group C is largely built

- **⑦ register a school** — POST create with a short code and an *optional* default password hashed
  with scrypt, "never returned, never logged" (`schools-admin.controller.ts:21`); the UI field is
  literally labelled "Default password (optional)"
  (`frontend/src/components/dash/school-dialogs.tsx:158`).
- **Forced first sign-in change** — provisioned accounts get `mustChangePassword: true` and
  `emailVerified: false`, with the comment above the method stating that no plaintext ever touches the
  path (`src/schools/school-users.service.ts:609-630` `createCredentialUser`); the
  flag rides in the session (`auth.config.ts:140-145`); the verification link drops unflagged accounts
  at `/first-password` (`auth.config.ts:27-38`); the screen exists
  (`frontend/src/routes/first-password.tsx`).
- **"You can also set it later in school settings"** — `PATCH /v1/schools/:id/settings` re-hashes the
  default and audits `school.settings_updated` with `meta {defaultPasswordUpdated: true}`; the UI is
  `frontend/src/routes/_dash/school/settings.tsx:146-202`. Onboarding refuses until a default exists:
  `school-users.service.ts:549-555` → 422 `SCHOOL_DEFAULT_PASSWORD_REQUIRED`, called from every
  provisioning path (`:184`, `:239`, `:291`, `:463`).
- **⑧⑨ onboard dialogs** — `frontend/src/components/dash/school-user-dialogs.tsx` (student: names,
  email, optional class, optional phone, preferred language; professional: name, email, role, title,
  department), with the artboard's own reassurance rendered ("The account starts on
  <school>'s default password and must…", `:44`, `:415`).
- **⑪ the registry** — `frontend/src/components/dash/SchoolUsersTable.tsx` renders
  User / Role / Details / State / Joined, and `stateTags` produces exactly the artboard's three
  vocabulary words plus one: `Default password`, `Unverified`, `Active`, `Deactivated`
  (`:25-36`). Details is `studentCode · classLabel` (`dash/panels.tsx:311-317`). The footer's
  "N of M users" is the design's "5 of 239 users"
  (`_dash/school/users.tsx:164`). Codes are minted as `<SCHOOLSHORTCODE>-4digits`
  (`src/schools/short-code.ts:42-48`) — the design's `MUDU98-1378` is sample text in that shape.
- **⑩ deactivate** — suspend/reactivate plus the durable in-app notification.
- **"view platform-wide patterns" (⑤)** — `src/analytics/admin-analytics.controller.ts:31`
  (`GET /v1/admin/analytics`) and `:35-52` (`GET /v1/admin/activity`, kinds `schools`/`people`/`chat`),
  surfaced in `frontend/src/routes/_dash/admin/pilot.tsx` (including text-vs-voice turn share, `:381-440`).
- **⑫ the suspended page** — `frontend/src/routes/_app/access-unavailable.tsx` is a static page
  (no student data of any kind, `noindex` at `:8`) reached when sign-in returns `SCHOOL_SUSPENDED` or
  `ACCOUNT_DEACTIVATED` (`_app/signin.tsx:70-76`).

### 2.5 Two privacy statements the product already makes well

`/history/about` (Epic H) is currently the most accurate privacy page in the product, because every
line was read against the server before it was written:

- **Retention, stated truthfully**: "Nothing here is removed on a timer. There is no automatic expiry
  running in this product…" (`frontend/src/lib/history.ts:187-188`, rendered at
  `routes/_app/history.about.tsx:130`). The backend agrees: there is no retention or expiry job
  anywhere in `src/` — the only scheduled work is the AI job worker
  (`src/ai/ai-worker.service.ts:58`), and the history service's own header comment says so
  (`src/history/history.service.ts:53-57`).
- **Voice, stated truthfully**: "Audio. A spoken turn is kept as the words it was transcribed into,
  marked as spoken." (`history.about.tsx:47`). Verified: `POST /v1/ai/transcribe` buffers the upload
  in memory and forwards it (`src/ai/ai.controller.ts:120-169`, `src/ai/ai.service.ts:686-713`); no
  audio path writes to disk or to any table.

That second line is the model for PE-03 — the sentence exists, in the right words, and is simply not
in the consent instrument.

---

## 3. Claims the artboards make that the code honours

Recorded so the next reader does not re-litigate them.

| Artboard claim | Shipped as |
| --- | --- |
| "Opening this page does not count as agreeing." | `ConsentGate.tsx:271`; and enforced server-side — the only write is the explicit POST at `disclosure.controller.ts:58`, and `conversations.service.ts:85`'s comment says "opening the chat is never consent" |
| "Nothing was started and no AI conversation was opened." (declined) | declining renders `ConsentGate.tsx:277-294` and calls no endpoint; the non-accepted send path refuses before any write (`conversations.service.ts:257-258`, `:268`) |
| "This is saved so your choice can be checked later." (③) | `ConsentRecord` + `GET /v1/ai/disclosure/status` (`consent.service.ts:27-38`) |
| Seven "can help with" items (①/②) | `ai-disclosure.ts:96-102` — all seven, one-for-one |
| "AI can make mistakes / cannot diagnose / cannot give therapy or emergency help" (①) | `ai-disclosure.ts:58-61`, and repeated as a ticked statement at `:166-173` |
| "Tell a trusted adult or contact emergency services straight away." | `ai-disclosure.ts:68-69`, `ConsentGate.tsx:292`, `access-unavailable.tsx:47-51` |
| "An authorised counsellor or psychologist reviews your request, and you can see its status." | the status surfaces built in Epic C (`/support/requests`, `/support/status-guide`) over the seven real `SupportRequest` statuses |
| "Accounts start on this password and are forced to change it at first sign-in." (⑦) | `school-users.service.ts:640-650` + `tenant.guard.ts:87-93` + `/first-password` |
| "Administrators see school and access details only, never student wellbeing information." (⑤–⑫) | §2.3 |
| "This action is recorded in the access log." (⑩) | `admin.service.ts:182-185`, surfaced at `_dash/admin/access-log.tsx` |
| "Your information … travels over an encrypted connection." | TLS on every deployed origin (`docs/DEPLOYMENT.md`) |
| "It sees your first name and your message, not your whole school record." | true as written — the prompt carries `Student first name:` (`src/ai/ai.service.ts:563`) and the context query selects exactly `firstName` + `preferredLanguage` (`src/ai/context/ai-context.service.ts:79-82`) |

---

## 4. Claims the artboards make that do not exist at all

These are the build-or-delete decisions. None is small.

| # | Design claim | Reality |
| --- | --- | --- |
| **PE-01** | ⑤ "**A one-time code is sent to your registered device after sign-in**" | There is **no OTP, no TOTP, no MFA, no second factor of any kind.** The only matches for `otp\|totp\|mfa\|two-factor\|one-time-code` in `src/` are syllables inside the vernacular corpus (`src/ai/intents/vernacular-keywords.ts`, `vernacular-corpus.ts`). Entry is email+password (`auth.config.ts:149-169`), with `requireEmailVerification: true` and `disableSignUp: true` |
| **PE-02** | ⑤ "every sign-in is recorded" / ⑩ "recorded in the access log" | Sign-ins write **no audit row**. Every `action:` literal written to `AuditLog` across `src/` is a
school, account, chat, AI-pipeline or privacy event — `school.*`, `chat.*`, `support_flag.*`,
`ai_generation.*`, `ai_response_report.*`, `follow_up.*`, `privacy.updated`,
`student.language_changed` and, as the nearest analogue of an auth event,
`ai.disclosure_acknowledged` (`src/ai/disclosure/disclosure.controller.ts:97`) — and **none of them is
an authentication event**. The auth plugin has only a `before` hook on `/sign-in/email`, and it throws without logging (`auth.config.ts:74-109`). What *does* exist: Better-Auth `Session` rows carrying `ipAddress` and `userAgent` (`prisma/schema.prisma:337-349`), which the admin service already reads for `lastActivityAt`. So: a session trail, not a sign-in audit, and no surface reads it |
| **PE-04b** | ⑤⑥ two separate sign-in portals (system admin / school professional), different email placeholders, different assurances | One `/signin` for every role, "Students and professionals: sign in with your account email and password" (`signin.tsx:92`); the split happens *after* authentication in `homeForRole` |
| **PE-13** | ⑩⑫ "sign in **through this school's link or QR code**" / "New students will not be able to activate an account" | There is **no school link, no QR code, no activation token, no invite surface.** Zero matches for `QR\|invite\|activation link\|school link` in the frontend `src/`. Accounts appear only by admin provisioning plus email verification. This is the same missing substrate that blocked Epic B's student-ID/access-token wizard |
| **PE-14** | (implied by the design's privacy toggles) student privacy choices | `PrivacyPreference` has three booleans — `shareAiCopingHubNotes`, `allowParentGuardianNotification`, `requestPeerSupportCompanion` (`schema.prisma:451-462`) — settable through `GET`/`PATCH /v1/privacy/preferences` (`privacy.service.ts:15-46`), and **read by nothing**. No feature, route or page anywhere consults them; `/privacy` renders two prose sections and zero controls (`frontend/src/routes/_app/privacy.tsx:17-24`). If a screen ever renders switches for these, they will be decoration |
| **PE-12** | ⑦⑪ a human "School ID" (`SN-SCH-0007`) beside the school code | Schools have a uuid `id` and a `shortCode` (`DNF-4Q7K`) only (`schema.prisma:286-304`). The design's second identifier does not exist |
| **PE-18** | ⑪ "5 of **239** users" | The register is capped at the newest 200 accounts and the UI says so honestly (`_dash/school/users.tsx:164-165`). A total count over the real roster would need a `count()` the endpoint does not do |

---

## 5. Sentences the product ships to students that are wrong or narrower than the truth

This is the section to read first if you only read one. These are not gaps in the build; they are
inaccurate representations **inside the consent instrument** — the text a student ticks, stored as
`ConsentRecord.metadata`, and the text the school is meant to be able to prove (
`ai-disclosure.ts:1-10`).

| # | Shipped sentence | What the code actually does |
| --- | --- | --- |
| **PE-03** | `what-we-collect` lists messages, check-in answers, alerts and requests, school details, consent records (`ai-disclosure.ts:116-124`). **No mention of voice.** | Students can record speech: `frontend/src/lib/voice.ts` captures PCM, encodes a 16 kHz WAV and posts it to `POST /v1/ai/transcribe` (`:209-218`), which forwards the **audio bytes** to a third-party endpoint — the Whisper chain for English/Pidgin or the hosted N-ATLaS ASR for Yoruba/Hausa/Igbo (`ai.service.ts:686-713`). The turn is then flagged `viaVoice` and stored (`ai.controller.ts:100-169`). The footer already names the transcription providers by name (`AppFooter.tsx:10-12`). `/history/about:47` discloses it. **The instrument a student agrees to does not.** |
| **PE-04** | `how-it-works`: "It only knows what you share **here** plus your school check-in details. It is not someone who remembers your whole life." (`ai-disclosure.ts:112`) | Context assembly calls `memory.recall(...)` for vector-similar summaries across the student's **earlier** conversations plus recent ones and hooks, and carries them into the prompt (`src/ai/context/ai-context.service.ts:132-139`). The sentence understates the model's reach, in the one document that describes it |
| **PE-05** | `privacy-in-short`: "your school counselling team is alerted with **your name**, your class, and **a short piece of the message** that triggered it" (`ai-disclosure.ts:79`) | The escalation note names the student by **`studentRef`**, not by name, plus `classLabel`, plus the excerpt (`src/support-flags/support-flag-alerts.service.ts:159-164`) — and then instructs staff: "Please **review the conversation** and follow up with the student today" (`:164`). Any COUNSELLOR/PSYCHOLOGIST/SUPPORT_STAFF in the school can open the full transcript (`conversations.controller.ts:52`, `conversations.service.ts:136-156`); `REVIEWER_ROLES` additionally get the review context (`:66`). So the promise is wrong in one direction (name) and materially understated in the other (a snippet vs the whole thread) |
| **PE-06** | `how-we-protect`: "Your information is stored on **your school's secure server**" (`ai-disclosure.ts:130`) | There is one deployed stack: a single Postgres instance shared by all schools, separated by a `schoolId` column and by `TenantGuard`/`inSchool` checks (`docs/DEPLOYMENT.md`, `prisma/schema.prisma:286-304`, `tenant.guard.ts:80-86`). Whether "your school's server" is a fair description of logical tenancy on shared hardware is a decision for the owner and for Doc A, not for this document |
| **PE-07** | `how-we-protect` says nothing at all about **how long** anything is kept | Nothing expires (§2.5). `/history/about` already states that truthfully in student language (`lib/history.ts:187-188`). The artboard's "How long information is kept will be confirmed before launch" is not shippable copy — the launch answer is now knowable, and it is "until a person agrees to a deletion request", which is also the sentence the unapproved HD-01…HD-11 decisions could change |
| **PE-08** | `when-we-escalate` (`ai-disclosure.ts:137-144`) promises escalation but never says who decides | The artboard's own line — "A person decides what happens next, not the AI" — is absent. It is also the one place where the sentence depends on a state the product has not reached: every indicator rule is still `configured: false`, so "if our safety rules are triggered" describes a lane whose thresholds are unapproved (Doc A / Epic D `CP-*`). Copy must not imply a running safeguarding engine that is not switched on |
| **PE-09** | `human-support` tells the student how to ask, not what happens after | The design adds "you can see its status", which ships (§3). Cheap, true, missing |
| **PE-10** | `how-it-works`: "A reflection chat is short on purpose: it **wraps up after a few turns**" (`ai-disclosure.ts:111`) | The turn cap is configuration, not code: the guided path wraps on a budget derived from `guided.maxExtendedTurns` and the free-text budget, and the deployed `.env` caps are what actually decide "a few". A consent instrument should not assert a number the deployment can change without re-consenting anyone |
| **PE-11** | (no artboard says this) withdrawal | `ConsentService.accept` is the only write and hard-codes `accepted: true` (`consent.service.ts:60-77`). There is no withdraw, no revoke, no decline row, no expiry. A student who agreed cannot un-agree through any product surface; they can only stop using the chat. The design never promises a withdraw control either — which is itself the question |
| **PE-15** | (no artboard says this) | `GET /v1/audit` is gated to `COUNSELLOR / PSYCHOLOGIST / SUPPORT_STAFF` (`src/audit/audit.controller.ts:13`) and returns the newest audit rows platform-wide — `audit.service.ts:38-48` applies no `schoolId` filter unless the caller passes one, and the controller never does. It carries action metadata, not wellbeing content, but it is cross-school visibility for staff accounts, against a tenancy model whose whole point is school separation. No frontend code calls it — every screen uses `GET /v1/admin/activity` or `GET /v1/schools/:id/activity` (`frontend/src/lib/admin.ts:67-80`). Either scope it or delete it |
| **PE-16** | (no artboard says this) | Declining is invisible **and** unrecordable: nothing is written (§3), which is exactly what ④ promises — but it also means the product cannot state how many students read the disclosure and chose not to use the AI. If that number is ever wanted, the current design cannot produce it without breaking the promise that makes ④ honest |

### Also open, lower order

- **PE-17** — the design's single "I understand and agree" button vs the shipped three-checkbox gate
  (`ai-disclosure.ts:163-179`, `ConsentGate.tsx:370-382`). The shipped gate is stricter and is the one
  that records which statements a student accepted. Recommendation: treat the design as stale here,
  and keep the instrument's three statements. Recorded rather than assumed.
- **PE-19** — the design's `Version 1.0` vs shipped `ai-disclosure-v2` (`ai-disclosure.ts:11-13`). The
  record screen already renders the real value (`ConsentGate.tsx:311`), so this is a content alignment
  choice, not a build.
- **PE-20** — ①'s two lists vs the shipped four-section `read-before-you-start`
  (`ai-disclosure.ts:44-83`). All the content exists; the first screen organises it as *what it is /
  what it cannot do / get human help now / your privacy in short*, which is arguably the right order
  for a child and is not what the artboard draws. A design-review call, not an engineering one.

---

## 6. Proposed vocabulary — none of it shipped

Names this document uses so decisions can be discussed without inventing them mid-conversation. They
describe nothing that exists.

- **second factor** / **step-up authentication** — the PE-01 thing, if it is built. No column, no
  provider, no route exists today; `Account` rows are Better-Auth-managed
  (`schema.prisma:306-335`), so this would be an upstream plugin decision as much as a product one.
- **sign-in event** — the PE-02 record. Would be an `AuditLog` row (`schema.prisma:842-865`) written
  from an auth `after` hook, carrying `success`/`failure code`, `ipAddress`, `userAgent`. The existing
  `Session` rows are the tempting proxy and are the wrong shape: they are deleted wholesale on
  suspension/deactivation/reset (`admin.service.ts:167`, `school-users.service.ts:422`, `:474`), so
  they cannot serve as a trail.
- **honoured preference** — a `PrivacyPreference` boolean that changes a server behaviour. All three
  today are stored preferences only.
- **activation link** — the PE-13 substrate: a school-scoped, expiring token a student redeems. The
  only token machinery in the product is Better-Auth email verification (`auth.config.ts:171-209`),
  which is not redeemable-by-link-into-a-school and cannot be issued by a school administrator.

---

## 7. Decision table

Every row is **PENDING**. Nothing in Epic E is release-approved; nothing here is a requirement until an
owner signs it. Column D/C = decision owner / clinical-doc owner.

| ID | Question the owner must answer | Evidence the answer must reckon with | Owner | Status |
| --- | --- | --- | --- | --- |
| PE-01 | Is a second factor required for staff and platform-admin sign-in, or is the design sentence deleted? | no OTP/TOTP/MFA anywhere; email+password + verified email only (`auth.config.ts:149-169`) | Product + security | ☐ PENDING |
| PE-02 | Do we record sign-ins as audit events, or do we stop saying "every sign-in is recorded"? | no auth audit hook; `Session.ipAddress/userAgent` exist but are destroyed by lifecycle deletes (`admin.service.ts:167`) | Product + safeguarding | ☐ PENDING |
| PE-03 | Does the consent instrument disclose voice capture and third-party transcription? | `what-we-collect` has no voice item (`ai-disclosure.ts:116-124`) while audio leaves the server (`ai.service.ts:686-713`); `/history/about:47` already says it | Safeguarding + legal | ☐ PENDING |
| PE-04 | Does the instrument disclose cross-conversation memory? | `ai-disclosure.ts:112` vs `ai-context.service.ts:132-139` | Safeguarding + AI ethics | ☐ PENDING |
| PE-05 | Correct the escalation sentence: ref or name, snippet or full transcript, which staff roles read it? | `ai-disclosure.ts:79` vs `support-flag-alerts.service.ts:159-164` + `conversations.controller.ts:52/:66` | Psychologist + safeguarding (Doc A) | ☐ PENDING |
| PE-06 | Is "your school's secure server" acceptable language for logical tenancy on shared hardware? | `ai-disclosure.ts:130`; one Postgres, `schoolId` scoping (`tenant.guard.ts:80-86`) | Legal + product | ☐ PENDING |
| PE-07 | What retention sentence goes in the instrument — the truthful "until a person agrees" or nothing? | no retention job (§2.5); `lib/history.ts:187-188`; depends on HD-01…HD-11 | Legal + safeguarding | ☐ PENDING |
| PE-08 | Add "a person decides what happens next, not the AI", and what does the instrument say while rules are unconfigured? | `ai-disclosure.ts:137-144`; every indicator rule `configured: false` | Psychologist (Doc A) | ☐ PENDING |
| PE-09 | Add "you can see its status" to the instrument? | ships at `/support/requests` | Psychologist | ☐ PENDING |
| PE-10 | Is a turn-count promise allowed in a consent instrument whose cap is env-configurable? | `ai-disclosure.ts:111`; deployed caps | Product + safeguarding | ☐ PENDING |
| PE-11 | Do students get a withdrawal path, and if so what happens to data already escalated? | `consent.service.ts:60-77` (accept is the only write); links to HD-04/HD-07 | Legal + psychologist | ☐ PENDING |
| PE-12 | Does a human-readable school ID exist as a product concept? | `schema.prisma:286-304` gives `id` + `shortCode` | Product | ☐ PENDING |
| PE-13 | Do school activation links / QR codes get built, or does Epic E's copy drop them? | no token surface at all; blocks Epic B's wizard too | Product + safeguarding | ☐ PENDING |
| PE-14 | Wire the three privacy booleans to real behaviour, delete them, or ship UI that currently would lie? | `schema.prisma:451-462` read by nothing; `/privacy` has no controls | Product + legal | ☐ PENDING |
| PE-15 | Scope `GET /v1/audit` to the caller's school, or remove the route? | `audit.controller.ts:13` + `audit.service.ts:38-48`; no consumer | Engineering owner | ☐ PENDING |
| PE-16 | Is "how many students declined" worth a record, given a decline record is the one thing that would break the "nothing was started" promise? | `ConsentGate.tsx:277-294` + zero writes | Safeguarding + product | ☐ PENDING |
| PE-17 | Keep the shipped three-statement gate over the design's single button? | `ai-disclosure.ts:163-179` | Psychologist | ☐ PENDING |
| PE-19 | Align the instrument's version vocabulary with the design, or mark the design stale? | `ai-disclosure.ts:11-13`; `ConsentGate.tsx:311` | Product | ☐ PENDING |
| PE-20 | Re-order the first screen to the design's two lists, or keep the shipped four? | `ai-disclosure.ts:44-83` | Design + product | ☐ PENDING |

**Sequencing note the owner should not have to rediscover:** PE-03, PE-04, PE-05, PE-06, PE-07, PE-08,
PE-09 and PE-10 all change the instrument. Changing `AI_DISCLOSURE_VERSION` re-prompts **every existing
student once** (`ai-disclosure.ts:6-9`). They should therefore be answered as one batch, not as eight
separate consent storms. PE-11 additionally cannot be answered before HD-04 and HD-07, because
"withdraw consent" and "what survives deletion" are the same question wearing two hats.

---

## 8. Executable QA rows (run when a decision lands, not before)

1. `POST /v1/ai/disclosure/acknowledge` with two of the three statement ids → 4xx, and
   `consent_record` gains no row.
2. Read `/consent` as a signed-out visitor → the disclosure renders; no session is created and no
   consent row exists afterwards.
3. Sign in with a student whose school was just suspended → 403 `SCHOOL_SUSPENDED`, and the pre-existing
   session is already gone (`admin.service.ts:167`).
4. With a live session, suspend the school mid-session → the next `/api/v1` call 403s; the socket
   disconnects.
5. Onboard a student while the school has no default password → 422
   `SCHOOL_DEFAULT_PASSWORD_REQUIRED` and no user row.
6. Complete onboarding, click the emailed link → lands on `/first-password`, and `PATCH /v1/users/me`
   style calls 403 `PASSWORD_CHANGE_REQUIRED` until the password is changed
   (`tenant.guard.ts:21-24`).
7. As a SCHOOL_ADMIN and as a PLATFORM_ADMIN, call `GET /v1/conversations/:id` for a student's
   conversation → both 403. This is the machine proof of "never student wellbeing information"; it
   should be in the journey harness.
8. `GET /v1/ai/disclosure/status` immediately after `acknowledge` → `{accepted: true}`, version equals
   the instrument's `consentVersion`, and `acceptedAt` round-trips to the `<time>` element on screen.
9. Record a voice turn end to end, then assert `conversation_message.viaVoice` is true and that **no**
   audio object exists in storage — the claim `/history/about:47` makes.
10. Set `allowParentGuardianNotification: true` and observe that nothing happens. That is PE-14 stated
    as a test.

---

## 9. Non-goals

- **No copy changes on this pass.** Every sentence in §5 needs an owner's answer first; a stale
  instrument is still better than a self-invented one.
- **No MFA build, no activation-link schema, no retention job.** §4 lists them as decisions; treating
  any of them as obvious is how a privacy product accumulates claims it cannot honour.
- **No new consent version minted.** Bumping `AI_DISCLOSURE_VERSION` is a re-consent event for the
  whole student population and belongs to the batch answer to §7.
- **Nothing here asserts the disclosure text is clinically adequate.** That verdict belongs to Doc A
  and the psychologist handoffs (`docs/`, Epic D `WN-*` / `CP-*`), none of which is approved.
- **No UI pixel work on group C.** It largely ships; the differences (PE-12, PE-18, PE-20) are content
  and vocabulary decisions.

---

## 10. What this document is for

Epic E's turn, when it comes, should be a signature exercise rather than a discovery exercise: sixteen
of the twenty decisions above can be answered without writing code, and four of them (PE-03, PE-04,
PE-05, PE-07) change text that is **already being agreed to right now**. If only one section is read
before that turn, read §5.

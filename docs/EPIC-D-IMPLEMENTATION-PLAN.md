# Natlas — Epic D / Wellbeing Resources / Content Pack implementation plan

> Inputs: three documents supplied by the Product Owner on 2026-10-30, all derived from
> Prof. Ejike Mgbenkemdi's psychology review (Enugu State University of Science and
> Technology) dated 25–26 October 2026:
>
> | # | Document | Content |
> | :-- | :-- | :-- |
> | **A** | *Epic D — Support & Safeguarding Indicators: Updated User Stories, Level Definitions, Design Handoff* | Levels A/B/C/U, seven workflow states, rule catalogue `IND-A01…IND-U01`, US-D01–US-D12 |
> | **B** | *Wellbeing Resources — Designer Update Requirements* (Jessica Amuta) | Eight approved categories, twelve resources `WN-01…WN-12`, US-WR-D01–US-WR-D11 |
> | **C** | *Approved Emotion Vocabulary, Prompt Library, Strategies & Content Version Register* v1.0.0 | `EMO-001…EMO-008`, `CP-01…CP-22`, age bands 13–15/16–17/18–22, versioning register |
>
> Status of this plan: **proposal.** Stage 0 holds five decisions that are not the
> developer's to make; nothing after Stage 1 should ship student-facing until they are
> answered.

---

## 0. Authority and approval boundary (read first)

The three documents do not agree with themselves, and the disagreement decides what can
be released.

* **Doc C §6** marks all six content packages `APPROVED`.
* **Doc C §1, §4, §5** mark every individual item `CONTENT_REVIEW_REQUIRED`, and
  `CP-09…CP-17` `BLOCKED_UNTIL_SAFEGUARDING_APPROVAL`.
* **Doc C §1** states the governing rule: *"Do not mark a content item 'approved' unless
  the authorized reviewer explicitly approves that exact version."*
* **Doc C §9**: the psychologist, safeguarding-lead and privacy signature lines are
  **blank**; only the Product Manager signed.
* **Doc A §10** describes its own source as *"a development handoff/provisional draft,
  not a validated clinical risk algorithm or approved safeguarding protocol"*, with the
  safeguarding reviewer fields uncompleted.

**Working position adopted by this plan:** the per-item statuses are operative and the
blanket register approval is a formatting error. Every package below is therefore
implemented as *reviewed-and-gated*, not *approved-and-live*. If the PO instead holds a
signed register that supersedes §4/§5, that is a one-line change to the seed's
`status` column — record the decision in §7 when it is made.

**Second boundary, independent of the above:** Doc A §1 forbids inventing numerical
cut-offs, recurrence windows, time thresholds, recipients or emergency contacts. No stage
of this plan introduces one. Where a rule cannot fire without such a number, the plumbing
ships and the rule stays unconfigured.

---

## 1. What the repository already satisfies

Verified against `main`-line code on 2026-10-30 — this is not new work.

| Requirement | Where it already lives |
| :-- | :-- |
| Doc A §1 "requests and indicators are distinct record types" | `SupportFlag` (prisma/schema.prisma:555) vs `SupportRequest` (prisma/schema.prisma:522) — separate models, separate audit |
| US-D05/D06/D07 seven-state request lifecycle | `SupportRequestStatus` = PENDING/ACCEPTED/SCHEDULED/IN_PROGRESS/COMPLETED/CANCELLED/ESCALATED (prisma/schema.prisma:106); PATCH accepts only the professional-settable five (src/support-requests/dto/review-support-request.dto.ts:18) |
| US-D06 "scheduled requires when + where" | `scheduledAt`/`locationLabel` are conditionally required on SCHEDULED (src/support-requests/dto/review-support-request.dto.ts:52-77) |
| US-D01/D12 filter counts and rows use one predicate | `matchesQueueFilter` / `deriveQueueStatus` (src/support-requests/queue-status.ts:115) — the count on a chip is the rows clicking it shows |
| Doc A §3 precedence rule 1 ("can never be downgraded") | Server keyword layer (src/ai/intents/intent-engine.service.ts:71-92); highest severity wins |
| Doc A §1 / US-D02 "an indicator is not a diagnosis" | `ai-boundaries.index.tsx` renders the live intent + guardrail config to staff; output ban on diagnosis and human impersonation (src/ai/guardrails/guardrails.config.ts:165-177) |
| US-D11 empty / restricted states already designed | Indicators workspace is a deliberately closed state for both authorised and unauthorised roles (frontend/src/routes/_dash/school/indicators.index.tsx:23) plus a "not a diagnosis" guide page |
| US-D10 school scoping + audit | `inSchool`/`schoolOf` helpers (src/common/tenant/school-scope.ts), `AuditLog` with actor/action/entity/schoolId (prisma/schema.prisma:602) |
| Doc B "human support visible from resource screens" | `ResourceSupport` rendered on resource home and detail |
| Doc B §1 "keep the existing screens, don't fork a new experience" | Student resources already on `/resources` + `/resources/$resourceId` |

Also already correct by omission: `CP-09…CP-17` (the direct safety questions) are **not**
asked anywhere in the product today — the safety floor is keyword-based on free text. That
matches their blocked status; nothing needs to be disabled.

---

## 2. Gap analysis

### 2.1 Doc A — indicator level, workflow, and the missing check-in signal

**G1 — level is modelled as severity, and there is no `U`.**
`SupportFlagSeverity` (prisma/schema.prisma:116) is `TIER_1_MODERATE | TIER_2_HIGH |
TIER_3_ACUTE` — a severity, not A/B/C/U. Doc A §1 requires the level to be a distinct
dimension, visible and visually separate from workflow status. There is no Uncertain state
at all, so IND-U01 has nowhere to land.

*Add* `level` (`A|B|C|U`), `ruleId`, `ruleVersion` to `SupportFlag`. Keep severity as an
independent field — the escalation alert path (US-D08) still needs it, and mapping
`A→none, B→TIER_1/2, C→TIER_3` is a presentation decision, not a schema collapse.

**G2 — two workflow vocabularies.**
`SupportFlagStatus` = OPEN/IN_REVIEW/ACKNOWLEDGED/RESOLVED/ESCALATED
(prisma/schema.prisma:122). Doc A US-D01 requires filters on
Pending/Accepted/Scheduled/InProgress/Completed/Canceled/Escalated, and US-D03 defines each
in words that are record-lifecycle, not triage. A decision is needed (§7 D3): converge
indicators onto the seven states, or keep triage states and expose a documented mapping.
The second is less migration; the first is what the handoff literally asks for.

**G3 — no provenance on a flag.** `SupportFlag` carries `triggerLabel`, `category`,
`intentId`, `aiContextSummary` but no rule ID/version. US-D02 requires "rule ID/version"
and requires the detail view to separate *student-reported content*, *system metadata*,
*AI summary* and *human decision* into labelled sections. `SupportRequest.initialMessage`
already freezes the verbatim student message (prisma/schema.prisma:534) — reuse that
pattern for indicators rather than re-reading the live conversation.

**G4 — the review decisions don't exist.** US-D02 requires
`No further action needed` / `Follow up with student` / `Follow safeguarding procedure`,
stored *separately from* workflow status. Nothing in `review-support-request.dto.ts` or
`SupportFlag` models this.

**G5 — Level B is blocked on the check-in, and this is the critical dependency.**
IND-B01 (distress recurring/persistent) and IND-B02 (interference with school,
relationships, sleep, functioning) cannot be evaluated, because a check-in is exactly one
feeling + one intensity + optional free text
(`create-check-in.dto.ts:11-19`, `EmotionalCheckIn` prisma/schema.prisma:343). There is no
persistence, context, functional-impact, coping-tried, trusted-person or help-seeking
answer to evaluate — those are `CP-03`…`CP-08` in doc C, which is why doc C must land
before doc A's B-level rules can. `docs/HANDOFF.md:357` already tracks "check-in-derived
wellbeing indicators … the last one standing"; this plan supplies the missing precondition
rather than a third implementation attempt at the conclusion.
**And note the ceiling:** IND-B01 still cannot *fire* without the recurrence window, which
doc A §4 says must be defined with the psychologist. Stage 3 persists the signal; Stage 4
surfaces it for human review; the automatic rule stays unconfigured until §7 D5 is
answered.

**G6 — escalation is not safe to call operational.** Two defects sit directly in front of
US-D08:

* The TIER_3 alert resolves its recipient with a school-agnostic
  `supportPerson.findFirst({ where: { active: true } })`
  (src/support-flags/support-flag-alerts.service.ts:152) and `SupportPerson` has no
  `schoolId` (prisma/schema.prisma:503) — an escalation can land on another school's
  staff. Doc A §7: *"school-specific, versioned safeguarding configuration; no
  placeholder contacts in production."*
* There is no delivery/acknowledgement state, no retry, no backup route, no service
  standard — US-D08 asks for all four and for the interface to never claim hand-off
  succeeded without confirmation.

Doc A's own rule (US-D08 last bullet: *"High-risk functionality is not represented as
operational until routes, coverage, backups and failure handling are verified"*) means
Stage 5 is gated on the tenancy fix, not on UI readiness.

**G7 — role surface is wider than the handoff.**
`@Roles('COUNSELLOR', 'PSYCHOLOGIST', 'SUPPORT_STAFF')` on the flag controller
(src/support-flags/support-flags.controller.ts:23) while the staff UI gates indicators to
counsellor/psychologist only. Doc A US-D10 names students, counsellors, psychologists,
safeguarding professionals and administrators with distinct permissions, and adds
"school administrators do not automatically access private conversations or restricted
case details". There is no safeguarding role in `UserRole`
(prisma/schema.prisma:9) to map `IND-C*` closure onto, which matters for US-D09's
"only authorized human can close a Level C case".

### 2.2 Doc B — resources are currently unapproved content

**G8 — the seeded catalogue is invented.** All five rows are placeholder titles with
placeholder media (`prisma/seed.ts:114-168`): *Navigating Exam Stress Without Cracking*,
*The "It's Not All On You" Reframe*, *4-7-8 Chill Breath Toolkit*, *Palm-Wine & Calm
Soundscape*, *Friendships Without the Fear* — `mediaUrl: https://cdn.example.com/…`. None
of `WN-01…WN-12` is present. They are stored `approved: true, active: true`, so
today's "approved" flag means "the seed author set it", which is exactly what doc C §1
forbids.

**G9 — taxonomy mismatch.** `ResourceCategory` has eleven values
(prisma/schema.prisma:78) and the UI labels them *Exam stress, Friendships, Family,
Identity, Anxiety, Grounding, Sleep, Focus, Cultural wisdom, Peer dynamics, General*
(frontend/src/lib/resources.ts:18). Doc B §3 mandates eight labels
(*Understand my feelings … Prepare for rest*) and a specific many-to-one mapping
(WN-02+WN-03 → "Help me feel steadier"). Doc B §2 says the current labels must be replaced
or remapped, not presented as the approved taxonomy.

**G10 — the "Resource type" filter is the format the handoff orders removed.**
Doc B §2/US-WR-D02: remove Read/Listen/Practise unless separately approved, show duration
instead. The student UI exposes a seven-value type select
(frontend/src/routes/_app/resources.index.tsx:159-170), driven by `ResourceType`
(prisma/schema.prisma:68) which includes `AUDIO_GUIDE`, `SOUNDSCAPE`, `INTERACTIVE`. The
`type` column can stay (activities genuinely have media) but must stop being student-
filterable, and the search box stays only if the PO confirms scope (US-WR-D01).

**G11 — the detail template has no content fields.** US-WR-D04 requires, per resource:
title, intended situation, estimated duration, **student-facing instructions in original
order**, optional reflection prompt, **safety note visually distinct from instructions**.
`WellbeingResource` (prisma/schema.prisma:454) has title/description/type/badge/duration/
media/tags only. Step-structured content already exists on the sibling model
`WellbeingActivity.steps` (prisma/schema.prisma:687) with a typed renderer contract
(`breath-pacing | timer | prompt-list | body-scan`, src/ai/activities/activities.config.ts
— six activities: box-breathing, 478-breathing, five-senses-grounding, mindful-body-scan,
thought-recap, worry-slot), so WN-01/02/03/11 are activities, not articles.

> **Hard content dependency:** doc B §4 and doc C §5 give titles, "use when" wording and
> durations, but **not the twelve full instruction sequences, reflection prompts or safety
> notes**. Doc B US-WR-D03/04 forbid paraphrasing them into production. Stage 2 therefore
> cannot be completed from the three supplied documents alone — it needs
> `Soul_Nurture_AI_Wellbeing_Coping_Resources_Reviewed_Copy.docx` and the companion
> workbook named in doc C's document-control table. See §7 D6.

**G12 — no next-step journey.** US-WR-D06's four options (*Not helpful / Try something
else / I want to talk to someone / I do not want to answer*) exist nowhere; the detail
route only renders the resource and `ResourceSupport`. `ActivitySession.feelingAfter` /
`noteAfter` (prisma/schema.prisma:709) is the nearest thing and is a feel-after signal,
not the approved four-way choice. Both doc B §5 and doc C §5.1 require that a click, a
refusal or a "Not helpful" **never** becomes an indicator — so this must not be wired into
the intent engine.

**G13 — "Picked for you".** `ResourcesService.tailored`
(src/resources/resources.service.ts:38) hard-codes "OVERWHELMED|ANXIOUS|STRESSED →
EXAM_STRESS/GROUNDING/ANXIETY, take 3, ordered by `updatedAt`" and returns the claim
"Based on your recent check-in and reflection signals." That is a stated-need mapping
dressed as a rationale, ordered by recency. Doc B §2 permits the label **only** when
selection follows a stated need or chosen category; ordering by `updatedAt` is neither.
Either make the mapping explicit and honest (stated need → mapped resources) or rename to
"Featured resource".

### 2.3 Doc C — vocabulary, prompts, versioning, age bands

**G14 — emotion vocabulary is a closed enum.** `FeelingLabel` (prisma/schema.prisma:35)
fixes twelve values; the student check-in renders eight emoji chips mapped onto them
(frontend/src/lib/journey.ts:126-133), single-select, mandatory. Doc C §3 proposes ~60
terms across eight groups (`EMO-001…EMO-008`) plus a required fallback set (§3.1:
something else / mixed feelings / not sure / prefer not to say / skip), multi-select, and
explicitly requires terms *not* be mapped to diagnoses or risk scores. An enum cannot hold
a reviewer-editable, versioned, age-varied list — this moves to a content table.

**G15 — intensity scales differ.** `FeelingIntensity` = A_LITTLE/SOMEWHAT/A_LOT
(prisma/schema.prisma:50); `CP-02` offers A little/Moderate/Strong/Very strong/I don't
want to say. Changing an enum in place would silently re-bucket every existing row; treat
it as new response-option content instead.

**G16 — the check-in is a DTO, not a prompt library.** `CP-01…CP-08` and `CP-18…CP-22`
have no representation; the conversation path hard-codes its JSON contract into the system
prompt (src/ai/prompts/system.prompt.ts:14-18). Doc C §7: *"Build a content
registry/configuration table rather than hard-coding prompt text in the model prompt."*

**G17 — none of the versioning machinery exists.** A grep across `src` and `prisma` for
`contentVersion|effectiveFrom|approvalState|ageBand|CONTENT_REVIEW|BLOCKED_UNTIL` returns
zero hits. The only gate is two booleans (`active`, `approved`). Doc C §6/§7 additionally
require semantic versioning with a meaning/safety-change rule, effective dates, per-turn
content ID + rule-version logging, three separate namespaces (emotion / wellbeing /
safeguarding) with different approval controls, and rollback to the last approved version.

**G18 — age bands cannot be derived.** `StudentProfile` (prisma/schema.prisma:262) has
`classLabel`, `studentCode`, `preferredLanguage` — no birth date or age. There is also no
band chosen at onboarding. Doc C §2 treats bands as presentation-only, so a school-selected
band is sufficient and avoids collecting date of birth; but that is a decision, not an
assumption (§7 D4).

**G19 — logging content provenance per turn.** `ConversationMessage` has `aiPayload Json?`
(prisma/schema.prisma:424) which already carries `understanding` — the right place to stamp
prompt/vocabulary IDs and rule version without duplicating sensitive text, per doc C §7.

### 2.4 Cross-cutting honesty rules the codebase mostly follows

"No success without backend confirmation" (US-D03/D06/D11), "empty results do not imply
safety" (US-D01/D11), "skipped means unknown, not safe" (US-D04) and "AI cannot close
Level C" (US-D09) are already the repo's habit — `queue-status.ts`'s header comment records
an actual regression where a derived status made a chip count disagree with its rows. These
are therefore stated as **assertions to test** (Stage 4 acceptance) rather than as new
mechanisms.

---

## 3. Prohibited by the source documents (do not implement)

Carried into every stage; each is a release blocker, not a style preference.

1. No invented numerical cut-offs, severity scores, recurrence windows, time thresholds,
   persistence definitions, or operational meanings of *repeated / persistent / significant
   / immediate* (Doc A §1, §9; doc C §4 notes).
2. No invented recipients, emergency contacts, referral routes, service hours, backup
   routes or acknowledgement SLAs; no placeholder contacts in a production seed
   (Doc A §7, §9).
3. No risk inference from an emotion word, a single low-mood report, a resource click, an
   activity refusal, or a "Not helpful" answer (Doc A §2.1; Doc B §5; Doc C §5.1).
4. No AI-generated closure of a Level C case, no AI declaration that a student is safe, no
   routine review decision that suppresses an approved C trigger (Doc A §2, US-D02/D08/D09).
5. No automatic caregiver notification where it could raise risk (Doc A US-D08; IND-C03).
6. No recommendation-algorithm claim; "Picked for you" only where a stated need or chosen
   category genuinely drove the selection (Doc B §2, US-WR-D01).
7. No Read/Listen/Practise format affordances, no resource rating, no streak/score/clinical
   outcome messaging (Doc B §2, US-WR-D05).
8. No numeric or confidence threshold for Level U; uncertainty is a handling state, not a
   fallback band, and must never silently downgrade to A (Doc A §2.1, §3, IND-U01).
9. No machine-translated safety-critical copy into production (Doc C §2.1).
10. No age-band-driven risk, consent or legal determination — bands change wording only
    (Doc C §2, §6).
11. No draft / under-review / retired content rendered as an approved student resource
    (Doc B §5; Doc C §1).
12. No paraphrasing of approved instruction sequences in production content
    (Doc B US-WR-D03/D04).

---

## 4. Stages

Each stage is independently shippable, independently reversible, and states which US
criteria it closes. Stages 2–4 are gated on Stage 0.

### Stage 0 — Decisions (no code)

Owner: PO + Prof. Mgbenkemdi + school safeguarding lead. Recorded in §7. This is the only
stage that can be done in a single meeting, and every later stage degrades into invention
without it.

### Stage 1 — Content registry foundation (backend; no student-visible change)

Replaces the boolean gate with the register doc C §6/§7 asks for.

```prisma
enum ContentKind { EMOTION_TERM CHECKIN_PROMPT RESPONSE_OPTION WELLBEING_RESOURCE
                   WELLBEING_ACTIVITY SAFEGUARDING_PROMPT AGE_BAND_RULE CATEGORY }
enum ContentStatus { DRAFT CONTENT_REVIEW_REQUIRED APPROVED_ACTIVE BLOCKED
                     SUPERSEDED RETIRED }
enum ApprovalNamespace { EDUCATION WELLBEING SAFEGUARDING }   // doc C §7: separate controls

model ContentItem {
  id            String   @id @default(uuid()) @db.Uuid
  code          String                     // EMO-003 / CP-05 / WN-07 / AGE-13-15
  kind          ContentKind
  namespace     ApprovalNamespace
  status        ContentStatus @default(DRAFT)
  majorVersion  Int          @default(1)   // doc C §6: meaning/safety change = MAJOR,
  minorVersion  Int          @default(0)   // new item or age variant = MINOR,
  patchVersion  Int          @default(0)   // non-meaningful fix = PATCH
  payload       Json                       // wording, response options, steps, safety note
  ageBand       String?                    // null = all bands
  locale        String   @default("en")
  approvedBy    String?                    // reviewer identity, not a bare boolean
  approvedAt    DateTime?
  effectiveFrom DateTime?
  effectiveTo   DateTime?
  supersedesId  String?  @db.Uuid
  createdAt     DateTime @default(now())
  updatedAt     DateTime @updatedAt

  @@unique([code, majorVersion, minorVersion, patchVersion, locale])
  @@index([kind, status, locale, ageBand])
  @@map("content_item")
}
```

Deliverables

1. `src/content/{content.module, content.service, content.controller}.ts` — `resolve(kind,
   codes, { ageBand, locale, now })` returns only `APPROVED_ACTIVE` items whose effective
   window contains `now`; a request for a `BLOCKED` code is a 403, not a silent empty.
2. `GET /v1/content` for `PLATFORM_ADMIN` (and later school staff) — the register as a
   table: code, version, status, approver, effective dates. Rollback drill = flip
   `status`/`effectiveTo` on the old row and re-activate its `supersedesId` parent; no
   deploy.
3. Seed the register from doc C verbatim, with the **operative status taken from each
   document section, not from §6**: `EMO-*`/`CP-01…08`/`CP-18…22` → `CONTENT_REVIEW_REQUIRED`;
   `CP-09…CP-17` → `BLOCKED`; `WN-*` → `CONTENT_REVIEW_REQUIRED`. Nothing resolves to a
   student until Stage 0 flips it.
4. Provenance stamping: every conversation turn writes `{ promptCodes, vocabularyVersion,
   ruleId, ruleVersion }` into `ConversationMessage.aiPayload.content` (G19) — IDs only,
   never copied student text (Doc C §7 last logging rule).
5. `AuditLog` extension for prior/new status and rule ID/version (US-D03/D10).

Closes: doc C §7 registry/versioning/rollback/logging rules. Unblocks: Stages 2, 3, 4.
No migration risk: `FeelingLabel` and the existing booleans keep working through it.

### Stage 2 — Wellbeing resources aligned to the twelve approved entries (doc B)

1. Remap to the eight approved categories (§3 of doc B) as `ContentItem` rows of kind
   `CATEGORY`, with the WN→category mapping including the documented many-to-one cases
   (WN-02+WN-03 → *Help me feel steadier*; WN-04+WN-12 → *Take one small step*;
   WN-06+WN-09 → *Handle a difficult moment*; WN-07+WN-08 → *When things feel heavy*).
   Add `contentCode` to `WellbeingResource`/`WellbeingActivity` so `WN-01…WN-12` are stable
   identifiers independent of uuid.
2. Retire the five invented seed rows (flip `status` to `RETIRED` — not delete; they exist
   in prod data and toolbox rows). Seed the twelve from the approved copy once D6 lands,
   split across the two models by whether the entry is read-content or step-rendered.
3. Add the detail-template fields: `intendedSituation`, ordered `instructions`,
   `reflectionPrompt` (nullable, labelled optional), `safetyNote` (rendered visually apart
   from instructions), and duration as the source's *range* text (`2–4 minutes`, `Flexible`)
   in `durationLabel` — `durationMinutes Int` cannot hold a range.
4. Frontend: remove the `ResourceType` select from the student filters
   (resources.index.tsx:159-170); keep category chips and duration; add the US-WR-D06
   four-option next-step block with "I want to talk to someone" routing into the existing
   `SupportRequest` journey, and "I do not want to answer" as a non-penalised exit.
   Persist the choice on `ActivitySession.noteAfter`-adjacent storage or a new
   `ResourceFeedback` row — with an explicit **no-flag** assertion (prohibition 3).
5. Fix the "Picked for you"/`tailored` honesty problem (G13): derive from the student's
   stated need or chosen category, or rename to "Featured resource".
6. States: retain F5 empty state only for genuinely empty categories (none are, on the
   approved mapping), plus loading / unavailable / broken-link with support still reachable
   (US-WR-D09/D11). Leave US-WR-D08's hand-off state pointed at Stage 5.

Closes: US-WR-D01…D07, D09…D11 (D08 deferred with reason). Blocked on D6 (full approved
copy) and D1 (status truth).

### Stage 3 — Expanded check-in per `CP-01…CP-08`, `CP-18…CP-22` (doc C)

1. Vocabulary moves out of `FeelingLabel` into `ContentItem(kind: EMOTION_TERM)` with the
   eight `EMO-*` groups and the §3.1 fallback set. Multi-select: new
   `CheckInFeelingSelection(checkInId, termCode, termLabelSnapshot, isStudentFreeText)`
   rows; keep the legacy single `feeling` column populated with a primary label for one
   release so dashboards and `CheckInFeedback` don't break, then drop it.
2. Keep `intensity` as `CP-02`'s five-point scale as content, never as a score
   (prohibition 1). Add the missing constructs as separate columns/rows, each *optional and
   skippable*: `CP-03` persistence, `CP-04` context, `CP-05` functional impact,
   `CP-06` coping tried, `CP-07` trusted person, `CP-08` help-seeking, plus `CP-18`
   preferred support and `CP-20` student-led meaning (free text optional).
3. **Skipped ≠ no risk, at the data layer:** store an explicit `UNKNOWN` / unanswered state
   per field rather than inferring from null (US-D04, doc A §2.1).
4. Wording varies by band; **meaning never does** (doc C §2.1). Band comes from Stage 0
   D4's decision. `CP-09…CP-17` are *not* added — they stay `BLOCKED`, and the keyword
   floor remains the safety net.
5. Do not create a single new flag in this stage. Stage 3's definition of done is that the
   signals are *captured and reviewable*, so the rule that consumes them can be approved
   separately from the plumbing that holds them.
6. Conversation reply: tentative reflection only — "It sounds like you may be feeling… Does
   that fit?" (doc C §2.1, §4.1) — as a system-prompt directive plus an output guardrail
   that strips asserted-emotion phrasing.

Closes: US-D04's evidence precondition; doc C §2, §3, §4 (non-safety prompts), §4.1.
Blocks: Stage 4's check-in-derived rules.

### Stage 4 — Epic D indicator surfaces (doc A)

1. `ruleId` + `ruleVersion` on the flag, with the catalogue as a versioned config file in
   the reviewer's existing house style (`src/ai/intents/indicators.config.ts`, alongside
   `intents.config.ts`): `IND-A01…IND-U01`, each declaring its level, evidence source
   (`MESSAGE_KEYWORDS | AI_CATEGORY | CHECKIN_SIGNAL`), and actions. `CP-16`-equivalent
   bullying and the A/B levels become entries here rather than new ad-hoc severity.
2. Check-in-derived review items consuming Stage 3's fields. Ship two shapes: an **U**
   record whenever potentially serious information conflicts or a safety-relevant answer is
   skipped (no silent downgrade to A — prohibition 8), and a **B review item surfaced to
   humans with its evidence listed** where persistence/impact were reported. The
   automatic IND-B01 recurrence rule stays *defined but unconfigured* until D5.
3. `SupportFlag` gains `level` (A/B/C/U), `reviewDecision`
   (`NO_FURTHER_ACTION | FOLLOW_UP_WITH_STUDENT | FOLLOW_SAFEGUARDING_PROCEDURE`) stored
   apart from workflow status (G4), `studentStatementSnapshot`, and the resolved
   `ruleId@version`.
4. API: `GET /v1/support-flags?status=` on the seven-state vocabulary (per D3), `GET /:id`
   with information types labelled separately, `POST /:id/review-decision`, audited
   transitions with prior/new status, `PATCH` restricted to state-legal transitions
   (US-D03) — reject an illegal transition server-side, and on failure keep the persisted
   status on screen (US-D03/D11).
5. Frontend: replace the closed indicators state with the real list (row: permitted student
   identifier, indicator label, generated timestamp, level, status — level and status in
   separate fields, distinct visual treatment, **not colour-alone** — §6 checklist), then
   detail, filters, three separate empty states (no indicators / no requests / no filter
   results), Level U state that does not read as low risk, and the linked-record reference
   that never merges request/indicator/case identity or audit history (US-D05/D09/D10).
6. Dashboard counts (US-D12) built on the single-predicate pattern already proven in
   `queue-status.ts`, plus explicit `Reviewed` / `Follow-up required` /
   `Completed this week` definitions with school timezone + week boundary — and the
   "empty ≠ safe" caption retained. Indicator-level counts stay distinct from
   support-request counts.
7. Permissions: reconcile `@Roles(... 'SUPPORT_STAFF')` on the flag controller with D2, and
   add the safeguarding-capable role the C-closure rules need (G7). Server-side for every
   read, search, filter and direct link (US-D10).

Closes: US-D01–D07, D09–D12; US-D08 except delivery.

### Stage 5 — Escalation hardening (US-D08/D09), gated

Prerequisite, first and separately: `schoolId` on `SupportPerson` (or a per-school
`SafeguardingRoute` versioned config), so `support-flag-alerts.service.ts:152` stops
picking a global row. Then: per-school route configuration, delivery + acknowledgement
states, retry and failure recording, backup route, and a human-only Level C close with
reason. Until a route is configured **and** end-to-end delivery plus failure handling are
actually tested against that school, the UI keeps the current honest framing
("not available yet") — doc A §9's last bullet is the acceptance criterion here, and
`R-01` (escalation endpoint fails → failure recorded, fallback activated, no false success)
is the test that proves it.

---

## 5. Verification

1. `npm run build`, `npm run lint` (0), `npm run test`, `npm run test:e2e:journey` ×2 —
   every existing suite stays green; the new assertions below live in `test/`.
2. **Corpus**: extend `src/ai/intents/escalation-corpus.ts` with doc A §8's scenarios as
   rows — `A-01/A-02`, `B-01…B-03`, `C-01…C-03`, `U-01/U-02`, `P-01`, `R-01`, `SEC-01`,
   `WF-01`. It already encodes exactly this A/B/C contract
   (`expectEscalation: No | Review | Immediate`), so the doc's QA table drops straight in.
   `P-01` is the precedence test that must never regress; `U-02` (skipped safety question →
   unknown, no safe inference) is the one most likely to break under a nullable column.
3. **No-threshold assertion**: a spec that scans `indicators.config.ts` and fails on any
   numeric recurrence/velocity parameter not present in an approved `ContentItem`. This is
   what makes §1's "do not invent" rule enforceable after this session ends.
4. **Content gating**: a spec proving a `BLOCKED` code can never resolve into a student
   surface, and that `DRAFT`/`RETIRED` resources are absent from every student list,
   detail, search and toolbox read (doc C §1, doc B §5).
5. **Separation**: a spec asserting indicator and request records keep distinct ids,
   statuses and audit rows when linked (US-D05/D10), and that a request cancellation never
   mutates an indicator or case (`WF-01`).
6. **Count/filter coherence**: chip count equals row count for all seven states on the
   same predicate (US-D12) — the regression `queue-status.ts` documents.
7. **AI-cannot-close**: server test that no AI/worker path transitions a Level C case to
   closed, and that a routine review decision cannot suppress a C trigger (US-D02/D09).
8. **Tenancy/role matrix**: cross-school and per-role access probe (SEC-01) for flags,
   requests, follow-ups and check-in history, including direct links.
9. Manual student journey on `:5050` (docs/HANDOFF.md local-browser setup) — home →
   category → resource → optional next step → support request; and the staff journey —
   list → filter → detail → decision → status. Record explicitly what was *not* exercised
   (the `tailored` path, Level U with no data, an unconfigured route).

---

## 6. Traceability

| Requirement | Stage | Note |
| :-- | :-: | :-- |
| US-D01, D02, D03, D04, D05, D06, D07, D10, D11, D12 | 4 | D04 needs Stage 3 for evidence to show |
| US-D08, D09 (closure/backup) | 5 | Gated on tenancy + tested routes |
| US-D02 review decisions | 4 | New field, stored apart from status |
| IND-A01, A02 | 2 + 4 | Content + surfacing; A never means "safe" |
| IND-B01 | — | **Blocked**: recurrence window undefined (D5) |
| IND-B02, B03, B05 | 3 → 4 | Needs CP-03/05/06/07 captured |
| IND-B04 | 4 | CP-16 wording is reviewable; C-override already in keyword floor |
| IND-C01…C05 | 5 | Needs school route config; no placeholder contacts |
| IND-U01 | 4 | State + human routing, no confidence threshold |
| US-WR-D01…D07, D09, D10, D11 | 2 | D04/D05 need full approved copy (D6) |
| US-WR-D08 | 5 | Hand-off state pointed at escalation |
| EMO-001…008 + fallbacks | 1 → 3 | Register first, check-in second |
| CP-01…08, CP-18…22 | 1 → 3 | `CONTENT_REVIEW_REQUIRED` until D1 |
| CP-09…17 | — | Stays `BLOCKED`; keyword floor unchanged |
| Age bands 13–15/16–17/18–22 | 1 → 3 | Presentation only; source undecided (D4) |
| Doc C §6/§7 versioning, gating, rollback, logging | 1 | The foundation everything else hangs on |

---

## 7. Open decisions for the PO (blocking)

| ID | Decision | Options | Needed by |
| :-- | :-- | :-- | :-- |
| **D1** | Which approval truth governs — doc C §6's blanket `APPROVED`, or §4/§5's per-item `CONTENT_REVIEW_REQUIRED`/`BLOCKED` with an unsigned §9? | (a) per-item statuses operative *(this plan's assumption — nothing student-facing until the psychologist signs the exact version)*; (b) produce the signed register, then ship | Stage 2 |
| **D2** | Does `SUPPORT_STAFF` see indicators? Today the API says yes, the UI says no. | roles that may read / review / escalate / close a Level C | Stage 4 |
| **D3** | Indicator workflow vocabulary: converge `SupportFlagStatus` onto doc A's seven states, or keep triage states + publish a mapping? | converge (migration) / map (documentation) | Stage 4 |
| **D4** | Age band source: school-selected band at onboarding, or collect date of birth (privacy + consent implications, doc C §8 legal row)? Bands must not drive risk or consent either way. | band-at-onboarding / birthDate / classLabel-derived | Stage 3 |
| **D5** | IND-B01's recurrence window, and the operational meaning of *repeated / persistent / significant / immediate*. Not developer-definable (doc A §1, §4, §9). | psychologist definition per school cohort | Stage 4 rule |
| **D6** | The twelve full `WN` entries — instructions, reflection prompts, safety notes — plus the reviewed copy for the emotion vocabulary. The three supplied documents give titles, "use when" and durations only, and forbid paraphrasing into production. | provide `…_Wellbeing_Coping_Resources_Reviewed_Copy.docx` + the companion workbook | Stage 2 |
| **D7** | Search scope on the resources home (US-WR-D01) — keep with a defined scope, or remove until approved? | keep title+description / remove | Stage 2 |
| **D8** | Per-school safeguarding recipients, local urgent routes, coverage hours, backups, acknowledgement standard (US-D08; doc A §9). | school-by-school | Stage 5 |
| **D9** | Consent/assent, privacy notice, confidentiality limits, retention and deletion for the 13–17 and 18–22 populations (doc A §9; doc C §8). | legal/privacy owner | Stage 3 + 4 |

---

## 8. Deliberately out of scope

* Adding `CP-09…CP-17` as check-in questions — they are blocked, and the keyword floor plus
  async vernacular re-evaluation already carries safety detection today.
* Any effectiveness/outcome dashboard built on `ActivitySession.feelingAfter` (parked in
  `docs/PHASE-C-PLAN.md`), which would also collide with the no-clinical-outcome rule.
* Confidence thresholds, model-generated severity ratings, or an AI "risk score".
* Replacing the existing `intents.config.ts` keyword floor. It is the only mechanism that
  currently catches a crisis disclosure, and doc A's precedence table puts it first.
* Touching the mobile/origin lane (`FRONTEND_VPS_SAME_ORIGIN_001`) — iPhone sign-in
  acceptance is still open and unrelated to any of the above.

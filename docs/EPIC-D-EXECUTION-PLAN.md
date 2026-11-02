# Natlas — Epic D execution plan (implementable slices only)

> Companion to `docs/EPIC-D-IMPLEMENTATION-PLAN.md` (the strategy contract). This file
> turns that gap analysis (G1–G19) into an ordered, build-now checklist, and marks exactly
> where each slice **stops** because the source documents forbid the developer from
> crossing. Nothing here invents a number, contact, recipient, age band, diagnosis or
> instruction sequence — those live behind Stage-0 decisions D1–D9 and the missing reviewed
> copy (D6).
>
> Standing gate (from the strategy plan §3): a rule that cannot fire without an unapproved
> number ships with the rule **defined and `configured:false`**; a content item whose status
> is `CONTENT_REVIEW_REQUIRED`/`BLOCKED` never renders as an approved student surface.
> Independent migration + spec per slice; each slice is separately shippable and reversible.

---

## Slice 1 — Content registry foundation (Doc C §6/§7). No student-visible change.

The one stage with zero clinical exposure, and the foundation Stages 2–4 hang on. Fully
implementable now.

**Schema (`prisma/schema.prisma`)** — new enums + model:
- `enum ContentKind { EMOTION_TERM CHECKIN_PROMPT RESPONSE_OPTION WELLBEING_RESOURCE
  WELLBEING_ACTIVITY SAFEGUARDING_PROMPT AGE_BAND_RULE CATEGORY }`
- `enum ContentStatus { DRAFT CONTENT_REVIEW_REQUIRED APPROVED_ACTIVE BLOCKED SUPERSEDED RETIRED }`
- `enum ApprovalNamespace { EDUCATION WELLBEING SAFEGUARDING }`
- `model ContentItem` exactly as strategy-plan Stage 1 (code, kind, namespace, status,
  major/minor/patch version, `payload Json`, `ageBand?`, `locale`, `approvedBy?`,
  `approvedAt?`, `effectiveFrom/To`, `supersedesId?`; unique on
  `[code,major,minor,patch,locale]`; index `[kind,status,locale,ageBand]`; `@@map("content_item")`).
- `AuditLog` (schema.prisma:616) gains optional `priorStatus String?`, `newStatus String?`,
  `ruleId String?`, `ruleVersion String?` (US-D03/D10). Additive, nullable → no backfill.

**Module (`src/content/`)** — new `content.module/service/controller`:
- `resolve(kind, codes, { ageBand, locale, now })` returns only `APPROVED_ACTIVE` rows whose
  effective window contains `now`; a request for a `BLOCKED` code is a **403**, not a silent
  empty (the plan's explicit rule).
- `GET /v1/content` — the register as a table (code/version/status/approver/effective dates),
  `@Roles('PLATFORM_ADMIN')`. Rollback = flip `status`/`effectiveTo` on the old row and
  re-activate its `supersedesId` parent — no deploy.

**Seed (`prisma/seed.ts`)** — from Doc C **verbatim**, operative status from the section,
not the §6 blanket:
- `EMO-001…EMO-008` (+ §3.1 fallbacks) → `CONTENT_REVIEW_REQUIRED`
- `CP-01…CP-08`, `CP-18…CP-22` → `CONTENT_REVIEW_REQUIRED`
- `CP-09…CP-17` (direct safety questions) → `BLOCKED` (not wired to the check-in; keyword
  floor unchanged)
- `WN-01…WN-12` → `CONTENT_REVIEW_REQUIRED` (payload holds only the metadata Doc B gives:
  title, "use when", duration range — **instructions/reflection/safety are `null` until D6**,
  never paraphrased in)
- eight Doc-B categories → `CATEGORY` rows.

**Provenance stamping (G19)** — in `src/ai/ai.service.ts` where the assistant message is
persisted (sync pass ~line 599–619; async merge in `src/ai/ai-worker.service.ts:443`),
merge `aiPayload.content = { promptCodes, vocabularyVersion, ruleId, ruleVersion }` onto the
turn. **IDs only, never copied student text.** `promptCodes` is `[]` until Slice 3 feeds the
library, so this is forward-compatible.

**Specs** — `content.service.spec.ts`: `resolve` returns APPROVED_ACTIVE-in-window only;
BLOCKED → 403; effective window respected; rollback flip verified. `audit` extension covered
by the Slice-4 transition spec.

**Does NOT do:** mark anything APPROVED (D1), seed any safety-critical or invented copy,
or expose `GET /v1/content` to staff (defer to D2).

---

## Slice 2 — Wellbeing resources: structure + the two no-decision honesty fixes (Doc B)

Schema + wiring + the fixes Doc B mandates that need no approval. The twelve full resource
bodies stay blocked on D6, so this slice ships **structure, un-rendered**.

**Schema**:
- `contentCode String? @unique` on `WellbeingResource` (schema.prisma:455) and
  `WellbeingActivity` (schema.prisma:701) → `WN-*` become stable ids independent of uuid.
- `WellbeingResource` gains `intendedSituation String?`, `instructions Json?` (ordered),
  `reflectionPrompt String?`, `safetyNote String?`, `durationLabel String?` (a *range*,
  e.g. `2–4 minutes` / `Flexible` — `durationMinutes Int` can't hold that). Activities keep
  using their existing `steps Json` renderer contract.
- New `model ResourceFeedback { id, studentId, resourceCode, choice enum(
  NOT_HELPFUL TRY_SOMETHING_ELSE WANT_TO_TALK DECLINED), createdAt }` for US-WR-D06.

**Seed**: flip the five invented rows (`prisma/seed.ts:114-168`, `mediaUrl: cdn.example.com`)
to `active:false, approved:false` — honesty fix, not deletion (they exist in prod/toolbox
rows). Add the twelve `WN-*` as rows with only the Doc-B metadata; keep them off the student
surface via the Slice-1 register status until D6.

**Frontend (student-visible, Doc-B-ordered, low risk)**:
- **G10** — remove the `ResourceType` select from the student filters
  (`frontend/src/routes/_app/resources.index.tsx:159-170`); keep the `type` column, just stop
  it being student-filterable; show duration instead. (Doc B §2/US-WR-D02.)
- **G13** — rename "Picked for you" → "Featured resource" and fix the rationale copy
  (`src/resources/resources.service.ts:43,75`) so the stated basis matches what actually
  drives selection. Conservative, no-decision fix.
- **US-WR-D06** — add the four-option next-step block to the resource detail route (options
  are given in Doc B, so no invention): Not helpful / Try something else / I want to talk to
  someone / I do not want to answer. "I want to talk to someone" routes into the existing
  `SupportRequest` journey; "I do not want to answer" is a non-penalised exit. Persist to
  `ResourceFeedback`.

**Category remap (data now, presentation gated)**: add the eight Doc-B labels as
`CATEGORY` content with the documented many-to-one mappings (WN-02+03→Help me feel steadier;
WN-04+12→Take one small step; WN-06+09→Handle a difficult moment; WN-07+08→When things feel
heavy). Keep the `ResourceCategory` enum (removing enum values is a migration risk); the
student chips read the eight approved labels only once Slice-1 status flips them live.

**Specs**: `ResourceFeedback` never creates a `SupportFlag` and is **never** read by the
intent engine (prohibition 3, hard assertion); DRAFT/RETIRED/invented rows absent from every
student list/detail/search/toolbox read.

**Does NOT do:** author the twelve instruction sequences/reflection prompts/safety notes
(D6); add ratings/streaks/clinical-outcome UI (prohibition 7); decide the search scope (D7,
left as-is).

---

## Slice 3 — Expanded check-in capture (Doc C `CP-01…08`, `EMO-*`). Plumbing only, OFF.

Schema + register content so the *signals exist and are reviewable*; the check-in UI does
not change for students because every item is `CONTENT_REVIEW_REQUIRED` until D1.

- Emotion vocabulary moves out of the closed `FeelingLabel` enum (schema.prisma:35) into
  `ContentItem(kind: EMOTION_TERM)` rows (the eight `EMO-*` groups + §3.1 fallback set:
  something else / mixed / not sure / prefer not to say / skip).
- Multi-select: new `CheckInFeelingSelection(checkInId, termCode, termLabelSnapshot,
  isStudentFreeText)`. **Keep the legacy single `EmotionalCheckIn.feeling` populated with the
  primary label** for one release so dashboards + `CheckInFeedback` don't break.
- Intensity as `CP-02` five-point *content* (A little / Moderate / Strong / Very strong /
  I don't want to say) — never a score. Keep `FeelingIntensity` (schema.prisma:50) so no
  existing row silently re-buckets (G15).
- Add the missing constructs as separate optional/skippable fields backed by
  `ContentItem(kind: CHECKIN_PROMPT)`: CP-03 persistence, CP-04 context, CP-05 functional
  impact, CP-06 coping tried, CP-07 trusted person, CP-08 help-seeking, CP-18 preferred
  support, CP-20 student-led meaning. **CP-09…CP-17 not added** (BLOCKED; keyword floor is
  the safety net).
- **Skipped ≠ no risk at the data layer (US-D04):** store an explicit `UNKNOWN`/unanswered
  state per field rather than inferring safety from null. This is the precondition IND-B02/B03
  and the U rule (Slice 4) consume.
- Optional, no content decision needed: the conversation reply becomes **tentative
  reflection** ("It sounds like you may be feeling… Does that fit?") via a system-prompt
  directive + an output guardrail that strips asserted-emotion phrasing (Doc C §2.1/§4.1).
  Flag separately if it should ship — it changes AI replies student-facing.

**Specs**: skipped safety-relevant answer resolves to `UNKNOWN`, never "safe"; the multi-select
rows + snapshot are captured; legacy single label still populated.

**Does NOT do:** flip any `CP/EMO` to student-visible (D1); pick an age-band source (D4 —
`ageBand` stays null = all bands); add the blocked safety questions.

---

## Slice 4 — Epic D indicator surfaces (Doc A). Surfaces + audit, zero thresholds.

Adds the distinct `level` dimension and the human review decision, and turns the closed
indicators placeholder into a real (role-correct) list/detail — **without** converging the
status enum (D3) or firing any rule that needs a number (D5).

**Schema**: `SupportFlag` (schema.prisma:569) gains
- `level IndicatorLevel` — `enum IndicatorLevel { A B C U }` (G1: a dimension separate from
  severity; keep `SupportFlagSeverity` because the alert path US-D08 still uses it).
- `ruleId String?`, `ruleVersion String?` (G3 provenance).
- `reviewDecision SupportFlagReviewDecision?` —
  `enum { NO_FURTHER_ACTION FOLLOW_UP_WITH_STUDENT FOLLOW_SAFEGUARDING_PROCEDURE }`, stored
  **apart from** workflow status (G4).
- `studentStatementSnapshot String?` — freeze the verbatim student line, reusing the
  `SupportRequest.initialMessage` pattern rather than re-reading the live conversation.
`SupportFlagStatus` stays OPEN/IN_REVIEW/ACKNOWLEDGED/RESOLVED/ESCALATED (D3 unanswered →
no migration; map in presentation).

**Config (`src/ai/intents/indicators.config.ts`, new, house style of `intents.config.ts`)** —
catalogue `IND-A01…IND-U01`, each declaring level, evidence source
(`MESSAGE_KEYWORDS | AI_CATEGORY | CHECKIN_SIGNAL`) and actions. **Any rule whose firing needs
an unapproved number (IND-B01 recurrence, IND-B* thresholds) ships `configured:false`** and
cannot auto-fire (prohibition 1). The no-threshold spec (§5.3) fails the build if a numeric
recurrence/velocity param appears that isn't an approved `ContentItem`.

**API (`src/support-flags/`)**:
- `GET /v1/support-flags` — rows carry permitted student identifier, indicator label,
  generated timestamp, `level`, `status` as **separate fields** (distinct visual treatment,
  not colour-alone).
- `GET /:id` — response sections split student-reported content / system metadata / AI
  summary / human decision (US-D02).
- `POST /:id/review-decision` + audited transitions recording prior/new status + rule
  id/version (uses the Slice-1 AuditLog columns). Server-side tenancy + role on every read,
  search, filter and direct link (US-D10).
- Keep `@Roles` exactly as today (counsellor/psychologist/support-staff on the API,
  counsellor/psychologist in the UI) — **do not widen** while D2 is open.

**Frontend** — replace the deliberately-closed indicators state
(`frontend/src/routes/_dash/school/indicators.index.tsx:23`) with the real list → filters →
detail; three separate empty states (no indicators / no requests / no filter results); a
Level U state that does **not** read as low risk (prohibition 8, no confidence number); a
linked-record reference that never merges request/indicator/case identity or audit history
(US-D05). Dashboard counts on the proven single-predicate pattern (`queue-status.ts`),
indicator counts kept distinct from request counts, "empty ≠ safe" caption retained.

**Level U surfacing**: an `U` record whenever potentially-serious information conflicts or a
safety-relevant answer was skipped (consumes Slice-3 `UNKNOWN`), routed to a human — never
downgraded to A.

**Specs**: no AI/worker path closes a Level C or suppresses a C trigger (US-D09); cancellation
of a request never mutates an indicator/case (`WF-01`); SEC-01 cross-school role matrix on
flags; count/filter coherence on all seven displayed states.

**Does NOT do:** converge `SupportFlagStatus` (D3); add a safeguarding `UserRole` (D2/G7);
fire IND-B01 (D5); invent recipients/contacts (D8).

---

## Slice 5a — Escalation tenancy fix (part of G6). Bug fix, not a feature.

The alert recipient currently resolves school-agnostically
(`src/support-flags/support-flag-alerts.service.ts:152` + `SupportPerson` has no `schoolId`,
schema.prisma:504) → an escalation can land on another school's staff. This is a real tenancy
defect (tracked in project memory), fixable without inventing contacts.

- Add `schoolId String? @db.Uuid` to `SupportPerson` (relation to `School`); index it.
- Scope the TIER_3 recipient selection to the student's school. No school staff / school-less
  student → audit `recipients:0`, alert failure never fails the flag (existing pattern).
- Spec: SEC-01 — a cross-school escalation never leaves the school.
- **UI keeps the honest "not available yet" framing** — the route itself is still unconfirmed
  until D8.

**Deferred to D8 (not implementable):** per-school urgent routes, coverage hours, backup
route, delivery + acknowledgement states, retry/failure recording, SLA. No placeholder
contacts in any seed (prohibition 2).

---

## Verification (every slice, and the whole)

`npm run build`, `npm run lint` (0), `npm run test`, `npm run test:e2e:journey` ×2 — all
existing suites stay green. Extend `src/ai/intents/escalation-corpus.ts` with Doc A §8 rows
(A-01/02, B-01…03, C-01…03, U-01/02, P-01, R-01, SEC-01, WF-01); `P-01` precedence and `U-02`
skipped-→-unknown are the two that most easily regress under a nullable column. Add the four
assertion specs named above (no-threshold scan, content gating, record separation,
AI-cannot-close, tenancy matrix). Manual `:5050` journeys (student home→category→resource→
next-step→support request; staff list→filter→detail→decision→status); explicitly record what
was **not** exercised (`tailored`, Level U with no data, an unconfigured route).

## Ordering & state

Ship in order 1 → 2 → 3 → 4 → 5a; each is its own migration + spec set on its own branch.
Slices 1/2/3/5a change **nothing student-facing** in behaviour (register + structure + honest
labels only); Slice 2's three fixes and Slice 4's surfaces are the student/staff-visible
parts. The blocked pieces (D1–D9, D6 copy) are recorded in each slice's "Does NOT do", so a
later session fills content behind the gate rather than re-deciding it.

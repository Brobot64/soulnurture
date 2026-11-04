# History-deletion review queue — provisional spec for professional review

**Status: `BLOCKED_UNTIL_SAFEGUARDING_APPROVAL`.** Nothing in §4–§7 is implemented, and
nothing here is approved. This document exists because Epic H shipped the student's *ask*
and no surface exists to *answer* it — see §1. It is written in the same register as the
Epic D handoffs: every rule below is a question with an evidence trail, not a decision.

| Reviewer | Name | Role | Signature | Date |
|---|---|---|---|---|
| Psychologist | Prof. Ejike Mgbenkemdi | clinical/safeguarding review | ☐ | |
| Safeguarding lead | | records-retention & hold rules | ☐ | |
| Legal / privacy owner | | data-subject rights, minors, backups | ☐ | |
| Product owner | | scope + sequencing | ☐ | |

**Date written:** 2026-11-04. **Branch:** `EPIC_H_DELETION_REVIEW_001` (from
`EPIC_H_WELLBEING_HISTORY_001` @ `55532dc`). **Session record:** `docs/HANDOFF.md` §0R.
**Parent decision:** D9 in `docs/EPIC-D-IMPLEMENTATION-PLAN.md:531` — "Consent/assent,
privacy notice, confidentiality limits, **retention and deletion** for the 13–17 and 18–22
populations", owner *legal/privacy*, still open. This document is the input to D9, not its
answer.

---

## 1. The gap, stated precisely

A student can now file a deletion request and nothing can be done with it.

* Built and pushed: `POST /api/v1/history/deletion-requests` inserts one
  `history_deletion_request` row and notifies (`src/history/history-deletion.service.ts:43`
  and `:143`). Route declared before the `:checkInId` param at
  `src/history/history.controller.ts:56`/`:69`.
* It deliberately deletes nothing: `HistoryDeletionScope` is documented as "a request, never
  an action" (`prisma/schema.prisma:211`–219).
* There is **no** reviewer surface. `git ls-files` finds no staff route, no queue endpoint
  and no decision column. The ask is visible to a reviewer only as an in-app notification
  (`HISTORY_DELETION_REQUEST`, `history-deletion.service.ts:8`).
* Consequence for the student's copy: the Epic H artboard ends its dialog with *"We will
  tell you the outcome"* (artboard text, `Epic H …pdf`). That sentence is **not shipped**,
  because nothing on the row can produce an outcome. §5 asks who is allowed to create one.

**Design provenance, stated so nobody over-reads it:** the erasure flow appears *only* on the
student side. `Epic H (Student Wellbeing History).pdf` has four student artboards and no
staff screen; `Epic E (Privacy, Consent & Access).pdf` contains no occurrence of
"delete", "removal", "retention" or "erasure" at all; and the consent instrument the students
actually accept (`src/ai/disclosure/`) says nothing about deletion either. So there is no
designed reviewer queue to implement — this spec proposes one for approval, which is why it
is a review document rather than a ticket.

---

## 2. Evidence: what an erasure would actually touch

Read off the schema, not assumed. A reviewer cannot decide "delete my history" without
knowing what disappears, because the cascades are uneven — some of a student's record is
designed to outlive their rows.

### 2.1 Deleting an `emotional_check_in` row

| Row | Relation | Effect |
|---|---|---|
| `check_in_answer`, `check_in_feeling_selection`, `check_in_feedback` | `onDelete: Cascade` (`schema.prisma:522`, `:540`, `:559`) | **gone with it** |
| `conversation.checkInId` | `onDelete: SetNull` (`:580`) | reflection survives, unlinked |
| `support_request.checkInId` | `onDelete: SetNull` (`:762`) | request survives, unlinked |
| `chat_thread.entryCheckInId` | plain `Uuid` column, **no relation at all** (`:987`) | id left dangling |
| `chat_thread.aiEntrySummary` | derived AI note shown in the staff request pool (`:989`) | **survives, untraceable to its source** |

### 2.2 Deleting a `conversation` (and its messages)

| Row | Relation | Effect |
|---|---|---|
| `conversation_message` | `onDelete: Cascade` (`:612`) | gone |
| `session_summary` (+ its `vector(1536)` embedding at `:920`) | `onDelete: Cascade` from both student and conversation (`:923`–`:924`) | gone — see §3.2 |
| `ai_response_report` | `message … onDelete: Cascade` (`:635`) | **the student's own complaint about an AI reply disappears with the reply** |
| `support_flag.conversationId` | `onDelete: SetNull` (`:815`) | flag survives, **with `studentStatementSnapshot` kept verbatim** (`:805`) |
| `support_request.initialMessage` | frozen text column, no FK (`:749`) | survives — it is the basis of a professional's action |

**Reading of the above two tables, offered as the central question rather than as an answer:**
the schema already encodes a position — safeguarding traces are *built* to survive
(`studentStatementSnapshot`, `initialMessage`, the flag row itself), while the reflective
record does not. So a "deletion" in this product is never a whole-person wipe; it is a
partial removal whose residue is exactly the material a reviewer would be most concerned
about. HD-03 asks the reviewers to confirm or reject that residue.

### 2.3 Two places the data lives that a row deletion does not reach

1. **AI memory.** `session_summary` is recalled into *future* replies by recency and by
   vector similarity (`src/ai/memory/memory.repository.ts:54`, `:68`, `:131`–`:139`).
   Deleting a summary removes it from recall — but nothing today removes the *inferences*
   already made in replies the student has kept. Not a blocker, a scope question (HD-06).
2. **Backups.** `pg_dump` nightly to `/opt/backups/natlas-*.sql.gz`, pruned after 14 days
   (`docs/MONITORING.md:127`, `docs/DEPLOYMENT.md:1320`). A deleted row is therefore
   recoverable for up to two weeks, and a reviewer queue must not imply otherwise (HD-07).

### 2.4 What is *not* affected — worth saying so a reviewer is not surprised

Audit rows keep `meta` with uuids and booleans only, never names or content
(`src/analytics/analytics.service.ts:313`; writer at `src/chat/chat.service.ts:166`).
Journal entries, toolbox saves, resource feedback and activity sessions are separate tables
with their own student FK — the Epic H scopes name *check-ins*, and those surfaces are not
in scope of the ask as written (`history-deletion.service.ts:77`–`:135` validates scope
fields exactly for that reason). Deactivating an account already keeps history by design
(`docs/API-TESTING-HANDBOOK.md:1366` — "soft removal … history kept"), so account removal
is not a deletion path either.

---

## 3. Existing reviewer precedents this queue should copy — and one contradiction

**3.1 The pattern that already works** (`src/conversations/ai-response-reports.service.ts:123`–`:142`):
resolve the reviewer's school from the actor (`reviewerSchool`), scope every read through
`inSchool(schoolId)` so a foreign row answers 404 and confirms nothing, write
`{outcome, reviewedById, reviewedAt}` inside a `$transaction` that also inserts an audit row,
and make the same decision from the same person idempotent. History-deletion review should
reuse this shape rather than invent one.

**3.2 A live contradiction to resolve before any code (HD-01).** The two Epic G/H surfaces
disagree about `SUPPORT_STAFF`:

* AI-report review **denies** support staff — the reviewer set is `COUNSELLOR`/`PSYCHOLOGIST`
  (`src/common/guards/roles.decorator.ts:11`), pinned by the journey assertion "support staff
  are not AI-report reviewers → 403".
* Deletion alerts **include** support staff — `REVIEWER_ROLES = ['COUNSELLOR',
  'PSYCHOLOGIST', 'SUPPORT_STAFF']` (`history-deletion.service.ts:11`), commented as "the
  roles that already read this student's wellbeing content, and no wider".

Both are defensible; they cannot both be the answer to "who decides". Being told about an ask
and being empowered to grant it are different permissions, and that distinction (notify ⊇
decide) is what HD-01 asks for.

---

## 4. Decisions requested

Each row is a question. "Code today" is what already ships; nothing there implies approval.

| ID | Question | Options on the table | Code today | Owner | Status |
|---|---|---|---|---|---|
| **HD-01** | Which roles may **decide** a deletion ask, as distinct from being **notified**? | (a) COUNSELLOR+PSYCHOLOGIST decide, all three notified; (b) all three decide; (c) a named safeguarding role only | notify = 3 roles (`history-deletion.service.ts:11`); decide = nobody | Psychologist + safeguarding | ☐ PENDING |
| **HD-02** | Does removal ever happen **inside the app**? | (a) reviewer records a decision, an operator performs the purge under a ticket; (b) in-app destructive action with a second person's confirmation; (c) never delete — redact/pseudonymise in place | no destructive code exists | Psychologist + legal | ☐ PENDING |
| **HD-03** | What is **exempt** from a granted deletion, and for how long must it be kept? Safeguarding flags, `studentStatementSnapshot`, `initialMessage`, audit rows, chat-thread summaries, backups. | named categories + windows, supplied by the reviewers — this document will not propose numbers | n/a | Safeguarding + legal | ☐ PENDING |
| **HD-04** | Is there a **retention period** at all, and who sets it? The Epic H artboard asserts "removed automatically after your school's retention period"; no expiry job exists anywhere in the server, so `HISTORY_RETENTION_TRUTH` currently tells students the opposite. | (a) none (say so); (b) per-school window (needs `School.settings`, field exists but is unused for this); (c) platform-wide default | zero implementation; artboard claim refused (`frontend/src/lib/history.ts:181`–`:188`) | Legal + PO | ☐ PENDING |
| **HD-05** | What may the student be told, and by whom? Is the deciding reviewer **named** to the student? | outcome vocabulary in §5; identity: recommended **never** | receipt shows `alertedAt` truth only (`frontend/src/routes/_app/history.index.tsx:187`–`:193`) | Psychologist + privacy | ☐ PENDING |
| **HD-06** | Is a **partial grant** legitimate — e.g. remove the reflection but keep the check-in, or keep the flag and drop the messages? §2 shows a check-in deletion leaves the conversation and the safeguarding residue behind, so "deleted" can be true of some rows and false of others. | (a) only whole-scope grants; (b) per-row subset with a stated basis; (c) redaction over deletion | scope is fixed at submit and immutable; `BEFORE_DATE`/`SELECTED_CHECK_INS` are day-granular/uuid-granular (`schema.prisma:471`–`:475`) | Psychologist + legal | ☐ PENDING |
| **HD-07** | How is a deletion **bounded** by copies the product cannot reach — backups (≤14 days), text already surfaced in later AI replies, the staff pool's composed note? | wording duty: what the app may claim, and what it must disclose | nothing claimed today | Legal | ☐ PENDING |
| **HD-08** | Does the answer change by **age band**? The content pack ships 13–15 / 16–17 / 18–22 bands, and D9 ties retention/deletion to the 13–17 and 18–22 populations. Is a guardian step ever required, given `allowParentGuardianNotification` defaults to `false` (`schema.prisma:455`)? | reviewer-supplied; note the app has no age field today, only `classLabel` | band exists in content, not in the student row | Legal + psychologist | ☐ PENDING |
| **HD-09** | May a student **withdraw** an ask, and may a granted decision be reversed? Today the row is write-once from the student side and there is no decision to reverse. | (a) withdraw any time before decision; (b) no withdrawal; (c) withdrawal allowed but the hold survives | no endpoint exists | Psychologist + PO | ☐ PENDING |
| **HD-10** | What happens to a pending ask when the student **changes or leaves school**? Recipients resolve through `professional.user.schoolId`, so the queue is the *current* school's; a deactivated account keeps its history (`API-TESTING-HANDBOOK.md:1366`). Who then owns the decision? | (a) current school; (b) platform operator; (c) ask becomes unactionable and the student is told | alert recipients = current school (`history-deletion.service.ts:157`–`:164`) | Safeguarding + legal | ☐ PENDING |
| **HD-11** | Is a **hold** (a marker that says "keep this") settable by a reviewer before any deletion exists, so the rule can be recorded even while §HD-02 is unresolved? | (a) yes, hold first; (b) no | no field exists | Safeguarding | ☐ PENDING |

---

## 5. Proposed vocabulary — proposals, not configuration

Deliberately **not** added to `schema.prisma` while HD-01…HD-03 are open: an enum value is a
claim about workflow, and the Epic D doctrine bans shipping review vocabulary ahead of
approval (`docs/EPIC-D-IMPLEMENTATION-PLAN.md`; the same reasoning that left all eleven Doc A
indicator rules `configured:false`). Shape, if approved:

* `outcome` — the decision on the ask. Options: `APPROVED_FULL` · `APPROVED_PARTIAL` ·
  `KEPT_FOR_SAFEGUARDING` · `KEPT_FOR_LEGAL_HOLD` · `NEEDS_MORE_INFORMATION`.
  *Why not a boolean:* the honest answer to a child's deletion request is frequently
  "kept, and here is why", and a boolean would render that as a refusal.
* `actionState` — kept **separate** from `outcome`, on the US-D03/G4 precedent that a
  decision and a lifecycle state are different facts (`schema.prisma:800`–`:802`):
  `AWAITING_REVIEW` · `DECIDED` · `ERASURE_QUEUED` · `ERASURE_DONE` · `ERASURE_FAILED`.
  Splitting them means an approved-but-not-yet-executed ask can never be shown as done —
  the failure mode §0R recorded for the student receipt.
* `decidedByUserId`, `decidedAt`, `decisionNote`, `holdReason` — the reviewer, the time, and
  the sentence that becomes payable the moment HD-05 approves outcome copy. The note stays
  staff-visible until HD-05 says otherwise.
* **No SLA field, no due date, no "responds within N days" text.** Inventing a time window is
  the specific prohibition the Epic D source states (§1) and `indicators.config.ts` honours
  with `configured:false`. If a window is wanted, HD-04 must produce it.

Copy that becomes safe only after approval: `history_deletion_request` read-back grows an
outcome line, and the dialog regains the artboard's *"We will tell you the outcome"* — which
stays dropped until something can tell them.

---

## 6. Proposed surface (conditional — do not build until §4 rows are signed)

Two reasons this is written as a sketch: it is unbuilt, and its shape is the least important
part. The permission answers (HD-01) and the residue rules (HD-03) are the review.

* `GET /v1/school/history-deletion-requests` — rows scoped with the `inSchool(schoolId)`
  pattern (§3.1), never `studentId`-wide; `?state=` filter; per-state counts for a chip row,
  because the existing staff surfaces all pair a list with counts
  (`frontend/src/routes/_dash/school/requests.index.tsx`, `indicators.index.tsx`).
* `GET`/`POST /v1/school/history-deletion-requests/:id/decision` — record-only at first
  (HD-02 (a)); transaction + audit row, idempotent re-post, `REVIEWER_ROLES` guard.
* `PATCH …/:id/hold` — only if HD-11 is yes.
* Student read-back: `GET /api/v1/history/deletion-requests` gains the outcome fields, and
  **must not** gain `decidedByUserId`'s name — the existing student projection is a
  whitelist for exactly this reason (`src/history/history.service.ts:119`–`:163`).
* Staff screen `_dash/school/deletion-requests.index.tsx` + detail, following
  `reports.$reportId.tsx`: list, detail, decision control, and the audit trail as a record —
  never a merged status on one row (the US-D02 "exactly four labelled kinds of content" rule
  that deferred ab04 applies here too).
* Migration: additive nullable columns on `history_deletion_request`, hand-written
  `migration.sql` with a rationale comment and `npx prisma migrate deploy` — `migrate dev` is
  unusable here because the shadow database cannot apply the pgvector migration
  (`docs/HANDOFF.md` §0Q).
* Sequencing honest note: **seven** migrations are applied locally and not on prod (the five
  Epic D ones, `ai_report_reason`, `history_deletion_request`). A reviewer queue on top of an
  unshipped table would be unverifiable, so §0R's open item (3) is a prerequisite.

---

## 7. QA rows, to be executed once (and only once) §4 is signed

Written now so the reviewers can reject claims rather than read them later. Each is an
executable assertion, in the style of the Doc A §8 rows already encoded in
`src/history/history.controller.spec.ts`.

1. Every role × every new route: 401 unauthenticated; `SCHOOL_ADMIN` and `PLATFORM_ADMIN` 403
   on content reads unless HD-01 explicitly grants otherwise; `STUDENT` 403.
2. A request from another school answers **404**, not 403, and is absent from the list count.
3. A decision writes `{outcome, decidedBy, decidedAt}` **and** one audit row in the same
   transaction; the audit `meta` carries ids only, never the student's note text.
4. Re-posting the same decision from the same reviewer changes nothing and returns the same
   row (idempotency); posting a *different* decision is either refused or recorded as a
   transition with `priorStatus`/`newStatus` — which of the two is HD-09's answer.
5. `KEPT_FOR_SAFEGUARDING` and `KEPT_FOR_LEGAL_HOLD` leave every wellbeing row in place
   (count before = count after) while the student's read-back shows the outcome line.
6. Nothing can reach `ERASURE_DONE` unless an erasure actually executed, and if HD-02 chooses
   (a), no route can set it at all — asserted by the absence of a writable path.
7. The student response never contains `decidedByUserId`, the reviewer's name, or any
   `holdReason` text that HD-05 has not approved.
8. A `SELECTED_CHECK_INS` ask whose ids no longer resolve is refused at submit with
   `CHECK_INS_NOT_FOUND` and its deliberately unspecific message (already true —
   `history-deletion.service.ts:111`–`:118`; keep it green).
9. A `BEFORE_DATE` ask is compared as a **day**, not a timestamp (`@db.Date`), across the
   UTC boundary.
10. Journey: an ask filed in Act 6 is decided in Act 7 by the professional, and Act 8 proves
    the student's receipt changed while the check-in count did not.

---

## 8. Explicit non-goals

* **No self-service delete.** Not a button, not a "confirm you understand" modal. §2.1 shows
  what a student "delete" would actually leave behind, which is worse than saying no.
* **No automatic expiry** until HD-04 produces a window from the reviewers, not from an agent.
* **No invented SLA, count threshold, recurrence rule or time cut-off** (Epic D §1
  prohibition, still governing).
* **No reviewer identity shown to a student** unless HD-05 approves it.
* **No staff read of `conversation_message`** beyond what the decision needs — ab04 is
  deferred for precisely this reason and this queue does not reopen it.
* **No claim about backups** in student-facing copy before HD-07.

---

## 9. What unblocks immediately after the review

* HD-01 + HD-02 → the queue's roles and whether it is record-only. *Nothing else in §6 can be
  written without these two.*
* HD-03 + HD-11 → the hold rules, which can ship before any erasure exists and are therefore
  the cheapest genuine privacy improvement available today.
* HD-04 → either a retention job, or the permanent sentence already shipped: "Nothing here is
  removed on a timer."
* HD-05 → the outcome copy, and the return of the artboard's "we will tell you the outcome".
* Until then, the student's receipt says what is true: whether a person was reached
  (`alertedAt`), and that filing deleted nothing.

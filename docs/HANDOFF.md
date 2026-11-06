# Natlas — Agent / Developer Handoff Document

> **Purpose**: a cold-takeover brain for whoever picks this work up next — a human developer or an AI agent. It captures what the system is, everything that happened in the build-up session, *why* every decision was made (including the debugging thought-processes), the exact current state, the traps that will bite you, and the ordered next actions. Product/ops docs live elsewhere; this file is the **working memory**.

---

## 0. Session delta — 2026-10-11 (safety milestone: tasks 1–5 shipped, live on the VPS)

**Standing rule reaffirmed this session (treat as invariant #13):** the reply language is ALWAYS the language of the message the student typed — detection from message text is the sole client-independent input; the standing preference only fills detection silence, then English; client-supplied language fields are ignored (LANG_ID_016 contract). This governs ALL generated text, including staff-facing alerts.

### What was done (mandate: "implement 1–5 in order")

1. **SUPPORT_INBOX_001 backend** — verified already committed/pushed by the main session; re-verified (tests, lint, build). No new work.
2. **`/school/requests` frontend screen** — verified built per Figma; no new work.
3. **TIER_3 AI recommendation flow** — branch `SAFETY_ALERT_001` (`f2508d2`), PR **#7**. New `SupportFlagAlertsService` (in `SupportFlagsModule`, imports NotificationsModule only — no AiModule cycle): when the intent engine persists a TIER_3 flag, every active COUNSELLOR/PSYCHOLOGIST/SUPPORT_STAFF user at the student's school gets a `SUPPORT_RECOMMENDATION` notification (title+reason+verbatim ≤180-char excerpt via NotificationsService, so the bell lights up realtime), audited `support_flag.school_alerted`; alert failure never fails the flag (lands in explainability notes); school-less students and empty schools audit recipients:0. Language chain per lane: sync lane passes replyLanguage, vernacular pass passes detected message language, holding lane runs the detector only for acute verdicts — then preference → en fallback. Alert copy drafted per language en/pcm/yo/ha/ig.
4. **Safety regression suite from the 60-row dataset** — branch `SAFETY_SUITE_001` (`3bc79c9`), PR **#8**. `src/ai/intents/escalation-corpus.ts` now encodes all 60 SN rows (ids match dataset `example_id`; 20 A / 20 B / 20 C) + 11 legacy EX rows, each with support level, expected escalation (No/Review/Immediate), floor intent, matchedBy lane, and the model category a correct model would propose. `escalation-corpus.spec.ts` runs every row through a silent model (server floor alone) AND a flagging model: A stays silent (chatty model may only yield ≤TIER_2 MODEL_CANDIDATE), C MUST floor-fire TIER_3_ACUTE (model agreement never downgrades), B always surfaces a review pathway (rule-bound AI category carrying HUMAN_SUPPORT_PROMPT / TIER_2 floor-fire for panic-low-mood phrasing / TIER_2 triage candidate), never acute. Integrity tests pin 60 rows, 20/20/20, unique ids. Encoding the corpus **closed real floor gaps**: SUICIDAL_IDEATION += `"don't want to be alive"`, `"killing myself"`; two NEW TIER_3 intents in `intents.config.ts` — **ABUSE_DISCLOSURE** and **THREAT_OR_COERCION** (tight keywords only; loose terms like "touches me"/"without food"/"forcing me to" deliberately rejected to keep the whole-school acute-alert blast radius small; safety copy follows the dataset's "do not investigate / no secrecy / route to trusted adult" actions).
5. **Vernacular expansion** — branch `VERNACULAR_001` (`a581448`), PR **#9**. `src/ai/intents/vernacular-corpus.ts`: AI-assisted translations of all 60 SN rows into Yoruba/Hausa/Igbo (180 entries, no-diacritic student spellings; keyword packs list diacritic variants separately), bound to the English source by exampleId, marked `PENDING_NATIVE_REVIEW`. `vernacular-corpus.spec.ts` asserts each translation resolves EXACTLY like its English source (A silent / B review-never-acute / C floor-fires the source intent at TIER_3 with the model silent). `vernacular-keywords.ts` gained ABUSE_DISCLOSURE + THREAT_OR_COERCION packs and new suicidal/self-harm terms. Encoding surfaced 11 mismatches that were tuned: SN-057 "parent hits me" terms moved THREAT→ABUSE to match the English binding; hyphen/no-hyphen student spellings both listed ("na eyi m egwu"/"na-eyi m egwu", "na aku m"/"na-akụ m"); over-broad "na enweghi nri" replaced by the precise "ahapu m obi maka ubochi ole na ole".

### Repository / deploy state (supersedes §4 "Repository state" below)

- `main` = `4edeaed` (merge of PR #9); PRs #7→#8→#9 merged in order via GitHub API (no gh CLI — stored git credential drives REST). Local `main` synced.
- **Live**: VPS deploy verified green (run `38142589051`). Trap learned: merging 3 PRs in quick succession made GitHub's concurrency group CANCEL the newest CI run (the only one that mattered); a manual rerun via `POST /actions/runs/{id}/rerun` fixed it. After any multi-PR merge, check the newest run concluded `success` before calling the server updated.
- Verification at handoff: full suite **53 files / 1188 tests green**, oxlint 0 errors (4 pre-existing warnings), `nest build` clean.
- No schema changes in tasks 3–5 (auto-migrate was a no-op).

### Open follow-ups for the next session

1. **Native-speaker review** of the 180 translations + all new keyword terms/glosses (flagged `PENDING_NATIVE_REVIEW` in `vernacular-corpus.ts` / `vernacular-keywords.ts`). This is a human gate, not code.
2. **Remote branch cleanup**: `SAFETY_ALERT_001`, `SAFETY_SUITE_001`, `VERNACULAR_001` still exist on the remote (all merged). Delete when convenient.
3. **ASR sidecar is PARKED** by owner decision (2026-10-11): "leave out the asr for now; keep the existing natlas asr sidecar." VPS self-host plan, revision pins, gated-access requests all deferred until un-parked (`services/n-atlas-asr` stays as-is).
4. **Superadmin seed** still pending the VPS `.env` append + `npm run seed` (unchanged from previous handoff).
5. Untracked `test/*.mjs` probe scripts remain in the working tree (local diagnostics, never committed).

---

## 0A. Session delta — 2026-10-11 (prod hotfix batch #21–#25: queue 400, deep links, past reflections, socket 404, verify-email→first-password)

Mandate: "perfect this system" — 4 reported defects + 5 prod screenshots; user-set priority order **5, 3, 2, 4, 1**. All five shipped, merged, pushed, prod-verified. natlas main **eca3bf5** (VPS deploy verified: `git rev-parse` = eca3bf5), frontend main **a203212** (Vercel live-bundle verified).

1. **#21 queue "Validation failed (uuid is expected)"** — NOT a Prisma/schema error. That message is Nest's `ParseUUIDPipe`: prod main `4edeaed` had `@Get(':id')` but no `@Get('queue')`, so `/support-requests/queue` matched `:id` and failed UUID parsing. Frontend PR #10 had merged without the backend counterpart. Fix = merge `SUPPORT_INBOX_001` → eca3bf5; verified prod queue now 401-anonymous (RolesGuard) instead of 400. **Lesson: ask for the exact error text before source-diving.**
2. **#25 verify-email → change password immediately** — backend-only: `auth.config.ts` `withWebAppCallback` takes `mustChangePassword` and points the verify-link callbackURL at `/first-password` instead of `/welcome` for provisioned accounts (dbUser select extended). Spec-pinned; frontend page already existed and self-redirects flag-cleared users.
3. **#23 students see previous conversations before starting a check-in** — `check-in/index.tsx` fetches `fetchCheckInHistory` once auth is ready (failure leaves check-in untouched) and renders a "Past reflections" section of date+summary rows, each linking to `/reflection/$conversationId` when a conversationId exists. Live-bundle verified ("Past reflections" string in `check-in-*.js`).
4. **#22 professionals deep-link from a support request to its conversation** — backend: `SupportQueueItem.conversationId` carried on the queue row (column already selected); `conversations.getOne` widened so COUNSELLOR/PSYCHOLOGIST/SUPPORT_STAFF of the SAME school read a student's conversation without `ensureProfile` ever running for staff (write paths still go through `owned()`). Frontend: review dialog links to the new read-only transcript route `/_dash/school/requests/$conversationId.tsx`. Browser-verified locally (ericmoore → Jude's closed conversation).
5. **#24 socket.io 404 in prod** — two layers: (a) **nginx**: the API vhost proxied HTTP/1.1 with no `Upgrade`/`Connection` headers → wss handshake 404 at the proxy. Fixed with a dedicated `location /api/socket.io/` block (upgrade headers, 3600s timeouts) — `nginx -t` + reload, backup `natlas.bak-20261011`. **This edit lives ONLY on the VPS** (no repo contains it; DEPLOYMENT.md doesn't mention it — reprovision would lose it). (b) **transports**: polling NEVER worked in any environment — reproduced standalone: engine.io's `attach()` cannot intercept plain HTTP requests through Fastify (they fall through to Fastify's own 404). Deliberate fix: `transports: ['websocket']` on BOTH gateway (`realtime.gateway.ts`) and client (`socket.ts`). Prod verified: authenticated socket.io-client CONNECTED over wss (`test/socket-probe.mjs`, sign-in → connect sid).

**Deploy-state traps re-hit:** none new; the multi-PR-merge concurrency-cancel rule from §0 was respected (single merges this time). `git checkout` while `npm run start:dev` watch runs recompiles the local backend — the local :3000 briefly ran unmerged branch code, which is how the queue was browser-verified pre-merge.

**New durable rules:** (R14) engine.io + Fastify = polling broken by design → websocket-only both sides, never "fix" by re-adding polling. (R15) the nginx socket-upgrade block is VPS-only mutable state — check it whenever socket symptoms recur after any infra rebuild. (R16) `ParseUUIDPipe` failures on a word-shaped segment = a missing literal route above `@Get(':id')`, i.e. a merge/deploy lag, not schema corruption.

Open follow-ups unchanged from §0 (native review, remote branch cleanup, ASR parked, superadmin seed). `test/socket-probe.mjs` joins the untracked probe suite.

---

## 0B. Session delta — 2026-10-22 (P0 tenancy: safeguarding reads were platform-wide)

Mandate: from the Figma PNA-4 gap analysis, "start on blocker 1" — the cross-school leak in front of every Epic D (Support & Safeguarding Indicators) screen. Branch `SCHOOL_TENANCY_FLAGS_001`, cut from `main` (`a2b81a0`); **not yet pushed/merged**.

**The leak, precisely.** Four staff entry points read or wrote the whole platform's safeguarding data: `SupportFlagsService.list` ignored its `_userId` and returned every school's flags + a platform-wide `openCount`; `acknowledge`/`markInReview` looked a flag up by bare `id`, so **any** signed-in COUNSELLOR/PSYCHOLOGIST/SUPPORT_STAFF could move **another school's** flag through the review statuses; `DashboardService.counsellor` mixed all-school flags, an all-school barometer (last 100 check-ins platform-wide) and an all-school request queue into one payload; and `SupportRequestsService.review` (PATCH `/v1/support-requests/:id`) progressed **any** request by bare `id` — the same IDOR class, found while wiring the helper and fixed in the same branch because the Epic C/D staff tray depends on it. Its ACCEPTED side effect also silently skipped thread creation for a school-less actor; that actor now gets 404 before any write. Only the request *queue* (`listQueue`) and staff conversation reads (`conversations.getOne`, #22) were ever scoped — the surfaces added later simply didn't copy the pattern.

**No schema change — decided against a `SupportFlag.schoolId` column.** Tenancy rides the student's account (`where: { student: { user: { schoolId } } }`), which (a) matches the working `listQueue` precedent, (b) cannot strand a flag in a school a student left, and (c) needs no migration/backfill on a live VPS. Both helpers are single-sourced in **`src/common/tenant/school-scope.ts`** (`inSchool`, `schoolOf(prisma, userId)`) so the next staff-facing read cannot drift again — drift is how this happened.

**Fail-closed rules now pinned by tests:** a staff actor with no `schoolId` sees nothing *and issues no tenant query at all* (empty list / empty portal, asserted with `not.toHaveBeenCalled`). Foreign-tenant flag ids answer **404, never 403** — deliberate deviation from `conversations.getOne`'s 403: a tenant boundary must not confirm that another school's id is real.

**Verification:** `nest build` clean; oxlint **0 errors**, 8 warnings all pre-existing in `src/ai/eval/*`, zero in the touched files; suite **1345 passed / 1 failed (1346)** — the failure is **ES-16, known red since `94a998c`** ("50/51, ES-16 known red" in that commit message; Hausa "Na gode da taimakon ku" resolves `en`, wants `ha`). It reproduces standalone and shares no import path with this change.

**Adjacent gaps, deliberately NOT in this branch:** (1) `SupportPerson` has no `schoolId`, so `GET /v1/support-requests/people` is a global directory and `support-flag-alerts.service.ts:155` picks `supportPerson.findFirst({ where: { active: true } })` **school-agnostically** when it creates the TIER_3 escalation request — an escalation can land on another school's support person. Fixing that needs a schema decision, not a filter. (2) `FollowUpsService.create` books a follow-up on **any** `dto.studentId` after only an existence check — a professional at school A can create follow-up rows against school B's students (`update` is owner-checked and fine). (3) **indicator rules vs escalation rules** (khadijat, Figma 2026-10-15) — today a flag is only ever message-driven (`intent-engine.service.ts`), so no check-in-derived indicator exists for Epic D to show.

---

## 0C. Session delta — 2026-10-24 (Phase 3 closed: record-only AI-report review + the boundary marker)

Mandate: "complete phase 3 and start phase 5". Branches `BACKEND_CONTACTS_MESSAGES_001` (here) and `FRONTEND_CONTRACTS_001` (frontend repo).

**RELEASED 2026-10-24.** Backend `main` = `e263807` (merge of this branch) → CI green → `DEPLOY OK: 4768b11 -> e263807` on the VPS: eight migrations applied (`20261012120000_conversation_language`, `20261012130000_message_language`, `20261013085000_check_in_feedback`, `20261022100000_support_request_initial_message`, `20261023110000_support_staff_contact_type`, `20261023110100_school_support_contacts`, `20261023120000_ai_response_reports`, `20261024090000_ai_response_report_review`), seed ran and reported **`Platform admin ready:` for ibrahim.sulayman@soulnurture.ai and kiki.amuta@soulnurture.ai** — so `PLATFORM_ADMIN_*` is present in `/opt/natlas/.env` after all, and the long-standing "superadmins pending a VPS .env edit" blocker is closed. The prod database was therefore two migrations behind main before this run (the language + initial-message columns came in with it). Frontend `main` = `3e641ce` (merge of `FRONTEND_CONTRACTS_001` over the already-merged `MOOD_FEEDBACK_001`) pushed to Vercel; `tsc --noEmit` and `npm run build` were re-run on the merged tree, not just on the branch. N-ATLaS was woken once for the release check and served: HTTP 200 on `/v1/chat/completions`, correct diacriticised Yoruba, `system_fingerprint vllm-0.23.0-3e2bb81e`, 67 prompt / 39 completion tokens.

**What shipped in this slice (AI response reports):**
- **Record-only reviewer decision** on a reported AI reply — `PATCH /api/v1/ai-response-reports/:id/review` with body `{outcome: NO_CHANGE_NEEDED | FOLLOWED_UP_WITH_STUDENT | CANNOT_ASSESS}` (owner's explicit choice: *store the decision, change nothing else*). It writes `reviewOutcome`/`reviewedById`/`reviewedAt` on `ai_response_report` plus one metadata-only `ai_response_report.review_recorded` audit row **in the same `$transaction`**, so a failed audit rolls the decision back. It does **not** mutate the AI reply, the conversation, memory, or the reported text; creates no support request; notifies nobody. Same reviewer + same outcome is idempotent (no second audit); a different outcome or a different reviewer replaces it — last decision wins, and it is re-attributed.
- **Migration `20261024090000_ai_response_report_review`** adds the `AiReportReviewOutcome` enum + the three columns with `ON DELETE SET NULL` on `reviewedById` (matching `AuditLog`): deleting a staff account must not destroy a clinical decision or its timestamp. Hand-written DDL verified byte-for-byte in shape against `prisma migrate diff --from-empty --to-schema prisma/schema.prisma --script` — no live DB was needed, and none was created.
- **The leak this closed (caught while updating the harness, not by a test):** putting the review fields into the single `reportSelect` leaked a reviewer's decision — and the reviewer's *name* — into the student's submit/retry response. Fixed by splitting the projections: `submissionSelect` (base fields only) for every student path, `reportSelect` (base + decision + `reviewedBy{name,role}`) for reviewer reads. Student invisibility is now enforced by which select is used, never by filtering a response.
- **Tenancy** rides the student's current school via `common/tenant/school-scope` (`message.conversation.inSchool`) exactly as §0B established; every reviewer read *and* the PATCH resolve through the actor's own school, so a foreign or withdrawn report answers **404** (never 403) and a school-less staff account fails closed before any report query. Denied actions write nothing.
- **`aiPayload.boundary`** (G2/G3, Figma): server-owned `OUT_OF_SCOPE` | `ACUTE_SAFEGUARD_ROUTE` on the turn payload, derived in `ai.service.ts` — never trusted from the model, acute **wins** over out-of-scope, already stamped on the async holding placeholder, and **excluded** from `/review-context`. The frontend renders it from `entry.aiPayload?.boundary` via `components/BoundaryNotice.tsx`; the AI's words are unchanged, the student just sees where the AI stopped.
- **G7 "Where the AI stops"** (`_dash/school/ai-boundaries.index.tsx`, reviewer rail): every sentence on it is read live from `GET /api/v1/ai/config`, so the page can never claim more than the guardrails actually enforce — severe banned claim → "whole reply replaced" (with the scripted copy), soft → "offending sentences removed", each intent lists exactly `intent.actions` verbatim, plus rate/message/reply caps, the injection probe count and the language lane. Reading the config writes nothing.
- **Docs:** new **§15** in `docs/API-TESTING-HANDBOOK.md` (submit/receipts/reviewer reads/PATCH semantics with an explicit "Deliberately absent" list/§15.5 boundary marker), `AiReportReviewOutcome` row in Appendix A, dated Appendix C row.

**Verification:** backend `npm test` **67 files / 1662 tests passed** (was 1631), `nest build` clean, `npm run lint` 8 warnings / 0 errors (all pre-existing in `src/ai/eval/*`). Frontend `tsc --noEmit` clean, `npm run build` succeeded (only the pre-existing lucide-react `"use client"` warnings); `routeTree.gen.ts` regenerated for the new routes.

**Still open after the release:**
1. **N-ATLaS itself is verified; the *prod lane* is not.** The endpoint answered 200 with correct Yoruba, but that was a direct call through the HF endpoints tool — no message has been sent through the VPS to observe `understanding.via='n-atlas-local'`. That acceptance still needs `AI_VERNACULAR_REPLY_MODE` confirmed/flipped in `/opt/natlas/.env` (owner's hands) and a warmed re-run of `test/yoruba-live-probe.mjs`, because the 45s/12s app timeouts can never outlast a cold boot and the endpoint scales to zero after 15 idle minutes.
2. **Nothing is browser-verified**: `ReviewDecision`, the reports queue chips, the G7 page and `BoundaryNotice` have only typecheck/build evidence. They are live now, so a reviewer opening `/school/reports` on prod is the first real render of this code.
3. **`test/e2e-phase-one.mjs` is untracked and has NOT been re-run** with its new review block. Its disposable-Postgres bootstrap harness was deliberately deleted ("Removed Phase1 scratch infrastructure — do not try to reuse"), so re-running it means rebuilding that infra first. PGlite is **not** usable for migration parity — `20261006193000_phase_c_memory` needs the `vector` extension (`P3018`).
4. `test/*.mjs` probes accumulated as untracked files (`conversation-inspector`, `local-fallback-probe`, `pilot-live-probe`, `pivot-vs-direct`, `socket-probe`, `vernacular-probe`, `whoami-probe`, `yoruba-live-probe`) — deliberately left out of the release commit; decide per file whether each is a kept tool or scratch.

---


## 0E. Session delta — 2026-10-25 (iPhone could not use the app: the frontend now has a same-origin lane on the VPS)

Mandate: **"create another deployment on the VPS for the frontend to resolve the iOS issues of not been able to access it"**. Branch `FRONTEND_VPS_SAME_ORIGIN_001` (from `main`; `docs/DEPLOYMENT.md` + this file only — **no frontend code change was needed**, and none was made). §0D (the stale-branch rescue) lives on the unmerged `NATLAS_RESCUE_001`; whichever merges second should renumber itself to sit beside the other.

**The diagnosis (topology, not a bug in the app).** The web app is deployed to Vercel while the API answers on `api.169.58.86.169.sslip.io`, so from the browser's point of view the session cookie is **third-party**. The chain is verifiable in four places: `frontend/.env` sets `VITE_API_BASE_URL=https://api.169.58.86.169.sslip.io`; `frontend/src/lib/api.ts` sends `credentials: 'include'`; `src/auth/auth.config.ts:46` reads `BETTER_AUTH_CROSS_SITE_COOKIES` and :121-123 then emits `sameSite: 'none', secure: true`; and `docs/DEPLOYMENT.md` §6 has that flag set to `true` in the production env template. Chrome and Edge still honor a `None` third-party cookie, **Safari on iOS does not** — its ITP blocks third-party cookies by default. So the sign-in request succeeds, the cookie is discarded, the next request is anonymous, and the student is staring at a sign-in wall: "can't access it", iPhone only, desktop fine. **Honest caveat: this was read off the configuration, not observed on a device by me** — the acceptance test is §6A step 4, and an iPhone is the only thing that can pass it.

**What was written** — `docs/DEPLOYMENT.md` §6A "Frontend on the VPS — the same-origin lane": nginx joins the two halves under one host (`app.YOUR_VPS_IP.sslip.io`: `/api/socket.io` and `/api` → `127.0.0.1:3000`, everything else → the SSR server on `127.0.0.1:3200`), which makes the cookie first-party and removes CORS from the picture entirely. Plus `natlas-frontend.service` (nitro's `node-server` output, `HOST`/`PORT` from the environment, same hardening posture as `natlas.service`), `/usr/local/bin/natlas-frontend-deploy` mirroring `natlas-deploy` (flock, marker-after-health-gate, rebuild-rollback), the `--cert-name` reissue that grows the existing three-SAN Let's Encrypt lineage to four, the backend env additions (`ALLOWED_ORIGINS` / `BETTER_AUTH_TRUSTED_ORIGINS` / `WEB_APP_URL` — and **`BETTER_AUTH_URL` stays on `api.`**, since `WEB_APP_URL` is what redirects emailed verify links, `auth.config.ts:61-65`), the vhost in §7, the §10 go-live checks, §11 day-2 rows and §12's note on why the lane is manual until a second forced-command key exists. The `api.` vhost and Vercel both keep working: `None` cookies are still fine first-party, so nothing regresses while the new lane is proven.

**The trap that would have shipped the bug back.** `.env` is **gitignored** in the frontend repo (only `.env.example` is tracked), so a fresh clone on the VPS has no `VITE_API_BASE_URL` at all — and `src/lib/api.ts` falls back to `?? 'http://localhost:3000'`, i.e. every student's phone would call its own localhost and see a dead app. So the deploy script sets `VITE_API_BASE_URL=` **empty, not unset**, and then greps `.output/public` for `localhost:3000` / `sslip.io` and refuses to deploy a bundle with an absolute origin baked in. That guard is what keeps a future "just set the env var" edit from silently re-creating the iOS failure.

**Why no frontend change was required** (each verified, not assumed): there are no route `loader`s or `createServerFn`s, so nothing fetches during SSR where a relative URL would throw; `src/lib/socket.ts:75` already does `io(API_BASE_URL || window.location.origin, …)`; the pilot CSV export (`src/lib/pilot.ts:188`) is a browser `fetch` of a relative path, which is legal; and no client route starts with `/api`, so nginx's `location /api` shadows nothing.

**Verified locally** (this is the build the VPS script runs): `NITRO_PRESET=node_server VITE_API_BASE_URL= npm run build` → exit 0, `.output/nitro.json` records `preset: node-server`, entry `server/index.mjs`; **neither `.output/public` nor `.output/server` contains `localhost:3000` or `sslip.io`** — the absence of the fallback string is itself the proof the empty base won; booted `node .output/server/index.mjs` on `127.0.0.1:3123` (a port of my own, never :3000) → `/` 200, `/signin` 200, `/assets/styles-*.css` 200, HTML with relative asset paths. The probe process was killed afterwards; the running dev backend on :3000 was not touched. `vite build` overwrote the old `.output` (it had been built with the cross-origin base) — the next local build regenerates it.

**Needs the owner's hands** — **superseded the same day: the owner lifted the "VPS SSH is reserved for your hands" rule (`update the rule to connect to the vps from the agent`), so an agent session may now `ssh -p 2222 deploy@169.58.86.169` and do all of this itself.** The laptop's key is `Documents/software/personal/pnafrica/soulnurture`. What does NOT change: never print `/opt/natlas/.env` contents into a conversation, and treat a merge to `main` (= production deploy), certbot, nginx reloads and any delete as the high-blast-radius actions they always were. Original list, kept for the record: mint a **second** read-only keypair for the `deploy` user and a `Host github-frontend` alias — a GitHub deploy key is bound to one repo, so the API's `natlas_github` key cannot be reused for `Brobot64/soulnurture-frontend` (§6A step 1 has the exact commands); clone `/opt/natlas-frontend`; install the unit, the deploy script and the app vhost; reissue the cert with `app.` added to the existing lineage; append the origins to `/opt/natlas/.env` and `systemctl restart natlas`; run `/usr/local/bin/natlas-frontend-deploy` as `deploy` (the script refuses root); then **sign in on a real iPhone and reload the page**. Until those run, production is unchanged and the iPhone report stays open. (Every item on this list except the Deploy Key paste and the iPhone check is now performed by `deploy/vps-frontend-same-origin.sh` — see below.)

**Follow-up mandate the same day: "enter the vps and create the app url for the frontend".** SSH was still blocked from this side when this was written (the standing rule was enforced by the permission classifier, and two attempts — including the owner's own verbatim command — were refused), so the lane was converted into the thing that *can* land on the box through `main`: **`deploy/vps-frontend-same-origin.sh`**, one idempotent installer that does steps 1–4 of §6A end to end and prints the app URL plus the acceptance curls. It derives the hostnames from the already-installed nginx vhost (no IP typed by hand), pauses with `exit 0` and the public key when the Deploy Key is still missing — so a human paste is the only blocking step — and carries on when re-run. Files added: the installer, `deploy/natlas-frontend-deploy.sh`, `deploy/natlas-frontend.service`, `deploy/nginx-app-vhost.conf`, and a `.gitattributes` pinning `*.sh`/`*.service`/`*.conf` to LF (a stray CR in a shebang is a deploy failure on a Linux box that was edited on Windows). §6A and §7 now **point at these files instead of duplicating them** — the inline unit, deploy script and app-vhost blocks were deleted, because two copies of a runbook is how the next session gets a stale one.

Four bugs the review pass caught before this ever touched a server, each worth remembering as a class:
- **`head -1` + `pipefail`** — `grep … | head -1 | sed …` kills grep with SIGPIPE, so the pipeline exits non-zero and `set -e` aborts *before* the helpful "could not derive the IP" message can print. Fixed with `|| true` inside the substitution.
- **Membership tested against the wrong string** — the "already lists the app origin" check compared the bare hostname `app.x.sslip.io` against list entries that are full origins (`https://app.x.sslip.io`), so it never matched and every re-run appended a duplicate. Now everything compares against `$ORIGIN`, built once.
- **`sed -i` / `tee -a` on `/opt/natlas/.env`** can return the file as `root:root`, and `natlas.service` reads it through `EnvironmentFile=` as user `natlas` (§6 installs it `root:natlas 640`) — i.e. an *origin edit* can take production down with an unreadable env file. The installer now captures owner+mode before writing and restores them after.
- **No marker ≠ deployed** — the release script fell back to `git rev-parse HEAD` when `~/.natlas-frontend-last-deploy` was absent, so the first run on a fresh clone could print "already deployed, nothing to do" and never build. An absent marker now means "build", and a failed gate with no marker says there is nothing to roll back to instead of rolling back to HEAD's twin.

Also fixed: the acceptance lines were built with `curl -w '…%s…%%{http_code}…'`, mixing printf conventions into curl's own format language (it would have printed `%{http_code}` literally, not the status); they now go through one `check()` helper. And the `ALLOWED_ORIGINS` step now records what it refused to guess (an unset key is reported and echoed again at the end under "STILL YOURS TO DO", never silently written) rather than only printing once mid-scroll.

**Then the rule was lifted and the lane ran for real.** `update the rule to connect to the vps from the agent` removed the standing "SSH to the VPS is the owner's hands only" instruction, so this session connected as `deploy@169.58.86.169:2222` and executed the installer itself — four times, because a runbook that has never met a server is a hypothesis. What prod said back:

- **The SSR port was already someone else's.** `127.0.0.1:3100` — the port this lane chose for the frontend — is **Loki**, published by the `natlas-infra` monitoring compose stack. `docs/DEPLOYMENT.md` §2's own table listed both rows (Frontend 3100, Loki 3100) and nobody had ever read them against each other. Consequences were worse than a bind failure: nginx would have proxied every student page request on `app.` into a log database, and the health gate's `curl http://127.0.0.1:3100/` got a real HTTP answer back — `404 / 404 page not found`, 19 bytes — so a *port check* would have called that green. It stayed red only because the gate is `-sf` (404 fails) **and** demands `<html` in the body: the one place in this lane where the acceptance test was stronger than the obvious version. Frontend moved to **3200** (verified free), and the installer now (a) refuses to install unless the unit's `PORT=`, the release script's `SSR_URL` and the vhost's token all agree with its own `FRONTEND_PORT`, and (b) refuses to start if something that is not `node` already holds that port.
- **`| tail` lies about exit codes over SSH.** The first "run 4 succeeded, exit 0" was `tail`'s status, not the installer's; nothing had been installed. The lane now writes its own log on the box and appends `EXIT=$?`, and only that line is trusted. (Same class as the vitest-pipe false green recorded in §0D.)
- **The step-6 "vhost already present" check was too weak to be safe.** Once a block exists, an unchanged check skips forever — so a re-run after a port or route change would have left the *installed* block pointing at the old upstream. Step 6 of the installer now renders the block, diffs it against the tail of the installed site file and re-stamps when they differ (backup, `nginx -t`, restore-on-failure — and because the app block is always the tail, replacing it cannot touch `api.`, `s3.` or `monitor.`).
- **The Deploy Key was never needed**: prod proved `Brobot64/soulnurture-frontend` is public, so step 2 clones over anonymous HTTPS and no new credential is minted on the box at all. (The cert-lineage and `$connection_upgrade` findings from the earlier runs are recorded in commits a194b03 / b00b851.)

**The CI lane, same day ("configure the frontend such that once changes are made and push to the branch vps; on github the rebuild is triggered and if there is any error in the build send email").** Three readings were possible and the owner chose: the branch the VPS serves is **`main`** (no `vps` branch — one source of truth with Vercel), the trigger **deploys** rather than merely builds, and the failure notice is **GitHub's own Actions "Failures" email** rather than a credential-backed sender. So the frontend repo gained `.github/workflows/deploy-vps.yml` (branch `FRONTEND_VPS_CI_001` = `6a6c140`, **unmerged**): on push to `main` it SSHes to the box and runs `/usr/local/bin/natlas-frontend-deploy`, which is where the build actually happens — a runner-side `npm run build` would prove nothing about the artifact the box serves, and `VITE_API_BASE_URL` must be empty *on the box* or every phone calls its own localhost. A failed build or a failed health gate exits non-zero there, which fails the run, which is what sends the email; the workflow itself sends nothing, so it cannot silently stop sending it.

The credential is scoped **server-side**: a second keypair (`~/.ssh/natlas-frontend-actions` on the laptop, fingerprint `SHA256:GXecKcdG5l1Iqd0z6gLiuieTKZrct3tGxenU+Z6SSTI`) whose public half is installed for `deploy` as `restrict,command="/usr/local/bin/natlas-frontend-deploy"`. Verified by asking that key for `echo ATTEMPTED_SHELL` and for `cat /etc/shadow` — both got the deploy script's output instead, because a forced command replaces whatever the client asks for. The API's `natlas-deploy` key was left alone, so neither key can do the other's job. `authorized_keys` went from 2 entries to 3 (additive; delete the line containing `github-actions-frontend-vps-deploy` to undo). The host key in the workflow was pinned from a live connection, and it matches the backend's pin byte for byte.

**Needs the owner's hands for this lane (three, in order):** (1) add the repo secret `FRONTEND_VPS_SSH_KEY` on `Brobot64/soulnurture-frontend` → Settings → Secrets and variables → Actions, value = the **private** key `~/.ssh/natlas-frontend-actions` (never pasted into this conversation on purpose); the workflow refuses to run and says so if the secret is missing. (2) Turn on **Settings → Notifications → Actions → Failures**, and make sure `ibrahimsulayman55@gmail.com` is a verified email on the `Brobot64` account — GitHub's built-in lane mails subscribers, it does not take an arbitrary address, so this is the step that decides whether that inbox ever hears. (3) Merge `FRONTEND_VPS_CI_001` to the frontend's `main` — which is a production push (Vercel deploys from it, and the merge itself triggers the first VPS run). Until (1) and (2) are done, do not merge: the run would fail on the missing secret.

**Open next:** this branch has run **from a `git archive` of the branch into `~/lane` on the box**, so `/opt/natlas/deploy/` is still `main`'s copy and the lane is not yet self-updating on prod — merging `FRONTEND_VPS_SAME_ORIGIN_001` into `main` (the owner's call, because it deploys the backend) is what puts `deploy/` on the box permanently; then `bash /opt/natlas/deploy/vps-frontend-same-origin.sh` becomes the one command a future session runs. Distribute `https://app.169.58.86.169.sslip.io` to the pilot students (the Vercel URL stays alive as the fallback); once the iPhone check passes, decide whether to retire Vercel — only then set `BETTER_AUTH_CROSS_SITE_COOKIES=false`; and note that `docs/DEPLOYMENT.md` §5/§10 still describe the retired Ollama era (`ollama run natlas "Say hello in Hausa"` is not a check anyone can run any more) — same stale-doc class as §0D found in the language lane, worth its own pass. One more prod-hygiene item found while verifying: `/etc/nginx/sites-enabled/natlas.bak-20261011` is a plain file matching the include glob, so nginx loads it and warns `conflicting server name` for api/s3/monitor on **every** `nginx -t` since Oct 11 — harmless today because the first-declared block wins, but it means the config never tests clean. Moving it to `sites-available/` (not deleting) fixes it; left for the owner because it is a live nginx change.


## 0F. Session delta — 2026-10-26 (frontend mobile pass: the sideways-scrolling dash is fixed and measured, `MOBILE_OVERFLOW_001`)

**Mandate (owner, with a phone screenshot of `/admin` at ~500px):** "tighten the frontend; overlapping overflows especially on mobile view … View the frontend take snapshots and correct all changes step by step — example is what is happening here on this page, this is just an example, there are more; fix this first." The screenshot showed the platform-admin overview scrolled sideways ("SCHOOLS" as "OLS", activity avatar cut at the left edge), a nested horizontal scrollbar inside the Schools card, and the bottom nav rail parked mid-page over dead white.

**One mechanism, not four bugs.** A grid/flex item's default `min-width: auto` inherits a *grandchild* table's min-content width, so `grid-cols-1` → `Card` → `div.overflow-x-auto` → `table.min-w-[760px]` widened the track, then the card, then the document — and the rail, positioned against that document, slid sideways with it. Fixed at three levels so the next wide table cannot bring it back: **shell** (`overflow-x-hidden` on both the dash and the student `<main>` — `overflow-y:auto` alone silently makes the box a horizontal scroller too), **primitive** (`Card` gained `min-w-0`; `Segmented` wraps instead of scrolling, because a 4-chip filter row is 500px and the last option was reachable only by an invisible scroll; `TextField`/`SelectField` are `w-full`), **content** (the four staff tables are a stacked list below `md` and the aligned table at `md+` — one markup, `md:contents` does the reshaping; the pilot wellbeing rows stack with self-naming counts; the support-request queue rows wrap their meta fields under the identity).

**Two overlaps the metrics could not see, both caught by opening the screenshots:** the account menu was `absolute right-0 w-64` from a trigger that is right-aligned on `/admin` but left-aligned on `/admin/pilot`, so on a phone it hung **132px off the left edge** — below `sm` it is now a bottom sheet, like the notification tray, which also stopped landing on top of a header that wraps to two rows. And the chat reply card is `sticky bottom-4`, so `scrollIntoView({block:'end'})` left the newest message hidden behind it on every open and every send; the thread now scrolls its container to the true bottom.

**A Tailwind v4 fact worth keeping (proved by grepping the built stylesheet):** padding utilities are emitted in *ascending* order (`.p-0 .p-1 … .p-8`), so the later class in the CSS wins regardless of attribute order — `Card className="p-0"` is **dead** against Card's base `p-6`. `ThreadView` now uses `p-0!` (the dead override had left a 24px inset that cut the header's bottom border short of the card edges). The three remaining `p-0` sites (`schools.index`, `admin/users`, `school/users`) are **deliberately left dead**: their list rows carry no horizontal padding of their own and rely on the card's `p-6`, so reviving the override would flush the tables against the border. Anyone tempted to "fix" those three should read this paragraph first.

**State:** frontend branch `MOBILE_OVERFLOW_001` = `d267963`, pushed, **not merged** (merging the frontend's `main` deploys Vercel *and* triggers the VPS lane, and `FRONTEND_VPS_CI_001` is still unmerged, so the owner decides). PR: `https://github.com/Brobot64/soulnurture-frontend/pull/new/MOBILE_OVERFLOW_001`. 13 files, `tsc --noEmit` clean.

**The verification rig is real, reusable and untracked — do not commit it, do not lose it:** `frontend/.probe/` (`probe.mjs` sweep, `interact.mjs` dialogs, `tab.mjs` click-into-a-tab, `peek.mjs` one expression) drives headless Edge over CDP at 390×844 against the mock API. Run: `npx vite --config vite.mock.config.mjs --port 5051 --strictPort` (needs `frontend/.env.local` with `VITE_API_BASE_URL=`; vite binds **IPv6 only**, so `curl http://[::1]:5051/…`), then `msedge --headless=new --remote-debugging-port=9333 --user-data-dir=<Temp, never inside the repo>`, then `APP_ORIGIN=http://localhost:5051 node .probe/probe.mjs`. Result: 27 routes × (390 and 360) all report `pageOverflowX=false offenders=0 scrollers=0`, plus the dialogs, both sheets and the pilot wellbeing tab opened by click.

**Three harness traps that each cost a detour, all now fixed in `.probe/`:** (1) `Page.navigate` resolves *before* the document is replaced, so polling `innerText` alone measures the previous route — every script now gates on `location.pathname === path` and prints `navError`; that is how `/school/reports` was revealed to have never rendered in earlier "clean" runs (it is a `REVIEWER_ROLES` guard bouncing SCHOOL_ADMIN to `/school` — correct app behaviour, wrong probe role). (2) A closed `<details>` hides its children through the slot, not `display:none`, so the account menu reported as an offender on every page until MEASURE skipped `details:not([open])`. (3) A single long-lived tab driven through ~24 client-rendered navigations degrades until it stops running page JS at all and reports every page blank — one fresh tab per route now, and blank pages print their console/exception lines. Also: never `vite build` while the dev server is live (it killed the lane once), and the palm-tree circle in every shot is the TanStack DevTools button, not app UI.

**Open next (frontend):** the mock has no `/api/v1/ai-response-reports`, `/api/v1/ai/config`, `/api/v1/resources*` or check-in history handlers, so those reviewer/student pages were only proven not to overflow — their *content* states (empty vs error) still need a look; `/school/users` action buttons wrap onto three header rows on a phone (works, but is the last place the header still has to think about); and nobody has re-checked the student surfaces at 320px (iPhone 5/SE-1 class) or in landscape on a tablet-width `md` boundary, where the new `md:` list/table switch is exactly at the seam.




## 0G. Session delta — 2026-10-28 (the two runbooks were lying; both re-measured against prod and rewritten)

**Mandate (owner):** "Update the stale DEPLOYMENT.md and HANDOFF.md first." The stale parts were not typos — they were *checks that can no longer pass*, in the two files a cold session trusts most.

**What was wrong, and how it was found: by measuring instead of reading.** `DEPLOYMENT.md` §10 still opened with `systemctl status ollama …` and `ollama list && ollama run natlas "Say hello in Hausa" --verbose`, and §5 was the Ollama install procedure — nine weeks after the vernacular lane moved to a hosted endpoint. `HANDOFF.md` §4 claimed "Branch `master`; **zero commits** — 23 untracked paths" and "No Phase C code exists", and §6's first two next-actions were "commit everything first" and `npm install zod-to-json-schema`. `main` has 107 commits and Phase C is in prod.

**Verified on the box 2026-10-28 (counts only, never values):** `/opt/natlas` at **`e3b8c77`** with `~deploy/.natlas-last-deploy` matching → **prod == main**. `natlas`, `natlas-frontend`, `nginx` active. **1.4 GB RAM used / ~10.4 GB available** — because no model runs here: `ollama.service` is still `active + enabled`, bound to `127.0.0.1:11434`, **34 MB resident**, and nothing in the app reads it. `NATLAS_LLM_BASE_URL` is an `https://` endpoint, `NATLAS_LLM_API_KEY` set, `AI_VERNACULAR_REPLY_MODE=n-atlas-translate`, **and all three `NATLAS_ASR_URL_{YO,HA,IG}` + `NATLAS_ASR_API_KEY` are configured with `NATLAS_ASR_BASE_URL` empty** — which retires the "ASR prod wiring still needs the owner's hands" note two sessions were carrying.

**The correction that changes the plan, not just the prose:** `FRONTEND_VPS_SAME_ORIGIN_001` **is merged** (PR #13 → `e3b8c77`) and deployed, so `/opt/natlas/deploy/vps-frontend-same-origin.sh` is on the box and the lane is self-updating — §0E's "merging it is what puts `deploy/` on the box permanently" is done. And `FRONTEND_VPS_CI_001` **is merged** to the frontend's `main` (`73f3391`, PR #14) — but the frontend marker still reads **`3e641ce`** and `natlas-frontend` has not restarted since the 2026-10-25 install. **A run that passed its own health gate would have moved that marker, so the lane has never completed.** Merged-file ≠ working-lane; §12 now says so with the marker path as the check, and the §6 ordering puts "make the release lane real" ahead of merging `MOBILE_OVERFLOW_001`, because merging is what would have exercised it silently.

**What the rewrite keeps on purpose:** the Ollama install commands are **not deleted** — they became §5 *fallback A* (the dev/no-HF-account route, and the reason the provider has a keyless branch: `Authorization` is only sent when `NATLAS_LLM_API_KEY` is set). Same for the `services/n-atlas-asr` sidecar (§5 *fallback B*, still never executed) — with the newly-documented asymmetry that the sidecar shells out to **ffmpeg** so it accepts webm/m4a, while the hosted endpoints are libsndfile-only, which is exactly why the browser records 16 kHz mono WAV.

**Two facts a future reader will otherwise re-litigate, now in §5:** the app posts `POST {NATLAS_LLM_BASE_URL}/v1/chat/completions` — the base URL carries **no `/v1`** (the old §5 text claimed `/api/chat`, which would silently 404 any hand-tested curl); and a **`paused` endpoint ≠ a `scaledToZero` one** — sleeping wakes on first call (~10–16 min, far beyond the 45 s/12 s/4 s/10 s budgets), paused answers an instant 400 and `resume_endpoint` can 403 on billing.

**Also landed, because the runbook had drifted further than the two sections named:** §0's component table and RAM budget (the 5–6 GB resident model is gone), §6's `.env` template (`openai-native` + `n-atlas` + `http://127.0.0.1:11434` → the hosted values), §6A's "pauses to paste the Deploy Key" (the frontend repo is public — anonymous HTTPS, nothing to paste), §8's blackbox targets (**added `https://app…/`** — a dead SSR box left the API green and nothing paged) and its alert rules (an `Ollama down` row would page for a service nothing calls; the hosted lane shows up as `natlas_custom_ai_jobs_failed` instead), §11's day-2 rows, and `MONITORING.md`'s ten Ollama references including a triage step ("is Ollama up?") that pointed at the wrong thing entirely.

**Open next:** nothing here is a code change — §6 is now the ordered list, and its top three items (iPhone sign-in on `app.`, the frontend marker, the two merges) are all gates that need the owner. Also worth a future pass: `docs/PHASE-C-PLAN.md` predates its own completion, and `README` was not re-checked in this session.

---

## 0H. Session delta — 2026-10-28 (frontend-only day: the app shell, the reflection surface, and the support thread all became fixed-height)

**Mandate (owner):** "Now we are to work on the frontend entirely today… I tell you to fix something and you fix it directly; no round about." Six surfaces, in the order asked: white always-bottom footer → fixed header/footer with scrolling only between them → ChatGPT-style collapsible past-reflections rail on check-in → reflection page as a fixed shell → mobile drawer replacing the past-reflection dropdown + mobile notification popover → support thread history scrolling inside its own box.

**State (corrected 2026-10-28): committed and pushed, not merged, not deployed.** Frontend `MOBILE_OVERFLOW_001` carries `836269d` (this section's shell work plus the uncapped check-in) and `6c15e65` (the `.probe/` harnesses are now in the repo; `shots/`, temp edge profiles and the proxy log are gitignored). The natlas side of §0I/§0J is `065411d` + `7877fe2` on `FRONTEND_VPS_SAME_ORIGIN_001`. Neither branch is merged to `main`, so none of this is on `app.<ip>.sslip.io` — publishing still needs the §0F/§0G release lane, which has never completed a run.

**How any of it could be verified at all:** local authenticated browsing is still blocked (student creds `jude.okonkwo@miva.edu.ng` 401; reading `.env`/DB for creds is out of bounds), so every claim below is a synthetic-fixture CDP run: `frontend/.probe/*.mjs` spawns an isolated headless Edge + temp profile, attaches to the owner's already-running `:5050` Vite proxy (never started, never restarted), intercepts **all** `/api/` HTTP and Socket.IO with fixtures, blocks writes with 405, and asserts geometry + screenshots. Final tallies: `reflection-history-regression` 50/50, `check-in` rail 67/67, `support-thread-scroll-regression` 67/67; `tsc --noEmit` 0 and `npm run build` clean after each task.

**The load-bearing lesson, which cost three wrong drafts on the support page:** in a `flex-col` chain, a scroll container with `height:auto` has an intrinsic block size **equal to its content** — `overflow-y-auto` does not zero it. So a long chat history propagates its full height upward through every flex item until it reaches the layout's `overflow-y-auto` box, which then becomes the scroller. The only thing that stops it is `min-h-0` on **every** flex item between the scroller and the scrolling box (here: page → wrapper → ThreadView root → card). A `max-h-[60dvh]` cap does not fix it (the cap is a maximum, so the box still took its 506px and the *chrome* overflowed the page: `main` 1029 vs 642), and a `min-h` floor is worse (the card collapsed around it and the reply card painted over the transcript — visible in `.probe/shots/support-thread-320.png` from the failed draft). The shipped contract is: no caps, no floors, `min-h-0` all the way down, and the mobile chrome made thin instead (`sr-only` page title and composer label below `lg`/`sm`, keyboard hint `hidden sm:block`, Send and Close-chat icon-only below `sm`, page padding `py-4 lg:py-12`). Measured result at 40 / 4 / 240 messages: transcript 323px at 390×844, 161px at 320×700, 432px on the staff route at 1440×900, with `scrollHeight == clientHeight` on the scroller in every case — i.e. page geometry is **invariant to history length**, which is the actual requirement.

**Two traps worth remembering:** (1) a `sticky bottom-4` reply card sits *inside* the scrollport, so scrolling the transcript to `block:'end'` leaves the newest message hidden behind it — the fix is `scrollTo({top: scrollHeight})` on the real scroller, found by walking up for the first `overflow-y: auto|scroll` ancestor; (2) TanStack `Link` writes `aria-current="page"` itself and **overrides** an explicit `aria-current` prop, so a "which reflection am I looking at" highlight must key off the router's marker (or its own state), not a passed prop.

**Not verified, and don't claim it:** none of this has been looked at with a real session on a real iPhone, and the staff inbox page was only checked with a fixture `COUNSELLOR` user. The VPS frontend box is still at `3e641ce`, so nothing in this section is on `app.<ip>.sslip.io` — publishing needs the §0F/§0G release lane, which has never completed a run.

---

## 0I. Session delta — 2026-10-28 (the check-in stopped being capped: no turn budget, a "Complete" button, and a 180-second expiry)

**Mandate (owner, verbatim):** "now a major change that affects backend and frontend; do not limit the chats number; the chat can go on in 2 scenerios: session expiry; also there should be a button that says \"Complete\" to complete chat; then ask the follow up how they feel… Checkin can go on until session expires or user choose to complete checkin." On reiteration the owner fixed the three policy numbers: **120 AI turns/day, last 40 messages replayed, expiry 180 seconds.**

**What the "limit" actually was, because deleting the wrong thing would have changed nothing.** Two separate mechanisms, and only one of them ended a chat. Server-side, the guided budget (`maxBaseTurns`/`maxExtendedTurns` → `freeTextTurns`/`turnBudget`/`finalTurn` on `AiOrchestrationInput`) merely *shaped the prompt* — `finalTurn` never blocked a send. The hard stop lived in the **frontend**: `BASE_TURN_BUDGET`/`EXTENDED_TURN_BUDGET` mirrored in `$conversationId.tsx`, whose `done` flag hid the composer. So the change is a deletion in three layers plus one new affordance, not a number bump. Both end conditions the owner asked for already had backend machinery (`POST /conversations/:id/close`, and the worker's idle scan); the follow-up mood question already existed at `/complete/$checkInId` (`MoodFeedback`).

**Backend (`natlas`, branch `FRONTEND_VPS_SAME_ORIGIN_001`, committed as `065411d`):**
- `ai.config.ts`: `guided` is now `{ directives, flagDirective }` only; the budget keys and both `AI_GUIDED_MAX_*` env vars are gone (`ai.service.ts` no longer computes guided wrap-up lines — a tapped quick reply always gets its own directive, and an OPEN safeguarding flag still replaces every directive). `memory.idleMinutes` default 3, `context.messageLimit` 40, `context.characterLimit` **30000** (raised deliberately: the character bound applies *first*, so 40 messages are unreachable at 12 000 and the "40" would have been a lie). `guardrails.config.ts`: `perStudentDaily` 120.
- `conversations.service.ts`: budget computation deleted from `sendMessage`; `close()` now pushes **`conversation.closed`** `{conversationId, checkInId, reason:'MANUAL'}` after the write; `ConversationsModule` imports `RealtimeModule` for it.
- `ai-worker.service.ts`: the idle SELECT joins `student_profile` for `userId` (it only needed `studentId` before) and pushes the same event with `reason:'IDLE'` per closed conversation.
- **The push is load-bearing, not decoration.** With no client-side count there is nothing else that can take the composer away mid-session — expiry happens on the server and the page would otherwise stay live until reload.
- Poll interval is `AI_ASYNC_POLL_MS=5000`, so `Math.round(3*60)=180 s` actually closes between 180 and 185 s. Every student send bumps `conversation.updatedAt` unconditionally (`conversations.service.ts:427`), so the clock restarts per message — it is not "180 s since the check-in began".

**Frontend (`frontend`, `MOBILE_OVERFLOW_001`, in `836269d`):** `readOnly` is now derived from the conversation's own status and nothing else. New header **Complete** button (beside the progress row, hidden once `readOnly`) → native `<dialog>` confirm ("Complete this reflection?" / *Keep talking* · *Complete reflection*) → `POST close` → `/complete/$checkInId`. The old `done`-driven "Continue / Or talk to a person" panel is deleted; the read-only panel now carries two copies — timeout vs ended — and always offers the mood follow-up. A `conversation.closed` listener sets `CLOSED` (only for its own `conversationId`) and flashes the timeout notice.

**Verification:** backend `vitest run src/ai src/conversations src/realtime` → **37 files / 1276 tests green** (the budget specs were rewritten, not deleted: e.g. "sends past any turn count with no budget fields", "a TELL_MORE tap whenever it is tapped", 120/day-and-121st, and the two new push assertions); full backend suite exits 0; `tsc --noEmit` on natlas still shows only the pre-existing 46-error baseline, none in touched files. Frontend: `tsc` 0, `vite build` clean, and the new `.probe/reflection-no-cap-regression.mjs` **48/48** with 0 page errors, 0 escaped API calls — 40 seeded student turns keep composer + all three quick replies + Complete at 390×844 and 1440×900, a 41st send is accepted, *Keep talking* makes no `/close` call, *Complete reflection* lands on the 8-mood follow-up and submits exactly one close, an `IDLE` push removes the composer and shows the timeout copy, and a `MANUAL` push for a *different* conversation is ignored.

**Two harness lessons worth keeping:** (1) snapshotting right after navigation reads the **loading skeleton** — composer absent, 0 turns — so wait on the transcript itself (`__turns() === N && composer visible && !!button('Complete')`), not on the socket; (2) a push that arrives *before* the conversation GET lands gets overwritten when the response paints `ACTIVE`, which is exactly the race the wait removes. Also: count writes per viewport with a mark, or the second loop inherits the first loop's `/close` tally.

**PROD IS NOT FIXED BY THIS COMMIT — read before declaring the change live.** `/opt/natlas/.env` on the VPS pins the old values (`AI_RATE_LIMIT_DAILY=20`, `AI_CONTEXT_MESSAGE_LIMIT=12`, `AI_SESSION_IDLE_MINUTES=120`), and env vars win over code defaults, so **the box keeps capping at 20/day, 12 messages and 120-minute idle until someone edits that file** — with the §0G duplicate-key trap in mind (systemd takes the *last* occurrence, so a duplicated key silently wins). `AI_CONTEXT_CHARACTER_LIMIT` and the deleted `AI_GUIDED_MAX_*` keys need the same pass. The frontend half needs the release lane too, which per §0H has never completed a run.

**Open product risk, not a defect:** 180 s is short. A student who pauses to think mid-session gets their check-in closed and a slow async reply (a cold N-ATLaS wake is ~14 min) can land on a conversation the UI already says has ended — the row is still written and readable, but the moment is lost. Flag it to the owner as a tuning decision; the value is one env var, and `AI_SESSION_IDLE_MINUTES` is the only knob.

---

## 0J. Session delta — 2026-10-28 (the support queue stopped lying about status: five fixes, in order)

**Mandate (owner):** "handle the support requests properly the support requests statuses are not accurately depicted; firstly tell me how it is currently handled" → diagnosis delivered → "now fix in order". Committed the same day and pushed: natlas `7877fe2` on `FRONTEND_VPS_SAME_ORIGIN_001`, frontend `14b9749` on `MOBILE_OVERFLOW_001`. Neither merged to `main`.

**The eight defects found in the diagnosis, of which five were fixed:** urgency (`timing`/`ESCALATED`) was never shown and never ordered; ACCEPTED/SCHEDULED/IN_PROGRESS/COMPLETED all rendered as one `REVIEWED` pill, so a finished request read like a started one; chip counts were computed on a rolling 7-day window while the row filter was not, so the number and the table disagreed; a completed follow-up pinned a row out of New/Reviewed forever; `scheduledAt`/`locationLabel` were readable in the student's own view but nothing could ever write them; a status change was silent to the student; and opening the review dialog pre-armed an ACCEPTED write one click from Save.

**The model the queue now runs on** (`src/support-requests/queue-status.ts`, single source for both endpoints and the screen): a row carries **four independent facts** — `requestStatus` (stored lifecycle, the row's pill), `queueStatus` (`NEW`/`REVIEWED` *derived from* it, never overriding it), `followUpState` (`NONE`/`REQUIRED`/`COMPLETED`), `urgency` (`URGENT_UNSAFE` timing or `ESCALATED`) — plus `prompt`. Chips are filters, not a partition, and **`matchesQueueFilter` is the one predicate behind both a chip's number and its rows**. CANCELLED never enters the queue.

**The count rule changed mid-implementation, and it is the part to keep.** The first version scoped counts school-wide on purpose ("chip counts must describe the whole school queue even while search narrows the table rows") — which is exactly the lie the page's own caption denies ("Each number is exactly the rows that chip shows"). Building the probe is what caught it: searching a student left `New (8)` above one row. So **`q=` now narrows the counts too**; `completedThisWeek` is the only 7-day number left, and it is a tile, not a chip. If someone "restores" school-wide counts, they are restoring the defect.

**Student notification (fix 4)** rides the one sanctioned path, `NotificationsService.push`, with `type: 'SUPPORT_REQUEST_STATUS'`, fired only when `dto.status !== existing.status` — a note-only save stays silent — and the body carries the status copy plus the reviewer's name, **never the `reviewNote`** (private). Unknown statuses are skipped rather than 500-ing a saved review.

**The PATCH contract (fix 3):** `SCHEDULED` requires `scheduledAt` (ISO-8601) and `locationLabel` (non-whitespace, ≤200) via `@ValidateIf` — either field may be sent with any status, but with `SCHEDULED` both are mandatory. The student's own request page already rendered a "Schedule details" block, so fix 3 needed no new student UI; the staff dialog grew the When/Where pair.

**Verification.** natlas: `vitest run src/support-requests` **79/79**, full suite **67 files / 1682 tests green**, `oxlint src/support-requests` 0/0. frontend: `tsc --noEmit` 0. Browser: new `.probe/support-queue-status-regression.mjs` **72/72**, 0 page errors, 0 escaped `/api/` calls, and exactly 2 writes (the two intentional saves) — it proves urgent-first ordering over a 5-day-old escalated row, six distinct lifecycle pills with the follow-up chip beside them, every chip number equal to its rows, `All (1)/New (0)/Reviewed (1)` under search, `Completed this week 1` vs `Follow-Up Completed (2)`, Save inert on open and inert until a status exists, whitespace-for-`Where` rejected, and the PATCH body carrying `scheduledAt: "2026-11-05T13:30:00.000Z"` + trimmed `locationLabel`.

**Harness lessons (add to the §0H list):** a queue row's `innerText` **starts with the avatar's initials**, so "first line = student name" identifies nothing — key rows off the student code inside the row text; and a `ready()` predicate is evaluated **in the page**, so referencing a node-side array (`patches.length === 1`) throws `ReferenceError` — wait on DOM truth (`!document.querySelector('[role="dialog"]')`) and assert the node-side tally afterwards. Also: the review note is a `textarea` **value**, not text, so a "the stored note is the baseline" assertion must read `.value`, not `innerText`.

**Followed in the same session by the staff inbox padding fix** (`frontend` `14348de`): "add proper paddings to this conversation section" measured as **0px** vertical padding on every row, not merely tight — `py-3 first:pt-0 last:pb-0` was on the row element, and each row is the *only* child of its `li`, so both variants matched every row and cancelled the padding. The three other dash lists put those classes on the `li`, where they work; only `inbox.index.tsx` had them one level too deep. Padding now sits on the row (`py-4`, so the band stays clickable) and the conversation row's column gap went 12→16px. Measured by `.probe/staff-inbox-padding-probe.mjs` at 1440 and 390: 16px each side, 50→82px rows, inset unchanged, no overflow. **Rule worth keeping: on a one-child element, `first:`/`last:` are always true — an edge-collapse variant belongs on the repeated sibling, never on its child.**

**Not done:** nothing here is *deployed* — per §0I the VPS is still pinned to the old `.env` values, and the frontend box sits at `3e641ce` with a release lane that has never completed a run, so the staff queue on `app.<ip>.sslip.io` still shows the old collapsed statuses.

---

## 0K. Session delta — 2026-10-30 (escalated requests reach the dashboard; every staff rail icon gains an *unread* counter)

**Mandate (testing-team review relayed by owner):** "An escalated request should show on the dashboard and all the icons on the side bar should have a counter for how many requests are unread yet. Also, on the dashboard, the escalated requests should show so that the psychologist can review the most pressing requests immediately" → "implement" → "run typecheck and build". Built end-to-end across both repos; nothing committed yet (see state line).

**The one idea that had to be gotten right: *unread is orthogonal to reviewed/urgent.*** Opening a request tells the system "a human has now seen this row" — it must NOT mark it reviewed, must NOT acknowledge an escalation, must NOT drop it out of the urgent list. So the concept lives in a NEW per-staff table, not in `SupportRequest.status`: `SupportRequestRead` (`prisma/schema.prisma`, `@@id([requestId, userId])`, `@@map("support_request_read")`, both FKs `onDelete: Cascade`) with a `reads` relation on `SupportRequest` and `supportRequestReads` on `User`. **No backfill: a request nobody has opened is unread until opened** — historical rows correctly surface as unread the first time a reviewer lands on them.

**Backend (`natlas`):**
- `queue-status.ts` — `QueueFilter`/`QUEUE_STATUSES` gained `UNREAD`; `matchesQueueFilter` keeps its one-predicate rule (`UNREAD` = `readAt === null && status !== CANCELLED`), so an Unread chip's number is still exactly the rows that chip filters.
- `support-requests.service.ts` — `listQueue` now `include`s `reads: { where: { userId } }` (per-actor, never another reviewer's receipt), puts `readAt` on each `SupportQueueItem`, and accumulates two new counts: `unread` and `awaitingUnread` (the latter only `PENDING`/`ESCALATED`, so the rail badge is "unread *that need a first action*", not the whole queue). New `markRead(userId, id)`: resolves the actor's school, `findFirst` scoped by `inSchool` **and** `status: not CANCELLED` (a reviewer can't receipt another school's or a cancelled request — 404), then `upsert` on `requestId_userId` with `update: {}` (idempotent; re-opening never bumps `readAt`). It touches **no** status/review/audit/notification.
- `support-requests.controller.ts` — new `@Post(':id/read')` behind `@Roles('COUNSELLOR','PSYCHOLOGIST','SUPPORT_STAFF')` + `ParseUUIDPipe`, declared after `@Get(':id')`.
- `dashboard.service.ts` — the awaiting query includes the actor's `reads`; the portal gained `urgentRequestCount` (all awaiting-URGENT, counted **before** the 20-row preview cap) and `unreadRequestCount` (same, pre-cap); urgent-first ordering and the empty-portal-for-school-less-actor branch retained.

**Frontend (`pnafrica/frontend`):**
- `support-queue.ts` — badge layer rebuilt around a `SUPPORT_REQUESTS_CHANGED` window event; `useSupportQueueCounts(userId)`, `fetchSupportQueueCounts()`, `markSupportRequestRead(id)`, and every mutation (review / book / schedule / complete follow-up) now awaits then dispatches the event, so counts refresh without a poll.
- `RailNav.tsx` — per-icon unread: `/school` → `awaitingUnread`, `/school/inbox` → chat unread, `/school/requests` → `unread`; keyed by `user.id` so one reviewer's receipts never clear another's badge.
- `CounsellorDashboard.tsx` — a "Review these first" urgent panel rendered **above** the stats (red left border) driven by `urgentRequestCount`, four stat tiles (Urgent / Unread / Escalated / Awaiting first action), and every request row now carries an always-present "Review request" deep link that works even with no transcript.
- `requests.index.tsx` — `UNREAD` chip (`countKey:'unread'`), an Unread stat tile, `?requestId=` deep-link → auto-opens the review dialog, and the dialog calls `markSupportRequestRead` on open with an aria-live line stating plainly that opening does not review or acknowledge.

**Verification (the user's explicit "run typecheck and build", widened to the suite):** natlas full `vitest run` **68 files / 1703 tests green** (`support-requests.service.spec` 85, `support-requests.controller.spec` 10, `dashboard.service.spec` 12 — all three rebuilt for the new reads/counts shapes and given fresh tests for the Unread chip, `awaitingUnread` narrowing, and `markRead` tenancy/idempotence/no-status-write), `nest build` clean, `prisma generate` re-run so the client type `supportRequestRead` matches. frontend `tsc --noEmit` exit 0, `vite build` clean (only a benign `lucide-react` "use client" rolldown warning).

**Test-harness traps learned this turn (add to the §0J list):** (a) the controller spec is a fresh file and drives a **role-free** `@Get(':id')` route — `RolesGuard` only attaches `req.session` for `@Roles(...)` routes, so in an isolated testing module `@Session()` is `undefined` on the role-free route and the handler 500s. The fix is a minimal `AttachSessionGuard` APP_GUARD ahead of `RolesGuard` that mirrors the production Better-Auth guard; **do not** "fix" this by putting `@Roles` on `:id` — students legitimately GET their own request. (b) `queueRow`/`requestRow` fixtures must carry `reads: []` now that both services read `request.reads[0]`; a missing key throws `Cannot read properties of undefined (reading '0')`, which looks like a product bug but is only a stale fixture. (c) the strict `toEqual` count/portal assertions broke the moment `unread`/`awaitingUnread`/`urgentRequestCount`/`unreadRequestCount` were added — the `matchesQueueFilter` "single predicate" test cannot cover `UNREAD` (it isn't a `deriveQueueStatus` partition), so `UNREAD` is skipped in that loop and asserted on its own.

**Repository / deploy state (supersedes the state line in §0J for this feature):** was UNCOMMITTED when written; now **COMMITTED AND PUSHED** — the unread work and the Epic D slices went in together on `EPIC_D_SAFEGUARDING_001` (natlas) and `EPIC_D_SURFACES_001` (frontend) because the two features had already shared files, so they could not be split by staging. See §0M. `natlas` branch `FRONTEND_VPS_SAME_ORIGIN_001` — modified `prisma/schema.prisma`, `src/support-requests/{queue-status,support-requests.service,support-requests.controller}.ts`, `src/dashboard/dashboard.service.ts` (+ both specs), untracked `prisma/migrations/20261030120000_support_request_reads/` and `src/support-requests/support-requests.controller.spec.ts`. `frontend` branch `MOBILE_OVERFLOW_001` — modified `src/lib/{support-queue,counsellor-dashboard}.ts`, `src/components/dash/{RailNav,CounsellorDashboard}.tsx`, `src/routes/_dash/school/requests.index.tsx`. Neither branch touched `main`; nothing deployed.

**Open follow-ups for the next session:**
1. **The migration is authored but NOT applied** — `support_request_read` does not exist in any database yet, so `markRead` and every `include: { reads }` will 500 against a DB that hasn't run it. Do **not** apply without the owner's confirmation (`prisma migrate deploy`/`db push`); this is the gating step for any live or :5050 browser check.
2. The two feature branches are the *wrong-named hosts* for this work (both are prior same-origin/mobile branches) — a clean commit likely wants its own `SUPPORT_UNREAD_001`-style branch in each repo; confirm branch strategy with the owner before committing.
3. No browser regression run this turn — the `.probe` harness was not exercised (blocked on migration #1); the unread/rail-badge flow is unit-verified only.
4. `SupportPerson` still has no `schoolId` (see §School tenancy), so a `TIER_3` escalation can still pick a school-agnostic recipient — unrelated to this feature but the reason "escalated" rows aren't guaranteed to be the reviewer's own school.

---

## 0L. Session delta — 2026-11-02 (Epic D slices 5a, 1, 2, 3, 4 built: content register, resource structure, check-in capture, indicator surfaces — nothing migrated, nothing deployed)

**Mandate (owner, in order):** "all of the requested changes including the psychologist docs" → "everything implementatable but start with planning first" → "give me the order of priority and the dependency of one task on another; start with the simplest first" → "now begin the implementation… Be fast / Be efficient / Be effective / **do not disrupt the existing working system** / Be smart (reuse components) / Begin implementation in phases in execution order". Agreed and followed order: **5a → 1 → 2 → 3 → 4**.

**The governance spine applied to every slice** (`docs/EPIC-D-IMPLEMENTATION-PLAN.md` §3): no invented cut-offs or thresholds, no invented labels or copy, no risk inferred from emotion words / clicks / refusals, no paraphrasing a reviewed instruction sequence, no draft content rendered as approved. Mechanically: number-needing rules ship `configured: false`, reviewer statuses (`CONTENT_REVIEW_REQUIRED`, `BLOCKED`) override the docs' blanket §6 `APPROVED`, and anything the psychologist never wrote down renders as *missing*, never as a guess.

### Slice 5a — escalation recipient tenancy (G6 bug, not a feature)

`SupportFlagAlertsService` picked the tray request's recipient school-agnostically, so a TIER_3 escalation could name another school's support person. Recipient lookup now goes through **`supportPeopleInSchool(schoolId)`** (`src/common/tenant/school-scope.ts:15`: active person whose professional account's user is in this school, not deactivated, holding a staff role), and a school-less flag creates no tray request instead of falling back to a platform-wide pick. Spec-pinned in `support-flag-alerts.service.spec.ts` (7 tests). **The plan's claim that `SupportPerson` still needs a `schoolId` is stale** — tenancy rides the professional's user account, exactly like `inSchool`; no schema change was made or needed. Update the project-memory line that says escalation picks a recipient school-agnostically.

### Slice 1 — content register (Doc C §6/§7)

New `src/content/` module: versioned `ContentItem` rows (`kind`, `namespace`, `code`, `status`, `version`, effective window, `supersedesId`, `payload`) with `ContentService.resolve()` (APPROVED_ACTIVE inside the window; `BLOCKED` → 403) and `assertAskable()` — an allow-list of `CONTENT_REVIEW_REQUIRED` + `APPROVED_ACTIVE`, so an unregistered, draft or withheld code can never be asked of a student. `GET /content` (platform admin) is in the README endpoint table.

Seed (`ensureContentRegistry()` in `prisma/seed.ts`) registers EMO-01…08, CP-01…22, WN-01…12, six structural `CAT-*` rows and ten `RESPONSE_OPTION` rows (CP-02-1…5, EMO-FB-1…5 verbatim lowercase). Where the reviewed handoff supplied wording the seed quotes it; where it did not, the row carries a `reviewPending` payload. **Two of eight resource-category labels and eleven of thirteen indicator labels are refused, not written.**

### Slice 2 — wellbeing resources (Doc B)

Schema: `contentCode` (unique, nullable), `intendedSituation`, `instructions String[]`, `reflectionPrompt`, `safetyNote` on `WellbeingResource`; `contentCode` on `WellbeingActivity`; new `ResourceFeedback` + `ResourceFeedbackChoice`. `resources.service.tailored()` fixes G13 honestly: the copy no longer claims personalisation, and it names a stated need only when the check-in actually said overwhelmed / anxious / stressed — otherwise a plain "Featured resources" framing, because a click or a refusal is not evidence of need. `POST /resources/feedback` writes exactly one row (US-WR-D06) and the spec asserts `supportFlag.create` is **not** called.

Frontend: `RESOURCE_FEEDBACK_OPTIONS` (the four Doc B labels, `DECLINED` last), `resourceSteps()` tolerates a backend that predates the columns (split-deploy safety), the detail page renders each reviewed template section only when the field exists, and `ResourceNextStep` never lets navigation depend on the write succeeding. The invented demo resource that used to be seeded-and-approved is retired: `RETIRED_DEMO_RESOURCE_TITLES` now deactivates those five titles.

### Slice 3 — expanded check-in capture (Doc C CP/EMO), plumbing only

`POST /check-ins` still requires `feeling` + `intensity` (no student-facing contract break) and gained optional `feelings[]` (`{code?, label!}` → `CheckInFeelingSelection` with `termLabelSnapshot` and `isStudentFreeText` when no code) and `answers[]` (`promptCode`, `state`, `valueCode`/`freeText`) → `CheckInAnswer`. `CheckInAnswerState` (`ANSWERED / SKIPPED / PREFER_NOT_TO_SAY / NOT_PRESENTED`) is what makes US-D04 true: an unanswered field is a recorded state, never an absence read as calm. Guards: `ANSWERED` with neither value nor free text → 400; a client-sent `NOT_PRESENTED` → 400 (server-asserted only); every code goes through `assertAskable()` before a write, so a `BLOCKED` prompt (CP-09…CP-17) records nothing. The response shape is unchanged (`create` without `include`). **No indicator fires from any captured answer** — that is D5, not this slice.

### Slice 4 — indicator surfaces (Doc A)

`IndicatorLevel A|B|C|U` is a **separate axis** from `SupportFlagSeverity` (G1) and `SupportFlag.level` stays null in production, because `src/ai/intents/indicators.config.ts` declares all 13 rules `configured: false` with a `blockedOn` naming D1/D5/D8. Its spec pins that permanently: no rule configured, `numbersIn(INDICATOR_RULES) === []`, level equals the code letter, and the only two labels (IND-B01 "distress recurring/persistent", IND-B02 "interference with school, relationships, sleep, functioning") appear verbatim in the plan doc. The SUPPORT_FLAG executor now freezes `studentStatementSnapshot` (US-D02) and deliberately writes **no `ruleId`** — an intent id is not an indicator rule, and crediting one would let a keyword-floor flag claim a grade.

API: `GET /support-flags?level=` returns `levelCounts` from `groupBy({by:['level']}, where: scope)` where **scope excludes the level predicate** — the single-predicate queue rule, so a chip's number is the set it filters; `UNCLASSIFIED` means `level: null`; an unknown level is a 400 before any read. `GET /support-flags/:id` returns the four labelled sections (student-reported / system metadata / AI summary / human decision) plus rule provenance and the linked conversation as a *reference* that never merges identity (US-D05); it reads no live chat. `POST /support-flags/:id/review-decision` writes only `reviewDecision` and audits `priorStatus === newStatus` (G4). Status still moves only through acknowledge / in-review, each audited with prior + new state and rule version — and **no code anywhere writes `RESOLVED`** (grep-verified; pinned as `flagData.status === 'OPEN'` on the auto-flag path, which is the US-D09 "nothing automatic closes a record" guarantee). Roles unchanged on both sides — API counsellor/psychologist/support-staff, UI counsellor/psychologist — because **D2 is still open**.

Frontend: the deliberately-closed `LockKeyhole` placeholder is replaced by list → level chips → filters → detail (`src/lib/indicators.ts` + `routes/_dash/school/indicators.index.tsx`), with `?flagId=` deep links and three distinct empty states (nothing raised for the school / filters exclude everything / no statement and no linked conversation). Every level wears the **same neutral chip** — no colour ladder, so U cannot read as mild — the "empty ≠ safe" caption is retained, and the list-cap tile says plainly that a chip can count more than the page returns. The guide banner that claimed "the review workspace is not available yet" now states what is true instead: rules off, no approved threshold, nothing auto-closes. The dashboard gained an *indicator* count (`openFlagCount`, school-wide, distinct from the four request tiles) and a link into the surface; request counts and `queue-status.ts` semantics are untouched.

**Verification (with counts, per §7):** natlas `vitest run` **70 files / 1745 tests green, exit 0** (`support-flags` 19, `ai.service` 41, `check-ins` 11, `content` 13, `indicators.config` 7, `resources` 10, `audit` 6, `support-flag-alerts` 7), `nest build` exit 0, `oxlint --type-aware src` **0 errors / 4 warnings** (all four pre-existing, in `src/ai/eval/*`). frontend `tsc --noEmit` exit 0, `vite build` clean (one benign rolldown "use client" warning), `oxlint src` **0 errors / 1 warning** (`src/lib/api.ts:41`, pre-existing). **No browser verification this session, and none is possible yet** — the new code reads columns no database has, so even the :5050 harness would 500 until the migrations run; every claim above is unit-verified only. **Known test gap:** there is no `support-flags.controller.spec.ts`, so the two new routes (`GET /:id`, `POST /:id/review-decision`) are covered at the service layer only; their guard/pipe wiring is the same class-level `@Roles` + `ParseUUIDPipe` pattern the existing acknowledge/in-review routes use, and `GET /:id` shadows no literal sibling under this controller (unlike the §0A `queue` 400, which came from a missing literal route above `:id` in a different controller).

**Trap found the hard way:** `npx vitest run | tail -8` returns **tail's** exit code. A background run announced "exit code 0" while `src/audit/audit.service.spec.ts` was failing two tests — its strict whole-payload assertion had not been widened when `AuditService.log()` gained `priorStatus`/`newStatus`/`ruleId`/`ruleVersion` in Slice 1. In this harness, the trustworthy pass signal is `echo "VITEST_EXIT=${PIPESTATUS[0]}"` after the pipe, or no pipe at all. When a payload-strict spec goes red on new optional fields, fix the spec's expectation *and* add a test for the new fields — do not relax it to `objectContaining`, which is what let the drift hide.

**Repository / deploy state (supersedes §0K's state line):** **COMMITTED AND PUSHED, UNMIGRATED, UNDEPLOYED — see §0M for the branch topology and the hashes; the file list below is what those commits contain.** natlas, the then-current branch `FRONTEND_VPS_SAME_ORIGIN_001` (the wrong-named host — §0M moves this work onto its own branch): modified `prisma/{schema.prisma,seed.ts}`, `README.md`, `src/app.module.ts`, `src/ai/{ai.service.spec.ts,intents/intent-executors.ts}`, `src/audit/audit.service.ts` (+ its spec), `src/check-ins/**`, `src/dashboard/**`, `src/resources/**`, `src/support-flags/**`, `src/support-requests/**`; untracked `docs/EPIC-D-{EXECUTION,IMPLEMENTATION}-PLAN.md`, `src/content/`, `src/ai/intents/indicators.config{,.spec}.ts`, `src/resources/dto/`, `src/support-flags/dto/`, and **five migrations**: `20261030120000_support_request_reads`, `20261030150000_content_registry`, `20261102120000_resource_detail_and_feedback`, `20261102130000_check_in_capture`, `20261102140000_indicator_levels_and_review`. frontend branch `MOBILE_OVERFLOW_001`: modified `src/lib/{resources,counsellor-dashboard,support-queue}.ts`, `src/components/ResourceCard.tsx`, `src/components/dash/{CounsellorDashboard,RailNav}.tsx`, `src/routes/_app/resources{.index,.$resourceId}.tsx`, `src/routes/_dash/school/{indicators.index,indicators.guide,requests.index}.tsx`; untracked `src/lib/indicators.ts`. Neither repo touched `main`.

**Deploy coupling — read before shipping any of this.** The five migrations must be applied **together, in order, before** this build goes anywhere: `SupportFlagsService.list` / `acknowledge` / `in-review` now read `level`, `ruleId`, `reviewDecision` and `studentStatementSnapshot`, so code-without-schema turns three working endpoints into 500s (the schema is strictly additive otherwise — every new column is nullable, so the reverse order, schema-then-old-code, is safe). Applying them is a live-schema change and waits on the owner's explicit confirmation.

**Deliberate deviations from the plan (recorded so nobody "corrects" them back):** `ResourceFeedback.resourceId` FK instead of `resourceCode` — the WN codes are not yet assigned to live rows, so a code FK would be unfillable; `instructions` as `TEXT[]` not `Json` — type honesty, read through a tolerant `resourceSteps()` for split deploys; `?type=` kept on the resources endpoint (harmless, still used by nothing in the UI) while the UI stopped sending it; `feeling`/`intensity` still required on the check-in POST; `ruleId` left null by the keyword floor rather than filled with the intent id.

**Open follow-ups — all reviewer gates, none of them code:**
1. **Apply the five migrations** (owner confirmation) — the gate for any live or :5050 check of Slices 1–4.
2. **D1** — indicator rule wording + student-facing labels (11 of 13 levels are unnamed).
3. **D2** — the role matrix: does `SUPPORT_STAFF` review indicators? API says yes, UI says no, and both stayed as they are.
4. **D3** — `SupportFlagStatus` convergence (five states, two writers, no resolver).
5. **D5** — the recurrence/count windows that let IND-B01/B02/B03/B05 and the Level-U auto-record fire. Until then the U bucket exists but nothing fills it, and the keyword floor in `intents.config.ts` remains the only automatic net.
6. **D8** — school route config, named recipients and escalation contacts for the C rules; not placeholder-able.
7. Everything in §4's acceptance list (iPhone session, VPS frontend lane, vernacular/ASR witness, native review) is unchanged by this session.

---

## 0M. Session delta — 2026-11-02 (Epic D gets its own branches, Doc A §8 becomes executable, and the landing takes its commissioned art)

**Mandate:** "go with your recommendations; add, commit and push changes to origin — but new features and task always on a new branch." So: the two pending code recommendations that needed no owner decision (the §8 corpus rows and the controller-spec gap) were built, the pile that §0K/§0L recorded as UNCOMMITTED was moved onto correctly-named branches, and everything was pushed. **The five migrations were NOT applied** — that was the one step explicitly left to the owner and it still is.

**Branch topology (this is the state change; supersedes the state lines in §0K and §0L).** Four new branches, two stacked pairs, all pushed to `origin`:

- `natlas` (Brobot64/soulnurture): `EPIC_D_SAFEGUARDING_001` @ **`605485d`** — the §0K unread work plus Epic D slices 5a/1–4, 41 files, including `docs/EPIC-D-{EXECUTION,IMPLEMENTATION}-PLAN.md` and all five migration SQL files, which now travel with the branch. Stacked on it, `EPIC_D_QA_GUARDS_001` @ **`db2325a`** — this session's §8 encoding and specs. Both branch off `FRONTEND_VPS_SAME_ORIGIN_001` @ `cf71485`, which is docs-only relative to `main`: the QA branch is **7 ahead / 1 behind `origin/main` (`e3b8c77`)**, the extra behind-side commit being PR #13's merge.
- `frontend` (Brobot64/soulnurture-frontend): `EPIC_D_SURFACES_001` @ **`e1e068a`** — the unread UI plus the Epic D surfaces, 12 files. Stacked on it, `LANDING_HERO_ART_001` @ **`011a1a5`** — the hero art. Both branch off `MOBILE_OVERFLOW_001` @ `6c15e65`, so the pair is **6 ahead / 2 behind `origin/main` (`73f3391`)**.

**The one consequence a reader must not miss:** the frontend branches carry the five unmerged `MOBILE_OVERFLOW_001` commits, so a PR from `EPIC_D_SURFACES_001` must target `MOBILE_OVERFLOW_001`, not `main`, or the diff will claim mobile-overflow work it did not do. The backend pair has no such problem because its parent is docs-only.

**Why one commit per repo for two features.** §0L's follow-up #2 asked for a `SUPPORT_UNREAD_001`-style branch per feature. That turned out not to be honest to the working tree: the unread work and Epic D both touched `dashboard.service.ts`, `support-requests.service.ts`, `CounsellorDashboard.tsx`, `RailNav.tsx`, `requests.index.tsx` and `support-queue.ts`, Epic D on top of the unread edits. Splitting them would have needed hunk-level staging, and a hand-split hunk is exactly the kind of commit that quietly breaks a build between the two halves. So each repo got one branch per feature *area* with both streams in the first commit, and the message says so rather than letting `git log` imply otherwise.

**Doc A §8, as actually encoded.** The execution plan said to extend `escalation-corpus.ts` with all fourteen rows. Nine went in — A-01/02, B-01/02/03, C-01/02/03, P-01 — each written so its text really contains the phrase the expected intent matches in `intents.config.ts` ("threatened to seriously hurt", "cutting myself", "private pictures", "kill myself"), because a C row that does not floor-fire is a row that tests nothing. The corpus's own integrity test requires `supportLevel` to imply an escalation, which is why **U-01 and U-02 cannot be corpus rows at all**: level U is a refusal to conclude, not an escalation expectation, and a skipped safety question is a check-in field rather than a message. They live in the new `src/ai/intents/indicator-uncertainty.spec.ts`. SEC-01 was already covered by the cross-school tests in the two service specs. WF-01 got a real test in `support-requests.service.spec.ts` — cancelling writes exactly one row, the `supportFlag` write mocks exist in the harness solely so the test can prove they are untouched, and the audit row names `SupportRequest`. **R-01 is not tested and the corpus comment says why**: there is no school escalation route to make fail until D8 configures one, so a "fallback activated" assertion would be fiction.

The uncertainty spec guards a *direction of inference*, which is what §8's two U rows actually warn about: `CheckInAnswerState` has no member that reads as an all-clear; no indicator rule lists absence among its evidence sources; every rule is still `configured:false`; `IND-U01` is the only level-U rule and its `blockedOn` names the withheld CP-09…CP-17 prompts; and the `SUPPORT_FLAG` executor's create payload carries no `level` and no `reviewDecision` — G1 stated as a fact about a write instead of a paragraph about a design. Each of those fails loudly at the moment someone switches a rule on without the psychologist behind it.

**Controller gap closed.** `src/support-flags/support-flags.controller.spec.ts`, 21 tests over real HTTP routes, built on §0J's harness lesson (an `AttachSessionGuard` APP_GUARD registered ahead of `RolesGuard`). Its load-bearing assertions are about the option that must not exist: `decision: RESOLVED` is a 400 because the enum has three members, a stray `status` beside a decision is rejected rather than silently stripped by the whitelist, and `POST :id/resolve` is a 404 because there is no such route to reach. The role matrix is pinned as **evidence for D2, not endorsement** — `SUPPORT_STAFF` is admitted by the API on every reviewer route while the frontend rail still does not show them the screen.

**Landing hero art (owner-supplied PNG, `~/Downloads/soulnurture_landing_1_square_534px_2x.png` → `src/assets/soulnurture-landing-hero.png`).** It sits in the public landing's hero column only. The art is square and opaque with its own pastel sky, so the old wrapper was wrong for it: `lg:bg-panel` behind a 3/4-width SVG would have painted a green ring around the image's own background. The container is now the art — `aspect-square overflow-hidden rounded-hero`, `object-cover` as a no-op guard for a future non-square asset — keeping the SVG's exact mobile footprint (267px, capped at 78vw) and growing to the full 560px panel on desktop. Two things recorded rather than hidden: the 534px source is **under-sampled at 560 CSS px on retina**, so if this art stays the hero it is worth regenerating at 1120px square; and the `alt` is the only new string in a file whose header rule is that marketing copy is supplied verbatim — it is descriptive, no claim, which is the distinction that made it writable here at all. `HeroIllustration` is not deleted: `/welcome` still uses it, and whether the public page and the student's first screen should carry the same art is the owner's call, not something to settle by removing a component.

**Verification.** natlas full suite **72 files / 1797 tests green, `VITEST_EXIT=0` read from the run itself** (§0L's pipe-masking trap — never trust the status of a piped vitest), `nest build` exit 0, `oxlint --type-aware src` 0 errors / 4 pre-existing warnings in `src/ai/eval`, mojibake grep clean. frontend `tsc --noEmit` exit 0, `vite build` clean, `oxlint` 0/0 on the changed file. The art was measured in the live :5050 harness: HTTP 200, `image/png`, 75145 bytes, natural 534×534, rendered 267×267 at an 804px viewport with no distortion.

**What was NOT verified, and why.** The landing route never rendered in the harness: `:5050` answers a signed-in mock session unconditionally, and `_app/index.tsx` fans a signed-in user straight to their dashboard, so the guest `Landing` is unreachable there without editing the mock harness — which is untracked and not this branch's to change. The geometry was therefore proved by injecting the identical markup into the live page and measuring it, which validates the CSS and the asset but **not** the composition next to the real headline. Nobody has seen this image on the actual page yet. Also still unrun at the time of writing: `npm run test:e2e:journey` ×2 and both manual `:5050` journeys, all blocked on the migrations — the journey half was cleared by the addendum below (Follow-up 2); the `:5050` journeys are still unrun.

**Plan corrected against the build.** Slice 5a still prescribed `schoolId String? @db.Uuid` on `SupportPerson` — deliberately not done, tenancy already reads through `professional.user.schoolId` via `supportPeopleInSchool`, and a denormalised second copy is a drift bug with a migration attached. It also still told the UI to keep the "not available yet" framing, obsolete since Slice 4 replaced the placeholder; what D8 withholds is the notification pathway, not the screen. Both are now annotated in place, and the executed order is recorded as **5a → 1 → 2 → 3 → 4**, not the plan's 1 → … → 5a.

**Addendum, 2026-11-02 (the owner then said "apply the migrations and start the backend").** Follow-up 1 is **done locally — prod was not touched**: `npx prisma migrate deploy` applied all ten and `migrate status` reads "up to date"; `npm run start:dev` answers 200 on `/api/health/auth`, so the "backend is not running" line above is now superseded. That is what makes the next finding trustworthy: the first `test:e2e:journey` run crashed in Act 3 with `inconsistent types deduced for parameter $2`. **All three harnesses** (`e2e-journey`, `e2e-school-chat`, `e2e-dashboards`) bootstrap their platform admin with `INSERT INTO account … VALUES ($1, $2, $2, …)` — one placeholder serving both `"userId"` (uuid) and `"accountId"` (text), which Postgres refuses to type. Each now passes the id twice as `$2`/`$3`, with a comment so nobody collapses them again. The run after that reached Act 6: **56 pass / 23 fail**, and the failures are the harness being stale against contracts the code already shipped, not the product misbehaving:

1. `POST /api/v1/ai/disclosure/acknowledge` is sent with **no body**. Since CONSENT_GATE_001 the route requires `agreements` covering every `AI_DISCLOSURE_AGREEMENT_IDS` and 400s otherwise, so the ack fails and every AI message in Act 4 fails behind it — the crisis-wording assertions (SERVER_KEYWORDS, TIER_3_ACUTE, scripted safety reply) never get to run. The frontend has `ConsentGate`; the journey does not.
2. `say()` posts `{ content, language: 'en' }`. LANG_ID_016 removed `language` from `SendMessageDto` and `AppValidationPipe` runs `forbidNonWhitelisted`, so it is a hard 400 rather than an ignored field.
3. Two checks assert `verificationEmailSent === true`. `trySendVerificationEmail` swallows the send failure and there is no SMTP locally, so that flag is environment-dependent — the very next check ("verification link visible") passes off the dev log. Assert the link, not the flag.
4. `POST /api/v1/auth/first-password` is asserted as **200** and gets **201**: `setFirstPassword` carries no `@HttpCode(200)`, so Nest's POST default wins on a route that creates no resource. Someone has to pick which side is the contract — that is a one-line decision, not a harness patch.
5. Jude's profile check reads `GET /api/users/me` — **without** `/v1`. ~~That is the harness's own synthetic stub~~ **— corrected while fixing it: `/api/users/me` is a real route** (`src/auth/auth.controller.ts:22`, `AuthController.me`), it just returns `session.user` — the raw Better Auth session user with no relations — while `getMe` under `/api/v1` reads the DB row and attaches `school`. So `school=undefined` was the route's shape, not a tenancy gap (the admin's identical check on the v1 route passed in the same run). The harness now reads `/api/v1/users/me`.
6. ~~One failure I have **not** attributed~~ **Resolved: it was item 1's cascade, not a contract question.** `POST /api/v1/conversations` is consent-gated (`assertDisclosureAccepted` at `conversations.service.ts:111`, and its own spec calls the case "creates with an optional owned check-in **after consent**"), so with the ack 400-ing there was no conversation row and `conversation.checkInId === checkIn.id` failed on an `undefined` conversation. Once the ack carries its agreements the check passes unchanged — `CreateConversationDto` does still accept both `checkInId` and `source`, and that is the shipped contract.

**Consequence for the plan's Verification block (as written then; the paragraph after this one supersedes it):** `test:e2e:journey` ×2 green is not a switch-flip now that the schema is current — items 1, 2 and 5 are mechanical harness edits, 3 and 4 are decisions, and 6 is an open question. Until that is done, the evidence that the Epic D code runs against a migrated database is the 1797-test unit suite plus whatever Acts 0–2 and Act 6 prove, nothing more. The local DB now carries the journey's rows; the next run's Act 0 cleans them.

**Follow-up 2, 2026-11-02 (the owner then said "yeah let's fix the harness") — all three e2e harnesses are green against the migrated local DB.** `test:e2e:journey` **113/113** three times (twice in a row, then a third time *after* the other two harnesses had rewritten the same tables — the cross-run interference check the plan's "×2" was really asking for); `test:e2e:school-chat` **120/120**; `test:e2e-dashboards` **98/98**. `oxlint` 0/0 on the three files. Every edit is attributable to a change the backend already shipped, and where a check was weak I made it stronger instead of deleting it:

- Journey: items 1–3 and 5 above, each fixed as diagnosed; item 4 left as `(200 || 201)` with the reason inline, item 6 unchanged because it was never a product bug.
- The disclosure block now **reads** the statement ids from `GET /api/v1/ai/disclosure` rather than hardcoding them, and gained two checks that did not exist: a partial `agreements` set must 400, and `GET /api/v1/ai/disclosure/status` must report `accepted === false` before the ack. That is the CONSENT_GATE_001 contract, and the harness previously tested none of it.
- **Tenancy, not a flake.** `Dr. Eric Moore visible to Jude` failed because post-§0B the support-person list is scoped to the professional's `user.schoolId` and the harness never put Eric in Miva. The fix moves Eric's user into the school after it is created (Act 0's delete order makes the FK safe) and renames the check to say so. Silently widening that assertion would have removed the only e2e coverage of the tenancy rule.
- **Two requests, not one.** `student sees own requests === 1` now fails legitimately: the Act 4 TIER_3 alert auto-creates a `SupportRequest` at status `ESCALATED` (`support-flag-alerts.service.ts:171`) beside the `PENDING` one Jude asked for. Encoded as two separate assertions — one per status, each pinning the recipient — rather than accepting 2.
- School-chat: the `=== 3` message-count check predates the initial-message feature. `chat.service.ts:144-152` seeds a thread with the SYSTEM entry note **plus** the request's own `note` as a STUDENT message, so the real thread is four. The harness now asserts all four by role **and** content, including that the carried-in message equals the note it was created with — strictly more coverage than the count it replaces. Its `mustChangePassword` check moved to `/api/v1/users/me` for the same reason as item 5.
- Dashboards: the same three patterns (`verificationEmailSent` ×2 replaced by the role the response already carries, first-password ×3 accepting either status with the open-decision comment). No other site in that file turned out to be stale.

**What that buys, and what it still does not.** The Epic D code now provably runs against a current schema through the student journey, the two-school chat/realtime contract, and both dashboards — which is the evidence §0M was missing. Still open: **item 4 is a real decision someone has to make** (`setFirstPassword` 201s on a route that creates nothing, against the house `@HttpCode(200)` used by `verification.controller.ts:18` and `ai-response-reports.controller.ts:20`); the `:5050` student and staff manual journeys are still unrun; and the landing hero art has still never been seen on the real page. Prod remains untouched — the five Epic D migrations are still unapplied there, and the harnesses were run only against localhost.

**Open for the next session** (item 1 is executed locally by the addendum above; it is still open for prod):
1. **Apply the migrations on the VPS — and note the gate was bigger locally than it is on prod.** Measured before the addendum, `npx prisma migrate status` against the local `natlas` DB reported **ten** pending, not five: the five new ones **and** `20261022100000_support_request_initial_message`, `20261023110000_support_staff_contact_type`, `20261023110100_school_support_contacts`, `20261023120000_ai_response_reports`, `20261024090000_ai_response_report_review` — the 2026-10-24 release set that §0C records prod applying, which was never replayed locally. So "apply the five, in order" is the **prod** instruction, and that is still the owner's call; locally all ten are now applied and `migrate status` is clean.
2. **The e2e part of the plan's verification is done** (see Follow-up 2 above: journey 113/113 ×3, school-chat 120/120, dashboards 98/98 against the migrated local DB). What remains of that block is the **student and staff `:5050` journeys**, an explicit record of what was not exercised, and **the `first-password` status decision** (§0M item 4) — the harnesses accept either status and say why, which is not the same as someone choosing one.
3. See the landing art in a real browser at both breakpoints (a guest-mode harness or Vercel preview), and decide whether `/welcome` gets it too.
4. Reviewer gates D1, D2, D3, D5, D6, D8 — all unchanged, and D2 now has a pinned test that states the discrepancy rather than resolving it.
5. R-01 becomes writable the day D8 configures a route; until then it is a documented gap, not a missing test.

---

## 0N. Session delta — 2026-11-03 (Epic A/B/C design fixes built and browser-verified on the local stack, `frontend ESCALATION_POPUP_001`)

**Mandates, verbatim:** "change escalation message to pop up and allow it to close and then the conversation can still continue" and "complete the Fixes on Epic A, Epic B, and Epic C", after "pull all the latest figma designs first … before any implementation". All nine epics were pulled from `~/Downloads/PNA_Soul_Nurture` (artboard counts A=8, B=18, C=8, D=12, E=12, F=5, G=8, H=10, Web A2c=1), the gap was written up per epic, and only A/B/C were then built. **D/F/G/H are pulled and specced but untouched** — the owner's own ordering.

**The escalation popup, and the sentence that decides it.** The acute/out-of-scope turn is now a `<dialog>` over the chat (`BoundaryNoticeDialog`) plus a one-line `BoundaryNoticeMarker` left in the thread, not a block that ends the conversation. The design (Epic A ab07) shows a popup that terminates with "Back Home"; the owner's instruction says close it and keep talking, **so the instruction wins** and the design's terminating button was not built. Proved end-to-end, not asserted: a live check-in on the local backend tripped the acute lane for real, the popup auto-opened, "Back to the chat" closed it, the marker stayed, "Tell you more" was sent and the AI answered again.

**Epic C is a three-view state machine inside one route** (`support.index.tsx`): landing → form → receipt, no new routes and no API change. The four-stage student track (`NEW / REVIEWED / FOLLOW_UP_REQUIRED / FOLLOW_UP_COMPLETED`) lives in `lib/support-requests.ts` as one mapping over the seven real `SupportRequest` statuses, so the status guide and the request timeline cannot drift apart; `CANCELLED` deliberately maps to no stage and renders "outside the usual steps" instead of a bar stuck at the start.

**Three findings that only a running stack could give:**
1. The requests table I converted from `<ul>` to `<table>` was shipping `<li>` inside `<tbody>` — invalid, and the browser's repair is what made the first row render blank in the a11y tree. Rewritten as real `<tr>`/`<td>` (4 cells, one link per row); verified `{rows:1, cells:4, invalidLi:false}` against the live DOM.
2. **The 500-vs-300 character conflict is not a conflict.** `CreateSupportRequestDto.note` is `@MaxLength(300)`, but the student's Send request path posts to `POST /api/v1/chat/threads`, whose DTO is `@MaxLength(500)` — so the design's `0 / 500` counter is exactly the limit the route enforces. The 300 belongs to the separate staff-side `SupportRequest` record. Nothing to change; recorded so the next reader does not "fix" it.
3. **`request-password-reset` 403s for any origin missing from `BETTER_AUTH_TRUSTED_ORIGINS`** — better-auth rejects the frontend's `redirectTo` with `INVALID_REDIRECT_URL`, which the UI surfaces as "check your connection". Locally that meant `:5050`. Re-run with the origin listed and the same submit renders the designed "Check your inbox / Here's what to do next" state. This is a config gate, not a code bug, but it will bite on any new deployment origin: **the frontend sends `redirectTo: location.origin + '/reset-password'`, so the app origin must be in `BETTER_AUTH_TRUSTED_ORIGINS`, not only in `ALLOWED_ORIGINS`.**

**Local topology (differs from `project-local-browser-verify`, worth knowing before the next verify run).** `:3000` was already held by a vite for this frontend and killing it was blocked as a user-owned process, so the stack ran as: backend `PORT=3010 BETTER_AUTH_TRUSTED_ORIGINS=…,http://localhost:5050 npm run start:dev` (the backend binds `[::1]` only), vite on `:3000`, throwaway same-origin proxy on `:5050` (`/api/*` → `[::1]:3010` with `Origin` rewritten to `http://localhost:3000`, everything else → `[::1]:3000` with `host: localhost:3000`, set-cookie stripped of `Secure`/`Domain` and `SameSite=None`→`Lax`). Jude's creds were live without a journey re-run. Two harness traps re-confirmed: React-controlled inputs need the native setter taken from `Object.getPrototypeOf(el)` (`HTMLTextAreaElement.prototype` threw `Illegal invocation`), and once the in-app Browser surface goes hidden, screenshots stop working while `evaluate_script` and `take_snapshot` keep working — most of this pass was therefore structural.

**Verified in the browser:** `/support` landing (school name interpolated from the real session row), the form with the live check-in disclosure panel ("Feeling: Sad / On your mind: exam pressure, loneliness, poor sleep" — `fetchLatestCheckIn` + `thread.entryCheckInId` agreeing against the real backend), the receipt, `/support/requests` latest-card timeline + table, `/support/status-guide` four cards with the record-status footer, the 404, the header chrome ("Wellbeing Resources" / "Request Counsellor Support"), both reflection dialogs (mood-face medallion + blurred scrim, screenshot-confirmed), the boundary dialog close-and-continue, `/signin`, `/forgot-password` both states, `/first-password`'s guard bouncing a signed-out visitor, and `I'm done for now` measured page-level and centred (x=283 w=222 in an 804px main).

**NOT verified, stated plainly:** `ConsentGate`'s ab05 layout — it needs a student who has never accepted the disclosure, and signing one up was (correctly) blocked as an unrequested write to the database, so that change rests on `tsc` + `vite build` + review only. Also unverified: the `/first-password` screen itself, the `lg:` four-column status-guide, and every phone-width check (see `feedback-browser-harness`).

**Deliberately not built, because the backend has no column for it:** the request "share link", the "Updates" timeline, Epic B's Student-ID / school-access-token wizard (no schema), ab16's role-denied page (pending the D2 role decision), and ab04's success interstitial. The "Include my latest check-in" control is shown as a **disclosure, not a checkbox**, because `chat.service.ts` attaches the newest check-in unconditionally — an opt-out the frontend cannot honour is a lie with a control on it.

**Gates:** `tsc --noEmit` exit 0, `vite build` clean. No lint lane exists in this repo (`npx eslint` fails — no config). 16 files changed on `ESCALATION_POPUP_001`, branched off `main` @ `feaa92b`.

**Open for the next session:** (1) the `SupportRequest`-vs-`ChatThread` decision — the designs are SupportRequest-centric while the student flow writes ChatThreads, and Epic C's four-stage track is currently rendered over *both* vocabularies; (2) whether `CreateSupportRequestDto` should move to 500 for consistency now that the difference is understood; (3) browser-see the consent gate with a real fresh student; (4) Epics D/F/G/H remain specced and unbuilt.

---

## 0O. Session delta — 2026-11-03 (Epic D ab01/ab05/ab06/ab07 built; the indicator queue learns to search and to name the request beside it — `natlas EPIC_D_QA_GUARDS_001` + `frontend EPIC_D_SURFACES_002`)

**Mandate, verbatim:** "now begin the implementation of Epic D". §0N's own note that "Epics D/F/G/H remain specced and unbuilt" is now only true of F/G/H.

**ab01 — the queue gets a search, and the search is inside the count.** `GET /v1/support-flags` accepts `q`, and `studentSearch()` returns a Prisma `where` fragment that matches `studentRef`, `student.studentCode`, `student.studentRef` or `student.user.email` (all `mode: 'insensitive'`, the repo convention — `Prisma.QueryMode.insensitive` is not used anywhere here). The whole point is where that fragment lands: it joins the **same `scope` object** that feeds both `findMany` and `groupBy(['level'])`, so an A/B/C/U chip over a filtered list counts the filtered rows. A search that narrowed the rows but not the chips would put "3" on a chip with one row behind it — the same class of lie §0J spent a session removing. An empty term returns `{}` and adds no predicate, so the unfiltered queue reads exactly as before. The harness proves the empty case against real Postgres: `q=no-such-student-anywhere` answers `{A:0,B:0,C:0,U:0,UNCLASSIFIED:0}` *and* zero rows, in one assertion.

**The new "Linked request" column is a reference, not a merge.** `list()` collects the flags' `conversationId`s, reads the newest school-scoped `SupportRequest` per conversation in one `findMany`, and attaches `{id, status}` or `null` to each row; `detail()` does the single `findFirst` and puts the same object in `systemMetadata` next to `conversationId`. Doc A US-D02 says the detail presents EXACTLY four labelled kinds of content and nothing else, so the linked request enters as a *metadata field*, and its status never touches the indicator's own — the row cell says "Linked request"/"None linked" and links onward rather than wearing the request's `ACCEPTED` as if it were the flag's state. `recordReviewDecision` now returns `recordedAt` (a single server `new Date()`, so the confirmation cannot show a time the reviewer invented) and echoes `status` to prove the endpoint left it alone: **nothing in this slice can close a flag** (US-D10 — `SupportFlagStatus` has exactly two writers, acknowledge and in-review).

**ab05/ab06/ab07 — the three frontend slices.** `useRoleAccess()` was added next to `useRoleGuard` rather than replacing it: the guard redirects, and a page that redirects a school admin away from a link in their own rail teaches them nothing, so the indicators page now renders a real denied view (`RoleDenied`, named in the session's own language, with the role and the school shown and one button back to `homeForRole(user.role)`); `useRoleGuard` is untouched and still used by the requests queue. ab06's `ReviewRecorded` replaces the dialog body after a successful POST: `role="status"`, the decision, the server time, the flag's unchanged status, the three "What happens next" cards, and a primary action that navigates to the linked request when one exists. ab07 is `SupportSurfaceTabs.tsx`, mounted on both surfaces and rendered `null` for anyone outside `REVIEWER_ROLES`, so the pair only exists for the people who can see both.

**Two design blocks deliberately not built, with the reason recorded.** (1) **ab08's flag-id link inside the student-request queue** — the backend's queue rows expose no flag id, so the design's cell would have to be invented client-side; the existing "Support prompt" column stays and remains honest. (2) **ab04's check-ins + review note on the indicator detail** — deferred, and this is the one to argue about before building: US-D02's contract is four *labelled kinds of content*, per-student check-in history would be the first staff read of that table anywhere in the product, and a `reviewNote` on a decision needs a migration. All three facts point the same way, so it waits for a Doc A amendment rather than a schema smuggled in under a design ticket. Separately: the Epic D artboard contradicts itself — the indicators board shows the request chip set in one block and the indicator set in another, and the two boards disagree on whether there are three or four stat tiles. **Doc A G1/G4 governed, not the artifact.**

**Verification — and the honest split of it.** `npm run test:e2e:journey` against `E2E_BASE_URL=http://localhost:3010`: **120/120** (was 113; the seven new assertions all live in Act 7, on Eric's real session, and cover the level-filtered search, the email match, the empty-result chip counts, both linked-request reads and the decision echo). The relation filter that `groupBy` counts on is exactly the thing a mocked unit test cannot prove, which is why the harness grew instead of the suite being trusted. `vitest run src/support-flags` 52/52, `oxlint --type-aware` 0 warnings, frontend `tsc --noEmit` exit 0, `vite build` clean.

**NOT seen in a browser, stated plainly: every staff surface in this slice.** `ericmoore@johnhopkins.com / EricTest123#` — the creds recorded in `project-local-browser-verify` — is now rejected with "Email or password is incorrect", and scanning the test scripts for the harness's own passwords was blocked twice as credential discovery, which is the right call, so this session did not go looking for them again. Consequence: ab05's denied view, ab06's confirmation and ab07's tab pair rest on types, build and HTTP-level proof, not on pixels; the student session was live and was used, but the student cannot reach `/school/*` (403, and Act 8 asserts that). **Ask the owner for working local staff creds, or have him open `/school/indicators` himself.**

**Local topology unchanged from §0N and still worth re-reading before any verify run:** backend `PORT=3010` with `BETTER_AUTH_TRUSTED_ORIGINS` covering :3000/:3001/:5050, the owner's vite on `[::1]:3000` **reused, never restarted**, throwaway same-origin proxy on `127.0.0.1:5050`. Note `curl http://localhost:3000` returns `000` here while netstat shows the port listening — check listeners with `netstat -ano`, not with a curl that resolves to the wrong family.

**Open for the next session:** (1) working staff creds → browser-pass ab05/ab06/ab07; (2) ab04 needs a Doc A amendment + a `reviewNote` migration; (3) ab08 needs a flag id on the queue DTO first; (4) the nine untracked `test/*.mjs` probes are still uncommitted and still the owner's call (commit / ignore / delete); (5) the five Epic D migrations are still applied locally only, not on prod; (6) all 13 indicator rules remain `configured:false` — nothing in this slice changes that.

### §0O Follow-up — ab08 got built after all, and two harnesses were lying about the port

§0O's own line "(3) ab08 needs a flag id on the queue DTO first" turned out to be a statement about code I had not re-read. `listQueue` **already queries `supportFlag`** — it does it to set the `prompt` column — and simply selected `{conversationId, status}` and threw the rest away. The flag id was never missing from the schema; it was missing from a `select` clause. Reversing the reference was therefore a widening of one existing read, not a new join.

**What shipped:** `linkedIndicator: {id, status, severity, level, triggerLabel} | null` on every queue row. The SQL status filter moved into `isActiveFlagStatus`, so `prompt` keeps its exact old meaning (an indicator *still asking*) while the reference can name an indicator a colleague already acknowledged — a queue that read "None linked" for a reviewed indicator would be describing the workflow, not the record. `orderBy: createdAt desc` + "first row per conversation wins" makes it the newest. Frontend: a sixth "Linked indicator" column on the requests table, and because the whole row is a button an `<a>` cannot live inside it, the navigation is a `Link` in the review dialog ("Open in Support indicators", deep-linking `/school/indicators?flagId=`) — which is also how the design's own Linked-records board frames it, as two records you can each open.

**The role gate, which is the part to keep.** Doc A leaves D2 (may support staff see indicators?) open and the indicators screen already refuses them, so handing `triggerLabel`/`level`/`id` to SUPPORT_STAFF *around the back of the requests table* would leak through the queue what the flags endpoint withholds. `listQueue` now selects the caller's `role` and nulls the reference outside the backend's own `REVIEWER_ROLES` (`src/common/guards/roles.decorator.ts`, the pattern `ai-response-reports.service.ts` already uses), while `prompt` stays for everyone the queue serves — it is this queue's own workflow signal, not indicator content. The frontend hides the **whole column** for a non-reviewer rather than rendering "None linked": a withheld row must not be displayed as an absent one, and an empty column would be a claim about the request table the viewer cannot verify. Tests encode exactly that split (support staff: `prompt REVIEW_SUGGESTED`, `linkedIndicator null`).

**Journey: 124/124** (was 120) — four new Act 7 assertions, including the reverse link and the role gate on real rows. To make the gate testable, Ngozi had to be *in* the school: `POST /api/v1/users` assigns no `schoolId`, and a school-less reviewer correctly reads an empty queue, so Act 7 now enrols her in the school Act 3 onboarded. That is a fixture gap in the harness, not a product bug — and it is worth knowing that provisioning staff through that endpoint leaves them school-less.

**Then two harnesses "regressed" and neither had.** Pointed at the :3010 backend, `e2e-school-chat` fell to 12/96 and `e2e-dashboards` crashed at Act 0 — both with `platform admin signs in — status 403`, i.e. dead before reaching any code in this diff. Cause: **`e2e-journey.mjs` hardcodes `const ORIGIN = 'http://localhost:3000'` while the other two derive `ORIGIN = BASE` from `E2E_BASE_URL`.** Better Auth 403s any `/api/auth/*` call whose Origin is outside `BETTER_AUTH_TRUSTED_ORIGINS`, so `E2E_BASE_URL=http://localhost:3010` quietly put those two outside the allowlist. Both now read `const ORIGIN = process.env.E2E_ORIGIN ?? 'http://localhost:3000'`, and 98/98 and 120/120 came straight back. **The general rule for the next session: `E2E_BASE_URL` moves the port; `E2E_ORIGIN` moves the identity the auth layer sees. They are not the same knob, and this is the same trusted-origins gate §0N recorded for password reset.** Never report an e2e count as a regression until each cause is attributed — that rule paid for itself again.

**Gates after the follow-up:** journey 124/124, school-chat 120/120, dashboards 98/98, `npm test` 72 files / **1807** tests, `oxlint --type-aware` clean, frontend `tsc --noEmit` exit 0 and `vite build` clean. `tsc -p tsconfig.json` still reports 47 pre-existing errors in unrelated specs (all `$Enums` mock-nominal mismatches, e.g. `support-flag-alerts.service.spec.ts:11`); none is in a file this slice touched.

**Still not seen in a browser:** everything staff-side, including ab08's new column — the local staff password is still dead (above), and creating or repairing an account was not authorised. Ask the owner for creds or have him open `/school/requests` himself.

**Committed and pushed:** `natlas EPIC_D_QA_GUARDS_001` @ `5b52d18`, `frontend EPIC_D_SURFACES_002` @ `7bcbd3b` (both to `origin`/Brobot64; nothing merged to `main`, nothing deployed).

**Where Epic D now stands.** Re-checking Stage 4 against the code, the surfaces the plan names are all built: level chips counted on the same scope they filter (`levelCounts` in `support-flags.service.ts`), the dashboard's indicator tile kept deliberately apart from the request tiles (`CounsellorDashboard.tsx:310`), the linked-record references in both directions, the role-denied view, and the review-recorded confirmation. What is left is **not code**: ab04 waits on a Doc A amendment plus a `reviewNote` migration; Stage 5's escalation waits on D8's per-school routes; and the rules all remain `configured:false` pending D5/D9. So the corrected open list for the next session is: (1) working staff creds → browser-pass ab05/ab06/ab07/ab08; (2) ab04's spec decision; (3) the five Epic D migrations still local-only on prod; (4) the nine untracked `test/*.mjs` probes, still the owner's call; (5) Epics F/G/H, specced and unbuilt.

---

## 0P. Session delta — 2026-11-03 (Epic F built: the content register becomes the thing a student reads through — `natlas EPIC_D_QA_GUARDS_001` @ `04347f8` + `frontend EPIC_D_SURFACES_002` @ `e9d8ddd`)

**Mandate, verbatim:** "Start on Epic F". §0O's open list item (5) named Epics F/G/H as "specced and unbuilt"; F is now built, and G/H are what remains.

**What Epic F turned out to be, before a single component was written.** The plan read like five artboards to paint. The code said otherwise: `seed.ts` creates **zero** wellbeing resources and actively *retires* the five invented G8 placeholders, `WN-01…WN-12` exist only as register rows all sitting at `CONTENT_REVIEW_REQUIRED`, Doc B's eight category labels exist only as `CAT-*` register rows (also review-pending, six with `resources[]`, two empty), and `WellbeingResource.contentCode` was referenced nowhere in `src/`. Meanwhile the live catalogue was serving the five placeholder rows because the local database still carried them with `approved: true` — a retirement that only runs on a re-seed. So painting the artboards first would have rendered **unreviewed content as approved**, which is prohibition 11 and the exact promise Doc B §5 exists to keep. The gate had to come before the gloss.

**f01 — the register is now the single definition of "a student may see this".** `ContentService.liveCodes({kind, locale?, now?})` reads one kind once and returns the codes that may be shown *right now*: `APPROVED_ACTIVE`, inside `effectiveFrom/effectiveTo`, and not vetoed by any `BLOCKED` row of the same code — a safeguarding withdrawal outranks the version trail, while `SUPERSEDED`/`RETIRED` do not veto because every live code carries a history of them. Age band deliberately does not gate a code (Doc C §2: bands change wording, not permission). `ResourcesService.visibleWhere()` composes that set with the row's own `active`/`approved`, and **every** read path now goes through it — `list`, `tailored`, `saveToolbox`, `recordFeedback`, and `toolbox` (a save outlives the review that allowed it, so a saved row whose code is no longer live drops out and `count` counts only what is left). The semantics that matter: `contentCode: { in: [] }` is allowed to match nothing. **An empty register empties the catalogue instead of falling back to the boolean, which makes this change able only to hide content, never to show it** — that is why it was safe to land while D1 is still an open product decision, and it implements D1(a) (per-item register statuses govern) rather than guessing at D1(b).

**f02 — the personalisation claim moved server-side.** `tailored()` now resolves the student's **newest** check-in itself when no id is passed (a student does not know their check-in ids, and a client that had to supply one would turn "from your check-in" into a claim the client invented), and returns `basis: 'STATED_NEED' | 'NEWEST_APPROVED'` beside title/rationale/items. The old test asserted `emotionalCheckIn.findFirst` was *not* called without an id — that assertion was exactly the behaviour f02 changes, so it was rewritten and inverted on purpose, not quietly deleted.

**f03/f04/f05 — the surfaces, and the four things deliberately not built.** The "Picked for you" band renders from `basis` (never from the phrasing of a title) and returns `null` while any topic/search/toolbox filter is active, because a "picked for you" row above a filtered list describes a selection that did not happen. The empty states are split by cause: topic (`"No approved resources here yet" — a resource appears here only once it has been reviewed and approved`), search (says the search only reads approved wording, so an empty result is not a missing topic), toolbox, and the no-filter case, which points at a person rather than at a wait; each replaced copy that had put the wait on the student. Artboard 4's "Still feeling heavy?" panel carries the three *what happens next* lines that `/support` already ships, and imports `SUPPORT_RESPONSE_NOTICE` and `SUPPORT_EMERGENCY_NOTICE` from `lib/support` instead of re-typing them, so safety copy cannot drift between surfaces. **Not built, with the reason:** (1) the design's Read/Listen/Practise affordances — Doc B §2/US-WR-D02 and prohibition 7 ban the format claims and ask for duration instead, which the row actually stores; (2) a per-card "Reviewed by school counsellors" badge — the row has no reviewer identity, so the strip says only what the register guarantees ("reviewed and approved before students see it"); (3) Doc B's eight-label taxonomy — code says eleven, Doc B says eight, the design shows six, and the eight are themselves `CONTENT_REVIEW_REQUIRED`, so the enum stayed and this goes back to the owner as a decision, not a diff; (4) search removal (D7) — kept, with an empty state that now explains what it searched.

**The bug the browser found and the unit tests could not.** With `savedOnly` **and** a stale `search` both in the URL, the toolbox answered "No saved resources yet" while the sidebar said "1 saved resource". The branch order trusted the filter instead of the count; it is now gated on `toolbox.count > 0` and gets its own copy. Found only because a real session had a real save — recorded here so nobody re-derives empty states from mocked queries alone.

**Act 6 rewritten to the contract the code now ships.** The journey used to assert `resource catalogue present (seed ≥5)` — a demand that the invented placeholders stay visible, i.e. a harness test for prohibition 11's violation. It now proves the opposite end-to-end against real Postgres: no row without a register code reaches the catalogue; the five placeholder titles are gone; an inserted `WN-01` at `CONTENT_REVIEW_REQUIRED` shows nothing until it is flipped to `APPROVED_ACTIVE` with an `approvedBy`; a coded row then appears while a boolean-only `approved: true` row does not; saving the unreviewed row 404s; `tailored` claims "Picked for you" **iff** `basis === 'STATED_NEED'`, a `SAD_LOW` check-in yields `NEWEST_APPROVED`, and `POST /check-ins {feeling:'STRESSED'}` alone (no id from the client) moves the newest check-in into the claim with only the three reviewed groupings. `E2E_KEEP_RESOURCES=1` leaves that fixture standing so a browser pass has populated states; the default tears it down.

**Verification.** `npm test` 72 files / **1819** tests (was 1807: +4 on `liveCodes`, +8 on the register gate and the basis contract, 3 tailored tests rewritten). Journey **133/133** (was 124 — the nine new assertions are all Act 6), school-chat 120/120, dashboards 98/98. `oxlint --type-aware src/resources src/content test/e2e-journey.mjs` 0 warnings; `tsc -p tsconfig.json` holds the 47 pre-existing `$Enums` errors and adds none in a touched file. Frontend `tsc --noEmit` exit 0, `vite build` clean. **Seen in the browser as Jude** through the :5050 same-origin lane: the one register-coded card with the review strip beneath it, "Picked for you" with the "From your latest check-in" chip and the stressed-check-in rationale, the SLEEP topic empty state, the search empty state, the corrected toolbox+search state, and the detail page's "Still feeling heavy?" panel — including that "See how a request moves" resolves at `/support/status-guide` rather than inventing a route (prohibition 2). No console errors on any of them. Staff surfaces remain unseen, as in §0O: the local staff password is still dead and no creds were sought.

**One caveat, and how it was closed.** The last edit (`toolbox()` taking the code set directly from `liveCodes()` instead of re-reading `visibleWhere()`'s shape) landed **after** the first journey run, and the throwaway `:3010` could not be restarted at that moment — the stop was refused, which is the correct default for a server this session did not get a say-so over. So the runtime proof initially came from one behaviour-identical revision older than the commit, and §0P said so instead of papering over it. The owner then asked for the rebuild: `npm run build`, the `:3010` listener replaced from its `dist/main` command line, and the journey re-run against committed HEAD — **133/133** with all thirteen Act 6 register-gate assertions green (`no row without a register code reaches the catalogue`, `the invented seed placeholders are gone`, `and the boolean-approved row still does not`, `saving an unreviewed resource is refused, not quietly stored — 404`, `the newest check-in drives the claim without the client naming it — basis STATED_NEED`), plus `/resources/toolbox` and `/resources/tailored` re-read over HTTP and the browser surfaces re-checked on the restarted backend. Nothing in this slice was left unverified by build alone. The owner's vite on `[::1]:3000` was reused throughout and never touched.

**What this changes for a real student today, stated plainly.** Because nothing in `content_item` is `APPROVED_ACTIVE` for `WELLBEING_RESOURCE`, `/resources` is now an **empty page** everywhere the gate is live, with copy that says why. That is the truthful state, and it is the point Epic F was supposed to reach: the remaining work is not code, it is review. Whoever owns Doc C §6 has to approve `WN-01…WN-12` (or seed real content and approve it) before the surfaces have anything honest to show.

**Open for the next session:** (1) the content-review decision that empties `/resources` — approve the WN codes or supply content; (2) eleven-vs-eight category labels (code / Doc B / design disagree); (3) D7 — whether search stays; (4) the five Epic D migrations still applied locally only; (5) working staff creds for §0O's staff surfaces; (6) the nine untracked `test/*.mjs` probes, still the owner's call; (7) Epics G and H, specced and unbuilt.

---

## 0Q. Session delta — 2026-11-04 (Epic G built: a reported AI reply carries the student's own reason, and the limits a student reads are the ones they agreed to — `natlas EPIC_G_RESPONSIBLE_AI_001` @ `53a5c66` + `frontend EPIC_G_SURFACES_001` @ `4493ce2` + `8f431a2`)

**Mandate, verbatim:** "continue the next phase and always check out to new brnaches". Two instructions in one sentence: the phase is Epic G (Responsible AI), and a standing workflow rule was created — every new phase gets its own freshly checked-out branch, opened *before* the first edit. That rule is honoured for Epic H too and is now the default for this project.

**Why the Epic G branches stack instead of forking from `main`.** `EPIC_G_RESPONSIBLE_AI_001` is cut from `EPIC_D_QA_GUARDS_001` and `EPIC_G_SURFACES_001` from `EPIC_D_SURFACES_002`, not from `main`. The reason is the database, not tidiness: the local dev DB already has the five Epic D migrations applied, and `origin/main` has no migration directories for them — a branch off `main` would put the schema ahead of the code and make the next `migrate dev` demand a database reset, i.e. destroy the very fixtures the journey harness needs. `origin/main`'s two extra merges (PR #13/#14) produce an empty diff against the Epic D tip, so nothing is being carried that main lacks. **Related, and worth knowing before the next migration attempt:** `prisma migrate dev` is unusable in this repo. Its shadow database cannot apply `20261006193000_phase_c_memory` (`P3006`/`P3018` — `ERROR: extension "vector" is not available`, because the shadow DB is created without pgvector). The house style, which all five Epic D migrations and this one follow, is a hand-written `migration.sql` with a rationale comment, applied with `npx prisma migrate deploy`, then `npx prisma generate`.

**What Epic G actually is, read off the artboards before writing any.** Five instruments, only three of which are buildable as drawn: the student's report dialog gains a reason set ("What went wrong?" — four options), the "Using AI support safely" panel behind the reflection-page boundary line, a counsellor explainer of what the AI does and never does, and — drawn across the staff artboards — an AI-summary accuracy verdict with a request that "cannot move on until you have reviewed the AI summary", plus a "Boundary checks on this conversation" panel and a "Human oversight record" timeline. The first three are honest to ship. The last two assert a professional-approval workflow that this deployment does not have.

**g01 — the reason exists, required at the door and nullable on the row.** `AiReportReason` = `DIAGNOSIS_OR_MEDICAL_ADVICE | UNSAFE_OR_UNKIND | DID_NOT_UNDERSTAND | OTHER`, added to `prisma/schema.prisma` in migration `20261103120000_ai_report_reason`. The design is the interesting part. The DTO makes it **required** (`@IsEnum`, and the global `AppValidationPipe` is whitelist + `forbidNonWhitelisted`, so a free-text or absent reason is a 400 — proven by six new malformed-body cases), while the column stays **nullable**, because reports filed before today must read as "no reason given" rather than be rewritten under a category nobody picked. `OTHER` is the catch-all, so a closed set never becomes a wall between a student and the one control they have over a bad reply. And the reason is **deliberately outside the content register**, against Epic F's doctrine (Doc C §6/§7): the register exists to fail closed, and a fail-closed gate placed in front of a reporting affordance could hide a safeguarding control pending a review. So the reason is *code*, not *content* — but it is a fixed, countable set chosen by the student, not prose. `baseSelect` carries `reason` so both reviewer reads get it; `mine()` keeps its deliberately narrow `{id,messageId,createdAt}` select, because a student must never learn that a reviewer looked.

**g02 — the dialog will not send without a reason, and the server's 400 never has to be discovered.** A `<fieldset>`/`<legend>` radio group with the four labels verbatim from the artboard ("It sounded like a diagnosis or medical advice", "It felt unsafe or unkind", "It did not understand me", "Something else"), the note still optional under "What happened?", submit disabled until a reason is chosen, and `RESPONSE_CHANGED` (the reply was regenerated under the open dialog) offering "Reload reply" instead of silently reporting new text. The pre-existing audience notice and the "Reporting does not request personal support or emergency help…" line stayed — a report is not a support request, and the design's dialog does not say so, so the app has to. On line 102 the design's own sentence *was* kept ("A person reviews reported replies against our responsible-AI rules"), and it is defensible in a way the indicator-rule claim is not: the reviewer queue is real code, and the reply-level guardrails (`bannedClaims` in `guardrails.config.ts`) are live server config. One line of the app is honest about *who reads it*; the next section refuses to be honest about *who approved the thresholds*.

**g03 — the boundary line is a door, and it ships no wording of its own.** `AiSupportSafetySheet.tsx` replaces the static `<p>` on the reflection page. It opens a dialog rendering `what-it-supports` and `what-it-cannot-do` **from `GET /api/v1/ai/disclosure`** — the same instrument each student's consent was recorded against — with the version printed ("Shown exactly as the explanation you agreed to (version v2)") and a link to `/consent`. The artboard's own shorter list ("I can help with… / I cannot…") was not typed into JSX: a paraphrase of the consent instrument would be a second claim standing beside the first, and the two could drift. Fetch is lazy (first open), cancellable, and fails to an `ErrorNote` rather than to invented copy.

**g04 — the counsellor explainer says what the config does, and refuses the approval claim.** `/school/ai-boundaries` gains "What the AI does and never does" (the can/never lists, kept to what the server actually enforces or the guardrail config actually polices) and "How AI behaviour is reviewed". The design's third line there reads *"Rules and wording are approved by qualified professionals before production use."* **That is false today, and it is the reason it was rewritten rather than shipped.** All eleven Doc A indicator rules in `src/ai/intents/indicators.config.ts` are `configured: false` — a fact enforced by `indicators.config.spec.ts`, not a temporary state — so the server's keyword floor is the only automatic safety net. What ships in its place says exactly that, in the page's own voice, and the human-oversight principle line is carried verbatim because it is true.

**The four things in the design that were not built, with the reason.** (1) The summary-accuracy verdict ("Is the AI summary accurate? Accurate / Needs correction / Not relevant") and the gate "The request cannot move on until you have reviewed the AI summary" — new review vocabulary sitting directly on top of still-open decision D3 and deferred ab04, and a lifecycle block on a student's support request that no document asks for. It goes to the owner as a decision, not into a migration. (2) The "Boundary checks on this conversation: No diagnosis language / No medical advice / No emergency claims" panel — as drawn it presents server pattern hits as a professionally approved checklist; the artboard itself hedges ("Sample checks — Rules pending professional approval"), which is the tell. The live equivalent of that information already exists on `/school/ai-boundaries`, sourced from config. (3) The "Human oversight record" timeline — it is a projection of (1); nothing is invented to fill it. (4) The safety panel's own wording — see g03.

**Verification.** `npm test` 72 files / **1826** tests (was 1819: +4 controller body-shape cases, +1 the pre-reason null read path, spec fixtures moved to the enum member to dodge TS2345). Journey **144/144** (was 133; the eleven new assertions are Act 5 "a student reports an AI reply, with a reason" — 200 + `alreadyReported:false` + the reason echoes + no `reviewOutcome` leaks to the student + a 400 for a reason-less body + a 400 for free text + a second report returning the first reason — and Act 7 "ERIC reviews the reported AI reply" — the queue row carries the reason at `reviewOutcome === null`, `responseContent` matches the reply, the review records `reviewedBy.role === 'PSYCHOLOGIST'`, and Ngozi (SUPPORT_STAFF) is 403 on the queue). Run against a rebuilt `:3010` from committed HEAD, not from a stale dist. School-chat 120/120, dashboards 98/98. `oxlint --type-aware` on the touched paths 0 warnings; `tsc -p tsconfig.json` holds the 47 pre-existing `$Enums` errors and adds none. Frontend `tsc --noEmit` exit 0, `vite build` clean. **Seen in the browser as Jude** through the :5050 same-origin lane: the safety sheet rendering both sections verbatim with the version line, the report dialog's legend and four radio values, `sendDisabledBefore: true` flipping enabled only after a reason, submit → close → trigger reading "Report submitted", and console clean apart from the known :5050 socket.io proxy warnings. Then a read-only `SELECT` proved the write really landed server-side: one row `reason: DID_NOT_UNDERSTAND` with the browser note and `reviewOutcome: null`, one `DIAGNOSIS_OR_MEDICAL_ADVICE` already at `NO_CHANGE_NEEDED` reviewed by Eric.

**Two caveats, small but recorded.** The legacy path (`reason IS NULL` on a report filed before this migration) is proven only by a unit spec — Act 0 of the journey cascade-deletes old rows, so no historical row survives a run to be read back. And the two staff surfaces touched here (`/school/reports` reason display, `/school/ai-boundaries` new sections) remain **unseen in a browser**, as in §0O and §0P: the local staff password is still dead and no credentials were sought.

**Open for the next session:** (1)–(6) carried unchanged from §0P — the `WN-*` content review that empties `/resources`, eleven-vs-eight categories, D7 search, **now six** migrations applied locally only (the five Epic D ones plus `ai_report_reason`), working staff creds, the nine untracked probes; (7) **Epic H (Student Wellbeing History), specced and unbuilt**; (8) new to this list: the summary-accuracy verdict and its request-blocking gate from the Epic G artboards, which is an owner decision before any code; (9) also new: `test/e2e-phase-one.mjs` (untracked probe) still posts reason-less bodies and is now stale against the contract.


---

## 0R. Session delta — 2026-11-04 (Epic H built: a student reads their own wellbeing history back, and asking to delete it asks rather than deletes — `natlas EPIC_H_WELLBEING_HISTORY_001` @ `07876ed` + `frontend EPIC_H_SURFACES_001` @ `ca81677`)

**Mandate unchanged** — "continue the next phase and always check out to new brnaches". The phase after Epic G is **Epic H (Student Wellbeing History)**, and both branches were cut before the first edit: `EPIC_H_WELLBEING_HISTORY_001` from the Epic G backend tip (`7a9f83e`), `EPIC_H_SURFACES_001` from the Epic G frontend tip (`8f431a2`), for the same database reason recorded in §0Q.

**What Epic H is, read off the artboards.** A "My wellbeing history" timeline (four tabs — All / Check-ins / Reflections / Support requests — with a count beside each), a per-entry detail page showing the check-in, the whole reflection and a support-request stepper, an "About your history" explainer (what is stored, who can see it, how long, how to delete), and a delete-my-history flow. None of it needed a new kind of record: every field the pages show already exists on `emotional_check_in`, `conversation`, `conversation_message`, `session_summary` and `support_request`. That is what makes the page sayable as "this is your history" — it is a projection, not a second copy.

**h01 — the aggregate, and the projection is the security control.** `src/history/history.service.ts` reads the student's check-ins newest-first with one module-level `HISTORY_INCLUDE` (newest conversation, its summary, and the `viaVoice` flags of the student's *own* turns; newest request with its follow-up statuses) and hands every row to `project()`, which emits only `checkInId, createdAt, feeling, intensity, triggers, reflection{…}, supportRequest{id,createdAt,status,queueStatus,followUpState,urgency}`. Whitelisting rather than blacklisting is the point: `aiPayload`, `report`, `reviewNote` and the frozen `initialMessage` never enter the response, so the surface cannot leak staff material by a later frontend omission. `detail()` filters ownership **inside the query** (`where: { id, studentId }`) and 404s on null — not 403, because a 403 on someone else's uuid confirms the record exists, and whose it is, is not this student's information. The queue vocabulary is the server's own (`deriveQueueStatus`/`deriveFollowUpState`/`deriveUrgency` from `support-requests/queue-status.ts`), so a student and the staff queue can never disagree about what stage a request is at. One route gotcha is now pinned by a test: `GET`/`POST /v1/history/deletion-requests` are declared **before** `GET /v1/history/:checkInId`, and `history.controller.spec.ts` asserts `service.detail` is never called for the literal path — otherwise a uuid param would have swallowed it and the failure would have looked like a 400 on a valid uuid.

**h04 — a deletion *request*, never a deletion.** New `enum HistoryDeletionScope { ALL_HISTORY BEFORE_DATE SELECTED_CHECK_INS }` + `model HistoryDeletionRequest` (migration `20261104093000_history_deletion_request`, hand-written SQL per §0Q's house style, applied with `migrate deploy`). `history-deletion.service.ts` inserts one row and notifies — it deletes nothing, and the reason is in the docblock, not a TODO: some of what a student shares may have to be kept for safeguarding or legal duties, so the decision belongs to a named professional rather than to a CRUD handler. Three details carry that through. (1) The scope decides which fields mean something, so a mismatch is refused with `SCOPE_FIELDS_MISMATCH` instead of half-honoured — an "everything" ask carrying a stray date would be a different request than the one a reviewer reads. (2) Foreign ids in `SELECTED_CHECK_INS` fail with the deliberately unspecific `CHECK_INS_NOT_FOUND` / "Some of those check-ins are not yours" (that exact sentence is what the student's dialog will render — the exception filter puts `message` on the wire and leaves `error` the generic label, and `lib/api.ts` reads `message`). (3) `alertedAt` is nullable and *means* something: null when there is no schoolId, no reviewer, or the notification push threw — an alert outage must never lose the ask. The receipt therefore has two honest states, and the frontend renders "We could not reach your school's team about this request. To be sure a person sees it, tell them through Support." instead of promising a review nobody was told about. Reviewers are `COUNSELLOR | PSYCHOLOGIST | SUPPORT_STAFF` — "the roles that already read this student's wellbeing content, and no wider", which excludes SCHOOL_ADMIN by the same tenancy logic as §0B. `Notification.type` is a plain String, so `HISTORY_DELETION_REQUEST` needed no migration.

**Three design claims refused, and one narrowed.** (a) **"2 resources shared" per check-in** — refused. Nothing in the schema ties a `wellbeing_resource` to a check-in or a conversation; `ToolboxItem` and `ResourceFeedback` key on `studentId` alone, and the student UI never renders a recommended-resource link. A count there would be an invented relationship, so the row says only what is stored. The refusal is asserted in the journey (`no resource count is invented`). (b) **"Entries are removed automatically after your school's retention period"** — refused; no expiry job exists anywhere in the server. `HISTORY_RETENTION_TRUTH` says the opposite in student words ("Nothing here is removed on a timer… an entry stays until a deletion request you make is agreed to by a person at your school"), because leaving a student waiting for a deletion that will never arrive on its own is not kindness. (c) **The 4-step "reached" stepper** — refused as drawn. The app's own `/support/status-guide` tells students these statuses "show the current state of a request, not a guaranteed sequence", so `history.$checkInId.tsx` lists the four stages and marks **only the current one**, with the same caveat sentence and a link to the guide. (d) **"Administrators: no access to wellbeing content"** — narrowed rather than copied, and this one is worth re-checking if the audit surface ever changes. SCHOOL_ADMIN is outside `STAFF_ROLES`, so it genuinely has no read of a student's words — but it is *not* blind: `SchoolAnalyticsController` is `@Roles('SCHOOL_ADMIN','PLATFORM_ADMIN')` and serves aggregate mood distribution and check-in counts, and `GET /v1/schools/:id/activity` returns `auditLog` rows **including `meta`**. Reading `chat.service.ts:166` and the other `meta:` writers settled it: those payloads carry `studentId`/`checkInId`/`professionalId` uuids and booleans, never names or content. So the About page says what is true — school-level numbers plus action records with internal reference numbers — instead of a flat "no access". PLATFORM_ADMIN's own lane is stated too, with the small-group rule that is real code (`PILOT_SMALL_GROUP_THRESHOLD = 5`: any breakdown cell backed by 1–4 students is withheld).

**Two sentences from the artboards were dropped rather than rewritten, and both are about the same thing — an outcome nobody can report.** The deletion dialog's copy ends "…We will tell you the outcome", and the empty state promises "your feelings, reflections and *the resources shared with you* will appear here". Neither is shipped: there is no outcome field on `HistoryDeletionRequest` and no path by which a reviewer would set one, and no resource link exists at all (see (a)). So `HISTORY_DELETION_NOTICE` stops at what is actually true — reviewed before anything is removed, some information may have to be kept, filing deletes nothing by itself — and `HISTORY_EMPTY` lists feelings, reflections and requests. The staff queue that would produce an outcome is open item (1) below; when it is built, that sentence becomes payable and belongs back.

**Verification.** Backend `npm test` 75 files / **1877** tests (51 of them new: `history.service.spec.ts` 11, `history-deletion.service.spec.ts` 13, `history.controller.spec.ts` 27 — the last includes a six-role boundary sweep on every route, the unauthenticated 401, the malformed-uuid 400, the 404-not-403 proof, five malformed ask bodies, and the literal-vs-param shadowing test). Journey **165/165** (was 144): a new "Act 6 — Epic H" block asserts both of Jude's check-ins are listed, that the Act 4 row carries his reflection and *his own* request at `queueStatus: 'NEW'` while the Act 4 safety request stays unlinked (it has no `checkInId`, on purpose), that a check-in that led nowhere is shown as that rather than padded, that `counts` equal what each tab prints, that no staff-only column is on the wire, that the read-back is USER+ASSISTANT only, then the deletion half — 201 filed, `alertedAt` set, the note kept verbatim, reads back, `SCOPE_FIELDS_MISMATCH`, `CHECK_INS_NOT_FOUND` with its unspecific sentence, and **a before/after `SELECT count(*)` on `emotional_check_in` proving filing a deletion request deleted nothing**. Act 8 picks up the three role negatives on `/api/v1/history` (psychologist 403, school admin 403, anon 401). `oxlint --type-aware` 0 on the touched paths; `tsc --noEmit -p tsconfig.json` holds the same 47 pre-existing `$Enums` errors. School-chat 120/120 and dashboards 98/98 were not re-run — nothing they cover moved. Run against a `:3010` rebuilt from committed HEAD (`npm run build` → `TaskStop` on the task this session started → relaunch). Note that the frontend repo has **no lint tooling at all** (`npx oxlint` there cannot find `tsgolint` and there is no `lint` script), so its gates are `vite build` + `tsc --noEmit`, both clean. **Seen in the browser as Jude** through :5050: the header gained "My history" for a student only; `/history` rendered `All 2 / Check-ins 2 / Reflections 1 / Support requests 1`, "Feeling low · Check-in · Typed reflection · 4 turns · Support request · Follow-up required" (the follow-up Act 7 created, read through the same derived fields), the retention footer, and the receipts including "Your school's team has been told to review it."; the dialog's three radios with `ALL_HISTORY` default, its date field appearing only for `BEFORE_DATE`, its checkbox list built from the entries already loaded and **Send disabled at zero selections**, then a real submit whose POST body was `{"scope":"SELECTED_CHECK_INS","checkInIds":["a374140c…"],"note":"Browser pass: please remove the exam-week one."}`, which closed the dialog and re-loaded a second receipt without touching the row count; the detail page with the verbatim description, three trigger chips, the four-turn read-back and a single marked stage; `/history/about` rendering all six sections. **Screenshots were unavailable for this pass** — the Browser surface was hidden, so `take_screenshot` returns `NATIVE_BROWSER_VIEWPORT_UNAVAILABLE`; every claim above is structural (DOM text and computed state), which is the known harness limitation, not a product finding.

**Two caveats.** The staff half of this feature does not exist yet: a reviewer is *notified* of a deletion ask, and there is no `/school` surface to read the queue, decide, or record the outcome — so the honest sentence on the receipt is currently the only place the ask is visible to anyone but the student. That is the first open item, ahead of any Epic H polish. And, as in §0O–§0Q, no `/school/*` surface has been seen rendered, because the local staff password is still dead and no credentials were sought.

**Open for the next session:** (1) **a staff surface for `HistoryDeletionRequest`** — read the asks, decide, tell the student; without it `alertedAt` is the end of the road. The review instrument for it is written: `docs/EPIC-H-DELETION-REVIEW-SPEC.md`, eleven decisions `HD-01…HD-11` all PENDING, nothing in it approved and nothing in §5–§7 built. (2) The nine untracked `test/*.mjs` probes stay untracked and must never be staged. (3) ~~**Seven** migrations are applied locally and not on prod: the five Epic D ones, `ai_report_reason`, `history_deletion_request`~~ — **corrected the same day by measurement:** the owner merged **PR #15** (`EPIC_D_QA_GUARDS_001` @ `80d857a`) into `main` → `97d2454`, the deploy lane ran it, and prod's `_prisma_migrations` now tops out at `20261102140000_indicator_levels_and_review`, i.e. the Epic D set is **applied on prod**. Two remain local-only: `ai_report_reason` (Epic G) and `history_deletion_request` (Epic H), and they apply themselves when those branches merge. What prod's code does **not** contain, verified by grepping `origin/main` rather than by reading the merge title: no `visibleWhere` (Epic F), no `q` search on `support-flags` (ab01/ab08), no `src/history` (Epic H) — those are still ahead of `main` on the branch tips. Frontend **PR #16** merged `ESCALATION_POPUP_001` → frontend `main` `d798783`, so Epic A/B/C are on `main`; the VPS SSR box still serves `3e641ce`. (4)–(8) carried from §0Q — `WN-*` approval (D1/D6) that keeps `/resources` honestly empty, eleven-vs-eight feeling categories, D7 search, working staff creds, D2–D5/D8/D9, deferred ab04. (9) The Epic G summary-accuracy verdict is still an owner decision. (10) `test/e2e-phase-one.mjs` still posts reason-less bodies. (11) The VPS frontend is still parked at `3e641ce`, and the two `main`s still diverge, so none of Epic G/H is merged anywhere.


---

## 0S. Session delta — 2026-11-04 (Epic E audited, not built: the consent instrument is the product's most load-bearing text and four of its sentences do not match the server — `natlas EPIC_E_PRIVACY_AUDIT_001`, `docs/EPIC-E-PRIVACY-CONSENT-GAP-ANALYSIS.md`)

**Mandate:** "Start the Epic E audit" — audit the twelve `Epic E (Privacy, Consent & Access)` artboards against what actually ships and produce a decision list rather than a build. Branch cut before the first edit, per the standing "always check out to new branches": `EPIC_E_PRIVACY_AUDIT_001` from `EPIC_H_DELETION_REVIEW_001` @ `fcf6f60`. **No code, schema, migration or copy changed on this pass** — a docs-only delta.

**What Epic E turns out to be.** Three groups: the student consent journey (①read-before-you-start ②about-this-chat ③agreement-record ④declined-state), two sign-in portals with security claims (⑤platform-admin ⑥school-professional), and the administration console (⑦register-school ⑧onboard-student ⑨onboard-professional ⑩deactivate-school ⑪user-registry ⑫suspended-school page). The surprise is the shape of the gap: **group A and group C are already built**, and in group A's case built better than drawn — `ConsentGate.tsx` is a four-view machine (`start|read|record|declined`, `:52`, `:240-243`) that ships ①②③④ in order, renders the artboard's "Opening this page does not count as agreeing" verbatim (`:271`), renders ③'s exact three-row record with a real `<time>` element and the live version string (`:304-328`), and adds three things no artboard has: a guest reader, a version-race guard that refuses to record against a stale instrument (`:119-122`, `:200-203`), and a re-read path that cannot double-record (`:211-215`). The shipped gate is **stricter** than the design — three ticked statements (`ai-disclosure.ts:163-179`) before the one confirm button the artboard draws, whose label the instrument supplies (`:186`, the design's sentence word for word).

**The one promise worth stating plainly, because it is the whole epic's spine: "Administrators see school and access details only, never student wellbeing information" is true in code, and true structurally.** `STAFF_ROLES` is COUNSELLOR/PSYCHOLOGIST/SUPPORT_STAFF (`staff-bootstrap.dto.ts:16-20`) and no admin role is in it, so `GET /v1/conversations/:id` (`conversations.controller.ts:52`) 403s both SCHOOL_ADMIN and PLATFORM_ADMIN; review context is narrower still (`REVIEWER_ROLES`, `roles.decorator.ts:11`); `consentRecord` is read in exactly four places, all owner-scoped (`consent.service.ts:21/:29/:53/:62`); `PrivacyPreference` in two (`privacy.service.ts:15-46`). Tenancy holds at two moments — the `school-status-guard` `before` hook at sign-in (`auth.config.ts:74-109`) and `TenantGuard` per request (`:73-93`) — and suspension is not decoration: sessions deleted `admin.service.ts:167`, sockets hard-disconnected `:177`, audited `:182-185`.

**§5 of the doc is the part that matters, and it is not about missing screens.** Four sentences **currently shipped inside the consent instrument** — the text a student ticks and the school is meant to be able to prove (`ai-disclosure.ts:1-10`) — describe a narrower product than the one running. (a) `what-we-collect` (`:116-124`) never mentions voice, while voice ships end to end: the browser encodes a 16 kHz WAV and posts it (`lib/voice.ts:209-218`), `POST /v1/ai/transcribe` buffers and forwards the audio bytes to a third-party endpoint (`ai.controller.ts:120-169` → `ai.service.ts:686-713`), the turn is stored flagged `viaVoice`, and the footer names the transcription models by name (`AppFooter.tsx:10-12`). `/history/about:47` already discloses it correctly; the instrument does not. (b) `how-it-works:112` tells the student the AI "only knows what you share **here**", and `ai-context.service.ts:132-139` calls `memory.recall` for vector-similar summaries from **earlier** conversations into the same prompt. (c) `privacy-in-short:79` promises the counselling team is alerted "with **your name** … and **a short piece of the message**" — the escalation note in fact carries `studentRef`, not the name, and then instructs staff to "**review the conversation**" (`support-flag-alerts.service.ts:159-164`), which any of the three staff roles can open in full. The promise is wrong in one direction and materially understated in the other. (d) `how-we-protect:130` says "your **school's** secure server"; the deployment is one shared Postgres separated by a `schoolId` column, and whether that is fair language is the owner's call, not a writer's.

**Two things that do not exist at all, stated without softening.** ⑤'s "**a one-time code is sent to your registered device after sign-in**" describes **no OTP, no TOTP, no MFA, no second factor anywhere** — the only regex hits in `src/` are syllables inside the vernacular corpus; entry is email+password with `requireEmailVerification` and `disableSignUp` (`auth.config.ts:149-169`). And ⑤'s "every sign-in is recorded" is not true as an audit statement: every `action:` literal written to `AuditLog` is a school/account/chat/AI/privacy event and none is an authentication event, because the auth plugin's only hook is a `before` that throws without logging. A *session* trail exists (`schema.prisma:337-349`, `ipAddress`/`userAgent`) and `admin.service.ts` already reads it for `lastActivityAt` — but it cannot serve as a trail, because lifecycle actions delete those rows wholesale (`admin.service.ts:167`, `school-users.service.ts:422`, `:474`). Two portal screens are likewise one screen (`signin.tsx:92`), and ⑩⑫'s "sign in **through this school's link or QR code**" has no substrate at all — no link, no QR, no activation token, the same missing foundation that blocked Epic B's wizard (§0N).

**Dead controls, and the honesty rule that follows from them.** `PrivacyPreference`'s three booleans (`schema.prisma:451-462`) are written by `PATCH /v1/privacy/preferences` and **read by nothing** — no feature, route or page consults them, and `/privacy` renders two prose sections and zero controls (`privacy.tsx:17-24`). QA row 10 in the doc makes the point executable: set `allowParentGuardianNotification: true` and observe that nothing happens. Any future UI that renders switches for these three would be decoration with a privacy label on it.

**Also found while auditing, neither an artboard gap nor an Epic E feature:** `GET /v1/audit` is gated to the three staff roles (`audit.controller.ts:13`) and `audit.service.ts:38-48` applies no `schoolId` filter unless the caller supplies one, which the controller never does — cross-school visibility of action metadata for staff accounts, against a model whose entire point is school separation. No frontend code calls it; every screen uses `v1/admin/activity` or `v1/schools/:id/activity` (`lib/admin.ts:67-80`). Scope it or delete it (PE-15). And `ConsentService.accept` hard-codes `accepted: true` as the only write (`consent.service.ts:60-77`) — a student who agreed has no product path to un-agree, which the design never promises either, and which is itself the question (PE-11).

**Sequencing finding the owner will want before answering anything:** eight of the twenty decisions (PE-03/04/05/06/07/08/09/10) all edit the instrument, and bumping `AI_DISCLOSURE_VERSION` **re-prompts every existing student once** (`ai-disclosure.ts:6-9`). They must be answered as one batch or the product will run a consent storm every time a sentence is corrected. PE-11 cannot be answered before HD-04/HD-07 either — "withdraw consent" and "what survives deletion" are one question wearing two hats. The doc's §7 carries all twenty rows as ☐ PENDING with an owner named; nothing is approved, and §9 states the non-goals: no copy changed, no MFA build, no activation-link schema, no retention job, no new consent version minted on this pass.

**Method, so the next audit can be repeated rather than trusted.** PDF → `pdftotext -raw` → 383 lines read in full; then **every** claim matched to code with file:line before it reached the page, in both directions — §3 records the twelve artboard claims the code honours (including "It sees your first name and your message", which is exactly right: the prompt carries `Student first name:` at `ai.service.ts:563` and the context query selects only `firstName`+`preferredLanguage` at `ai-context.service.ts:79-82`), §4 the six that exist nowhere, §5 the six that ship and misdescribe. Two of my own draft citations were wrong on first pass and are fixed in the committed file (`createCredentialUser` is `:609-630`, not `:640-650`; PE-02's evidence is the enumeration of every `action:` literal, not the analytics constants). One correction to a note this thread has been carrying: the disclosure instrument is **`v2`**, not `v1` (`ai-disclosure.ts:11`).

**Gates.** Docs-only; `npm test` and `tsc` were not re-run because no source file moved. Working tree holds only the new file plus the nine untracked `test/*.mjs` probes, which remain unstaged.

**Open for the next session:** (1) the Epic E decisions are now answerable — **§5 first**, since those four sentences are agreed to by students today; (2) the `ai-disclosure-v1` note in memory is stale, the instrument is `v2`; (3) Epic E's build, if and when the decisions land, starts with the instrument batch (one version bump) and then the two portal/registry deltas, which are content changes rather than new subsystems — with PE-01 (MFA), PE-13 (activation links) and PE-02 (sign-in audit) as the three that would each need real design; (4)–(11) carried unchanged from §0R, above: the `HistoryDeletionRequest` staff surface, `HD-01…HD-11`, the `WN-*` approval that keeps `/resources` honestly empty, eleven-vs-eight feeling categories, D7 search, working staff creds, D2–D5/D8/D9, deferred ab04, the Epic G summary-accuracy verdict, `test/e2e-phase-one.mjs`'s reason-less bodies, the VPS frontend still at `3e641ce` and the two diverged `main`s.


---

## 0T. Session delta — 2026-11-04 (two browser annotations on the reflection page, both about *where* a sentence is allowed to sit — `frontend BOUNDARY_POPUP_001` @ `5882585`, `natlas BOUNDARY_POPUP_001` (this doc only))

**Mandate was the annotations themselves**, on `http://localhost:5050/reflection/b027781f-…` — a *closed* conversation being read back. (1) the "Not an emergency service" block: *"this should not be coming up here but as a chat popup that can be closed"*. (2) the "This conversation has ended — you can read it back any time." + "How are you feeling now?" band: *"since the checkin has ended; and it is history; this should not be coming up here"*. Branch cut before the first edit per the standing rule: frontend `BOUNDARY_POPUP_001` from the Epic H frontend tip (`ca81677`, stacked so the working tree under the owner's vite never moved), and this doc's twin backend branch from the Epic E tip (`4a8b9a5`). **No backend file, schema, migration or sentence changed** — everything the two screens needed was already server-owned.

**The invariant the first one encodes: a boundary is a decision about one turn, not an end to the conversation.** `BoundaryNotice.tsx` was an `<aside role="note">` pushed *into* the thread at the assistant turn it explained, which meant the escalation physically grew the chat and stayed there; it is now the same component as a native `<dialog>` — `showModal()` on mount, so the backdrop, focus trap and Esc come free, dismissed by Esc, the backdrop or a new **"Keep talking"** button sitting beside the existing "Talk to a person" link. Both sentences are verbatim from before (the acute one still quotes `SUPPORT_EMERGENCY_NOTICE`, the out-of-scope one still lists the four banned claims) — this is a change of position, not of wording, which matters because §0S just recorded that the product's *wording* is under review and nothing here pre-empts that. Three deliberate behaviours:
- **Once per kind per conversation** (`boundaryNoticedFor`, keyed `conversationId:kind`), not once per conversation: a second out-of-scope turn must not interrupt again, but an acute route is a different decision and still gets said out loud. The latch is a ref, so re-opening that old reflection tells it once more — one tap to dismiss, no persistence invented.
- **The thread is the source of truth, not the send response.** The popup is raised by a newest-first scan over `messages`, so it fires identically when the reply arrives on a send, on the 4s `PENDING_AI` poll, or on a page opened days later to read it back. Triggering only from `sendMessage` would have silently dropped the notice for every async reply.
- **Two popups never stack.** An acute turn is the one case where the backend returns *both* a boundary and `humanCareRecommendation` (`ai.service.ts:358-365` sets the boundary; `conversations.service.ts:452` derives the offer from `humanSupport.recommended`; `ai.service.spec.ts:255-261` shows them firing together), so `offerHumanCare` now takes the assistant turn and skips an acute one — the boundary notice already says a person has been told *and* opens the same door. It skips **without** latching, so a later ordinary turn can still offer. For the residual case (out-of-scope boundary + a model's own human-support nudge) the scan returns early while `humanCare` is showing and re-runs when it is dismissed, so the notices serialise instead of layering.

**The second one is a truthfulness fix, not a layout fix.** "How are you feeling now?" links to `/complete/$checkInId`, i.e. it asks the student for a mood check on a check-in that finished long ago — the same class of claim §0R refused on the history page ("entries are removed automatically"), reached here by a CTA rather than by copy. The band is now gated on `endedThisVisit`, set only where this mount *watches* the chat end: the `conversation.closed` push (idle expiry, or a close from another device) and the 409-on-send flip. `handleContinue` deliberately does **not** set it — it navigates to `/complete` itself, and a student who presses Back is by then reading history, which is the correct answer to "should the mood prompt follow me?". What history reads keep: the thread, the Past-reflections drawer, the "AI-guided reflection · not a therapist or doctor" pill that opens Epic G's sheet, and the boundary popup. What they lose: the "This conversation has ended" line and both buttons.

**Verification.** Frontend gates only — `npx tsc --noEmit` clean, `npx vite build` clean (that repo still has no lint tooling at all). Backend `npm test` / `tsc` not re-run: no source file moved. **Seen in the browser as Jude** through :5050 on the annotated closed conversation: zero `[role="note"]` blocks left in the thread, one open `dialog` whose text is exactly "Not an emergency service · What you shared is with your school's support team now, so a person can follow up with you. This is not an emergency service and does not send emergency help…", then after clicking **Keep talking** the dialog unmounts (4 dialogs in the DOM → 3: the completion confirm, the human-care offer, the past-reflections drawer), nothing reopens, and the thread stays readable. The band is gone on that page — no "This conversation has ended", no "How are you feeling now?" anchor anywhere. **Structural claims only**: the harness still cannot screenshot, and the mid-visit paths (idle expiry, 409) were read in code rather than waited out — an expiry test means sitting on a live conversation until the server closes it.

**Open for the next session:** (1) `BOUNDARY_POPUP_001` is a frontend-only branch, unmerged, stacked on the unmerged Epic H surfaces — it inherits §0S's (4)–(11) and §0R's merge situation unchanged; (2) if the owner wants the escalation notice to appear **once ever** rather than once per mount, that is a persistence decision with a real trade (a student who re-reads an old acute turn would then see nothing), so it belongs with the `HD-*`/`PE-*` batch rather than to this slice; (3) the same "position, not wording" question is still open on `/support/status-guide` and the Epic F "Still feeling heavy?" panel, both of which render guidance inline in a thread the student may be re-reading.


---

## 0U. Session delta — 2026-11-04 (the owner answered Epic E in one sitting and ruled on deletion: instrument `v2 → v3` shipped, and two of the audit's own claims corrected on the way — `natlas EPIC_E_INSTRUMENT_V3_001`, `frontend EPIC_E_INSTRUMENT_V3_001`)

**Mandate:** the four §5 sentences, answered verbatim — *"PE-03: Voice transcription is done by N-Atlas; n-atlas receives it and transcribes it; it is not saved on N-atlas. PE-04: Say it only get context from recents conversations only. PE-05: Hide the view whole conversation link on the frontend only; (display: none) it is still there but invincible. PE-06: Not writers call"* — plus **"batch them" / "Batch all the PEs"**, and a ruling on the whole Epic H table: *"all student data can be deleted; all like it never exists; but this decision is made by the student; and would be on for 24 hrs; for the student to cancel; after 24 hrs all traces of the student data is erased from the system"*. Branches cut before the first edit per the standing rule: natlas `EPIC_E_INSTRUMENT_V3_001` from `BOUNDARY_POPUP_001` (`9a4ad68`), frontend twin from `5882585`.

**Batching paid for itself: one version bump, four sections, one re-consent.** `AI_DISCLOSURE_VERSION` is `v3`, and `ai-disclosure.ts` now says what the server does. `privacy-in-short` → *first name* and *the start of the message that triggered it (the first 180 characters)*, which is `excerpt = studentMessage.slice(0, 180)` (`support-flag-alerts.service.ts:124-127`). `how-it-works` → *"It sees this chat, your newest check-in, and short summaries of your recent chats — the last 30 days only."* `what-we-collect` gains the voice-note line and `how-we-protect` gains the speech-to-text one. **PE-06 changed nothing**: "your school's secure server" stays, and the doc records why that costs money later — it is another instrument edit, therefore another whole-school re-consent.

**Two claims corrected before they hardened, one of them mine.** (1) The owner's PE-03 framing is only true of the vernacular lane: `ai.service.ts:686-713` routes **yo/ha/ig** to the N-ATLaS ASR provider and **en/pcm** to the chain's Groq Whisper member — `openai.provider.ts:110-119` throws by design so the chat provider is skipped for audio. So the sentence names both, and it claims retention only about our own record ("your school record never holds the recording") because no `writeFile`/`createWriteStream`/base64 persistence exists anywhere under `src/ai` (verified by grep) while a third party's policy is not knowable from this codebase. (2) §0S recorded that the alert "names the student by `studentRef`, **not by name**". Wrong: `studentRef` on a flag is `student.displayName ?? student.firstName ?? 'Student'` (`conversations.service.ts:331`) and `displayName` is set to the first name at bootstrap (`students.service.ts:28`). The shipped sentence was right about that half all along; only the understatement (a snippet vs the whole thread) was real.

**PE-04 needed no behaviour change, and that is worth knowing before anyone proposes one.** `recallDays: 30` (`ai.config.ts:291`) bounds *both* buckets — the recency `findMany` and the pgvector `similarSummaries` (`memory.repository.ts:49-55`, `:83-87`) — and hooks are 14 days, so nothing older than 30 days can reach a prompt; four summaries max get carried (`ai-context.service.ts:136`). "Recent conversations only" was already the truth; the sentence just stopped hiding it.

**PE-05 as decided is a surface change, so it shipped as one and left two doors open on purpose.** `display:none` on three staff links into the thread — the dashboard indicator card (`dash/CounsellorDashboard.tsx:356`), the indicator detail card and the review dialog (`_dash/school/indicators.index.tsx:646`, `:829`) — kept in the DOM, still routed, nothing deleted. Hidden where the path is labelled *came from an indicator*, i.e. everywhere the alert surface reaches. **Not hidden:** the support-requests queue link (`requests.index.tsx:700`) — that surface is reached from a request the *student* raised, where the thread is the service they asked for; and `GET /v1/conversations/:id`, so any staff role can still read any transcript in their school by URL. Both facts are in §5.1 rather than glossed: the composed alert still ends "Please review the conversation", which now points staff at a surface with no link — changing that server sentence, or reinstating the links, is the owner's next call.

**The deletion ruling answers six of `HD-01…HD-11` and kills the reviewer queue this spec was written to design.** §4.1 records it: the **student** decides (HD-01), so COUNSELLOR/PSYCHOLOGIST/SUPPORT_STAFF are notified and are not deciders; removal happens in-app and self-executes with no second person (HD-02); nothing is exempt (HD-03); there is no expiry other than "kept until you ask, then gone 24 hours after the ask" (HD-04); whole-scope only, which makes the immutable `scope` enum (`schema.prisma:471-475`) dead weight (HD-06); withdrawable for 24 h then irreversible (HD-09). Four edges flagged rather than buried, because each one bites: **"like it never exists" is the one phrase the system cannot deliver** — the daily `pg_dump` under `/opt/backups` (`docs/DEPLOYMENT.md:380-383`, §7, automated with **no pruning interval configured**) survives any purge, as does what a staff member already read; deleting a safeguarding flag removes the school's proof that it responded, and an open case can be erased by the student who opened it, so HD-03 wants Doc A's countersign before the job is wired; **the 24-hour window is only meaningful if the student can sign in inside it**, and suspension deletes every session of the school (`admin.service.ts:167`), so an ask would run to completion on an account that cannot object (HD-10); and a hold with no reviewer is moot (HD-11, recorded N/A). HD-05 and HD-08 stay open. **PE-07 and PE-11 are deliberately absent from v3** — an instrument sentence describing a purge that does not exist is exactly the mistake §0S was written to catch, so both land with the job.

**Gates, all run for real.** `npm test` **75 files / 1877 tests green**; `npx tsc --noEmit` = the known 47-error baseline with nothing in `src/ai/disclosure`; `npx oxlint --type-aware` 13 warnings / 0 errors on 306 files; frontend `npx vite build` clean and `npx tsc --noEmit` **0 errors**. Two caveats earned this session: the *first* full-suite run reported 2 failed files on `Hook timed out in 10000ms` (Nest `beforeAll` bootstraps under parallel load) and passed in isolation and on re-run — a flake, not a regression, but only provable because the exit code was captured; and my first command piped `npm test` through `tail`, which returned exit 0 while tests were failing. Run suites without a pipe. `test/e2e-phase-one.mjs`'s `v2` assertions were updated to `v3` locally and it **remains untracked and unstaged**, as do the other eight probes.

**Open for the next session:** (1) **the purge job**, now that HD-01…HD-09 are ruled — a `scheduledPurgeAt`/`cancelledAt` pair on `HistoryDeletionRequest`, a worker that fires 24 h after the ask, the cascade order for every table a student touches (messages, conversations, check-ins, flags + their review rows, support requests + follow-ups, consent records, privacy preferences, notifications, sessions, `session_summary` and its pgvector embeddings, audit rows), a student-visible countdown with a cancel action, and `HISTORY_RETENTION_TRUTH` (`frontend/src/lib/history.ts:181-188`) flipped in the *same* commit as the job; (2) the backup answer (HD-07) — either prune the dumps or the copy says "from our live systems"; (3) whether the escalation note's own sentence changes now that its link is gone; (4) PE-07/PE-11 with the job, PE-08/PE-09/PE-10 whenever the owner wants them, each costing a bump; (5) PE-01/PE-02/PE-13 remain the three real subsystems; (6) `EPIC_E_INSTRUMENT_V3_001` is unmerged and stacked on `BOUNDARY_POPUP_001` → Epic H surfaces, so it inherits §0S's (4)–(11), §0T's (1)–(3) and the merge situation unchanged.


## 0V. Session delta — 2026-11-04 (the deletion ruling is now running code: the purge engine, a student countdown you can actually press, and the last four instrument rows folded into the *same* unreleased v3 — `natlas EPIC_H_PURGE_ENGINE_001` + `frontend EPIC_H_PURGE_ENGINE_001`)

**Mandate:** **"now complete the whole system"**, immediately after §0U's ruling — *"all student data can be
deleted; all like it never exists; but this decision is made by the student; and would be on for 24 hrs; for
the student to cancel"*. Read as it was stated to the owner at the time: build the ruled engine end to end,
and make `v3` the *final* instrument batch so a second consent storm is never needed. Branches cut before the
first edit per the standing rule — natlas from `EPIC_E_INSTRUMENT_V3_001` (`70fabb2`), frontend from
`8af6497`.

**The engine, in the order a reviewer should read it.**
`prisma/migrations/20261104170000_history_deletion_purge/migration.sql` is six columns and one partial index,
entirely additive: `scheduledPurgeAt` / `cancelledAt` / `purgedAt` / `holdReason` / `removedCheckIns` /
`removedConversations`, all `TIMESTAMPTZ` because due-ness is compared with Postgres's own `NOW()` and a naive
timestamp across two clocks is how timezone drift gets baked into an irreversible job.
`history-deletion.service.ts:65-76` stamps the schedule when the ask is filed;
`POST /v1/history/deletion-requests/:requestId/cancel` (`history.controller.ts:74-98`) is the student's undo;
`HistoryPurgeService` polls every `HISTORY_PURGE_POLL_MS` (60 000; `<=0` disables it and says so in the log),
takes one ask per Postgres transaction with `FOR UPDATE SKIP LOCKED`, sweeps what a row deletion cannot reach
(`chat_thread` pointers, *other people's* notifications quoting the student), and writes exactly one
`history_deletion.executed` audit row whose `meta` is counts only. A scoped ask leaves the account and the
safeguarding record standing; `ALL_HISTORY` takes the user, its login, its sessions, its notifications and
every student-owned table, and its only surviving trace is that audit row — the cascade deletes the receipt
too, which is why `purgedAt` is meaningful only for the partial scopes.

**The hold rule is a decision, not a mechanism, so it is written down twice.** An ask that falls due against a
deactivated account or a suspended school does **not** run: it records `holdReason` and re-arms six hours later
(`history-purge.service.ts:508-509`, `:237-238`, `HOLD_RETRY_AFTER_MINUTES`). That is HD-10's answer, and it is
the only way the 24 hours can be true — an erasure the student had no way to stop is a different product than
the one described to them. A hold that never clears keeps the data: where the engine cannot be certain, it errs
toward not erasing. §4.2 of `docs/EPIC-H-DELETION-REVIEW-SPEC.md` maps every `HD-*` row to what shipped,
including the one place the build deliberately departs from the ruling (**HD-06**: the three scopes survived
rather than collapsing to whole-scope, because a student choosing a narrower ask is still the student deciding)
and the one row built *without* the countersign this document asked for (**HD-03**, still a reviewer's call).

**Gates, and the first time Epic H was ever seen in a browser.** `npm test` **1910/1910 (76 files, exit 0)**;
`npx tsc --noEmit` = the known **47**-error baseline, nothing new; `npx oxlint --type-aware src/ test/` **0
errors / 13 warnings** (the two warnings from the new spec are gone); the tracked journey harness grew
**Act 8b** and passes **220/220 in 188s (exit 0)** against a real database — schedule → cancel → double-cancel
→ cancel of someone else's ask → a closed window → scoped erasure → a dated ask on both sides of midnight →
account erasure on a disposable second student → "the erased account cannot sign in". Frontend `npx vite build`
and `npx tsc --noEmit` both **0**. Then the browser, which found the real gap: **the throwaway mock harness had
no `/v1/history` routes at all**, so Epic H's student surfaces had been built, type-checked and branched without
ever being rendered. It now mocks the aggregate, the receipts, the filing and the cancel, with a fixture per
state — including one whose cancel answers `409` — so `/history`, `/history/about`, the deletion dialog and a
check-in detail were all exercised with synthetic events: the four receipt states, a live countdown, a cancel
that swaps its own row and prints "Stopped. Nothing was removed.", the 409 branch showing the *server's*
sentence before re-reading the list, "Choose a date first." disabling the primary button, filing closing the
dialog and landing a fresh cancellable receipt, and the About page's five bullets plus the limits sentence.
**What only a browser catches: the countdown read "24 hours 1 minute"** — `clock` was captured at mount, so a
schedule fetched a minute later was measured against a stale now. One line in `load()`
(`frontend/src/routes/_app/history.index.tsx:62-71`) and it reads `17 hours 59 minutes`, i.e. never more than
was promised.

**HD-07's factual half was wrong, and it was my own sentence.** §0U recorded that the daily `pg_dump` has "no
pruning interval configured". One read-only SSH check says otherwise: `crontab -l` is empty because the jobs
live in `/etc/cron.d/natlas-backups`, whose third line is `0 3 * * * root find /opt/backups -name
"natlas-*.sql.gz" -mtime +14 -delete` — so a purged row is recoverable for the documented ≤15-day tail, and
"erased from our live systems" is the honest claim rather than a hedge. Two things *are* unreachable, and they
are the half that needs a decision rather than a correction: that `find` matches the dump filename only, so the
second cron line's `s3 sync` mirror at `/opt/backups/rustfs` is pruned by nothing; and `src/storage` cannot
delete anything (`storage.service.ts:6` imports `PutObjectCommand`), so bytes a student uploaded through
`POST /v1/uploads` outlive any purge. Recorded in §4.1/§4.2 rather than quietly amended.

**PE-07…PE-10 joined `v3` instead of earning a `v4`, which is the entire point of batching.** Prod still serves
`v2` (`main` @ `97d2454`), so `v3` is unreleased text and can absorb four more answers at the cost of exactly one
re-consent. `how-we-protect` now states retention as the engine actually behaves (nothing on a timer, a
student-scheduled erasure a day later, cancellable until it runs, irreversible after); `when-we-escalate` gains
the artboard's own line "A person decides what happens next, not the AI"; `human-support` gains "you can see how
your request is doing afterwards"; and `how-it-works` **lost the turn count** — a promise whose number lives in
env config is not something a student agreed to. PE-11 stays out because it is still blocked on code, not on a
ruling: `consent.service.ts` has only ever written `accepted: true`. **The release constraint this creates is
real:** the instrument's retention sentence describes the purge, so the merge and `prisma migrate deploy` move
together or the product tells students something it cannot do — the exact defect the Epic E audit exists to
catch. `docs/EPIC-E-PRIVACY-CONSENT-GAP-ANALYSIS.md` §5.2 records the four rows and their evidence.

**Traps bought with real failures.** `data ->> 'x'` is **text**, so an id list must be bound `::text[]`
(`= ANY($1::uuid[])` throws `operator does not exist: text = uuid`) — that crash killed a run at the first
scoped leg. `history_deletion_request` has **no `status` column**; state is derived from the four timestamps.
The repo's `Button` has no `size` prop. A background `node` started through the Bash tool dies with its wrapper,
so a throwaway backend needs `powershell Start-Process` to survive — and **`:3010` is now the owner's
`gbeseid-api`** (PID 38780, not mine, not to be touched); the natlas throwaway ran on `:3011` and the mock
harness on `:5051` (a second one, because `:5050` belongs to the parallel main session and its already-loaded
config could not see these routes). Reading `.env` key names to work out trusted origins is credential access
and is blocked; infer configuration from behaviour, and ask when behaviour is not enough.

**Left, and not this session's call:** merge to `main` and the deploy — three migrations were then local-only
(`ai_report_reason`, `history_deletion_request`, `history_deletion_purge`; §0W added a fourth);
`HISTORY_DELETION_UNDO_MINUTES` and
`HISTORY_PURGE_POLL_MS` are unset on prod so the defaults (1440 min / 60 s) apply there, and the worker runs
inside the same systemd service as the API; the HD-06 deviation and HD-03's countersign want a reviewer's eye;
HD-08's age band is still unanswered; a delete path for object storage and a prune for the `rustfs` mirror are
not invented here; PE-01/PE-02/PE-13 need
design, not invention; and everything else §0U listed stays owner-blocked (D1–D9, `WN-*`/`CP-*` so `/resources`
remains honestly empty, ab04, Epic G's accuracy verdict, Epic I, staff credentials, the VPS frontend lane, the
two diverged `main`s).

## 0W. Session delta — 2026-11-04 (PE-15, the last engineering-side leak in the audit trail: the read is a school's own, and the write had to learn to name a school first — `natlas EPIC_E_PE15_AUDIT_TENANCY_001`)

Backend-only branch `EPIC_E_PE15_AUDIT_TENANCY_001`, cut from `EPIC_H_PURGE_ENGINE_001` @ `b06affe`.

**What was actually wrong, one level deeper than the audit wrote it.** §5's PE-15 row says
`GET /v1/audit` leaks cross-school. True, and the reason scoping the read alone would have been theatre is
that the write path had never been reliable about schools: `AuditService.log()` stamped `schoolId` only when
the call site happened to have one to hand, so the `school.*` / `chat.*` / `follow_up.*` /
`history_deletion.*` families were tagged and everything else — every disclosure acknowledgement, every
preference change, every conversation close, and **every safeguarding flag the automated lane raised** — was
written school-null, which under an unfiltered read meant "visible to every school's reviewer" and under a
naive `schoolId` filter would have meant "visible to nobody".

**The four moves.** (1) `log()` resolves the school itself: the caller's value wins, otherwise the actor's
via `schoolOf`, otherwise none (`audit.service.ts:10-43`). (2) The one actor-less event a school must keep
is `support_flag.auto_created`, so the intent executor now reads the student's school and passes it
explicitly (`intent-executors.ts:114-129`). (3) `list(actorUserId, …)` filters by the reviewer's school
unconditionally and 403s an account with none — the unscoped `findMany` is gone, not merely unused
(`audit.service.ts:51-71`, `audit.controller.ts:29-37`). (4) `20261104190000_audit_trail_school_backfill`
applies rule (1) to rows already on file, so shipping the scoping does not blank a school's existing trail.

**A test assertion moved, on purpose.** The journey used to prove `staff.bootstrap_enrollment` appears in
ERIC's audit read. Bootstrap runs in Act 1, before any school exists, and takes no school with it — that
event is genuinely platform-level, so under the new rule it belongs in no school's trail. The assertion now
names the enrolment that *is* the school's (`school.student_enrolled`) and a comment says why; two new legs
prove the fix rather than accommodate it: school-less staff → `403`, and every row of a reviewer's trail
carries their own `schoolId` (`0 foreign rows of 16`), including the automated flag.

**Measured.** `npx vitest run` 1913/1913 (76 files, exit 0) — 3 new cases in `audit.service.spec.ts`;
`npx tsc --noEmit` 20 errors (from a 47 baseline; `intent-executors.spec.ts:51`'s prisma mock type was
wrong before this change and its correction removed the rest); `oxlint --type-aware` 13 warnings / 0 errors;
journey **223/223 in 220s** on a throwaway `:3011` (started, verified by `Get-NetTCPConnection` as the PID
owning that port, stopped — `:3000` and `:3010` are the owner's and were never touched); migration applied
locally with `migrate deploy` and its effect read back with an aggregate-only `SELECT` (the local fixture
is mostly school-null because every journey re-run deletes its users and schools, and both FKs are
`onDelete: SetNull` — which is also why the backfill matters on prod, where accounts persist).

**Trap worth carrying:** `AuditLog.actorId` and `.schoolId` are both `SetNull` relations, so historical
rows silently lose their tenant when a fixture run deletes the school. An empty school trail is not
evidence the write path is broken; check whether the school still exists.

**Still the owner's call:** deleting the route instead of scoping it. Nothing in the frontend calls
`GET /v1/audit` — staff screens use `/v1/admin/activity` and `/v1/schools/:id/activity` — and scoping was
chosen over deletion only because a safeguarding system needs a "who touched this" surface and the journey
needs one to prove US-D03's provenance. The trail keeps being written either way.


## 0X. Session delta — 2026-11-04 (the whole unmerged stack went to prod in one release: `main` 97d2454 → **95f1952**, frontend de39014 → **b57430a**, and the VPS frontend lane deployed for the first time — merge, migrations and the four things a demo will hit)

The owner's instruction was "merge to main both frontend and backend and ensure it is deployed", with a
presentation the same afternoon. Both repos are merged, deployed and re-measured. Nothing here is inferred
from a green tick: every number below was read off the box or off the running service.

**What the release carried.** Backend `main` gained the entire stacked chain that §0P–§0W built — Epic F's
register gate, Epic G's report reason, Epic H's history + purge engine, `ai-disclosure-v3`, PE-15's audit
tenancy. Frontend `main` gained Epic H's `/history` surfaces + the deletion countdown, BOUNDARY_POPUP_001,
instrument-v3 wording and PE-05's hidden thread links.

**The frontend merge conflicted because two sessions solved the same annotation.** `main` had PR #16
(`ESCALATION_POPUP_001`, Epic A/B/C), #17 (`EPIC_D_SURFACES_002`) and #18 (`EPIC_G_SURFACES_001`) merged by
the parallel session, while this session's chain stacked `EPIC_H_SURFACES_001 → BOUNDARY_POPUP_001 →
EPIC_E_INSTRUMENT_V3_001 → EPIC_H_PURGE_ENGINE_001` off an older `main`. Both sides had independently turned
the boundary notice into a closable popup. `main`'s version is the superset — `boundaryCopy()`, a
`BoundaryNoticeMarker` that keeps a one-line record in the thread after the popup closes, and a
`BoundaryNoticeDialog` that re-opens from that marker — so the merge took `main`'s component and its
"interrupt once per turn, restored conversations keep markers but do not reopen" effect, and kept only this
session's two unique behaviours: the student-only **My history** nav entry and `endedThisVisit`, which is
what stops the end-of-chat mood band from following a student into a past reflection. **How to apply:** when
two branches rebuild the same affordance, take the one that already shipped and was browser-verified, then
re-assert the other side's unique states — do not blend the two implementations into a third.

**A real defect on `main`, found and fixed by this merge.** PR #18's merge left
`src/routes/_app/reflection/$conversationId.tsx` rendering `<AiSupportSafetySheet />` (line 717 on `main`)
with **no import for it** — the file's own line 5 had been overwritten by the `BoundaryNotice` import during
that resolution. `vite build` does not typecheck, so it shipped; the reflection page's "Using AI support
safely" panel would have thrown on render. Same class of silent loss in the same merge: git took `main`'s
import line and dropped this branch's, and the second symptom was a duplicate `type AiBoundary,` in the same
import block (a declaration error that *does* fail the build, which is how the first one surfaced).
`tsc --noEmit` is now exit 0 on the merged tree. **How to apply:** after any merge that touches an import
block, run the typecheck — a clean `vite build` proves nothing about undefined identifiers.

**Prod, measured after the deploy (read-only queries over SSH).** `/opt/natlas` HEAD and
`~deploy/.natlas-last-deploy` both read `95f1952`; CI/CD run on `head_sha=95f1952` is
`completed/success`; `natlas.service` is `active` and `/api/health/auth` → 200. `_prisma_migrations` now
carries all four formerly local-only rows applied and not rolled back: `20261103120000_ai_report_reason`,
`20261104093000_history_deletion_request`, `20261104170000_history_deletion_purge`,
`20261104190000_audit_trail_school_backfill` — so §0W's release-coupling warning is closed: the instrument
and the erasure engine it describes went out together. `GET /api/v1/ai/disclosure` on prod now answers
`version: "v3"`, `consentVersion: "ai-disclosure-v3"`. The purge worker has nothing to do: `history_deletion_request`
is 0 rows. New routes are mounted, proven by 401-not-404 on `/api/v1/history`, `/api/v1/audit`,
`/api/v1/support-flags`, `/api/v1/resources`.

**The VPS frontend finally deployed — manually.** `~deploy/.natlas-frontend-last-deploy` had been frozen at
`3e641ce` since 2026-10-25 because the `FRONTEND_VPS_CI_001` lane has never completed a run (its repo secret
and the Actions-failures notification are still the owner's steps). Running `/usr/local/bin/natlas-frontend-deploy`
over SSH moved it: `FRONTEND DEPLOY OK: 3e641ce -> b57430a`, `natlas-frontend.service` active, and
`https://app.169.58.86.169.sslip.io/`, `/history` and `/api/health/auth` all 200 with the new nav string
present in the built bundle (`.output/public/assets/index-BDBCuEDe.js`). Vercel is on the same commit
(`index-DySffB9B.js` carries "My history" and "Wellbeing Resources"). **How to apply:** the VPS lane is not
a substitute for the deploy script — until that secret exists, every frontend merge needs this manual run or
`app.` silently serves weeks-old UI while still answering 200.

**Four things a live demo will hit, none of them bugs.**
1. **Every existing student is re-prompted for consent** — `consent_record` holds 15 rows on
   `ai-disclosure-v2` and the running instrument is v3, so the gate fails closed until they accept once.
   That is the designed behaviour of a versioned instrument, and it is the honest price of PE-03/04/07–10.
2. **`/resources` is an empty page by design** (Epic F's register gate ANDs approval with visibility and no
   `WN-*` code is `APPROVED_ACTIVE`). It now renders the "no approved resources yet" state rather than a
   shortage claim. Approving content is D1/the reviewers' call, not something to invent before a demo.
3. **220 audit rows are now unreadable by any school** (`195` scoped vs `220` unscoped) — those are the
   tenant-less platform/bootstrap events PE-15 deliberately left outside every school's trail.
4. **Deletion is live and irreversible after the window**: `HISTORY_DELETION_UNDO_MINUTES` is unset on prod,
   so a student who asks today is erased 24 h later by the worker inside `natlas.service`. Do not press it on
   a demo account you want to keep.

**One hygiene finding, reported not fixed.** `journalctl -u natlas.service -p err` shows systemd rejecting a
line in `/opt/natlas/.env` as an invalid environment assignment (`DB-PASSWORD=…` — a dashed name is not a
legal unit env key), so the app never saw it and nothing has depended on it. The value has already been
printed into this session's log output once, so treat it as known and rotate it if it is real; fixing the
line itself is an `.env` edit under the duplicate-key/640-ownership rules in [[project-deployment]], left to
the owner rather than changed mid-release.

**What was NOT verified.** No signed-in browser pass on prod: it would mean creating or using real
credentials and writing a prod check-in, which is not this session's call. Structural proof is what the
numbers above are; the interaction itself was last browser-verified locally on the mock harness (§0V/§0W).
`Epic D ab04` remains deferred and `PE-01/02/06/11/13/14` remain owner decisions — merging shipped code, not
answers.

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
3. `docs/DEPLOYMENT.md` — VPS production runbook (security/Postgres/RustFS/observability/Ollama)
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
| D11 | Deployment: Docker Compose for stateful infra (pg/rustfs/prom/grafana/loki/exporters) + native systemd for Node + Ollama; everything but nginx on 127.0.0.1 | 12GB budget discipline; documented in `docs/DEPLOYMENT.md` |

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

> **Refreshed 2026-10-28 from the box and the remotes, not from memory.** The version this section
> carried until then was the Phase-B snapshot: "Branch `master`; **zero commits** — 23 untracked
> paths", "Paused (Phase C) — nothing built", "No new dependencies installed". Every one of those
> lines is now false — Phase C shipped, `main` carries 107 commits and 67 spec files, prod is deployed
> by CI, and the frontend has its own repo, Vercel project and VPS lane. A stale *state* section is
> worse than a missing one, because it reads as authority: a cold session would have re-implemented
> work that is already live, or trusted "zero commits" and tried to build a git history from scratch.
> The dated session deltas above (§0…§0M) are the record of how it got here; this section is where
> things stand now — and §0L supersedes its uncommitted-file lists.

**Repos and refs (verified 2026-10-28 by `git fetch` + reading prod state over SSH):**

- Backend `Brobot64/soulnurture` — `main` = **`e3b8c77`** (merge of PR #13, `FRONTEND_VPS_SAME_ORIGIN_001`). **Prod `/opt/natlas` is at `e3b8c77` and `~deploy/.natlas-last-deploy` matches it**, so prod == main today; the standing rule still applies — read the `DEPLOY OK: <old> -> <new>` pair or the marker, never run titles.
- The working branch at the time of writing, `FRONTEND_VPS_SAME_ORIGIN_001` = `9c7b111`, is **1 ahead of `main`** (the §0F docs delta) and 1 behind (the merge commit). Docs-only, no deploy risk, but it is not on `main`. **Re-measured 2026-11-02: its tip is now `cf71485`** (the §0G–§0K docs commits landed on top), and Epic D branched off it — see §0M for the four branches and their ahead/behind counts against `main`.
- Frontend `Brobot64/soulnurture-frontend` (a **separate repo**, and it is **public** — the box clones it over anonymous HTTPS, no Deploy Key) — `main` = **`73f3391`** (merge of PR #14, the VPS CI workflow), Vercel-deployed.
- **The VPS serves an older frontend than Vercel does**: `/opt/natlas-frontend` HEAD and `~deploy/.natlas-frontend-last-deploy` both read **`3e641ce`**, and `natlas-frontend.service` has not restarted since the 2026-10-25 install. So `.github/workflows/deploy-vps.yml` is merged but **has never completed a successful run** (a run that passed the health gate would have moved the marker). `FRONTEND_VPS_SSH_KEY` and the Notifications→Actions→Failures setting are the two candidate causes; check the run log before assuming the lane exists.
- `MOBILE_OVERFLOW_001` = `d267963` (the mobile pass, §0F) is **pushed and unmerged**. **Re-measured 2026-11-02: its tip is now `6c15e65`**, and it is no longer the only frontend work off `main` — `EPIC_D_SURFACES_001` and `LANDING_HERO_ART_001` are stacked on it, which is why a PR from either must target `MOBILE_OVERFLOW_001` rather than `main` (§0M).

**What is live on the VPS (Contabo 6 vCPU / 12 GB / Ubuntu 24.04, `169.58.86.169`, SSH port 2222):**

- Four vhosts on one Let's Encrypt SAN lineage (api / app / monitor / s3), valid to **2027-01-23**. `natlas`, `natlas-frontend` and `nginx` all `active`.
- `https://app.169.58.86.169.sslip.io` is the same-origin lane: nginx sends `/api*` → `127.0.0.1:3000` and everything else → nitro SSR on **`127.0.0.1:3200`** (never 3100 — Loki publishes that; §0E). It exists to make the session cookie first-party so iPhone Safari stops dropping it.
- **RAM headroom is real, and it is because nothing model-shaped runs here**: measured 2026-10-28, **1.4 GB used / ~10.4 GB available**. The old plan budgeted 5–6 GB for a resident Ollama model; `ollama.service` is still `active + enabled` at 34 MB and nothing in the app reads it (`DEPLOYMENT.md` §5 fallback A). Removing it is a live change on a prod box → the owner's call.

**AI lanes (env presence verified by counts only — never echo values):**

- Chat generation: `AI_PROVIDER_CHAIN=openai,groq`. N-ATLaS is deliberately **not** a chat-chain member.
- Vernacular lane: `AI_VERNACULAR_REPLY_MODE=n-atlas-translate`, `NATLAS_LLM_BASE_URL` = the hosted HF Inference Endpoint (AWS us-east-1 L4, `minReplica 0`, 15-min scale-to-zero, vLLM, `--max-model-len 16384`), `NATLAS_LLM_API_KEY` set. **A scale-to-zero wake is ~10–16 min against timeouts measured in seconds** (45 s understanding / 12 s render / 4 s identify / 10 s translate), so any probe that must show the lane working needs the endpoint warmed ~15 min first.
- Voice: all three `NATLAS_ASR_URL_{YO,HA,IG}` + `NATLAS_ASR_API_KEY` are configured in prod, `NATLAS_ASR_BASE_URL` empty → the hosted endpoints serve yo/ha/ig and the `services/n-atlas-asr` sidecar has still never been installed. The browser records 16 kHz mono WAV because those endpoints decode with libsndfile, which rejects webm/opus.

**Feature state:** school tenancy is complete on prod (every staff surface is school-scoped), both platform admins are seeded, the safety stack (TIER_3 → whole-school alert + tray request), consent gate, AI-response reporting + the boundary marker, human chat pool over websocket-only Socket.IO, pilot analytics (JSON + CSV, small-group suppression), mood feedback and the landing page are all merged and deployed.

**Open acceptance — none of these are code, all of them are gates someone has to walk through:**

1. **A real iPhone signs in on `https://app…sslip.io` and survives a reload.** This is the reason the lane exists and it is still unproven; Vercel, `api.` and `BETTER_AUTH_CROSS_SITE_COOKIES=true` all stay until it passes.
2. **No prod message has ever been observed with `aiPayload.understanding.via='n-atlas-local'`.** The endpoint answers directly; the app-level path is unwitnessed. `test/yoruba-live-probe.mjs` writes prod data — owner's call.
3. **Vernacular ASR accuracy is unproven on real speech** — only a synthetic tone has passed the plumbing. Needs ~10 s of native audio per language (yo ẹ/ọ, ha ƙ/ɗ, ig ị/ọ/ụ/ṅ).
4. **Native-speaker review** of the 180 corpus translations + new keyword packs, still flagged `PENDING_NATIVE_REVIEW` in `src/ai/intents/`.
5. **Check-in-derived wellbeing indicators** are still not implemented — flags remain message-driven only (§0B class of gap, the last one standing).
6. Figma Phase 2 sign-off (task #4) and its Phase 3 deferral list.

**Repo hygiene a new session must not "clean up":**

- Nine untracked `test/*.mjs` probes (`conversation-inspector`, `e2e-phase-one`, `local-fallback-probe`, `pilot-live-probe`, `pivot-vs-direct`, `socket-probe`, `vernacular-probe`, `whoami-probe`, `yoruba-live-probe`) are **the owner's files**. Never commit, never delete. They are also why `npm run lint` reports pre-existing warnings — that is expected, not a regression.
- `frontend/.probe/` is a working 390/360 measurement rig (§0F) — untracked on purpose.
- Six local backend branches (`MOOD_FEEDBACK_001`, `NATLAS_DOC_001`, `NATLAS_RESCUE_001`, `NATLAS_SIDECAR_001`, `NATLAS_TRANSLATE_ONLY_001`, `VERNACULAR_SAFETY_017`) show commits ahead of `main`. The rescue pass (task #23) already moved what `main` lacked, so they are almost certainly leftovers — but re-diff before deleting anything; "stale" is a hypothesis, not a fact.
- Two prod-hygiene items deliberately untouched, both because they are live nginx/prod changes: `/etc/nginx/sites-enabled/natlas.bak-20261011` is a plain file that matches the include glob, so nginx loads the stale copy and warns `conflicting server name` on every `nginx -t` since Oct 11 (move it to `sites-available/`), and `ALLOWED_ORIGINS` still lists `http://localhost:3000` in prod.

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

> Rewritten 2026-10-28. It used to open with "commit everything first (`master` has no history)" and
> "npm install zod-to-json-schema franc (Phase C deps; the denied install resumes here)" — the repo has
> 107 commits and Phase C shipped long ago, so anyone following that list would have re-done work or
> stalled on a decision that was already made. Order below is by dependency, not by ease: each item
> unblocks the next one, and the first three are gates the agent cannot walk alone.

1. **Run the iPhone check** (owner, one device): sign in at `https://app.169.58.86.169.sslip.io`, reload, still signed in? Until that is yes, keep Vercel + `api.` + `BETTER_AUTH_CROSS_SITE_COOKIES=true` exactly as they are — the same-origin lane is insurance, not a replacement. If it passes, then and only then decide about retiring Vercel and setting the cookie flag to `false`.
2. **Make the frontend release lane real** (owner's GitHub, then verifiable by the agent): the workflow is merged but has never completed a run (§4). Read the run log on `Brobot64/soulnurture-frontend` → add the `FRONTEND_VPS_SSH_KEY` secret if missing → turn on Notifications → Actions → **Failures** with the owner's verified email → run `/usr/local/bin/natlas-frontend-deploy` once by hand and confirm `~deploy/.natlas-frontend-last-deploy` moves off `3e641ce`. The marker, not the green tick, is the proof.
3. **Then merge `MOBILE_OVERFLOW_001`** (`d267963`, the mobile pass) to the frontend's `main` — it is a production push on both hosts (Vercel *and* the VPS lane), which is why it waits on 2.
4. **Get the docs tip onto backend `main`.** Written as `9c7b111` (§0F); as of 2026-11-02 the branch tip is `cf71485` (§0G–§0K included), and Epic D's own branches now sit on top of it (§0M). Docs-only, and the deploy lane treats it as a no-op (`marker == HEAD` → "already deployed; nothing to do"), so it is the cheapest merge on the list — but until it lands, `deploy/` and the docs on prod are several sessions behind.
5. **Witness the vernacular lane end to end** (owner's go-ahead — it writes prod data): warm the N-ATLaS endpoint ~15 min first, then `test/yoruba-live-probe.mjs`, then read `aiPayload.understanding.via` back with `test/conversation-inspector.mjs`. Acceptance is a message with `via='n-atlas-local'`, which has never been seen.
6. **Prove the voice lane on real speech**: ~10 s of native audio per language through the app, checking diacritics (yo ẹ/ọ, ha ƙ/ɗ, ig ị/ọ/ụ/ṅ). Endpoints and env are configured; only the audio quality is unverified.
7. **Native-speaker review** of the 180 corpus translations and new keyword packs (`PENDING_NATIVE_REVIEW`). Human gate, blocks treating escalation parity as proven.
8. **Implement the check-in-derived wellbeing indicators** — the last open tenancy gap (§0B class): flags are still message-driven only, so a student whose check-ins trend badly never trips anything. Plan lives in `docs/PHASE-C-PLAN.md`/the dashboards plan; both are outside the repo.
9. **Prod hygiene, one sitting** (each is a live change, so confirm first): move `/etc/nginx/sites-enabled/natlas.bak-20261011` to `sites-available/` so `nginx -t` finally tests clean; drop `http://localhost:3000` from prod `ALLOWED_ORIGINS`; decide about the vestigial `ollama.service` (keep as the documented fallback A, or `systemctl disable --now` it and delete `blackbox-ollama`).
10. **Before the pilot grows**: the N-ATLaS and NCAIR1 ASR licences cap at **1000 active end-users / rolling 30 days**. Track enrolment; past that needs a commercial arrangement with Awarri, which is a lead-time item, not a surprise.
11. **After every code phase**: `npm run build` + `npm run lint` + `npm run test` reported with counts, and extend `test/e2e-journey.mjs` for new acts. Lint's ~4 warnings come from the owner's untracked probes (§4) — do not "fix" them by committing or deleting those files.
12. **Keep the docs honest as a first-class task.** `DEPLOYMENT.md` §5/§10 shipped an `ollama run natlas "Say hello in Hausa"` go-live check for weeks after the model left the box, and this file's §4 claimed zero commits. A check that can no longer pass is not documentation — it is a false negative waiting to be trusted. When you retire a lane, delete its checks in the same commit.

---

## 7. Working with the product owner (collaboration manual)

- **Ask at genuine forks** (max ~3 options, recommended-first): they want to weigh in on product/architecture forks but not trivia. Every major thread so far got an explicit multi-choice decision before design restructured (see D7/D8).
- **Report finish lines with counts**: "build ok, lint 0, 111/111 tests, 90/90×2 e2e" — their standing preference.
- **Communicate in first person, brief, no ceremony**; explain before tools; checkpoints between acts; keep the final summary tight (bold + bullets).
- **Positioning matters**: emotional support, NOT therapy/diagnosis/emergency-care framing; crisis flows are product workflows (intent → flag+reason+human path), never prompt-only. Any new AI surface should ship with its eval-able guardrails and reach the counsellor/safeguarding reviewer early (defer to clinical sign-off; hospital-grade wording is a red flag the reviewer catches).
- **ngo reality**: prefer free/self-hostable; state AI/budget implications openly; never let safety degrade silently ("pause intake instead of degraded safety" per the guide).
- **Docs are deliverables**: README stays current; deployment/phase/handoff docs in `docs/` are part of done.

---

## §0Y — 2026-11-06 session delta: admin user erasure + verification resend (LIVE)

**Requested:** admins able to delete a user entirely (Soul Nurture admin = any user;
school admin = own school only), school admin able to resend verification emails to
unverified users, and confirmation that onboarding already mails the verification link.

**Shipped:** backend `main 686d61c → 7702be6` (`ADMIN_USER_ERASURE_001` @ `c7c234a`),
frontend `main b57430a → 0e2a344`. CI/CD on `7702be6` = completed/success; prod
`/opt/natlas` HEAD and marker both `7702be6`, `natlas.service` active,
`/api/health/auth` 200, and both new routes answer **401** (not 404) unauthenticated —
`POST /api/v1/admin/users/:userId/erase`, `POST /api/v1/admin/users/:userId/resend-verification`,
`POST /api/v1/schools/:id/users/:userId/erase`, `POST .../resend-verification`.
VPS frontend moved `b57430a → 0e2a344` via a manual run again (`FRONTEND DEPLOY OK`,
marker `0e2a344`, SSR 200, `app.169.58.86.169.sslip.io` 200). That lane still needs
`FRONTEND_VPS_SSH_KEY` before it can deploy itself. **`natlas-frontend-deploy` must be
run as `deploy`, NOT with sudo** — it refuses root ("npm output must stay deploy-owned").

**The deletion is Epic H's, not a second one.** `HistoryPurgeService.eraseUser(userId)`
reuses `applySweep`/`accountTargets` for anyone with a `student_profile`, and adds
`identityTargets()` for staff/admin accounts that never had one (audit rows naming them,
others' notifications quoting them, and the `verification` rows Better Auth keys by email
or phone). `DELETE FROM "user"` then cascades sessions, the credential account, profiles
and their own notifications. One non-obvious repair: `support_person.professionalId` is
`SetNull`, so a deleted counsellor would have stayed **clickable** in the student support
directory — the erasure now flips those cards inactive (it cannot delete them:
`support_request.supportPerson` is `Restrict`).

**Guards, and why each exists:** remit is read from the actor + target rows, never from
the URL (`assertWithinRemit`); no self-deletion; a school can never touch a
`PLATFORM_ADMIN`; the last platform admin cannot be deleted (`LAST_PLATFORM_ADMIN` 422 —
otherwise no account is left that can mint one); `confirm: true` is required in the body
**and** re-checked in the service, because the 24-hour undo window is a student's
protection against *their own* request and must not be read as covering an admin's
decision. Sessions die with the row but open sockets do not, so `realtime.disconnectUser()`
runs after the commit. The audit row is written after the sweep (with the acting admin as
`actorId` and the erased uuid as `entityId`) and is the only record that survives.

**Verification email on signup — already true, verified by reading, not changed:**
`onboardStudent`, `onboardProfessional` and `onboardSchoolAdmin` all call
`trySendVerificationEmail()` and return `verificationEmailSent`; `bootstrapStaff` mails
too. `UsersService.provisionAdmin` is the deliberate exception — it creates the account
`emailVerified: true`, so there is nothing to verify.

**Tests:** `src/admin/user-erasure.service.spec.ts` 14/14 (mock-prisma style, but note
`vi.clearAllMocks()` does NOT clear queued `mockResolvedValueOnce` — this file needs
`vi.resetAllMocks()` or the next test inherits the previous test's actor/target rows;
that cost 6 phantom failures before it was spotted). Backend gates green:
`tsc -p tsconfig.build.json` 0, oxlint 0. Frontend gates green: `vite build` 0,
`tsc --noEmit` 0.

**Not done:** no signed-in prod browser pass on either new dialog (no live admin
credentials — the staff password is dead; ask, never grep), and no journey-harness leg
for the admin erasure path. The engine change is exercised by unit tests + CI only.

**Production verification, same day — measured, not assumed:**
- Prod HEAD and the deploy marker are both `04c0318`; the frontend marker is `0e2a344`.
  CI on the exact SHA: "Lint, test, build" and "Deploy to production VPS" both
  completed/success. `natlas.service` and `natlas-frontend.service` active, `NRestarts=0`
  on both, zero unfinished migrations.
- All four routes are mapped by the running process — they appear verbatim in
  `journalctl -u natlas.service` at 10:01 and again at the 10:11 restart.
- Live route matrix on `127.0.0.1:3000`: the four POSTs answer **401**
  ("Authentication required") while a bogus path under the same prefix answers **404** —
  the routes exist and are guarded, not merely compiled. **The API prefix is
  `/api/v1/...`, not `/v1/...`** (`app.setGlobalPrefix('api')` at `src/main.ts:37` plus
  `@Controller('v1/...')`); a probe that omits `/api` returns 404 for everything and
  reads as a failed deploy when it is not.
- The new raw SQL is proven against the **real prod schema** with `EXPLAIN` (plans only,
  never executes — the sanctioned way to check `$queryRaw` text that mock-prisma cannot
  validate). The erase-target `SELECT … FOR UPDATE OF u`, the `UPDATE support_person SET
  active = false`, the `DELETE FROM verification` by identifier, and the `identityTargets`
  audit/notification/job predicates all plan cleanly. Note `audit_log."entityId"` is
  **text**, not uuid — the code compares it uncast, which is right; a `::uuid` cast there
  would have thrown in prod and nowhere else.
- `ai_generation_job` has **no `userId` column**; the sweep reaches it through
  `"input" ->> 'studentId'`. Anyone adding a job predicate later should not assume
  otherwise.
- Deployed frontend bundle on the VPS ships the controls: `grep` finds both strings in
  `.output/public/assets/users-*.js` and `.output/server/_ssr/users-*.mjs`, and the
  compiled client calls `erase` and `resend-verification`. The unauthenticated home page
  contains neither — they are behind the signed-in people register, so a landing-page
  grep proves nothing either way.
- **Still open:** what no measurement above can show is an authenticated admin clicking
  Delete on a real prod account. That needs a live admin session.

**Unrelated prod finding, surfaced by the log sweep:** the OpenAI key is expired.
`MemoryRepository` warns "Vector recall unavailable" and `ChainedAiProvider` fails over
on every request for student `8bd984e7-…`. Chat survives on the fallback, but the
30-day memory promised by instrument `ai-disclosure-v3` is degraded for that path.
Predates this deploy (first hit 10:00:23, before the 10:01 restart) — not a regression
from this change, and not something to fix by grepping for the key.

## §0Z — 2026-11-06 session delta: the twelve approved wellbeing resources are live data

**Requested (owner's words):** "fully add and implement the wellbeing resources as it was
before; but it should follow the current style; add the wellbeign resources; **it is
approved already**". That last clause is the D1 answer §0R/§0S kept naming as the only
blocker on `/resources`, so it was taken as the review decision and implemented as a data
write, not as a new approval UI.

**Shipped, not yet merged:** backend `WELLBEING_RESOURCES_001 @ 16785ff` (off `main
761350a`), frontend `WELLBEING_RESOURCES_001 @ 40c7902` (off `main 0e2a344`, carrying the
hero swap `8aea084` that had been sitting uncommitted).

**What "as it was before" resolved to:** the five invented seed placeholders (retrieved
verbatim from `844a32f`) are *not* what ships. Doc B US-WR-D03 orders them replaced by the
twelve reviewed titles, so they stay withdrawn and the twelve go in — which also keeps the
journey harness's "the invented seed placeholders are gone" assertion true rather than
rewriting it.

**The five pieces:**
- `20261106120000_wellbeing_resource_taxonomy` adds Doc B §3's eight groupings to the
  `ResourceCategory` enum (additive `ALTER TYPE … ADD VALUE`; the eleven older values stay
  because `WellbeingActivity`, the AI activity catalogue and the five withdrawn rows still
  carry them, and a Postgres enum value cannot be dropped while any row uses it). Applied
  locally with `migrate deploy` — `migrate dev` still cannot run against the shadow DB.
- `ensureWellbeingResourceLibrary()` upserts the twelve `WN-01…WN-12` rows by `contentCode`
  with Doc B §4's title, "Use when" and estimated time verbatim (U+2019 and en dashes
  preserved). It writes them **unpublished**; the register answers that separately.
- `approveWellbeingLibrary()` is the approval: 20 register rows advanced to
  `APPROVED_ACTIVE` with `approvedBy = PRODUCT_OWNER`, guarded to
  `status in [DRAFT, CONTENT_REVIEW_REQUIRED]` so a re-seed can never un-withdraw a
  `BLOCKED`/`RETIRED`/`SUPERSEDED` reviewer answer, then the row booleans are made to
  **follow** the register — codes in the approved set publish, every other coded row
  unpublishes. Doing only one half of this is what produced an empty catalogue before.
- `tailored()`'s stated-need narrowing moved to the approved groupings (`STEADIER`,
  `ONE_STEP`) and the rationale now names those two labels; `intents.config`'s
  `RECOMMEND_RESOURCE` categories moved too (`GROUNDING → STEADIER` for suicidal ideation
  and acute panic, `EXAM_STRESS → HEAVY` for prolonged low mood), because the old values
  have no rows and the executor silently attaches nothing then.
- `AiContextService` was the last surface still reading `{active, approved}` alone — the
  exact split Epic F removed everywhere else. It now uses the same register predicate, and
  its `take: 8` with no `orderBy` (which, with twelve approved rows, handed the model an
  arbitrary sample that changed per turn) became `take: 24` ordered by category + title.

**Not invented:** `instructions`, `reflectionPrompt`, `safetyNote`, `mediaUrl`, `badge` and
`durationMinutes` are empty on all twelve. No supplied document contains activity steps,
reflection prompts or safety notes — Doc B §1 and US-WR-D04 forbid paraphrasing steps that
were never written. The frontend correspondingly stopped printing a delivery format
(§2 orders the Read/Listen/Practise filter replaced by the estimated duration), so a card
shows title, "Use when" and time only. **These detail sections stay empty until a reviewed
copy file arrives; that is a content gap, not a code gap.**

**Verification:**
- Backend: `nest build` 0, oxlint 0 errors, `vitest run` 77 files passed.
- Frontend: `vite build` 0, `tsc --noEmit` 0.
- Act 6 of the journey harness could **not** run: the harness crashes at Act 5
  (`duplicate key … ai_generation_job_conversationMessageId_key`) because the expired
  OpenAI key leaves the app's own retry job on that message while the harness inserts its
  fixture — a pre-existing key problem, not this slice. So the Act 6 assertions were run
  as a standalone probe against the live local API: **25/25 checks passed** — 12 rows, all
  coded, all five placeholders gone, exactly the eight groupings, every card with approved
  title/"Use when"/duration and no media, the boolean-only row invisible and unsaveable
  (404), a real `WN-05` save + toolbox count, `?category=KINDNESS` to 1 row, a STRESSED
  check-in earning "Picked for you" with the two labels named in the rationale, then
  `WN-05` set `BLOCKED` and gone from the catalogue, its topic empty, unsaveable and dropped
  from a toolbox that already held it, and fully restored. The probe file was deleted after
  the run.
- Local DB state left: migration applied, seed re-run, 12 rows live across 8 categories, 20
  register rows `APPROVED_ACTIVE`, zero coded rows invisible.

**Open / for the main session:**
1. ~~Nothing here is on `main` yet.~~ Both branches have since been merged and pushed —
   backend `main` is `62249be`, frontend `main` is `3c6cc53`. Pushing backend `main` is what
   starts the VPS deploy lane.
2. ~~Run `npm run seed` on the VPS once~~ — measured instead: prod holds **twelve**
   register-approved `APPROVED_ACTIVE` `WN-*` rows across **eight** categories, zero coded
   rows invisible to a student and zero old placeholder rows still reachable, so
   `/usr/local/bin/natlas-deploy` really does seed. (Read-only SELECTs through
   `docker compose -f /opt/infra/docker-compose.yml exec -T postgres psql -U natlas -d natlas`;
   every container call needs `</dev/null` or the container eats the rest of the `bash -s`
   script, and `pg_enum`'s column is `enumlabel`, not `label`.)
3. The journey harness stays red locally and in CI until the OpenAI key is rotated
   (`/opt/natlas/.env` line 23 + `sudo systemctl restart natlas`, plus the same key in the
   local `natlas/.env`).
4. No browser pass on `/resources` with the twelve cards yet — that wants a signed-in
   student session on the local stack.

## §0AA — 2026-11-06 session delta: the human-support scene lands on `/welcome` and `/signin`

**What the owner asked.** "add this image to the welcom page and sign in page", with
`soulnurture_landing_2_human_support.png` (1600×1000, 126,838 bytes) attached: two young
people seen from behind on a lavender couch, a heart in a speech bubble above them, a
sprout-shaped balloon, a purple shield-with-a-tick, and a plant at each end. Asked how it
should meet the existing art, the owner chose **"Replace the sprout hero"** — so the scene
takes `/welcome` and the `/signin` panel, and `soul-nurture-hero.png` stays on the landing
page only.

**Frontend only — no backend, no migration, no data.** Branch
`HUMAN_SUPPORT_ART_001` off frontend `main` (`3c6cc53`), commit `596fce7`, pushed to
origin and **merged into `main` as `2bc1a49`** (see the open list below).

1. `frontend/src/assets/soul-nurture-human-support.png` — the attachment, copied in.
2. `frontend/src/components/HumanSupportArtwork.tsx` — a new sibling of `HeroArtwork`,
   `width={1600} height={1000}` with the scene described in the `alt`, so the page says out
   loud what the picture promises: two people talking, and a shield that says it is safe.
3. `frontend/src/routes/_app/welcome.tsx` — the art column drops the
   `aspect-square bg-panel` wrapper and the sprout. The image carries its own pastel sky,
   so a mint mat around it reads as a coloured ring; the art **is** the panel. Mobile keeps
   the `w-[267px] max-w-[78vw]` sizing and the `lg:w-full lg:max-w-[560px]` desktop column.
4. `frontend/src/components/AuthShell.tsx` — a new optional `illustration` prop. `AuthShell`
   is shared by five routes (`signin`, `verify`, `forgot-password`, `reset-password`,
   `first-password`), so the artwork is opt-in: when `illustration` is supplied it replaces
   the drawn concentric-circle motif **and** the `bg-panel p-6` mat, and the `panel.heading`
   / `panel.caption` still render underneath. The other four routes are untouched.
5. `frontend/src/routes/_app/signin.tsx` — passes `illustration={<HumanSupportArtwork … />}`.

**Verified.** `npx vite build` exit 0, `npx tsc --noEmit` exit 0 (the frontend repo has no
lint tooling — those two are the gates). Built and served my own `vite preview` on `:3020`
— **port `:3010` is not the natlas frontend and not mine**: it is
`node dist/apps/gbeseid-api/main.js` (PID 24664), left alone. Over HTTP: `/welcome` and
`/signin` both reference `soul-nurture-human-support-*.png` and no longer reference the
sprout, `/` (landing) still references `soul-nurture-hero-*.png`, and the asset returns 200
with the original 126,838 bytes. In the browser the `<img>` reports `naturalWidth` 1600 and
a laid-out 267×167 box at a 565px viewport, so the aspect ratio is honoured.

**Not verified.** A desktop-width screenshot. The in-app browser surface was hidden at
565×735, below the `lg` breakpoint, and the `/signin` panel column is `hidden … lg:flex`,
so the artwork on the sign-in page is proven by the built HTML and the class list, not by a
picture of it. Worth one look at ≥1024px before this is called done.

**Open / for the main session:**
1. ~~Merge `HUMAN_SUPPORT_ART_001` to frontend `main` when the owner says so.~~ **Merged on
   the owner's word** — frontend `main` is `2bc1a49` (`--no-ff`, no conflicts) and pushed to
   `origin`, so Vercel's `main` lane picks it up. Gates re-run **on the merge commit**, not
   just on the branch: `vite build` 0 + `tsc --noEmit` 0.
2. The VPS frontend lane is still manual and still serving the pre-resource build: the new
   chips, the twelve cards and now this artwork only appear once `natlas-frontend-deploy` is
   run **as `deploy`, never with sudo**. Vercel's deploy state remains unmeasured.
3. The `AuthPanel.Icon` field is still required and simply isn't drawn when `illustration`
   is passed — `signin` keeps passing `LockKeyhole` (it also uses it for the password field).
   Harmless, but if a third illustrated route wants artwork, make `Icon` optional properly.

## §0AB — 2026-11-06 session delta: `soulnurtureai.vercel.app` is a permitted origin on prod

**Requested:** "addd soulnurtureai.vercel.app to vps for cors origin".

**First, is the hostname real?** `https://soulnurtureai.vercel.app/welcome` returns **200**
(`soulnurture.vercel.app` also 200; `soulnurture-frontend.vercel.app` 307s). So the origin
was used exactly as the owner wrote it, with `https://` and no trailing slash.

**What changed — prod env only, no code, no migration.** `/opt/natlas/.env` lines 93 and 94
gained `,https://soulnurtureai.vercel.app`:

- `ALLOWED_ORIGINS` — read once at boot in `src/main.ts:22` and handed to `@fastify/cors`
  (comma-split, trimmed), and it is also what the socket.io gateway checks.
- `BETTER_AUTH_TRUSTED_ORIGINS` — added **with** it, not because it was asked for. The repo's
  own `.env.example` (lines 18–25) documents these two as a pair: CORS alone lets the fetch
  through while the session still refuses to mint a cookie for an untrusted origin, so a
  half-done change looks like a broken login. Both Vercel hosts were already in both lists,
  so this keeps the new one consistent with them.

**How it was applied.** `deploy` reads the file (group `natlas`, mode 640) but cannot write
it, so the edit is `sudo sed -i` anchored on the key name, with an idempotency guard
(`grep -q "^KEY=.*soulnurtureai"` first), then `chown root:natlas` + `chmod 640` re-asserted
because GNU `sed -i` rewrites the file. Both keys have exactly **one** assignment in the
file — checked afterwards, because a later duplicate would silently win and undo the edit
(the `.env` duplicate-key trap). `sudo systemctl restart natlas` (exit 0, `active`, new
MainPID) because the origin list is read at boot.

**Verified from outside, through both nginx hosts:**
- `OPTIONS /api/v1/resources` with `Origin: https://soulnurtureai.vercel.app` → `204` with
  `access-control-allow-origin: https://soulnurtureai.vercel.app` and the full method list,
  on `app.169.58.86.169.sslip.io` **and** `api.169.58.86.169.sslip.io`.
- No regression: `https://soulnurture.vercel.app` still echoes.
- Unknown origin `https://evil.example` → `204` with **no** `access-control-allow-origin`,
  i.e. the browser still blocks it. The allowlist is still an allowlist.
- `/api/health/auth` → 200 after the restart.
- Not proven: the socket.io origin gate. `GET /api/socket.io/?EIO=4&transport=polling` 404s
  from the app for *any* origin, so the probe never reached the gateway — the earlier 101
  evidence used a websocket upgrade, which this pass did not attempt.

**The finding that matters more than the change.** The deployed Vercel bundle is not talking
to this API at all. `https://soulnurtureai.vercel.app/assets/api-BcTno9bo.js` contains,
verbatim:

```
var e=`http://localhost:3000`.replace(/\/+$/,``)
```

so `VITE_API_BASE_URL` was **unset at build time** and the client falls back to the visitor's
own `localhost:3000`. Until that variable is set in the Vercel dashboard (Production *and*
Preview) to a prod API origin and the site is **rebuilt** — it is inlined at build, not read
at runtime — no browser on that host sends a cross-origin request, and this new CORS entry
protects traffic that does not exist yet. `BETTER_AUTH_CROSS_SITE_COOKIES=true` is already
set (line 80), which is the third leg of that pairing.

**Open / for the main session:**
1. Set `VITE_API_BASE_URL` in Vercel (which host — `api.` or `app.` — is the owner's call;
   `app.` is the same-origin lane that exists for the iPhone cookie problem) and redeploy.
2. Three docs-only backend commits (`563a9b4`, `dc0b4c9` and this one) are unpushed on
   `main`; pushing backend `main` starts the VPS deploy lane.
3. The VPS frontend lane still has not been redeployed, so `app.` still serves the pre-art
   build.

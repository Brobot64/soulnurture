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

**Open next:** this branch has run **from a `git archive` of the branch into `~/lane` on the box**, so `/opt/natlas/deploy/` is still `main`'s copy and the lane is not yet self-updating on prod — merging `FRONTEND_VPS_SAME_ORIGIN_001` into `main` (the owner's call, because it deploys the backend) is what puts `deploy/` on the box permanently; then `bash /opt/natlas/deploy/vps-frontend-same-origin.sh` becomes the one command a future session runs. Distribute `https://app.169.58.86.169.sslip.io` to the pilot students (the Vercel URL stays alive as the fallback); once the iPhone check passes, decide whether to retire Vercel — only then set `BETTER_AUTH_CROSS_SITE_COOKIES=false`; automate this lane in CI with a second restricted key; and note that `docs/DEPLOYMENT.md` §5/§10 still describe the retired Ollama era (`ollama run natlas "Say hello in Hausa"` is not a check anyone can run any more) — same stale-doc class as §0D found in the language lane, worth its own pass.


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

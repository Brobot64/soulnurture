/**
 * NATLAS END-TO-END JOURNEY
 * --------------------------------------------------------------------------
 * One scripted run of the entire backend, every user type, in order:
 *
 *   0. Preflight (app + DB reachable)
 *   1. ERIC (psychologist) — secret-gated staff bootstrap sign-up, verify,
 *      sign-in, professional profile, name/phone change (Australian number)
 *   2. Provisioned staff (SUPPORT_STAFF) — POST /api/v1/users + sign-in
 *      (proves hashes fix) + dashboard access; admin seeds Dr. Eric Moore as
 *      a support person (no admin CRUD exists yet — documented gap)
 *   3. JUDE (student at Miva University, Nigeria) — the public door is
 *      closed (400 EMAIL_PASSWORD_SIGN_UP_DISABLED); a raw-SQL platform
 *      owner creates the school + provisions its admin (owner-only route),
 *      the admin is forced onto a personal password, onboards Jude with the
 *      school default password, and Jude verifies → default sign-in → forced
 *      change → profile, sanctuary, consent, privacy prefs, AI disclosure
 *   4. JUDE's journey — check-in → conversation → 3 AI messages; the third
 *      uses crisis wording so the intent engine must persist a TIER_3
 *      SERVER_POLICY flag + safety message + human-support pathway
 *   5. ASYNC AI — a queued AiGenerationJob is inserted by DB (simulating a
 *      first-generation outage); the worker must rewrite the placeholder
 *      message (COMPLETE) and an exhausted job must flip to FAILED; then JUDE
 *      reports an AI reply with a reason (Epic G)
 *   6. Resources / toolbox / journal / support request lifecycle
 *   7. ERIC's professional review — dashboard, flags ack/in-review, request
 *      review (status+note), follow-up create/complete, the reported reply's
 *      review decision, audit trail, AI config
 *   8. RBAC negatives (+401 anon, 403 student→staff routes)
 *   8b. EPIC H DELETION ENGINE — the 24-hour promise is a real schedule and a
 *      real cancel; the worker then carries out a scoped erasure (named
 *      check-ins, a dated cut-off at UTC midnight) and an account-wide one,
 *      against a second student it is allowed to erase, and proves what is left
 *      behind: one content-free audit row, nothing else
 *   9. Sign-out everywhere; sessions really revoked
 *
 * Every act prints ROUTE + PAYLOAD + key result fields. Non-zero exit on any
 * assertion failure. Safe to re-run: Act 0 cleans all test data.
 *
 * Usage:  npm run test:e2e:journey     (server must be running on :3000)
 */
import { Pool } from 'pg';
import { randomUUID } from 'node:crypto';
import { hashPassword } from 'better-auth/crypto';

const BASE = process.env.E2E_BASE_URL ?? 'http://localhost:3000';
const DB_URL =
  process.env.E2E_DATABASE_URL ??
  process.env.DATABASE_URL ??
  'postgresql://postgres:postgres@localhost:5432/natlas';
const ENROLLMENT_KEY =
  process.env.E2E_STAFF_BOOTSTRAP_KEY ?? 'natlas-boot-2026-local';
const ORIGIN = 'http://localhost:3000';
const SHORT_CODE_CHARSET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

const ERIC = {
  name: 'Eric Moore',
  email: 'ericmoore@johnhopkins.com',
  password: 'eriMore123#',
  phone: '+14425430012',
  newName: 'Eric Moore Andrew',
  newPhone: '+61411223344',
};
const NGOZI = {
  name: 'Ngozi Banks',
  email: 'ngozi.banks@johnhopkins.com',
  role: 'SUPPORT_STAFF',
  phone: '+2348011122233',
  password: 'StaffSafe123#',
};
const JUDE = {
  name: 'Jude Okonkwo',
  email: 'jude.okonkwo@miva.edu.ng',
  password: 'JudeSafe123#',
  phone: '+2348098765432',
};
// Onboarded only so the deletion engine has an account it is allowed to erase.
// Never Jude: wiping the account the browser pass logs into would take the
// owner's own fixture down with it.
const AMARA = {
  name: 'Amara Eze',
  email: 'amara.gone@miva.edu.ng',
  password: 'AmaraSafe123#',
};
// Journey-specific owner email — never the one e2e-school-chat.mjs bootstraps,
// so both scripts can share one dev database without deleting each other.
const OWNER = {
  name: 'Platform Owner',
  email: 'platform.owner@journey.natlas.test',
  password: 'OwnerSafe123#',
};
const SCHOOL = { name: 'Miva University', defaultPassword: 'MivaSafe#2026' };
const SCHOOL_ADMIN = {
  name: 'Grace Adeyemi',
  email: 'grace.adeyemi@miva.edu.ng',
  password: 'GraceSafe123#',
};

// ---------------------------------------------------------------------------
// tiny HTTP client with per-actor cookie jars
// ---------------------------------------------------------------------------
function makeActor(name) {
  return { name, jar: new Map() };
}

function absorbCookies(actor, response) {
  if (!actor) return;
  const rawCookies = response.headers.getSetCookie?.() ?? [];
  for (const raw of rawCookies) {
    const [pair] = raw.split(';');
    const eq = pair.indexOf('=');
    const name = pair.slice(0, eq).trim();
    const value = pair.slice(eq + 1).trim();
    if (value === '' || /Expires=Thu, 01 Jan 1970/i.test(raw)) {
      actor.jar.delete(name);
    } else {
      actor.jar.set(name, value);
    }
  }
}

async function api(actor, method, path, body, opts = {}) {
  // Better Auth validates the Origin on mutating requests; include it always.
  const headers = { origin: ORIGIN, accept: 'application/json' };
  if (actor && actor.jar.size > 0) {
    headers.cookie = [...actor.jar.entries()]
      .map(([k, v]) => `${k}=${v}`)
      .join('; ');
  }
  if (body !== undefined) headers['content-type'] = 'application/json';
  const init = { method, headers };
  if (body !== undefined) init.body = JSON.stringify(body);
  if (opts.redirect) init.redirect = opts.redirect;
  const response = await fetch(`${BASE}${path}`, init);
  absorbCookies(actor, response);
  let json = null;
  try {
    json = await response.json();
  } catch {
    // some Better Auth flows may return empty bodies / redirects
  }
  return { status: response.status, body: json };
}

const data = (res) => res.body?.data ?? res.body?.user ?? res.body ?? null;

let passed = 0;
let failed = 0;
function check(name, condition, detail) {
  const ok = Boolean(condition);
  if (ok) passed++;
  else failed++;
  console.log(
    `    [${ok ? 'PASS' : 'FAIL'}] ${name}${detail ? ` — ${detail}` : ''}`,
  );
  if (!ok) process.exitCode = 1;
  return ok;
}
function act(title) {
  console.log(`\n== ${title}`);
}

const pool = new Pool({ connectionString: DB_URL });
const db = (sql, params = []) => pool.query(sql, params);

/**
 * Better Auth 1.7 email-verification tokens are HS256 JWTs that live only in
 * the emailed link (the `verification` table isn't used for them). In dev the
 * backend exposes the last dispatched link at
 * /api/verification/dev-links/:email; production 404s that route on principle.
 */
async function devVerificationUrl(actor, email) {
  const res = await api(actor, 'GET', `/api/verification/dev-links/${email}`);
  return res.body?.data?.url ?? null;
}

const shortCodeRe = (prefix) => new RegExp(`^${prefix}[${SHORT_CODE_CHARSET}]{4}$`);

// ---------------------------------------------------------------------------
async function main() {
  const started = Date.now();
  const eric = makeActor('Eric');
  const ngozi = makeActor('Ngozi');
  const jude = makeActor('Jude');
  const owner = makeActor('Owner');
  const schoolAdmin = makeActor('SchoolAdmin');
  const anon = null; // unauthenticated caller is just null

  // ---------------------------------------------------------------- act 0
  act('Act 0 — preflight');
  const root = await api(anon, 'GET', '/api');
  check('GET /api envelope ok', root.status === 200 && root.body?.success === true);
  const health = await api(anon, 'GET', '/api/health/auth');
  check('GET /api/health/auth ok', health.status === 200 && data(health)?.service === 'auth', 'route: GET /api/health/auth');
  await db('SELECT 1');
  check('Postgres reachable', true);

  act('Act 0 — clean re-run data');
  const EMAILS = [
    ERIC.email,
    NGOZI.email,
    JUDE.email,
    AMARA.email,
    OWNER.email,
    SCHOOL_ADMIN.email,
    'probe.token@x.com',
    'fake.staff@x.com',
  ];
  await db(`DELETE FROM "user" WHERE email = ANY($1::text[])`, [EMAILS]);
  await db(`DELETE FROM school WHERE name = $1`, [SCHOOL.name]);
  await db(`DELETE FROM support_person WHERE name = 'Dr. Eric Moore'`);
  await db(`DELETE FROM verification WHERE identifier = ANY($1::text[])`, [EMAILS]);
  check('test data cleaned', true);

  // ---------------------------------------------------------------- act 1
  act('Act 1 — ERIC (PSYCHOLOGIST): staff bootstrap signup');
  console.log('  POST /api/v1/staff/bootstrap', JSON.stringify({ name: ERIC.name, email: ERIC.email, role: 'PSYCHOLOGIST', phone: ERIC.phone, enrollmentKey: '***' }));
  let res = await api(anon, 'POST', '/api/v1/staff/bootstrap', {
    name: ERIC.name,
    email: ERIC.email,
    password: ERIC.password,
    phone: ERIC.phone,
    role: 'PSYCHOLOGIST',
    enrollmentKey: ENROLLMENT_KEY,
  });
  check('staff bootstrap creates the professional', res.status === 201 && data(res)?.user?.email === ERIC.email, `status ${res.status}`);
  check('bootstrap account still needs email verification', data(res)?.user?.emailVerified === false);

  res = await api(anon, 'POST', '/api/v1/staff/bootstrap', {
    name: 'Fake',
    email: 'fake.staff@x.com',
    password: 'Fake1234#',
    role: 'PSYCHOLOGIST',
    enrollmentKey: 'wrong-key',
  });
  check('wrong enrollment key rejected (403)', res.status === 403, `status ${res.status}`);
  res = await api(anon, 'POST', '/api/v1/staff/bootstrap', {
    name: 'Fake', email: 'fake.staff@x.com', password: 'Fake1234#', role: 'STUDENT', enrollmentKey: ENROLLMENT_KEY,
  });
  check('STUDENT role rejected via bootstrap (400)', res.status === 400, `status ${res.status}`);
  res = await api(anon, 'POST', '/api/v1/staff/bootstrap', {
    name: ERIC.name, email: ERIC.email, password: ERIC.password, role: 'PSYCHOLOGIST', enrollmentKey: ENROLLMENT_KEY,
  });
  check('duplicate email rejected (401-style 422)', res.status === 422 || res.status === 409, `status ${res.status}`);

  act('Act 1 — ERIC verifies email + explicit sign-in');
  let verifyUrl = await devVerificationUrl(anon, ERIC.email);
  check('verification link visible in the dev server log', !!verifyUrl);
  if (verifyUrl) {
    const target = new URL(verifyUrl);
    // Manual redirect: the auth flow bounces to its callbackURL and settles
    // the session cookie on the FIRST response; following the redirect would
    // land on the SPA root (404). The verify call runs through ERIC's own
    // actor so the auto-sign-in session cookie enters his jar.
    res = await api(eric, 'GET', `${target.pathname}${target.search}`, undefined, { redirect: 'manual' });
    check('verify-email consumes token (auto sign-in)', res.status === 200 || res.status === 302, `status ${res.status}`);
  }
  res = await api(eric, 'POST', '/api/auth/sign-in/email', { email: ERIC.email, password: ERIC.password });
  check('Eric signs in', res.status === 200 && !!res.body?.user, `status ${res.status}`);

  res = await api(eric, 'GET', '/api/users/me');
  check('GET /api/users/me shows PSYCHOLOGIST role', data(res)?.role === 'PSYCHOLOGIST', data(res)?.role);

  res = await api(eric, 'GET', '/api/v1/professionals/me');
  check('GET /api/v1/professionals/me auto-profile', res.status === 200 && !!data(res)?.id);
  res = await api(eric, 'PATCH', '/api/v1/professionals/me', {
    title: 'Clinical Psychologist',
    department: 'Counselling & Psychological Services',
    available: true,
  });
  check('PATCH /api/v1/professionals/me updates profile', data(res)?.title === 'Clinical Psychologist');

  console.log('  POST /api/auth/update-user', JSON.stringify({ name: ERIC.newName, phone: ERIC.newPhone }));
  res = await api(eric, 'POST', '/api/auth/update-user', { name: ERIC.newName, phone: ERIC.newPhone });
  check('Eric renames to Eric Moore Andrew + Australian phone', res.status === 200, `status ${res.status}`);
  res = await api(eric, 'GET', '/api/users/me');
  check('rename reflected', data(res)?.name === ERIC.newName, data(res)?.name);

  // ---------------------------------------------------------------- act 2
  act('Act 2 — provisioned staff via POST /api/v1/users + hash-fix sign-in');
  console.log('  POST /api/v1/users', JSON.stringify({ name: NGOZI.name, role: NGOZI.role, email: NGOZI.email }));
  res = await api(eric, 'POST', '/api/v1/users', { ...NGOZI });
  check('staff provisions SUPPORT_STAFF', res.status === 201 && data(res)?.email === NGOZI.email, `status ${res.status}`);

  res = await api(ngozi, 'POST', '/api/auth/sign-in/email', { email: NGOZI.email, password: NGOZI.password });
  check('Ngozi signs in (hashed password bug fixed)', res.status === 200 && !!res.body?.user, `status ${res.status}`);
  res = await api(ngozi, 'GET', '/api/v1/dashboard/counsellor');
  check('SUPPORT_STAFF sees dashboard', res.status === 200, `status ${res.status}`);
  // PE-15: at this point Ngozi has been provisioned by POST /v1/users, which
  // assigns no school, so she is entitled to no tenant's audit trail. The
  // dashboard above reads empty for the same reason — the audit log answers
  // 403, because the trail is a governance surface and a reviewer with no
  // school is a provisioning error, not a reader of zero rows.
  res = await api(ngozi, 'GET', '/api/v1/audit');
  check('school-less staff cannot read any school’s audit trail', res.status === 403, `status ${res.status}`);

  act('Act 2 — admin seeds Dr. Eric Moore as a support person');
  const ericProf = await db(
    `SELECT p.id, p."userId" FROM professional_profile p JOIN "user" u ON u.id = p."userId" WHERE u.email = $1`,
    [ERIC.email],
  );
  const ericProfileId = ericProf.rows[0]?.id;
  const ericUserId = ericProf.rows[0]?.userId;
  check('Eric professional profile id found', !!ericProfileId);
  await db(
    `WITH updated AS (
       UPDATE support_person SET active = true, "availableToday" = true
       WHERE "professionalId" = $1 AND type = 'PSYCHOLOGIST'
       RETURNING id
     )
     INSERT INTO support_person (id, "professionalId", name, type, title, "availabilityLabel", "availableToday", active, "createdAt", "updatedAt")
     SELECT $2, $1, 'Dr. Eric Moore', 'PSYCHOLOGIST', 'Visiting Clinical Psychologist', 'Available Today', true, true, now(), now()
     WHERE NOT EXISTS (SELECT 1 FROM updated)`,
    [ericProfileId, randomUUID()],
  );
  check('Dr. Eric Moore listed as support person', true);

  // ---------------------------------------------------------------- act 3
  act('Act 3 — the public sign-up door is closed');
  console.log('  POST /api/auth/sign-up/email', JSON.stringify({ name: JUDE.name, email: JUDE.email }));
  res = await api(anon, 'POST', '/api/auth/sign-up/email', { name: JUDE.name, email: JUDE.email, password: JUDE.password, phone: JUDE.phone });
  check('public sign-up refused (uniform 400, no email-existence oracle)', res.status === 400 && res.body?.code === 'EMAIL_PASSWORD_SIGN_UP_DISABLED', `status ${res.status} code ${res.body?.code}`);

  act('Act 3 — platform owner bootstraps the school (raw SQL, no sign-up route)');
  const ownerId = randomUUID();
  await db(
    `INSERT INTO "user" (id, name, email, "emailVerified", role, "mustChangePassword", "createdAt", "updatedAt")
     VALUES ($1, $2, $3, true, 'PLATFORM_ADMIN', false, now(), now())`,
    [ownerId, OWNER.name, OWNER.email],
  );
  await db(
    `INSERT INTO account (id, "userId", "accountId", "providerId", password, "createdAt", "updatedAt")
     VALUES ($1, $2, $3, 'credential', $4, now(), now())`,
    // "userId" is uuid and "accountId" is text: one placeholder for both makes Postgres
    // fail with "inconsistent types deduced for parameter". Do not collapse $2/$3.
    [randomUUID(), ownerId, ownerId, await hashPassword(OWNER.password)],
  );
  res = await api(owner, 'POST', '/api/auth/sign-in/email', { email: OWNER.email, password: OWNER.password });
  check('platform owner signs in', res.status === 200 && res.body?.user?.role === 'PLATFORM_ADMIN', `status ${res.status}`);

  console.log('  POST /api/v1/schools', JSON.stringify({ name: SCHOOL.name }));
  res = await api(owner, 'POST', '/api/v1/schools', { name: SCHOOL.name, defaultPassword: SCHOOL.defaultPassword });
  const school = data(res);
  check('school created ACTIVE with an acronym short code', res.status === 201 && school?.status === 'ACTIVE' && shortCodeRe('MU').test(school?.shortCode ?? ''), `status ${res.status} code ${school?.shortCode}`);
  const schoolId = school?.id;

  // Tenancy (the §0B P0) scopes both the staff flag queue and a student's
  // support-person list to one school, so the professional who reviews Jude in
  // Act 7 and receives his request in Act 6 has to belong to Miva — Eric signs
  // up in Act 1, before this school exists, so his schoolId lands here.
  await db(`UPDATE "user" SET "schoolId" = $2 WHERE id = $1`, [ericUserId, schoolId]);

  act('Act 3 — school admin provisioned, forced onto a personal password');
  console.log('  POST /api/v1/schools/:id/admins', JSON.stringify({ name: SCHOOL_ADMIN.name, email: SCHOOL_ADMIN.email }));
  res = await api(owner, 'POST', `/api/v1/schools/${schoolId}/admins`, { name: SCHOOL_ADMIN.name, email: SCHOOL_ADMIN.email });
  // `verificationEmailSent` is not a pass/fail signal here: trySendVerificationEmail
  // swallows the send and dev has no SMTP, so it is false locally while the link
  // still lands in the dev-log route the very next check reads.
  check('owner provisions the school admin (owner-only route)', res.status === 201 && data(res)?.user?.role === 'SCHOOL_ADMIN', `status ${res.status} role ${data(res)?.user?.role}`);

  verifyUrl = await devVerificationUrl(anon, SCHOOL_ADMIN.email);
  check('verification link visible for the school admin', !!verifyUrl);
  if (verifyUrl) {
    const target = new URL(verifyUrl);
    res = await api(schoolAdmin, 'GET', `${target.pathname}${target.search}`, undefined, { redirect: 'manual' });
    check('school admin verifies email (auto sign-in)', res.status === 200 || res.status === 302, `status ${res.status}`);
  }
  res = await api(schoolAdmin, 'POST', '/api/auth/sign-in/email', { email: SCHOOL_ADMIN.email, password: SCHOOL.defaultPassword });
  check('school admin signs in with the school default password', res.status === 200, `status ${res.status}`);
  res = await api(schoolAdmin, 'GET', '/api/v1/users/me');
  check('admin profile shows school + forced change', data(res)?.school?.name === SCHOOL.name && data(res)?.mustChangePassword === true, `school=${data(res)?.school?.name} mustChange=${data(res)?.mustChangePassword}`);

  res = await api(schoolAdmin, 'GET', `/api/v1/schools/${schoolId}/users`);
  check('admin locked out of onboarding until the change (403 PASSWORD_CHANGE_REQUIRED)', res.status === 403 && JSON.stringify(res.body ?? {}).includes('PASSWORD_CHANGE_REQUIRED'), `status ${res.status}`);

  res = await api(schoolAdmin, 'POST', '/api/v1/auth/first-password', { newPassword: SCHOOL_ADMIN.password });
  check('admin sets a personal password (no old password)', (res.status === 200 || res.status === 201) && data(res)?.passwordChanged === true, `status ${res.status}`);
  res = await api(schoolAdmin, 'GET', `/api/v1/schools/${schoolId}/users`);
  check('admin allowed again after the change', res.status === 200, `status ${res.status}`);
  res = await api(schoolAdmin, 'POST', `/api/v1/schools/${schoolId}/admins`, { name: 'Peer Admin', email: 'peer.admin@miva.edu.ng' });
  check('admin cannot mint peers (owner-only route, 403)', res.status === 403, `status ${res.status}`);

  act('Act 3 — JUDE onboarded by the school (no public sign-up)');
  console.log('  POST /api/v1/schools/:id/students', JSON.stringify({ email: JUDE.email, firstName: 'Jude' }));
  res = await api(schoolAdmin, 'POST', `/api/v1/schools/${schoolId}/students`, {
    email: JUDE.email,
    firstName: 'Jude',
    lastName: 'Okonkwo',
    classLabel: 'Sociology 300 Level',
    phone: JUDE.phone,
  });
  const enrolled = data(res);
  check('school onboards Jude (201 + student row)', res.status === 201 && enrolled?.user?.role === 'STUDENT', `status ${res.status} role ${enrolled?.user?.role}`);
  check(`student code follows the school short code (${school?.shortCode}-####)`, new RegExp(`^${school?.shortCode}-\\d{4}$`).test(enrolled?.studentCode ?? ''), enrolled?.studentCode);

  verifyUrl = await devVerificationUrl(anon, JUDE.email);
  check('verification link visible for Jude', !!verifyUrl);
  if (verifyUrl) {
    const target = new URL(verifyUrl);
    // Same as Eric: verification auto-sign-in goes through Jude's own actor.
    res = await api(jude, 'GET', `${target.pathname}${target.search}`, undefined, { redirect: 'manual' });
    check('Jude verifies email (auto sign-in)', res.status === 200 || res.status === 302, `status ${res.status}`);
  }
  res = await api(jude, 'POST', '/api/auth/sign-in/email', { email: JUDE.email, password: SCHOOL.defaultPassword });
  check('Jude signs in with the school default password', res.status === 200, `status ${res.status}`);
  // /api/users/me is the raw Better Auth session user (no relations); the school
  // is only on the application profile route.
  res = await api(jude, 'GET', '/api/v1/users/me');
  check('Jude role STUDENT, school attached, forced change pending', data(res)?.role === 'STUDENT' && data(res)?.school?.name === SCHOOL.name && data(res)?.mustChangePassword === true, `role=${data(res)?.role} school=${data(res)?.school?.name} mustChange=${data(res)?.mustChangePassword}`);

  res = await api(jude, 'POST', '/api/v1/auth/first-password', { newPassword: JUDE.password });
  // The route has no @HttpCode, so Nest's POST default (201) wins. Whether the
  // contract is 200 or 201 is the owner's call — §0M item 4 — so the journey
  // accepts either rather than silently redefining it.
  check('Jude sets a personal password', (res.status === 200 || res.status === 201) && data(res)?.passwordChanged === true, `status ${res.status}`);
  const throwaway = makeActor('throwaway-Jude');
  res = await api(throwaway, 'POST', '/api/auth/sign-in/email', { email: JUDE.email, password: SCHOOL.defaultPassword });
  check('school default dead for Jude after the change', res.status === 401, `status ${res.status}`);
  res = await api(throwaway, 'POST', '/api/auth/sign-in/email', { email: JUDE.email, password: JUDE.password });
  check('Jude personal password works', res.status === 200, `status ${res.status}`);
  res = await api(jude, 'GET', '/api/users/me');
  check('Jude session survives the forced change', res.status === 200, `status ${res.status}`);

  res = await api(jude, 'PATCH', '/api/v1/students/me', {
    displayName: 'Jude O.',
    classLabel: 'Sociology 300 Level',
    preferredLanguage: 'en',
    vibe: 'quiet, thoughtful',
  });
  check('PATCH /api/v1/students/me', data(res)?.displayName === 'Jude O.');
  res = await api(jude, 'GET', '/api/v1/students/me/sanctuary');
  check('sanctuary greets Jude', typeof data(res)?.greeting === 'string' && data(res).sosAvailable === true, data(res)?.greeting);

  res = await api(jude, 'POST', '/api/v1/consent/accept', { version: 'v1' });
  check('consent accepted v1', data(res)?.accepted === true);
  res = await api(jude, 'GET', '/api/v1/consent/me');
  check('consent history visible', Array.isArray(data(res)) && data(res).length >= 1);

  res = await api(jude, 'GET', '/api/v1/privacy/preferences');
  check('privacy prefs start from safe defaults', data(res)?.shareAiCopingHubNotes === false);
  res = await api(jude, 'PATCH', '/api/v1/privacy/preferences', { shareAiCopingHubNotes: true });
  check('privacy pref updated', data(res)?.shareAiCopingHubNotes === true);

  act('Act 3 — AI capabilities & limits disclosure (MUST-protected)');
  res = await api(anon, 'GET', '/api/v1/ai/disclosure');
  check('disclosure GET (anonymous, pre-login)', res.status === 200 && data(res)?.text?.includes('cannot'), `status ${res.status}`);
  // CONSENT_GATE_001 turned the ack into an affirmative action: the student ticks
  // every statement, and the ids come from the disclosure itself so the journey
  // follows the content instead of hardcoding a list that can drift from it.
  const agreementIds = (data(res)?.agreements ?? []).map((a) => a.id);
  check('disclosure publishes the statements that must be ticked', agreementIds.length >= 1, JSON.stringify(agreementIds));
  const partial = agreementIds.slice(0, -1);
  res = await api(jude, 'POST', '/api/v1/ai/disclosure/acknowledge', { agreements: partial });
  check('a partial tick list is refused (400) and records nothing', res.status === 400, `status ${res.status} ids ${JSON.stringify(partial)}`);
  res = await api(jude, 'GET', '/api/v1/ai/disclosure/status');
  check('Jude is still un-acknowledged after the refusal', data(res)?.accepted === false, JSON.stringify(data(res)));
  res = await api(jude, 'POST', '/api/v1/ai/disclosure/acknowledge', { agreements: agreementIds });
  check('Jude acknowledges the AI explanation', data(res)?.acknowledged === true, `status ${res.status}`);

  // ---------------------------------------------------------------- act 4
  act("Act 4 — JUDE's journey: check-in + guided AI reflection");
  console.log('  POST /api/v1/check-ins', JSON.stringify({ feeling: 'SAD_LOW', intensity: 'A_LOT' }));
  res = await api(jude, 'POST', '/api/v1/check-ins', {
    feeling: 'SAD_LOW',
    intensity: 'A_LOT',
    description: 'Two exams in two days. The hostel is loud, course mates are far, and I have not eaten well.',
    triggers: ['exam pressure', 'loneliness', 'poor sleep'],
  });
  const checkIn = data(res);
  check('check-in created', !!checkIn?.id && checkIn.feeling === 'SAD_LOW');
  res = await api(jude, 'GET', '/api/v1/check-ins');
  check('check-in list has latest', data(res)?.items?.[0]?.id === checkIn.id);

  res = await api(jude, 'POST', '/api/v1/conversations', { checkInId: checkIn.id, source: 'chat' });
  const conversation = data(res);
  check('conversation rooted in the check-in', !!conversation?.id && conversation.checkInId === checkIn.id);

  const say = async (content) => {
    console.log('  POST /api/v1/conversations/:id/messages', JSON.stringify({ content: content.slice(0, 70) + (content.length > 70 ? '…' : '') }));
    // LANG_ID_016: the student no longer tells the server what language to answer
    // in — the reply language comes from the student's preferredLanguage. The pipe
    // runs forbidNonWhitelisted, so sending `language` here is a 400, not an
    // ignored field.
    return api(jude, 'POST', `/api/v1/conversations/${conversation.id}/messages`, { content });
  };

  res = await say(
    'Good morning. I am a 300 level Sociology student at Miva University, Nigeria. Today was rough — lectures, then assignments back to back.',
  );
  check('message 1: AI hug reply (no flag expected)', res.status === 201 || res.status === 200, `status ${res.status}`);

  res = await say('Lately everything feels heavier. Deadlines are close and the hostel is too loud to rest.');
  const msg2Intent = data(res)?.activeIntent ?? null;
  check('message 2: reply is a real success (guards ribbon effects)', (res.status === 201 || res.status === 200) && msg2Intent?.severity !== 'TIER_3_ACUTE', `status ${res.status} intent ${JSON.stringify(msg2Intent)}`);

  console.log('  POST /api/v1/conversations/:id/messages', JSON.stringify({ content: '(crisis wording)' }));
  res = await say('Honestly, some nights I feel there is no reason to live. I keep thinking I want to end it all.');
  const crisis = data(res);
  check('message 3: intent detected (SERVER_KEYWORDS)', crisis?.activeIntent?.id === 'SUICIDAL_IDEATION', JSON.stringify(crisis?.activeIntent));
  check('message 3: severity TIER_3_ACUTE', crisis?.activeIntent?.severity === 'TIER_3_ACUTE');
  check('message 3: scripted safety message replaces generic reply', crisis?.assistantMessage?.content?.includes('matter'), crisis?.assistantMessage?.content?.slice(0, 60));
  check('message 3: human support pathway guaranteed', crisis?.humanCareRecommendation?.show === true, crisis?.humanCareRecommendation?.message?.slice(0, 60));

  res = await api(jude, 'GET', `/api/v1/conversations/${conversation.id}`);
  const messages = data(res)?.messages ?? [];
  check('conversation holds 6 persisted messages', messages.length === 6, String(messages.length));
  const lastMessage = messages[messages.length - 1];
  check('last AI payload asyncState COMPLETE', lastMessage?.aiPayload?.asyncState === 'COMPLETE');
  check('last AI payload flags the intent', lastMessage?.aiPayload?.supportFlag?.candidate === true && lastMessage?.aiPayload?.supportFlag?.category === 'SUICIDAL_IDEATION');

  // Resolve Jude's DB profile once; reused by the async probes below.
  const judeProfileId = (
    await db(
      `SELECT id FROM student_profile WHERE "userId" = (SELECT id FROM "user" WHERE email = $1)`,
      [JUDE.email],
    )
  ).rows[0]?.id;
  check('Jude student profile resolved from DB', !!judeProfileId);

  // ---------------------------------------------------------------- act 5
  act('Act 5 — async AI: queued regeneration lands after the fact');
  // Simulate a first-generation outage for a NEW message: enqueue directly.
  res = await api(jude, 'POST', `/api/v1/conversations/${conversation.id}/messages`, {
    content: 'If I keep being honest — how do I manage exam week without spiralling?',
  });
  const queuedTurn = data(res);
  check('queued turn returns instantly with a reply', (res.status === 201 || res.status === 200) && queuedTurn?.assistantMessage?.content !== undefined, `status ${res.status}`);

  res = await api(jude, 'GET', `/api/v1/conversations/${conversation.id}`);
  const asyncTargetMessageId = (data(res)?.messages ?? []).slice(-1)[0]?.id;
  check('async target message id found', !!asyncTargetMessageId, String(asyncTargetMessageId));
  if (asyncTargetMessageId && judeProfileId) {
    await db(
      `INSERT INTO ai_generation_job (id, "conversationMessageId", input, status, "nextRetryAt", "createdAt", "updatedAt")
       VALUES ($3, $1, $2::jsonb, 'PENDING', now(), now(), now())`,
      [asyncTargetMessageId, JSON.stringify({
        studentId: judeProfileId,
        conversationId: conversation.id,
        checkInId: checkIn.id,
        userContent: 'If I keep being honest — how do I manage exam week without spiralling?',
        language: 'en',
        studentRef: 'Jude O.',
        classLabel: 'Sociology 300 Level',
      }), randomUUID()],
    );
  }
  let rewritten = false;
  for (let i = 0; i < 20 && !rewritten; i++) {
    await new Promise((resolve) => setTimeout(resolve, 1_500));
    res = await api(jude, 'GET', `/api/v1/conversations/${conversation.id}`);
    const target = (data(res)?.messages ?? []).find((m) => m.id === asyncTargetMessageId);
    rewritten = target?.aiPayload?.asyncState === 'COMPLETE' && target?.aiPayload?.viaAsyncRetry === true;
  }
  check('worker rewrites the placeholder (COMPLETE + viaAsyncRetry)', rewritten === true);

  // Exhausted-retry job drives a placeholder to FAILED status.
  res = await api(jude, 'POST', '/api/v1/conversations', { source: 'chat' });
  const conv2 = data(res);
  res = await api(jude, 'POST', `/api/v1/conversations/${conv2.id}/messages`, { content: 'another retry lane probe' });
  check('exhaust-probe conversation + message created', (res.status === 201 || res.status === 200), `status ${res.status}`);
  res = await api(jude, 'GET', `/api/v1/conversations/${conv2.id}`);
  const failPlaceholderId = (data(res)?.messages ?? []).slice(-1)[0]?.id;
  check('exhaust-probe placeholder id found', !!failPlaceholderId, String(failPlaceholderId));
  if (failPlaceholderId && judeProfileId) {
    await db(
      `INSERT INTO ai_generation_job (id, "conversationMessageId", input, attempts, status, "nextRetryAt", "createdAt", "updatedAt")
       VALUES ($3, $1, $2::jsonb, 3, 'PENDING', now(), now(), now())`,
      [failPlaceholderId, JSON.stringify({
        // Unknown conversation makes the worker's post-generation
        // conversation.update throw deterministically — healthy providers
        // must not make this probe succeed.
        studentId: judeProfileId,
        conversationId: randomUUID(),
        checkInId: null,
        userContent: 'exhaust probe',
        language: 'en',
        studentRef: 'Jude O.',
        classLabel: null,
      }), randomUUID()],
    );
  }
  let failedTowards = false;
  for (let i = 0; i < 20 && !failedTowards; i++) {
    await new Promise((resolve) => setTimeout(resolve, 1_500));
    res = await api(jude, 'GET', `/api/v1/conversations/${conv2.id}`);
    const target = (data(res)?.messages ?? []).find((m) => m.id === failPlaceholderId);
    failedTowards = target?.aiPayload?.asyncState === 'FAILED';
  }
  check('exhausted job flips placeholder to FAILED (holding kept)', failedTowards === true);

  // ---------------------------------------------------------------- act 5
  act('Act 5 — Epic G: a student reports an AI reply, with a reason');
  // Reporting is the one control a student holds over a bad reply, so the
  // reason Epic G asks for has to survive the whole path: chosen here, counted
  // by a reviewer in Act 7, and never answered back as a review field.
  res = await api(jude, 'GET', `/api/v1/conversations/${conversation.id}`);
  const assistantMessages = (data(res)?.messages ?? []).filter((m) => m.role === 'ASSISTANT' && typeof m.content === 'string');
  check('assistant replies exist to report', assistantMessages.length >= 2, `${assistantMessages.length}`);
  const reportedMessage = assistantMessages[0];
  res = await api(jude, 'POST', '/api/v1/ai-response-reports', {
    messageId: reportedMessage.id,
    expectedContent: reportedMessage.content,
    reason: 'DIAGNOSIS_OR_MEDICAL_ADVICE',
  });
  const reportReceipt = data(res)?.report;
  check('report accepted with the reason the student chose', res.status === 200 && data(res)?.alreadyReported === false
    && reportReceipt?.reason === 'DIAGNOSIS_OR_MEDICAL_ADVICE', `status ${res.status} reason ${reportReceipt?.reason}`);
  check('and the receipt still hides every reviewer field', !('reviewOutcome' in (reportReceipt ?? {})), Object.keys(reportReceipt ?? {}).join(','));
  res = await api(jude, 'POST', '/api/v1/ai-response-reports', {
    messageId: assistantMessages[1].id, expectedContent: assistantMessages[1].content,
  });
  check('a report with no reason is refused', res.status === 400, `status ${res.status}`);
  res = await api(jude, 'POST', '/api/v1/ai-response-reports', {
    messageId: assistantMessages[1].id, expectedContent: assistantMessages[1].content, reason: 'It was rude',
  });
  check('free text is not a reason', res.status === 400, `status ${res.status}`);
  res = await api(jude, 'POST', '/api/v1/ai-response-reports', {
    messageId: reportedMessage.id, expectedContent: reportedMessage.content, reason: 'OTHER',
  });
  check('a second report on the same reply returns the first one, reason and all',
    data(res)?.alreadyReported === true && data(res)?.report?.reason === 'DIAGNOSIS_OR_MEDICAL_ADVICE', `reason ${data(res)?.report?.reason}`);

  // ---------------------------------------------------------------- act 6
  act('Act 6 — resources, toolbox, journal, support request');
  // The content register — not the row booleans — decides what a student sees
  // (Doc B §5, Doc C §1). This local DB still carries the five invented seed
  // placeholder rows with approved: true and no contentCode, so Act 6 is the
  // proof that they are now invisible, and that a register-approved row is not.
  const CODED_TITLE = '[e2e] register-approved breathing';
  const UNCODED_TITLE = '[e2e] approved on the table only';
  await db(`DELETE FROM wellbeing_resource WHERE title IN ($1, $2)`, [CODED_TITLE, UNCODED_TITLE]);
  res = await api(jude, 'GET', '/api/v1/resources');
  const unapproved = (data(res)?.items ?? []).filter((r) => !r.contentCode);
  check('no row without a register code reaches the catalogue', unapproved.length === 0, `${unapproved.length} leaked: ${unapproved.map((r) => r.title).join(', ')}`);
  check('the invented seed placeholders are gone', !(data(res)?.items ?? []).some((r) => /Navigating Exam Stress|Not All On You|Chill Breath|Palm-Wine|Without the Fear/.test(r.title ?? '')), (data(res)?.items ?? []).map((r) => r.title).join(', '));

  await db(
    `INSERT INTO content_item (id, code, kind, namespace, status, payload, "createdAt", "updatedAt")
     VALUES ($1, 'WN-01', 'WELLBEING_RESOURCE', 'WELLBEING', 'CONTENT_REVIEW_REQUIRED', '{}'::jsonb, now(), now())
     ON CONFLICT DO NOTHING`,
    [randomUUID()],
  );
  await db(
    `UPDATE content_item SET status = 'APPROVED_ACTIVE', "approvedBy" = 'e2e-journey'
     WHERE code = 'WN-01' AND kind = 'WELLBEING_RESOURCE'`,
  );
  await db(
    `INSERT INTO wellbeing_resource (id, title, description, type, category, "contentCode", instructions, active, approved, "createdAt", "updatedAt")
     VALUES ($1, $2, 'One breathing step the register has approved.', 'SOMATIC_EXERCISE', 'GROUNDING', 'WN-01', ARRAY['Breathe in for four, out for six.'], true, true, now(), now())`,
    [randomUUID(), CODED_TITLE],
  );
  await db(
    `INSERT INTO wellbeing_resource (id, title, description, type, category, active, approved, "createdAt", "updatedAt")
     VALUES ($1, $2, 'Approved by the boolean alone — never registered, never reviewed.', 'ARTICLE', 'GROUNDING', true, true, now(), now())`,
    [randomUUID(), UNCODED_TITLE],
  );

  res = await api(jude, 'GET', '/api/v1/resources');
  const resources = data(res)?.items ?? [];
  const codedResource = resources.find((r) => r.title === CODED_TITLE);
  check('the register-approved row appears', !!codedResource, `${resources.length} rows`);
  check('and the boolean-approved row still does not', !resources.some((r) => r.title === UNCODED_TITLE));

  res = await api(jude, 'GET', '/api/v1/resources/tailored', undefined);
  const tailored = data(res);
  check('tailored offers a resource', (tailored?.items ?? []).length >= 1, `${tailored?.items?.length}`);
  check('the title only claims personalisation when the basis earned it', (tailored?.title === 'Picked for you') === (tailored?.basis === 'STATED_NEED'), `title ${tailored?.title} · basis ${tailored?.basis}`);
  check("a SAD_LOW check-in gets the neutral surface, not 'Picked for you'", tailored?.basis === 'NEWEST_APPROVED', `basis ${tailored?.basis}`);

  // The client names no check-in id: the service must resolve the newest one
  // itself, or "from your check-in" would be a claim the frontend invented.
  res = await api(jude, 'POST', '/api/v1/check-ins', {
    feeling: 'STRESSED',
    intensity: 'A_LOT',
    description: 'Act 6 personalisation probe.',
    triggers: ['exam pressure'],
  });
  const stressedCheckIn = data(res);
  check('second check-in created', stressedCheckIn?.feeling === 'STRESSED', `status ${res.status}`);
  res = await api(jude, 'GET', '/api/v1/resources/tailored', undefined);
  const personalised = data(res);
  check('the newest check-in drives the claim without the client naming it', personalised?.basis === 'STATED_NEED' && personalised?.title === 'Picked for you', `title ${personalised?.title} · basis ${personalised?.basis}`);
  check('and it only ever offers the three reviewed groupings', (personalised?.items ?? []).every((r) => ['EXAM_STRESS', 'GROUNDING', 'ANXIETY'].includes(r.category)), (personalised?.items ?? []).map((r) => r.category).join(', '));

  res = await api(jude, 'POST', '/api/v1/resources/toolbox', { resourceId: codedResource.id });
  check('toolbox save', res.status === 201 || res.status === 200, `status ${res.status}`);
  const uncodedRow = await db(`SELECT id FROM wellbeing_resource WHERE title = $1`, [UNCODED_TITLE]);
  res = await api(jude, 'POST', '/api/v1/resources/toolbox', { resourceId: uncodedRow.rows[0].id });
  check('saving an unreviewed resource is refused, not quietly stored', res.status === 404, `status ${res.status}`);
  res = await api(jude, 'GET', '/api/v1/resources/toolbox');
  check('toolbox lists saved resource', data(res)?.count === 1);

  // Put the register back, so a run leaves the local DB as honest as it found
  // it. E2E_KEEP_RESOURCES=1 skips the restore — that is how a browser pass
  // gets one real approved resource to look at, without anyone hand-editing SQL.
  if (process.env.E2E_KEEP_RESOURCES === '1') {
    console.log('  E2E_KEEP_RESOURCES=1 — the [e2e] resource and the WN-01 approval stay put.');
  } else {
    await db(`DELETE FROM wellbeing_resource WHERE title IN ($1, $2)`, [CODED_TITLE, UNCODED_TITLE]);
    await db(
      `UPDATE content_item SET status = 'CONTENT_REVIEW_REQUIRED', "approvedBy" = NULL
       WHERE code = 'WN-01' AND kind = 'WELLBEING_RESOURCE'`,
    );
  }

  res = await api(jude, 'POST', '/api/v1/journal', { title: 'Rough day', content: 'Long notes about the exam-week haze and the loud hostel.', prompt: 'good news' });
  const jEntry = data(res);
  check('journal entry created', !!jEntry?.id);
  res = await api(jude, 'PATCH', `/api/v1/journal/${jEntry.id}`, { content: 'Updated: tomorrow gets steadier.' });
  check('journal PATCH works', data(res)?.content?.includes('steadier'));
  res = await api(jude, 'DELETE', `/api/v1/journal/${jEntry.id}`);
  res = await api(jude, 'GET', `/api/v1/journal/${jEntry.id}`);
  check('journal DELETE means really gone (404)', res.status === 404, `status ${res.status}`);

  res = await api(jude, 'GET', '/api/v1/support-requests/people');
  const people = data(res) ?? [];
  const ericPerson = people.find((p) => p.name === 'Dr. Eric Moore');
  check('Dr. Eric Moore visible to Jude (same school after the tenancy move)', !!ericPerson, `list: ${people.map((p) => p.name).join(', ')}`);
  res = await api(jude, 'POST', '/api/v1/support-requests', {
    supportPersonId: ericPerson.id,
    personType: 'PSYCHOLOGIST',
    timing: 'TODAY_STUDY_PERIOD',
    note: 'Please, I would like to talk today.',
    checkInId: checkIn.id,
    conversationId: conversation.id,
  });
  const supportRequest = data(res);
  check('support request created for Dr. Eric Moore', !!supportRequest?.id && supportRequest.status === 'PENDING', supportRequest?.status);
  res = await api(jude, 'GET', '/api/v1/support-requests');
  const mine = data(res)?.items ?? [];
  const asked = mine.filter((r) => r.status === 'PENDING');
  const openedBySafety = mine.filter((r) => r.status === 'ESCALATED');
  // Two rows, and they mean different things: the student's own request, and the one
  // the TIER_3 alert route opened for him in Act 4 (support-flag-alerts.service).
  // Asserting `length === 1` predated that pathway and would now hide it.
  check('student sees the request he made', asked.length === 1 && asked[0]?.supportPerson?.name === 'Dr. Eric Moore', `${asked.length} PENDING: ${asked.map((r) => r.supportPerson?.name).join(', ')}`);
  check('the Act 4 safety alert opened its own request to a same-school professional', openedBySafety.length === 1 && openedBySafety[0]?.supportPerson?.name === 'Dr. Eric Moore', `${openedBySafety.length} ESCALATED: ${openedBySafety.map((r) => r.supportPerson?.name).join(', ')}`);

  // -------------------------------------------------------- Epic H: history
  act('Act 6 — Epic H: the student’s own history is their own rows, and nothing else');
  res = await api(jude, 'GET', '/api/v1/history');
  const history = data(res);
  const historyItems = history?.items ?? [];
  const act4Entry = historyItems.find((e) => e.checkInId === checkIn.id);
  const act6Entry = historyItems.find((e) => e.checkInId === stressedCheckIn.id);
  check('every check-in the student made is on the list', !!act4Entry && !!act6Entry, `${historyItems.length} rows`);
  check('the Act 4 row carries the reflection it led to', act4Entry?.reflection?.conversationId === conversation.id, `reflection ${act4Entry?.reflection?.conversationId}`);
  // The newest request linked to the check-in, which is Jude's own from a few
  // lines above. The Act 4 safety request is deliberately not linked: it has no
  // checkInId, so it must not appear as though the student asked for it.
  check('and the support request he sent, still unread by the school', act4Entry?.supportRequest?.id === supportRequest.id && act4Entry?.supportRequest?.queueStatus === 'NEW', `request ${act4Entry?.supportRequest?.id} · ${act4Entry?.supportRequest?.queueStatus}`);
  check('a check-in that led nowhere is shown as that, not padded', act6Entry?.reflection === null && act6Entry?.supportRequest === null, `reflection ${act6Entry?.reflection} · request ${act6Entry?.supportRequest}`);
  check('the counts are the same numbers the page prints per tab', history?.counts?.all === historyItems.length && history?.counts?.reflections === historyItems.filter((e) => e.reflection !== null).length && history?.counts?.supportRequests === historyItems.filter((e) => e.supportRequest !== null).length, JSON.stringify(history?.counts));
  const historyWire = JSON.stringify(history ?? null);
  // The projection is a whitelist, so this is the leak test: staff-only columns
  // are not merely hidden by the frontend, they never leave the server.
  check('no staff-only field is on the wire', !/reviewNote|aiPayload|initialMessage|supportPersonId|professionalId/.test(historyWire));
  check('and no resource count is invented', !/resources/i.test(historyWire));

  res = await api(jude, 'GET', `/api/v1/history/${checkIn.id}`);
  const historyDetail = data(res);
  check('one entry opens with the student’s own words', historyDetail?.description === checkIn.description);
  const detailRoles = [...new Set((historyDetail?.messages ?? []).map((m) => m.role))];
  check('the reflection read-back is the student and the AI only', (historyDetail?.messages ?? []).length > 0 && detailRoles.every((role) => role === 'USER' || role === 'ASSISTANT'), `roles ${detailRoles.join(', ')}`);
  res = await api(jude, 'GET', `/api/v1/history/${randomUUID()}`);
  check('an id that is not the student’s 404s — it is not their information', res.status === 404, `status ${res.status}`);

  res = await api(jude, 'POST', '/api/v1/history/deletion-requests', {
    scope: 'SELECTED_CHECK_INS',
    checkInIds: [stressedCheckIn.id],
    note: 'The exam-week one, please.',
  });
  const deletionAsk = data(res);
  check('a deletion ask is filed as a request', (res.status === 201 || res.status === 200) && deletionAsk?.scope === 'SELECTED_CHECK_INS' && deletionAsk?.checkInIds?.length === 1, `status ${res.status}`);
  check('a person at the school was actually told', !!deletionAsk?.alertedAt, `alertedAt ${deletionAsk?.alertedAt}`);
  check('the student’s words are kept as sent', deletionAsk?.note === 'The exam-week one, please.');
  res = await api(jude, 'GET', '/api/v1/history/deletion-requests');
  check('the ask reads back to the student', (data(res)?.items ?? []).some((r) => r.id === deletionAsk?.id));
  const asksBeforeCount = await db(`SELECT count(*)::int AS n FROM emotional_check_in WHERE "studentId" = $1`, [judeProfileId]);
  res = await api(jude, 'POST', '/api/v1/history/deletion-requests', { scope: 'ALL_HISTORY', beforeDate: '2026-01-01' });
  check('ALL_HISTORY carrying a stray date is refused, not half-honoured', res.status === 400 && res.body?.code === 'SCOPE_FIELDS_MISMATCH', `status ${res.status} code ${res.body?.code}`);
  res = await api(jude, 'POST', '/api/v1/history/deletion-requests', { scope: 'SELECTED_CHECK_INS', checkInIds: [randomUUID()] });
  // The filter puts the exception's own `message` on the wire and leaves the
  // generic `error` label alone — and the frontend reads `message` too, so this
  // is the exact sentence a student sees. It must stay unspecific: whether an id
  // exists at all is not this student's information.
  check('a check-in id that is not the student’s is refused without saying why', res.status === 400 && res.body?.code === 'CHECK_INS_NOT_FOUND' && res.body?.message === 'Some of those check-ins are not yours', `status ${res.status} code ${res.body?.code} message ${JSON.stringify(res.body?.message)}`);
  const asksAfterCount = await db(`SELECT count(*)::int AS n FROM emotional_check_in WHERE "studentId" = $1`, [judeProfileId]);
  check('filing a deletion request deleted nothing', asksBeforeCount.rows[0].n === asksAfterCount.rows[0].n, `${asksBeforeCount.rows[0].n} → ${asksAfterCount.rows[0].n}`);
  res = await api(jude, 'GET', '/api/v1/history');
  check('and the history still lists everything', (data(res)?.items ?? []).length === historyItems.length);

  // ---------------------------------------------------------------- act 7
  act("Act 7 — ERIC's professional review of Jude");
  res = await api(eric, 'GET', '/api/v1/dashboard/counsellor');
  const dash = data(res);
  check('dashboard exposes the intent flag', (dash?.flags ?? []).some((f) => f.intentId === 'SUICIDAL_IDEATION'), dash?.flags?.map((f) => f.triggerLabel).join(','));
  check('dashboard flag carries description + reason (flag plus reason)', typeof dash?.flags?.[0]?.aiContextSummary === 'string' && dash.flags[0].aiContextSummary.includes('Student'), dash?.flags?.[0]?.aiContextSummary?.slice(0, 80));
  check('dashboard exposes Jude support request', (dash?.supportRequests ?? []).length >= 1);
  check('barometer counts recent check-ins', dash?.barometer?.total >= 1, `total ${dash?.barometer?.total}`);

  res = await api(eric, 'GET', '/api/v1/support-flags');
  const flags = data(res)?.items ?? [];
  check('flags feed shows the TIER_3 flag (SERVER_POLICY)', flags.some((f) => f.severity === 'TIER_3_ACUTE' && f.source === 'SERVER_POLICY'), `open ${data(res)?.openCount}`);
  const flagId = flags[0].id;
  res = await api(eric, 'POST', `/api/v1/support-flags/${flagId}/acknowledge`);
  check('flag acknowledge', res.status === 201 && data(res)?.message === 'Flag acknowledged', `status ${res.status}`);
  res = await api(eric, 'POST', `/api/v1/support-flags/${flagId}/in-review`);
  check('flag in-review', res.status === 201 || res.status === 200, `status ${res.status}`);

  // ab01 shipped two reads on this queue, and both need a real Postgres behind
  // them: a relation filter inside the `where` that `groupBy` counts on is not
  // something a mocked unit test can prove, and a "Linked request" cell is only
  // honest if the request it names really exists.
  res = await api(eric, 'GET', '/api/v1/support-flags?level=U&q=jude.okonkwo');
  check('student search on the indicator queue answers 200 with the level filter applied', res.status === 200, `status ${res.status}`);
  res = await api(eric, 'GET', '/api/v1/support-flags?q=jude.okonkwo');
  const searched = data(res)?.items ?? [];
  check('indicator search finds Jude by his account email', searched.length === flags.length && searched.length >= 1, `${searched.length} of ${flags.length}`);
  res = await api(eric, 'GET', '/api/v1/support-flags?q=no-such-student-anywhere');
  const unmatched = data(res);
  check('a search with no match empties the rows and the chip counts together', (unmatched?.items ?? []).length === 0 && Object.values(unmatched?.levelCounts ?? {}).every((n) => n === 0), JSON.stringify(unmatched?.levelCounts));
  check('the indicator names the request that shares its conversation', flags.some((f) => f.conversationId === conversation.id && f.linkedRequest?.id === supportRequest.id), flags.map((f) => `${f.conversationId}/${f.linkedRequest?.id ?? 'none'}`).join(','));
  check('a flag on no conversation links no request', flags.every((f) => (f.conversationId ? true : f.linkedRequest === null)));

  res = await api(eric, 'GET', `/api/v1/support-flags/${flagId}`);
  check('flag detail names the linked request as a reference, not a merged status', data(res)?.systemMetadata?.linkedRequest?.status !== undefined && data(res)?.systemMetadata?.status === 'IN_REVIEW', `${data(res)?.systemMetadata?.status}/${data(res)?.systemMetadata?.linkedRequest?.id ?? 'none'}`);
  res = await api(eric, 'POST', `/api/v1/support-flags/${flagId}/review-decision`, { decision: 'FOLLOW_UP_WITH_STUDENT' });
  const recorded = data(res);
  check('recording a decision answers with the server time and the status it left alone', recorded?.decision === 'FOLLOW_UP_WITH_STUDENT' && recorded?.status === 'IN_REVIEW' && typeof recorded?.recordedAt === 'string', `${recorded?.status}/${recorded?.recordedAt}`);

  // ab08 is the same link read from the other side, and it has a second job:
  // proving that a support-staff account — the role Doc A has not approved
  // indicator content for — still gets its own workflow prompt but is never
  // handed the indicator's label, level or id through the requests queue.
  res = await api(eric, 'GET', '/api/v1/support-requests/queue');
  const ericRow = (data(res)?.items ?? []).find((r) => r.id === supportRequest.id);
  check('the request names the indicator that shares its conversation', ericRow?.linkedIndicator?.id === flagId, `${ericRow?.linkedIndicator?.id}/${flagId}`);
  check('two records keep two statuses on the same row', ericRow?.requestStatus === 'PENDING' && ericRow?.linkedIndicator?.status === 'IN_REVIEW', `${ericRow?.requestStatus}/${ericRow?.linkedIndicator?.status}`);
  // Ngozi was provisioned by POST /api/v1/users, which assigns no school — and
  // a school-less reviewer reads an empty queue, which is correct product
  // behaviour but proves nothing here. Enrol her in the school Act 3 just
  // onboarded so she is the case the indicator gate exists for: support staff
  // inside the tenant, looking at the same rows as the counsellor beside her.
  await db(
    `UPDATE "user" SET "schoolId" = (SELECT s.id FROM school s WHERE s.name = $1 LIMIT 1) WHERE email = $2`,
    [SCHOOL.name, NGOZI.email],
  );
  res = await api(ngozi, 'GET', '/api/v1/support-requests/queue');
  const staffRow = (data(res)?.items ?? []).find((r) => r.id === supportRequest.id);
  check('support staff keep the prompt their own queue is built on', staffRow?.prompt === 'REVIEW_SUGGESTED', `prompt ${staffRow?.prompt}`);
  check('and are not handed the indicator record around the back', staffRow?.linkedIndicator === null, JSON.stringify(staffRow?.linkedIndicator));

  res = await api(eric, 'PATCH', `/api/v1/support-requests/${supportRequest.id}`, {
    status: 'ACCEPTED',
    reviewNote: 'Jude, come by my office at 10am.',
  });
  check('professional reviews request (ACCEPTED + note)', data(res)?.status === 'ACCEPTED' && data(res)?.reviewNote?.includes('10am'), data(res)?.reviewNote);

  res = await api(eric, 'POST', '/api/v1/follow-ups', {
    studentId: judeProfileId,
    supportRequestId: supportRequest.id,
    notes: 'Booked biweekly catch-up after exams.',
    dueAt: new Date(Date.now() + 86_400_000).toISOString(),
  });
  const followUp = data(res);
  check('follow-up created (was impossible pre-plan)', res.status === 201 && followUp?.status === 'PENDING', `status ${res.status}`);
  res = await api(eric, 'PATCH', `/api/v1/follow-ups/${followUp.id}`, { status: 'SCHEDULED' });
  check('follow-up scheduled', data(res)?.status === 'SCHEDULED');

  res = await api(eric, 'GET', '/api/v1/audit?limit=100');
  const auditRows = data(res)?.items ?? [];
  const auditActions = auditRows.map((a) => a.action);
  check('audit shows auto-created flag', auditActions.includes('support_flag.auto_created'));
  check('audit shows enrollment + review + follow-up + disclosure trails', auditActions.includes('school.student_enrolled') && auditActions.includes('support_request.status_changed') && auditActions.includes('follow_up.created') && auditActions.includes('ai.disclosure_acknowledged'), `unique actions: ${new Set(auditActions).size}`);
  // PE-15 replaced the old `staff.bootstrap_enrollment` in that list on
  // purpose: ERIC was bootstrapped in Act 1, before any school existed, so his
  // enrolment is a platform event with no tenant to belong to. What a school
  // reviewer must see is the enrolment INTO their own school, which is
  // `school.student_enrolled` — and the proof of the fix is the next row: not
  // one event in this reviewer's trail carries a different school.
  check('every row of a reviewer’s trail is their own school’s', auditRows.length > 0 && auditRows.every((a) => a.schoolId === schoolId), `${auditRows.filter((a) => a.schoolId !== schoolId).length} foreign rows of ${auditRows.length}`);
  check('and the flag an automated lane raised is still visible to the school it concerns', auditRows.some((a) => a.action === 'support_flag.auto_created' && a.schoolId === schoolId));

  // The other half of Epic G's report path: a person in the school reads the
  // reason, and the student who filed it is told nothing about that reading.
  act('Act 7 — ERIC reviews the reported AI reply');
  res = await api(eric, 'GET', '/api/v1/ai-response-reports');
  const reportedRow = (data(res)?.items ?? []).find((r) => r.id === reportReceipt?.id);
  check('the reviewer queue carries the reason the student chose', reportedRow?.reason === 'DIAGNOSIS_OR_MEDICAL_ADVICE'
    && reportedRow?.reviewOutcome === null, `reason ${reportedRow?.reason} outcome ${reportedRow?.reviewOutcome}`);
  check('and the reply text the student saw is the text on file', reportedRow?.responseContent === reportedMessage.content);
  res = await api(eric, 'PATCH', `/api/v1/ai-response-reports/${reportReceipt.id}/review`, { outcome: 'NO_CHANGE_NEEDED' });
  const reviewedReport = data(res);
  check('a reviewer decision is recorded against the reply, not the conversation',
    res.status === 200 && reviewedReport?.reviewOutcome === 'NO_CHANGE_NEEDED' && reviewedReport?.reviewedBy?.role === 'PSYCHOLOGIST',
    `status ${res.status} outcome ${reviewedReport?.reviewOutcome} by ${JSON.stringify(reviewedReport?.reviewedBy)}`);
  res = await api(jude, 'GET', `/api/v1/ai-response-reports/mine?conversationId=${conversation.id}`);
  check('the student receipt after a review says only that it was reported',
    (data(res)?.items ?? []).some((r) => r.id === reportReceipt.id)
    && !JSON.stringify(data(res)).includes('reviewOutcome'), JSON.stringify(data(res))?.slice(0, 120));
  res = await api(ngozi, 'GET', '/api/v1/ai-response-reports');
  check('support staff are not AI-report reviewers', res.status === 403, `status ${res.status}`);

  act('Act 7 — AI configuration explainability endpoint');
  res = await api(eric, 'GET', '/api/v1/ai/config');
  const aiConfig = data(res);
  check('GET /api/v1/ai/config lists intents & actions', Array.isArray(aiConfig?.intents) && aiConfig.intents.some((i) => i.id === 'SUICIDAL_IDEATION'));
  check('config endpoint exposes no secrets', JSON.stringify(aiConfig ?? {}).includes('API key') === false && !JSON.stringify(aiConfig ?? {}).includes('GROQ_API_KEY'));

  // ---------------------------------------------------------------- act 8
  act('Act 8 — RBAC negatives');
  res = await api(anon, 'GET', '/api/v1/check-ins');
  check('anon student route → 401', res.status === 401, `status ${res.status}`);
  res = await api(jude, 'GET', '/api/v1/support-flags');
  check('student staff-route → 403', res.status === 403, `status ${res.status}`);
  res = await api(jude, 'GET', '/api/v1/dashboard/counsellor');
  check('student dashboard → 403', res.status === 403, `status ${res.status}`);
  res = await api(jude, 'GET', '/api/v1/audit');
  check('student audit → 403', res.status === 403, `status ${res.status}`);
  res = await api(jude, 'GET', '/api/v1/ai/config');
  check('student ai/config → 403', res.status === 403, `status ${res.status}`);
  res = await api(jude, 'POST', '/api/v1/users', { name: 'x', email: 'y@z.com', role: 'PSYCHOLOGIST', password: 'LongEnough1#' });
  check('student provisioning → 403', res.status === 403, `status ${res.status}`);
  res = await api(jude, 'GET', '/api/v1/professionals/me');
  check('student professionals/me → 403', res.status === 403, `status ${res.status}`);
  res = await api(jude, 'PATCH', `/api/v1/support-requests/${supportRequest.id}`, { status: 'CANCELLED' });
  check('student cannot review own request via PATCH', res.status === 403, `status ${res.status}`);
  // Epic H's route is the student's own read. A professional reaches the same
  // content through the staff surfaces, never through this one — so the history
  // controller has no staff role to grant, and the frontend can leave the
  // "About your history" page off every staff navigation.
  res = await api(eric, 'GET', '/api/v1/history');
  check('psychologist student-history route → 403', res.status === 403, `status ${res.status}`);
  res = await api(schoolAdmin, 'GET', '/api/v1/history');
  check('school admin student-history route → 403', res.status === 403, `status ${res.status}`);
  res = await api(anon, 'GET', '/api/v1/history');
  check('anon student-history route → 401', res.status === 401, `status ${res.status}`);

  // ---------------------------------------------------------------- act 8b
  act('Act 8b — Epic H: the deletion engine keeps the 24-hour promise');

  const DEL = '/api/v1/history';
  const purgeAskRow = async (id) =>
    (await db('SELECT * FROM history_deletion_request WHERE id = $1', [id])).rows[0] ?? null;
  const purgeCount = async (sql, params = []) =>
    Number((await db(sql, params)).rows[0]?.n ?? -1);

  /**
   * The erasure runs on the worker's own timer (HISTORY_PURGE_POLL_MS, 60s by
   * default), so the run waits for its tick instead of pretending to cause one.
   * Bounded on purpose: an ask that never lands is a FAIL, not a hang. A `null`
   * row is also a result — ALL_HISTORY cascades its own receipt away.
   */
  const waitPurged = async (id, limitMs = 180_000) => {
    const until = Date.now() + limitMs;
    for (;;) {
      const row = await purgeAskRow(id);
      if (row === null || row?.purgedAt || row?.holdReason) return row;
      if (Date.now() > until) return row;
      await new Promise((resolve) => setTimeout(resolve, 3000));
    }
  };
  /**
   * The only fixture this leg needs: the window, walked forward. Everything the
   * erasure itself does is the production code path, on the production SQL.
   */
  const rewindAsk = (id) =>
    db(
      `UPDATE history_deletion_request
       SET "scheduledPurgeAt" = NOW() - interval '1 minute'
       WHERE id = $1`,
      [id],
    );

  const judeUserId = (
    await db('SELECT "userId" FROM student_profile WHERE id = $1', [judeProfileId])
  ).rows[0]?.userId;

  // --- the promise is a schedule, and the undo is real --------------------
  res = await api(jude, 'POST', `${DEL}/deletion-requests`, {
    scope: 'BEFORE_DATE',
    beforeDate: '2026-01-01',
    note: 'The one I am going to cancel.',
  });
  const cancelAsk = data(res);
  check('a dated ask is stored with its window', (res.status === 201 || res.status === 200) && !!cancelAsk?.id && !!cancelAsk?.scheduledPurgeAt, `status ${res.status}`);
  const cancelWindowMinutes = Math.round((Date.parse(cancelAsk?.scheduledPurgeAt ?? '') - Date.now()) / 60000);
  check('the undo window is the 24 hours the student was promised', Math.abs(cancelWindowMinutes - 1440) <= 2, `${cancelWindowMinutes} min`);
  check('filing removes nothing and cancels nothing', cancelAsk?.purgedAt === null && cancelAsk?.cancelledAt === null);

  res = await api(jude, 'POST', `${DEL}/deletion-requests/${cancelAsk.id}/cancel`);
  const cancelledReceipt = data(res);
  check('the student cancels inside the window', (res.status === 200 || res.status === 201) && !!cancelledReceipt?.cancelledAt && cancelledReceipt?.purgedAt === null, `status ${res.status}`);
  const cancelRow = await purgeAskRow(cancelAsk.id);
  check('the cancel is on the row, so the worker will never pick it up', !!cancelRow?.cancelledAt && cancelRow?.purgedAt === null);

  res = await api(jude, 'POST', `${DEL}/deletion-requests/${cancelAsk.id}/cancel`);
  check('a second cancel says so instead of pretending', res.status === 409 && res.body?.code === 'ALREADY_CANCELLED', `status ${res.status} code ${res.body?.code}`);
  res = await api(jude, 'POST', `${DEL}/deletion-requests/${randomUUID()}/cancel`);
  check('an ask that is not the student’s 404s', res.status === 404, `status ${res.status}`);
  res = await api(jude, 'POST', `${DEL}/deletion-requests/not-a-uuid/cancel`);
  check('a malformed ask id is refused before the service sees it', res.status === 400, `status ${res.status}`);
  res = await api(eric, 'POST', `${DEL}/deletion-requests/${cancelAsk.id}/cancel`);
  check('a professional cannot make or unmake the student’s choice (403)', res.status === 403, `status ${res.status}`);

  // --- a scoped erasure erases the scope, and only the scope --------------
  res = await api(jude, 'POST', `${DEL}/deletion-requests`, {
    scope: 'SELECTED_CHECK_INS',
    checkInIds: [checkIn.id, stressedCheckIn.id],
  });
  const scopedAsk = data(res);
  check('the Act 6 ask and this one are both still open receipts', !!scopedAsk?.id && !!scopedAsk?.scheduledPurgeAt);
  const scopedConvIds = (
    await db('SELECT id FROM conversation WHERE "checkInId" = ANY($1::uuid[])', [[checkIn.id, stressedCheckIn.id]])
  ).rows.map((r) => r.id);
  const scopedMsgIds = (
    await db('SELECT id FROM conversation_message WHERE "conversationId" = ANY($1::uuid[])', [scopedConvIds])
  ).rows.map((r) => r.id);
  const scopedFlagsBefore = await purgeCount('SELECT count(*)::int AS n FROM support_flag WHERE "studentId" = $1', [judeProfileId]);
  const scopedRequestsBefore = await purgeCount('SELECT count(*)::int AS n FROM support_request WHERE "studentId" = $1', [judeProfileId]);
  const scopedNoticesBefore = await purgeCount(
    // The Act 4 escalation alert is a row in someone else's inbox that names this
    // conversation. `data ->> …` is text, so the id list goes in as text:
    // comparing it to uuid[] is an operator Postgres does not have.
    `SELECT count(*)::int AS n FROM notification
     WHERE "userId" <> $1::uuid AND "data" ->> 'conversationId' = ANY($2::text[])`,
    [judeUserId, scopedConvIds],
  );
  await rewindAsk(scopedAsk.id);
  const scopedRow = await waitPurged(scopedAsk.id);
  check('the worker carries a closed window out', !!scopedRow?.purgedAt, `holdReason ${scopedRow?.holdReason ?? 'none'}`);
  check('the receipt says what actually went', Number(scopedRow?.removedCheckIns) === 2 && Number(scopedRow?.removedConversations) === scopedConvIds.length, `${scopedRow?.removedCheckIns} check-in(s), ${scopedRow?.removedConversations} conversation(s) of ${scopedConvIds.length}`);
  check('the named entries are gone', await purgeCount('SELECT count(*)::int AS n FROM emotional_check_in WHERE id = ANY($1::uuid[])', [[checkIn.id, stressedCheckIn.id]]) === 0);
  check('the reflections that existed only as those entries went with them', await purgeCount('SELECT count(*)::int AS n FROM conversation WHERE id = ANY($1::uuid[])', [scopedConvIds]) === 0);
  check('their messages went with the cascade', await purgeCount('SELECT count(*)::int AS n FROM conversation_message WHERE id = ANY($1::uuid[])', [scopedMsgIds]) === 0);
  check('no chat thread is left pointing at an erased entry', await purgeCount(
    `SELECT count(*)::int AS n FROM chat_thread t
     WHERE t."entryCheckInId" IS NOT NULL
       AND NOT EXISTS (SELECT 1 FROM emotional_check_in e WHERE e.id = t."entryCheckInId")`,
  ) === 0, 'deletion-spec §2.1 residue repair');
  const scopedFlagsAfter = await purgeCount('SELECT count(*)::int AS n FROM support_flag WHERE "studentId" = $1', [judeProfileId]);
  const scopedRequestsAfter = await purgeCount('SELECT count(*)::int AS n FROM support_request WHERE "studentId" = $1', [judeProfileId]);
  check('a scoped erasure does not quietly take the safeguarding record with it', scopedFlagsAfter === scopedFlagsBefore && scopedRequestsAfter === scopedRequestsBefore, `flags ${scopedFlagsBefore}→${scopedFlagsAfter}, requests ${scopedRequestsBefore}→${scopedRequestsAfter}`);
  check("someone else's inbox stops carrying the erased conversation", await purgeCount(
    `SELECT count(*)::int AS n FROM notification
     WHERE "userId" <> $1::uuid AND "data" ->> 'conversationId' = ANY($2::text[])`,
    [judeUserId, scopedConvIds],
  ) === 0, `${scopedNoticesBefore} staff notice(s) naming it, ${scopedConvIds.length} conversation(s) erased`);
  check('the student is told what was removed', await purgeCount(
    `SELECT count(*)::int AS n FROM notification WHERE type = 'HISTORY_DELETION_EXECUTED' AND "userId" = $1::uuid`,
    [judeUserId],
  ) >= 1);
  res = await api(jude, 'POST', `${DEL}/deletion-requests/${scopedAsk.id}/cancel`);
  check('cancel after the erasure is refused as what it is — nothing left to undo', res.status === 409 && res.body?.code === 'ALREADY_REMOVED', `status ${res.status} code ${res.body?.code}`);
  const scopedAudit = await db(
    `SELECT action, meta FROM audit_log WHERE action = 'history_deletion.executed' AND "entityId" = $1`,
    [scopedAsk.id],
  );
  check('one audit row records the erasure and holds no content', scopedAudit.rowCount === 1 && scopedAudit.rows[0]?.action === 'history_deletion.executed' && !JSON.stringify(scopedAudit.rows[0]?.meta).includes('hostel'), JSON.stringify(scopedAudit.rows[0]?.meta ?? null));
  res = await api(jude, 'GET', `${DEL}/deletion-requests`);
  const receiptList = (data(res)?.items ?? []).find((r) => r.id === scopedAsk.id);
  check('the student’s own list reads the outcome back', !!receiptList?.purgedAt && Number(receiptList?.removedCheckIns) === 2, JSON.stringify(receiptList?.purgedAt));

  // --- the day boundary means UTC midnight, and the account leg ----------
  const amara = makeActor('Amara');
  res = await api(schoolAdmin, 'POST', `/api/v1/schools/${schoolId}/students`, {
    email: AMARA.email,
    firstName: 'Amara',
    lastName: 'Eze',
    classLabel: 'Chemistry 200 Level',
    phone: '+2348077712345',
  });
  const amaraEnrolled = data(res);
  check('a second student is onboarded, to be erased by the account leg', res.status === 201 && amaraEnrolled?.user?.role === 'STUDENT', `status ${res.status}`);
  const amaraUserId = amaraEnrolled?.user?.id;
  const amaraStudentId = (
    await db('SELECT id FROM student_profile WHERE "userId" = $1::uuid', [amaraUserId])
  ).rows[0]?.id;

  const amaraVerify = await devVerificationUrl(anon, AMARA.email);
  if (amaraVerify) {
    const amaraTarget = new URL(amaraVerify);
    res = await api(amara, 'GET', `${amaraTarget.pathname}${amaraTarget.search}`, undefined, { redirect: 'manual' });
    check('Amara verifies her email', res.status === 200 || res.status === 302, `status ${res.status}`);
  }
  res = await api(amara, 'POST', '/api/auth/sign-in/email', { email: AMARA.email, password: SCHOOL.defaultPassword });
  check('Amara signs in with the school default password', res.status === 200, `status ${res.status}`);
  res = await api(amara, 'POST', '/api/v1/auth/first-password', { newPassword: AMARA.password });
  check('Amara sets a personal password', (res.status === 200 || res.status === 201) && data(res)?.passwordChanged === true, `status ${res.status}`);
  await api(amara, 'POST', '/api/v1/consent/accept', { version: 'v1' });
  res = await api(amara, 'GET', '/api/v1/ai/disclosure');
  await api(amara, 'POST', '/api/v1/ai/disclosure/acknowledge', {
    agreements: (data(res)?.agreements ?? []).map((a) => a.id),
  });
  res = await api(amara, 'POST', '/api/v1/check-ins', {
    feeling: 'ANXIOUS',
    intensity: 'A_LITTLE',
    description: 'Act 8b deletion fixture — the entry a dated ask names.',
  });
  const amaraCheckIn = data(res);
  check('Amara has a check-in to erase', !!amaraCheckIn?.id, `status ${res.status}`);
  res = await api(amara, 'POST', '/api/v1/journal', { title: 'Keep', content: 'A journal entry a partial erasure must not reach.', prompt: 'good news' });
  const amaraJournal = data(res);
  check('Amara has a journal entry too', !!amaraJournal?.id, `status ${res.status}`);
  res = await api(amara, 'POST', '/api/v1/support-requests', {
    supportPersonId: ericPerson.id,
    personType: 'PSYCHOLOGIST',
    timing: 'TODAY_STUDY_PERIOD',
    note: 'Act 8b fixture — the safeguarding row the account leg must take.',
  });
  const amaraRequest = data(res);
  check('Amara has a support request on file', !!amaraRequest?.id, `status ${res.status}`);

  const todayUtc = new Date().toISOString().slice(0, 10);
  const tomorrowUtc = new Date(Date.now() + 86_400_000).toISOString().slice(0, 10);
  res = await api(amara, 'POST', `${DEL}/deletion-requests`, { scope: 'BEFORE_DATE', beforeDate: todayUtc });
  const datedTodayAsk = data(res);
  res = await api(amara, 'POST', `${DEL}/deletion-requests`, { scope: 'BEFORE_DATE', beforeDate: tomorrowUtc });
  const datedTomorrowAsk = data(res);
  await Promise.all([rewindAsk(datedTodayAsk.id), rewindAsk(datedTomorrowAsk.id)]);
  const datedTodayRow = await waitPurged(datedTodayAsk.id);
  const datedTomorrowRow = await waitPurged(datedTomorrowAsk.id);
  check('a dated ask runs the day it names, not the day before it', !!datedTodayRow?.purgedAt && Number(datedTodayRow?.removedCheckIns) === 0 && Number(datedTodayRow?.removedConversations) === 0, `${datedTodayRow?.removedCheckIns} check-in(s) for ${todayUtc}`);
  check('and the next day erases what that day created', !!datedTomorrowRow?.purgedAt && Number(datedTomorrowRow?.removedCheckIns) === 1, `${datedTomorrowRow?.removedCheckIns} check-in(s) for ${tomorrowUtc}`);
  check('a dated erasure leaves the account and the journal standing', (await purgeCount('SELECT count(*)::int AS n FROM "user" WHERE id = $1::uuid', [amaraUserId])) === 1 && (await purgeCount('SELECT count(*)::int AS n FROM journal_entry WHERE id = $1::uuid', [amaraJournal.id])) === 1);

  res = await api(amara, 'POST', `${DEL}/deletion-requests`, {
    scope: 'ALL_HISTORY',
    note: 'Like I never existed.',
  });
  const accountAsk = data(res);
  check('ALL_HISTORY is scheduled like any other ask, and deletes nothing yet', (res.status === 201 || res.status === 200) && !!accountAsk?.scheduledPurgeAt && !!accountAsk?.alertedAt && accountAsk?.purgedAt === null, `status ${res.status}`);
  const amaraAuditIds = (
    await db(
      `SELECT id::text AS id FROM emotional_check_in WHERE "studentId" = $1::uuid
       UNION SELECT id::text FROM journal_entry WHERE "studentId" = $1::uuid
       UNION SELECT id::text FROM support_request WHERE "studentId" = $1::uuid
       UNION SELECT id::text FROM support_flag WHERE "studentId" = $1::uuid
       UNION SELECT id::text FROM conversation WHERE "studentId" = $1::uuid
       UNION SELECT id::text FROM consent_record WHERE "studentId" = $1::uuid
       UNION SELECT id::text FROM privacy_preference WHERE "studentId" = $1::uuid
       UNION SELECT id::text FROM history_deletion_request WHERE "studentId" = $1::uuid
       UNION SELECT id::text FROM "user" WHERE id = $2::uuid
       UNION SELECT id::text FROM student_profile WHERE id = $1::uuid`,
      [amaraStudentId, amaraUserId],
    )
  ).rows.map((r) => r.id);
  check('the sweep has ids to find before the rows go', amaraAuditIds.length >= 6, `${amaraAuditIds.length} id(s)`);

  await rewindAsk(accountAsk.id);
  const accountRow = await waitPurged(accountAsk.id);
  check('the account-wide ask leaves no receipt row — the cascade took that too', accountRow === null, JSON.stringify(accountRow?.purgedAt ?? null));
  for (const table of [
    'emotional_check_in',
    'journal_entry',
    'support_request',
    'support_flag',
    'conversation',
    'consent_record',
    'privacy_preference',
    'toolbox_item',
    'session_summary',
    'chat_thread',
    'follow_up',
  ]) {
    const left = await purgeCount(`SELECT count(*)::int AS n FROM ${table} WHERE "studentId" = $1::uuid`, [amaraStudentId]);
    check(`${table}: nothing of Amara’s survives`, left === 0, `${left} row(s) left`);
  }
  check('the login itself is gone', (await purgeCount('SELECT count(*)::int AS n FROM "user" WHERE id = $1::uuid', [amaraUserId])) === 0);
  check('with the profile, the password hash, the sessions and the notices',
    (await purgeCount('SELECT count(*)::int AS n FROM student_profile WHERE id = $1::uuid', [amaraStudentId])) === 0 &&
    (await purgeCount('SELECT count(*)::int AS n FROM account WHERE "userId" = $1::uuid', [amaraUserId])) === 0 &&
    (await purgeCount('SELECT count(*)::int AS n FROM session WHERE "userId" = $1::uuid', [amaraUserId])) === 0 &&
    (await purgeCount('SELECT count(*)::int AS n FROM notification WHERE "userId" = $1::uuid', [amaraUserId])) === 0);
  check('and the verification rows Better Auth keys by contact detail', await purgeCount(
    `SELECT count(*)::int AS n FROM verification WHERE identifier = ANY($1::text[])`,
    [[AMARA.email, '+2348077712345']],
  ) === 0);
  check('no staff inbox anywhere still quotes her', await purgeCount(
    `SELECT count(*)::int AS n FROM notification
     WHERE "body" ILIKE '%Amara%' OR "data" ->> 'studentId' = $1`,
    [amaraStudentId],
  ) === 0);
  const amaraAudit = await db(
    `SELECT action, "entityId", meta FROM audit_log WHERE "entityId" = ANY($1::text[])`,
    [amaraAuditIds],
  );
  check('the audit trail naming her objects is swept, every row of it', amaraAudit.rows.every((r) => r.action === 'history_deletion.executed'), `${amaraAudit.rowCount} left: ${amaraAudit.rows.map((r) => r.action).join(', ')}`);
  check('exactly one row survives the whole erasure — the erasure notice itself', amaraAudit.rowCount === 1 && amaraAudit.rows[0]?.entityId === accountAsk.id, `${amaraAudit.rowCount} row(s)`);
  check('and it carries counts, not the person', !/Amara|amara\.gone|2348077712345/.test(JSON.stringify(amaraAudit.rows[0]?.meta ?? {})), JSON.stringify(amaraAudit.rows[0]?.meta ?? null));
  const throwawayAmara = makeActor('throwaway-Amara');
  res = await api(throwawayAmara, 'POST', '/api/auth/sign-in/email', { email: AMARA.email, password: AMARA.password });
  check('the erased account cannot sign in', res.status === 401, `status ${res.status}`);

  // The Act 6 ask is still open on Jude's 24-hour timer. Stop it: a test fixture
  // that fires a day later would erase rows the browser pass expects to find.
  res = await api(jude, 'POST', `${DEL}/deletion-requests/${deletionAsk.id}/cancel`);
  check('the ask Act 6 left scheduled is cancelled, so no timer outlives the run', (res.status === 200 || res.status === 201) && !!data(res)?.cancelledAt, `status ${res.status}`);

  // ---------------------------------------------------------------- act 9
  act('Act 9 — sign-out really invalidates sessions');
  res = await api(jude, 'POST', '/api/auth/sign-out');
  check('Jude sign-out', res.status === 200, `status ${res.status}`);
  res = await api(jude, 'GET', '/api/users/me');
  check('stale Jude cookie now 401', res.status === 401, `status ${res.status}`);
  res = await api(eric, 'POST', '/api/auth/sign-out');
  res = await api(eric, 'GET', '/api/users/me');
  check('stale Eric cookie now 401', res.status === 401, `status ${res.status}`);
  res = await api(ngozi, 'POST', '/api/auth/sign-out');
  res = await api(ngozi, 'GET', '/api/users/me');
  check('stale Ngozi cookie now 401', res.status === 401, `status ${res.status}`);
  res = await api(schoolAdmin, 'POST', '/api/auth/sign-out');
  res = await api(schoolAdmin, 'GET', '/api/users/me');
  check('stale school admin cookie now 401', res.status === 401, `status ${res.status}`);
  res = await api(owner, 'POST', '/api/auth/sign-out');
  res = await api(owner, 'GET', '/api/users/me');
  check('stale owner cookie now 401', res.status === 401, `status ${res.status}`);

  // ------------------------------------------------------------- summary
  const total = passed + failed;
  const seconds = Math.round((Date.now() - started) / 1000);
  console.log(
    `\n=== E2E JOURNEY RESULT: ${passed}/${total} assertions passed${failed ? ` — ${failed} FAILED` : ' ✓'} (${seconds}s) ===\n`,
  );
}

main()
  .catch((error) => {
    console.error('\nE2E journey crashed:', error?.message ?? error);
    process.exitCode = 1;
  })
  .finally(() => pool.end());

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
 *      message (COMPLETE) and an exhausted job must flip to FAILED
 *   6. Resources / toolbox / journal / support request lifecycle
 *   7. ERIC's professional review — dashboard, flags ack/in-review, request
 *      review (status+note), follow-up create/complete, audit trail, AI config
 *   8. RBAC negatives (+401 anon, 403 student→staff routes)
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

  act('Act 2 — admin seeds Dr. Eric Moore as a support person');
  const ericProf = await db(
    `SELECT p.id FROM professional_profile p JOIN "user" u ON u.id = p."userId" WHERE u.email = $1`,
    [ERIC.email],
  );
  const ericProfileId = ericProf.rows[0]?.id;
  check('Eric professional profile id found', !!ericProfileId);
  await db(
    `INSERT INTO support_person (id, "professionalId", name, type, title, "availabilityLabel", "availableToday", active, "createdAt", "updatedAt")
     VALUES ($2, $1, 'Dr. Eric Moore', 'PSYCHOLOGIST', 'Visiting Clinical Psychologist', 'Available Today', true, true, now(), now())
     ON CONFLICT (name, type) DO UPDATE SET "professionalId" = EXCLUDED."professionalId", active = true, "availableToday" = true`,
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
     VALUES ($1, $2, $2, 'credential', $3, now(), now())`,
    [randomUUID(), ownerId, await hashPassword(OWNER.password)],
  );
  res = await api(owner, 'POST', '/api/auth/sign-in/email', { email: OWNER.email, password: OWNER.password });
  check('platform owner signs in', res.status === 200 && res.body?.user?.role === 'PLATFORM_ADMIN', `status ${res.status}`);

  console.log('  POST /api/v1/schools', JSON.stringify({ name: SCHOOL.name }));
  res = await api(owner, 'POST', '/api/v1/schools', { name: SCHOOL.name, defaultPassword: SCHOOL.defaultPassword });
  const school = data(res);
  check('school created ACTIVE with an acronym short code', res.status === 201 && school?.status === 'ACTIVE' && shortCodeRe('MU').test(school?.shortCode ?? ''), `status ${res.status} code ${school?.shortCode}`);
  const schoolId = school?.id;

  act('Act 3 — school admin provisioned, forced onto a personal password');
  console.log('  POST /api/v1/schools/:id/admins', JSON.stringify({ name: SCHOOL_ADMIN.name, email: SCHOOL_ADMIN.email }));
  res = await api(owner, 'POST', `/api/v1/schools/${schoolId}/admins`, { name: SCHOOL_ADMIN.name, email: SCHOOL_ADMIN.email });
  check('owner provisions the school admin (owner-only route)', res.status === 201 && data(res)?.verificationEmailSent === true, `status ${res.status}`);

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
  check('admin sets a personal password (no old password)', res.status === 200 && data(res)?.passwordChanged === true, `status ${res.status}`);
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
  check('school onboards Jude (201 + verification email)', res.status === 201 && enrolled?.verificationEmailSent === true, `status ${res.status}`);
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
  res = await api(jude, 'GET', '/api/users/me');
  check('Jude role STUDENT, school attached, forced change pending', data(res)?.role === 'STUDENT' && data(res)?.school?.name === SCHOOL.name && data(res)?.mustChangePassword === true, `role=${data(res)?.role} school=${data(res)?.school?.name} mustChange=${data(res)?.mustChangePassword}`);

  res = await api(jude, 'POST', '/api/v1/auth/first-password', { newPassword: JUDE.password });
  check('Jude sets a personal password', res.status === 200 && data(res)?.passwordChanged === true, `status ${res.status}`);
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
  res = await api(jude, 'POST', '/api/v1/ai/disclosure/acknowledge');
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
    return api(jude, 'POST', `/api/v1/conversations/${conversation.id}/messages`, { content, language: 'en' });
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

  // ---------------------------------------------------------------- act 6
  act('Act 6 — resources, toolbox, journal, support request');
  res = await api(jude, 'GET', '/api/v1/resources');
  const resources = data(res)?.items ?? [];
  check('resource catalogue present (seed ≥5)', resources.length >= 5, String(resources.length));
  res = await api(jude, 'GET', '/api/v1/resources/tailored', undefined);
  check('tailored resources exist', ((data(res)?.items ?? []).length >= 1));
  const groundingResource = resources.find((r) => r.category === 'GROUNDING');
  res = await api(jude, 'POST', '/api/v1/resources/toolbox', { resourceId: groundingResource?.id ?? resources[0].id });
  check('toolbox save', res.status === 201 || res.status === 200, `status ${res.status}`);
  res = await api(jude, 'GET', '/api/v1/resources/toolbox');
  check('toolbox lists saved resource', data(res)?.count === 1);

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
  check('Dr. Eric Moore visible to Jude', !!ericPerson);
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
  check('student sees own requests', (data(res)?.items ?? []).length === 1);

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

  res = await api(eric, 'GET', '/api/v1/audit?limit=30');
  const auditActions = (data(res)?.items ?? []).map((a) => a.action);
  check('audit shows auto-created flag', auditActions.includes('support_flag.auto_created'));
  check('audit shows enrollment + review + follow-up + disclosure trails', auditActions.includes('staff.bootstrap_enrollment') && auditActions.includes('support_request.status_changed') && auditActions.includes('follow_up.created') && auditActions.includes('ai.disclosure_acknowledged'), `unique actions: ${new Set(auditActions).size}`);

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

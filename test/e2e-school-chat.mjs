/**
 * NATLAS SCHOOL TENANCY + HUMAN CHAT — END-TO-END
 * --------------------------------------------------------------------------
 * The full multi-tenant lifecycle, live realtime included, in one run:
 *
 *   0. Preflight + clean slate; raw-SQL bootstrap of a PLATFORM_ADMIN
 *   1. Platform console — create two schools (6-char short codes derived from
 *      the acronym), guard against onboarding with no school default password,
 *      set it, list schools, platform overview
 *   2. School onboarding — admin enrolls a student + professional (school A)
 *      and a student (school B); each verifies via the dev link, signs in with
 *      the school default password (profile shows school + forced change),
 *      gets 403 PASSWORD_CHANGE_REQUIRED outside the allowlist, sets a
 *      personal password, and the old default stops working
 *   3. Realtime auth — cookie-authenticated sockets connect; an anonymous
 *      socket is dropped server-side
 *   4. A student asks to talk — check-in → thread (AI-labeled SYSTEM entry
 *      note, sensitive check-in text excluded) → the school's professionals
 *      get chat.request.created live; a student of ANOTHER school gets
 *      nothing and is barred at REST
 *   5. Claim — first professional wins; both sides see chat.thread.claimed
 *      live; a second claim is refused
 *   6. Messages — REST writes, live chat.message.new + notification.new +
 *      chat.unread.updated to the right rooms only; read markers zero badges
 *   7. Close — both sides notified; messaging a closed thread is refused
 *   8. Suspend — live sockets die ('io server disconnect'), sessions are
 *      revoked, sign-in 403 SCHOOL_SUSPENDED, durable notification rows
 *   9. Reactivate — sign-in and sockets work again
 *  10. Whole-run assertion: school B's student saw ZERO realtime events
 *
 * Non-zero exit on any assertion failure. Safe to re-run: Act 0 cleans all
 * test data (schools by name, users by email) then re-bootstraps the admin.
 *
 * Usage:  npm run test:e2e:school-chat   (server must be running on :3000)
 */
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { io } from 'socket.io-client';
import { hashPassword } from 'better-auth/crypto';

const BASE = process.env.E2E_BASE_URL ?? 'http://localhost:3000';
const DB_URL =
  process.env.E2E_DATABASE_URL ??
  process.env.DATABASE_URL ??
  'postgresql://postgres:postgres@localhost:5432/natlas';
const ORIGIN = BASE;
const SOCKET_PATH = '/api/socket.io';
const SHORT_CODE_CHARSET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

const ADMIN = {
  name: 'Platform Owner',
  email: 'platform.owner@e2e.natlas.test',
  password: 'OwnerSafe123#',
};
const SCHOOL_A = { name: 'Riverside Academy', defaultPassword: 'Riverside#2026' };
const SCHOOL_B = { name: 'Hilltop School', defaultPassword: 'Hilltop#2026' };
const STUDENT_A = {
  name: 'Ama Mensah',
  email: 'ama.mensah@e2e.natlas.test',
  password: 'AmaSafe123#',
  classLabel: 'JSS 2B',
};
const PRO_A = {
  name: 'Dr. Kojo Ashanti',
  email: 'kojo.ashanti@e2e.natlas.test',
  password: 'KojoSafe123#',
  role: 'COUNSELLOR',
  title: 'Senior Counsellor',
  department: 'Guidance & Counselling',
};
const STUDENT_B = {
  name: 'Bilal Yakubu',
  email: 'bilal.yakubu@e2e.natlas.test',
  password: 'BilalSafe123#',
  classLabel: 'P5',
};
const ADMIN_EMAIL = ADMIN.email;
const ALL_EMAILS = [
  ADMIN.email,
  STUDENT_A.email,
  PRO_A.email,
  STUDENT_B.email,
];
const SCHOOL_NAMES = [SCHOOL_A.name, SCHOOL_B.name];

// ---------------------------------------------------------------------------
// tiny HTTP client with per-actor cookie jars (same pattern as e2e-journey)
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

// ---------------------------------------------------------------------------
// tiny realtime client with per-socket event recorders
// ---------------------------------------------------------------------------
const TRACKED_EVENTS = [
  'chat.request.created',
  'chat.thread.claimed',
  'chat.message.new',
  'chat.thread.closed',
  'chat.unread.updated',
  'notification.new',
  'notification.unread.updated',
];

const sockets = [];
function connectSocket(label, actor) {
  const headers = { origin: ORIGIN };
  if (actor && actor.jar.size > 0) {
    headers.cookie = [...actor.jar.entries()]
      .map(([k, v]) => `${k}=${v}`)
      .join('; ');
  }
  const sock = io(BASE, {
    path: SOCKET_PATH,
    transports: ['websocket'],
    reconnection: false,
    forceNew: true,
    timeout: 5000,
    extraHeaders: headers,
  });
  const rec = {
    label,
    sock,
    connected: false,
    connectError: null,
    disconnectReason: null,
    events: [],
  };
  sock.on('connect', () => {
    rec.connected = true;
  });
  sock.on('connect_error', (error) => {
    rec.connectError = error?.message ?? String(error);
  });
  sock.on('disconnect', (reason) => {
    rec.disconnectReason = reason;
    rec.connected = false;
  });
  for (const name of TRACKED_EVENTS) {
    sock.on(name, (payload) => rec.events.push({ name, payload }));
  }
  sockets.push(rec);
  return rec;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(predicate, timeoutMs = 7000, intervalMs = 50) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = predicate();
    if (value) return value;
    await sleep(intervalMs);
  }
  return null;
}

function findEvent(rec, name, predicate = () => true) {
  return rec.events.find((event) => event.name === name && predicate(event.payload));
}

async function waitForEvent(rec, name, predicate = () => true, timeoutMs = 7000) {
  return waitFor(() => findEvent(rec, name, predicate), timeoutMs);
}

const eventNames = (rec) => rec.events.map((event) => event.name).join(', ');

const shortCodeRe = (prefix) => new RegExp(`^${prefix}[${SHORT_CODE_CHARSET}]{4}$`);

// ---------------------------------------------------------------------------
async function main() {
  const started = Date.now();
  const admin = makeActor('Admin');
  const studentA = makeActor('StudentA');
  const proA = makeActor('ProA');
  const studentB = makeActor('StudentB');
  const anon = null;

  // ---------------------------------------------------------------- act 0
  act('Act 0 — preflight, clean slate, platform admin bootstrap');

  let res = await api(anon, 'GET', '/api/health/auth');
  check('API + auth reachable', res.status === 200 && data(res)?.service === 'auth', `status ${res.status}`);
  const ping = await db('SELECT 1 AS ok');
  check('database reachable', ping.rows[0]?.ok === 1);

  await db(
    `DELETE FROM chat_thread WHERE "schoolId" IN (SELECT id FROM school WHERE name = ANY($1))`,
    [SCHOOL_NAMES],
  );
  const usersDeleted = await db('DELETE FROM "user" WHERE email = ANY($1)', [ALL_EMAILS]);
  const schoolsDeleted = await db('DELETE FROM school WHERE name = ANY($1)', [SCHOOL_NAMES]);
  await db('DELETE FROM verification WHERE identifier = ANY($1)', [ALL_EMAILS]);
  console.log(
    `    (clean slate: removed ${usersDeleted.rowCount} users, ${schoolsDeleted.rowCount} schools)`,
  );

  const adminId = randomUUID();
  await db(
    `INSERT INTO "user" (id, name, email, "emailVerified", role, "mustChangePassword", "createdAt", "updatedAt")
     VALUES ($1, $2, $3, true, 'PLATFORM_ADMIN', false, now(), now())`,
    [adminId, ADMIN.name, ADMIN.email],
  );
  await db(
    `INSERT INTO account (id, "userId", "accountId", "providerId", password, "createdAt", "updatedAt")
     VALUES ($1, $2, $2, 'credential', $3, now(), now())`,
    [randomUUID(), adminId, await hashPassword(ADMIN.password)],
  );

  res = await api(admin, 'POST', '/api/auth/sign-in/email', {
    email: ADMIN.email,
    password: ADMIN.password,
  });
  check('platform admin signs in', res.status === 200, `status ${res.status}`);
  const adminMe = await api(admin, 'GET', '/api/v1/users/me');
  check('admin profile role PLATFORM_ADMIN', data(adminMe)?.role === 'PLATFORM_ADMIN');

  // ---------------------------------------------------------------- act 1
  act('Act 1 — platform console: schools, short codes, default-password guard');

  res = await api(admin, 'POST', '/api/v1/schools', {
    name: SCHOOL_A.name,
    defaultPassword: SCHOOL_A.defaultPassword,
  });
  check('school A created', res.status === 201, `status ${res.status}`);
  const schoolA = data(res);
  check(
    'school A short code is acronym-derived (RA + 4)',
    shortCodeRe('RA').test(schoolA?.shortCode ?? ''),
    schoolA?.shortCode,
  );
  check('school A starts ACTIVE', schoolA?.status === 'ACTIVE');

  res = await api(admin, 'POST', '/api/v1/schools', { name: SCHOOL_B.name });
  check('school B created', res.status === 201, `status ${res.status}`);
  const schoolB = data(res);
  check(
    'school B short code is acronym-derived (HS + 4)',
    shortCodeRe('HS').test(schoolB?.shortCode ?? ''),
    schoolB?.shortCode,
  );

  res = await api(admin, 'POST', `/api/v1/schools/${schoolB.id}/students`, {
    email: STUDENT_B.email,
    firstName: 'Bilal',
    lastName: 'Yakubu',
    classLabel: STUDENT_B.classLabel,
  });
  check(
    'onboarding without a default password → 422 SCHOOL_DEFAULT_PASSWORD_REQUIRED',
    res.status === 422 &&
      JSON.stringify(res.body).includes('SCHOOL_DEFAULT_PASSWORD_REQUIRED'),
    `status ${res.status}`,
  );

  res = await api(admin, 'PATCH', `/api/v1/schools/${schoolB.id}/settings`, {
    defaultPassword: SCHOOL_B.defaultPassword,
  });
  check(
    'school B default password set',
    res.status === 200 && data(res)?.defaultPasswordUpdated === true,
    `status ${res.status}`,
  );

  res = await api(admin, 'GET', '/api/v1/schools');
  const schoolList = data(res)?.items ?? [];
  check(
    'school list shows both schools with user counts',
    res.status === 200 &&
      schoolList.some((s) => s.name === SCHOOL_A.name && s._count?.users !== undefined) &&
      schoolList.some((s) => s.name === SCHOOL_B.name),
  );

  res = await api(admin, 'GET', '/api/v1/admin/overview');
  const overview = data(res);
  check(
    'platform overview shape {schools, users, chat}',
    res.status === 200 &&
      typeof overview?.schools?.total === 'number' &&
      typeof overview?.schools?.active === 'number' &&
      typeof overview?.users?.students === 'number' &&
      typeof overview?.users?.professionals === 'number' &&
      typeof overview?.chat?.pendingRequests === 'number',
  );

  // ---------------------------------------------------------------- act 2
  act('Act 2 — school onboarding: verify → default password → forced change');

  async function enrollUser({ actor, school, defaultPassword, personalPassword, kind, body, studentCodeRe }) {
    const path =
      kind === 'student'
        ? `/api/v1/schools/${school.id}/students`
        : `/api/v1/schools/${school.id}/professionals`;
    let r = await api(admin, 'POST', path, body);
    const enrolled = data(r);
    check(
      `${kind} ${body.email} onboarded under ${school.name}`,
      r.status === 201 && enrolled?.verificationEmailSent === true && Boolean(enrolled?.user?.id),
      `status ${r.status}`,
    );
    if (studentCodeRe) {
      check(
        `student code follows school short code (${school.shortCode}-####)`,
        studentCodeRe.test(enrolled?.studentCode ?? ''),
        enrolled?.studentCode,
      );
    }

    const verifyUrl = await devVerificationUrl(anon, body.email);
    check(`verification link dispatched for ${body.email}`, Boolean(verifyUrl));
    if (!verifyUrl) return { userId: enrolled?.user?.id };
    const target = new URL(verifyUrl);
    r = await api(actor, 'GET', `${target.pathname}${target.search}`, undefined, {
      redirect: 'manual',
    });
    check(
      `verification link accepted for ${body.email}`,
      [200, 302].includes(r.status),
      `status ${r.status}`,
    );

    r = await api(actor, 'POST', '/api/auth/sign-in/email', {
      email: body.email,
      password: defaultPassword,
    });
    check(`${body.email} signs in with the school default password`, r.status === 200, `status ${r.status}`);

    r = await api(actor, 'GET', '/api/v1/users/me');
    const me = data(r);
    check(
      `${body.email} profile shows school + forced change`,
      r.status === 200 &&
        me?.school?.name === school.name &&
        me?.mustChangePassword === true &&
        me?.emailVerified === true,
      `school=${me?.school?.name} mustChange=${me?.mustChangePassword}`,
    );

    r = await api(actor, 'GET', '/api/v1/chat/unread');
    check(
      `${body.email} blocked from chat until password change (403 PASSWORD_CHANGE_REQUIRED)`,
      r.status === 403 && JSON.stringify(r.body).includes('PASSWORD_CHANGE_REQUIRED'),
      `status ${r.status}`,
    );

    r = await api(actor, 'POST', '/api/v1/auth/first-password', {
      newPassword: personalPassword,
    });
    check(`${body.email} sets a personal password (no old password)`, r.status === 200 && data(r)?.passwordChanged === true, `status ${r.status}`);

    r = await api(actor, 'GET', '/api/v1/chat/unread');
    check(`${body.email} allowed again after the change`, r.status === 200 && data(r)?.total === 0);

    const throwaway = makeActor(`throwaway-${body.email}`);
    r = await api(throwaway, 'POST', '/api/auth/sign-in/email', {
      email: body.email,
      password: defaultPassword,
    });
    check(`${body.email} default password dead after the change`, r.status === 401, `status ${r.status}`);
    r = await api(throwaway, 'POST', '/api/auth/sign-in/email', {
      email: body.email,
      password: personalPassword,
    });
    check(`${body.email} personal password works`, r.status === 200, `status ${r.status}`);

    return { userId: enrolled?.user?.id };
  }

  const studentAEnrollment = await enrollUser({
    actor: studentA,
    school: schoolA,
    defaultPassword: SCHOOL_A.defaultPassword,
    personalPassword: STUDENT_A.password,
    kind: 'student',
    body: {
      email: STUDENT_A.email,
      firstName: 'Ama',
      lastName: 'Mensah',
      classLabel: STUDENT_A.classLabel,
    },
    studentCodeRe: new RegExp(`^${schoolA.shortCode}-\\d{4}$`),
  });
  const studentAId = studentAEnrollment.userId;

  const proAEnrollment = await enrollUser({
    actor: proA,
    school: schoolA,
    defaultPassword: SCHOOL_A.defaultPassword,
    personalPassword: PRO_A.password,
    kind: 'professional',
    body: {
      email: PRO_A.email,
      name: PRO_A.name,
      role: PRO_A.role,
      title: PRO_A.title,
      department: PRO_A.department,
    },
  });
  const proAId = proAEnrollment.userId;

  const studentBEnrollment = await enrollUser({
    actor: studentB,
    school: schoolB,
    defaultPassword: SCHOOL_B.defaultPassword,
    personalPassword: STUDENT_B.password,
    kind: 'student',
    body: {
      email: STUDENT_B.email,
      firstName: 'Bilal',
      lastName: 'Yakubu',
      classLabel: STUDENT_B.classLabel,
    },
    studentCodeRe: new RegExp(`^${schoolB.shortCode}-\\d{4}$`),
  });
  const studentBId = studentBEnrollment.userId;

  // ---------------------------------------------------------------- act 3
  act('Act 3 — realtime auth: cookie sockets connect, anonymous is dropped');

  const sockStudentA = connectSocket('studentA', studentA);
  const sockProA = connectSocket('proA', proA);
  const sockStudentB = connectSocket('studentB', studentB);
  const sockAnon = connectSocket('anonymous', null);

  await waitFor(
    () =>
      (sockStudentA.connected || sockStudentA.connectError) &&
      (sockProA.connected || sockProA.connectError) &&
      (sockStudentB.connected || sockStudentB.connectError),
    8000,
  );
  check('student A socket connected', sockStudentA.connected, sockStudentA.connectError ?? '');
  check('professional A socket connected', sockProA.connected, sockProA.connectError ?? '');
  check('student B socket connected', sockStudentB.connected, sockStudentB.connectError ?? '');
  await sleep(1500);
  check(
    'anonymous socket dropped server-side',
    !sockAnon.connected,
    sockAnon.connectError ?? sockAnon.disconnectReason ?? 'no reason reported',
  );

  // ---------------------------------------------------------------- act 4
  act('Act 4 — student asks to talk: pool push + cross-school isolation');

  res = await api(studentA, 'POST', '/api/v1/check-ins', {
    feeling: 'ANXIOUS',
    intensity: 'A_LOT',
    description: 'Exams are piling up and I keep losing sleep.',
    triggers: ['exams', 'sleep'],
  });
  check('student A check-in created', res.status === 201, `status ${res.status}`);
  const checkInId = data(res)?.id;

  res = await api(studentA, 'POST', '/api/v1/chat/threads', {
    note: 'I would like to talk to someone about exams.',
    checkInId,
  });
  check('chat request created (201)', res.status === 201, `status ${res.status}`);
  const threadA = data(res);
  check('thread starts PENDING', threadA?.status === 'PENDING');
  check('thread carries the entry check-in', threadA?.entryCheckInId === checkInId);
  const systemMessage = threadA?.messages?.[0];
  check(
    'entry note is a SYSTEM message equal to the summary',
    systemMessage?.role === 'SYSTEM' &&
      systemMessage?.content === threadA?.aiEntrySummary &&
      Boolean(threadA?.aiEntrySummary),
  );
  check(
    'entry note is labeled AI-composed (composedByAi boolean)',
    typeof systemMessage?.meta?.composedByAi === 'boolean',
    `meta=${JSON.stringify(systemMessage?.meta)}`,
  );
  check(
    'sensitive check-in description not woven into the entry note',
    !systemMessage?.content?.includes('piling up'),
  );

  const requestEvent = await waitForEvent(
    sockProA,
    'chat.request.created',
    (payload) => payload?.threadId === threadA.id,
  );
  check('professional sees chat.request.created live', Boolean(requestEvent), eventNames(sockProA));
  check(
    'request event carries student first name + class label',
    requestEvent?.payload?.student?.firstName === 'Ama' &&
      requestEvent?.payload?.student?.classLabel === 'JSS 2B',
    JSON.stringify(requestEvent?.payload?.student),
  );
  check(
    'request event carries pendingCount (school-scoped = 1)',
    requestEvent?.payload?.pendingCount === 1,
    `pendingCount=${requestEvent?.payload?.pendingCount}`,
  );
  const requestNotif = await waitForEvent(
    sockProA,
    'notification.new',
    (payload) => payload?.type === 'CHAT_REQUEST',
  );
  check('professional gets a CHAT_REQUEST notification', Boolean(requestNotif));

  res = await api(studentA, 'POST', '/api/v1/chat/threads', {
    note: 'another ask while one is pending',
  });
  check(
    'second pending request refused (409 PENDING_REQUEST_EXISTS)',
    res.status === 409 && JSON.stringify(res.body).includes('PENDING_REQUEST_EXISTS'),
    `status ${res.status}`,
  );

  res = await api(proA, 'GET', '/api/v1/chat/inbox');
  check(
    'professional inbox lists the pending thread',
    res.status === 200 && (data(res)?.items ?? []).some((t) => t.id === threadA.id),
  );
  res = await api(studentA, 'GET', '/api/v1/chat/threads');
  check(
    'student thread list lists the request',
    res.status === 200 && (data(res)?.items ?? []).some((t) => t.id === threadA.id),
  );

  res = await api(studentB, 'POST', '/api/v1/check-ins', {
    feeling: 'STRESSED',
    intensity: 'SOMEWHAT',
    triggers: ['friends'],
  });
  const checkInB = data(res)?.id;
  res = await api(studentB, 'POST', '/api/v1/chat/threads', {
    note: 'school B concern',
    checkInId: checkInB,
  });
  check('student B creates a school B thread', res.status === 201, `status ${res.status}`);
  const threadB = data(res);

  await sleep(1200); // grace: any (wrong) cross-school push would land now
  const proARequestEvents = sockProA.events.filter((e) => e.name === 'chat.request.created');
  check(
    'professional A saw exactly one request event — school A only',
    proARequestEvents.length === 1 && proARequestEvents[0].payload?.threadId === threadA.id,
    `count=${proARequestEvents.length}`,
  );
  check(
    'student B socket saw zero realtime events',
    sockStudentB.events.length === 0,
    eventNames(sockStudentB),
  );

  res = await api(studentB, 'GET', `/api/v1/chat/threads/${threadA.id}`);
  check('student B cannot read school A thread (404)', res.status === 404, `status ${res.status}`);
  res = await api(studentB, 'POST', `/api/v1/chat/threads/${threadA.id}/claim`);
  check('student B cannot claim (403, staff route)', res.status === 403, `status ${res.status}`);
  res = await api(studentB, 'GET', '/api/v1/chat/inbox');
  check('student B cannot see the staff inbox (403)', res.status === 403, `status ${res.status}`);
  res = await api(studentB, 'GET', '/api/v1/chat/unread');
  check('student B unread is zero (own school only)', res.status === 200 && data(res)?.total === 0);

  // ---------------------------------------------------------------- act 5
  act('Act 5 — claim: first professional wins, everyone sees it live');

  res = await api(proA, 'POST', `/api/v1/chat/threads/${threadA.id}/claim`);
  check('professional A claims the request', [200, 201].includes(res.status), `status ${res.status}`);
  const claimed = data(res);
  check('thread now ACTIVE', claimed?.status === 'ACTIVE');
  check(
    'claim payload names the professional',
    claimed?.professional?.user?.name === PRO_A.name,
    claimed?.professional?.user?.name,
  );

  const claimedStudent = await waitForEvent(
    sockStudentA,
    'chat.thread.claimed',
    (payload) => payload?.threadId === threadA.id,
  );
  check('student sees chat.thread.claimed live', Boolean(claimedStudent), eventNames(sockStudentA));
  check(
    'claim event carries the professional name',
    claimedStudent?.payload?.professionalName === PRO_A.name,
    claimedStudent?.payload?.professionalName,
  );
  const claimedProA = await waitForEvent(
    sockProA,
    'chat.thread.claimed',
    (payload) => payload?.threadId === threadA.id,
  );
  check('the school professionals room sees the claim too', Boolean(claimedProA));
  const claimedNotif = await waitForEvent(
    sockStudentA,
    'notification.new',
    (payload) => payload?.type === 'CHAT_CLAIMED',
  );
  check('student gets a CHAT_CLAIMED notification', Boolean(claimedNotif));

  res = await api(proA, 'POST', `/api/v1/chat/threads/${threadA.id}/claim`);
  check(
    'second claim refused (409 CHAT_THREAD_TAKEN)',
    res.status === 409 && JSON.stringify(res.body).includes('CHAT_THREAD_TAKEN'),
    `status ${res.status}`,
  );
  res = await api(proA, 'GET', '/api/v1/chat/inbox');
  check('inbox is empty after the claim', res.status === 200 && (data(res)?.items ?? []).length === 0);

  // ---------------------------------------------------------------- act 6
  act('Act 6 — messages: REST writes, room-targeted push, unread badges');

  const studentText = 'I keep panicking before every exam.';
  res = await api(studentA, 'POST', `/api/v1/chat/threads/${threadA.id}/messages`, {
    content: studentText,
    viaVoice: true,
  });
  check('student message sent', [200, 201].includes(res.status), `status ${res.status}`);
  check(
    'message stored as STUDENT with viaVoice',
    data(res)?.role === 'STUDENT' && data(res)?.viaVoice === true,
  );

  const proGotStudentMsg = await waitForEvent(
    sockProA,
    'chat.message.new',
    (payload) => payload?.threadId === threadA.id && payload?.message?.role === 'STUDENT',
  );
  check('professional receives chat.message.new live', Boolean(proGotStudentMsg), eventNames(sockProA));
  check('voice flag crosses realtime', proGotStudentMsg?.payload?.message?.viaVoice === true);
  const selfEcho = await waitForEvent(
    sockStudentA,
    'chat.message.new',
    (payload) =>
      payload?.threadId === threadA.id &&
      payload?.message?.role === 'STUDENT' &&
      payload?.message?.content === studentText,
  );
  check('sender socket gets the same message event', Boolean(selfEcho));

  const proNotif = await waitForEvent(
    sockProA,
    'notification.new',
    (payload) => payload?.type === 'CHAT_REPLY',
  );
  check('professional gets a CHAT_REPLY notification', Boolean(proNotif));
  const proUnread = await waitForEvent(
    sockProA,
    'chat.unread.updated',
    (payload) => payload?.total === 1,
  );
  check('professional unread badge → 1 live', Boolean(proUnread), eventNames(sockProA));
  check('unread byThread points at the thread', proUnread?.payload?.byThread?.[threadA.id] === 1);

  const replyText = 'Thank you for reaching out — let us work through exam nerves together.';
  res = await api(proA, 'POST', `/api/v1/chat/threads/${threadA.id}/messages`, {
    content: replyText,
    viaVoice: false,
  });
  check('professional reply sent', [200, 201].includes(res.status), `status ${res.status}`);

  const stuGotReply = await waitForEvent(
    sockStudentA,
    'chat.message.new',
    (payload) => payload?.threadId === threadA.id && payload?.message?.role === 'PROFESSIONAL',
  );
  check('student receives the reply live', Boolean(stuGotReply), eventNames(sockStudentA));
  const stuNotif = await waitForEvent(
    sockStudentA,
    'notification.new',
    (payload) => payload?.type === 'CHAT_REPLY',
  );
  check('student gets a CHAT_REPLY notification', Boolean(stuNotif));
  const stuUnread = await waitForEvent(
    sockStudentA,
    'chat.unread.updated',
    (payload) => payload?.total === 1,
  );
  check('student unread badge → 1 live', Boolean(stuUnread));

  res = await api(studentA, 'GET', '/api/v1/chat/unread');
  const unreadRest = data(res);
  check(
    'student unread REST {total:1, byThread:{thread:1}}',
    res.status === 200 && unreadRest?.total === 1 && unreadRest?.byThread?.[threadA.id] === 1,
    JSON.stringify(unreadRest),
  );

  res = await api(studentA, 'POST', `/api/v1/chat/threads/${threadA.id}/read`);
  check(
    'student marks read',
    [200, 201].includes(res.status) && data(res)?.id === threadA.id && data(res)?.read === true,
    `status ${res.status}`,
  );
  const stuUnreadZero = await waitForEvent(
    sockStudentA,
    'chat.unread.updated',
    (payload) => payload?.total === 0,
  );
  check('student badge → 0 live after read', Boolean(stuUnreadZero));

  res = await api(proA, 'POST', `/api/v1/chat/threads/${threadA.id}/read`);
  const proUnreadZero = await waitForEvent(
    sockProA,
    'chat.unread.updated',
    (payload) => payload?.total === 0,
  );
  check('professional badge → 0 live after read', Boolean(proUnreadZero));

  res = await api(studentA, 'GET', `/api/v1/chat/threads/${threadA.id}`);
  const fullThread = data(res);
  const messages = fullThread?.messages ?? [];
  check('full thread has exactly 3 messages', messages.length === 3, `count=${messages.length}`);
  check(
    'exactly one SYSTEM entry note, AI-labeled',
    messages.filter((m) => m.role === 'SYSTEM').length === 1 &&
      typeof messages.find((m) => m.role === 'SYSTEM')?.meta?.composedByAi === 'boolean',
  );
  check(
    'non-system messages carry sender ids',
    messages.filter((m) => m.role !== 'SYSTEM').every((m) => Boolean(m.senderUserId)),
  );
  check(
    'message order is entry → student → professional',
    messages[1]?.role === 'STUDENT' &&
      messages[1]?.content === studentText &&
      messages[2]?.role === 'PROFESSIONAL' &&
      messages[2]?.content === replyText,
  );

  // ---------------------------------------------------------------- act 7
  act('Act 7 — close: both sides notified, closed thread refuses messages');

  res = await api(studentA, 'POST', `/api/v1/chat/threads/${threadA.id}/close`);
  check(
    'student closes the chat',
    [200, 201].includes(res.status) && data(res)?.status === 'CLOSED',
    `status ${res.status}`,
  );
  const closedStudent = await waitForEvent(
    sockStudentA,
    'chat.thread.closed',
    (payload) => payload?.threadId === threadA.id,
  );
  const closedPro = await waitForEvent(
    sockProA,
    'chat.thread.closed',
    (payload) => payload?.threadId === threadA.id,
  );
  check('both sides see chat.thread.closed live', Boolean(closedStudent && closedPro));

  res = await api(studentA, 'POST', `/api/v1/chat/threads/${threadA.id}/messages`, {
    content: 'are you still there?',
  });
  check(
    'message after close refused (409 CHAT_THREAD_CLOSED)',
    res.status === 409 && JSON.stringify(res.body).includes('CHAT_THREAD_CLOSED'),
    `status ${res.status}`,
  );
  res = await api(studentA, 'POST', `/api/v1/chat/threads/${threadA.id}/close`);
  check('re-close is idempotent', [200, 201].includes(res.status) && data(res)?.status === 'CLOSED');

  // ---------------------------------------------------------------- act 8
  act('Act 8 — suspend: sockets die, sessions revoked, sign-in blocked');

  res = await api(admin, 'POST', `/api/v1/schools/${schoolA.id}/suspend`);
  check(
    'school A suspended',
    [200, 201].includes(res.status) && data(res)?.status === 'SUSPENDED',
    `status ${res.status}`,
  );
  const bothDropped = await waitFor(
    () =>
      sockStudentA.disconnectReason === 'io server disconnect' &&
      sockProA.disconnectReason === 'io server disconnect',
  );
  check(
    'school A sockets force-dropped by the server',
    Boolean(bothDropped),
    `student=${sockStudentA.disconnectReason} pro=${sockProA.disconnectReason}`,
  );
  check('dropped sockets report disconnected', !sockStudentA.connected && !sockProA.connected);
  await sleep(800);
  check('school B socket survives (different user room)', sockStudentB.connected);

  res = await api(studentA, 'GET', '/api/v1/users/me');
  check('stale school A session revoked (401)', res.status === 401, `status ${res.status}`);
  res = await api(studentA, 'POST', '/api/auth/sign-in/email', {
    email: STUDENT_A.email,
    password: STUDENT_A.password,
  });
  check(
    'student sign-in blocked (403 SCHOOL_SUSPENDED)',
    res.status === 403 && JSON.stringify(res.body).includes('SCHOOL_SUSPENDED'),
    `status ${res.status}`,
  );
  res = await api(proA, 'POST', '/api/auth/sign-in/email', {
    email: PRO_A.email,
    password: PRO_A.password,
  });
  check(
    'professional sign-in blocked (403 SCHOOL_SUSPENDED)',
    res.status === 403 && JSON.stringify(res.body).includes('SCHOOL_SUSPENDED'),
    `status ${res.status}`,
  );

  const suspendNotifs = await db(
    `SELECT COUNT(*)::int AS count FROM notification
     WHERE type = 'SCHOOL_SUSPENDED' AND "userId" = ANY($1)`,
    [[studentAId, proAId]],
  );
  check(
    'durable SCHOOL_SUSPENDED notifications written for both users',
    (suspendNotifs.rows[0]?.count ?? 0) >= 2,
    `count=${suspendNotifs.rows[0]?.count}`,
  );
  const studentBNotifs = await db(
    `SELECT COUNT(*)::int AS count FROM notification
     WHERE type = 'SCHOOL_SUSPENDED' AND "userId" = $1`,
    [studentBId],
  );
  check(
    "school B's student received no suspension notification",
    (studentBNotifs.rows[0]?.count ?? 0) === 0,
    `count=${studentBNotifs.rows[0]?.count}`,
  );
  res = await api(studentB, 'GET', '/api/v1/chat/unread');
  check('school B REST is unaffected', res.status === 200);

  // ---------------------------------------------------------------- act 9
  act('Act 9 — reactivate: sign-in and realtime come back');

  res = await api(admin, 'POST', `/api/v1/schools/${schoolA.id}/reactivate`);
  check(
    'school A reactivated',
    [200, 201].includes(res.status) && data(res)?.status === 'ACTIVE',
    `status ${res.status}`,
  );
  res = await api(studentA, 'POST', '/api/auth/sign-in/email', {
    email: STUDENT_A.email,
    password: STUDENT_A.password,
  });
  check('student signs in again', res.status === 200, `status ${res.status}`);
  check(
    'mustChangePassword stays false after first-password change',
    data(res)?.user?.mustChangePassword === false,
  );
  res = await api(studentA, 'GET', '/api/v1/chat/unread');
  check('student REST access restored', res.status === 200);

  const sockStudentAAgain = connectSocket('studentA-reactivated', studentA);
  await waitFor(() => sockStudentAAgain.connected || sockStudentAAgain.connectError, 8000);
  check(
    'student socket connects again after reactivation',
    sockStudentAAgain.connected,
    sockStudentAAgain.connectError ?? '',
  );

  // --------------------------------------------------------------- act 10
  act('Act 10 — whole-run room targeting: school B saw nothing');

  check(
    'student B accumulated zero realtime events across the entire run',
    sockStudentB.events.length === 0,
    eventNames(sockStudentB),
  );
  const proAThreadBEvents = sockProA.events.filter((e) => e.payload?.threadId === threadB?.id);
  check('professional A never saw any school B event', proAThreadBEvents.length === 0);

  // ------------------------------------------------------------- summary
  const total = passed + failed;
  const seconds = Math.round((Date.now() - started) / 1000);
  console.log(
    `\n=== E2E SCHOOL-CHAT RESULT: ${passed}/${total} assertions passed${failed ? ` — ${failed} FAILED` : ' ✓'} (${seconds}s) ===\n`,
  );
  console.log(`(admin bootstrap email for reruns: ${ADMIN_EMAIL})`);
}

main()
  .catch((error) => {
    console.error('\nE2E school-chat crashed:', error?.message ?? error);
    process.exitCode = 1;
  })
  .finally(async () => {
    for (const rec of sockets) rec.sock.disconnect();
    await pool.end();
  });

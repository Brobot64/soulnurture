/**
 * NATLAS DASHBOARDS — END-TO-END
 * --------------------------------------------------------------------------
 * The admin & school dashboard API surface, asserted live against a running
 * server:
 *
 *   0. Preflight + clean slate; raw-SQL bootstrap of a PLATFORM_ADMIN
 *   1. Platform console — two schools with default passwords; the analytics
 *      window ladder (14/30/90 + fallbacks), series shape (ascending days
 *      ending today), fixed 7d-vs-previous deltas, eight-face mood donut,
 *      MON..SUN weekday bars; enriched school register
 *   2. Provision a school admin (owner-only route) → verify → sign in with
 *      the school default password → blocked everywhere but the allowlist
 *      (403 PASSWORD_CHANGE_REQUIRED) → personal password → default dead;
 *      a school admin cannot mint peers (403 on the admins route)
 *   3. School admin onboards a student → mid-state onboarding tile (1 of 2
 *      incomplete → 50%); the student verifies, changes password, checks in
 *      and asks for a human (PENDING chat thread)
 *   4. Analytics with data — school roster counts, 100% onboarding, today's
 *      counters, ANXIOUS→STRANGE mood roll-up, today's weekday bar; school B
 *      sees zero of school A's story (window cells all 0)
 *   5. Registers & feeds — settings panel (+ default-password update), chat
 *      thread register (filters + 422 negatives), enriched school list
 *      (students/professionals/pendingChats/lastActivityAt), admin users
 *      (q/role/schoolId/limit/422), activity feeds (platform + school scope,
 *      kind filters, actor & school labels), reset-password round-trip
 *      (sessions revoked, onboarding dips to 50%, default sign-in, 100%)
 *   6. Negatives — school admin refused on /admin/* (403); cross-school
 *      walls (403 SCHOOL_ACCESS_DENIED); a foreign user under the own-school
 *      path 404s like a missing one; unknown school 404; anonymous 401
 *
 * Non-zero exit on any assertion failure. Safe to re-run: Act 0 cleans all
 * test data (threads by school, users by email, schools by name) then
 * re-bootstraps the platform admin.
 *
 * Usage:  npm run test:e2e:dashboards   (server must be running on :3000)
 */
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { hashPassword } from 'better-auth/crypto';

const BASE = process.env.E2E_BASE_URL ?? 'http://localhost:3000';
const DB_URL =
  process.env.E2E_DATABASE_URL ??
  process.env.DATABASE_URL ??
  'postgresql://postgres:postgres@localhost:5432/natlas';
const ORIGIN = BASE;
const SHORT_CODE_CHARSET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const DAY_MS = 24 * 60 * 60 * 1000;

const ADMIN = {
  name: 'Platform Owner',
  email: 'platform.owner@dashboards.natlas.test',
  password: 'OwnerSafe123#',
};
const SCHOOL_A = { name: 'Cape Coast College', defaultPassword: 'CapeCoast#2026' };
const SCHOOL_B = { name: 'Kumasi High School', defaultPassword: 'KumasiHigh#2026' };
const UPDATED_DEFAULT = 'NewCape#2026';
const SCHOOL_ADMIN = {
  name: 'Efua Boateng',
  email: 'efua.boateng@dashboards.natlas.test',
  password: 'EfuaSafe123#',
};
const STUDENT_A = {
  name: 'Yaa Asante',
  email: 'yaa.asante@dashboards.natlas.test',
  password: 'YaaSafe123#',
  classLabel: 'JHS 3A',
};
const STUDENT_B = {
  name: 'Kwame Osei',
  email: 'kwame.osei@dashboards.natlas.test',
  classLabel: 'Form 2',
};
const ALL_EMAILS = [
  ADMIN.email,
  SCHOOL_ADMIN.email,
  STUDENT_A.email,
  STUDENT_B.email,
];
const SCHOOL_NAMES = [SCHOOL_A.name, SCHOOL_B.name];
const MOOD_IDS = [
  'GREAT',
  'NORMAL',
  'SAD',
  'ANGRY',
  'CONFUSED',
  'INDIFFERENT',
  'STRANGE',
  'DISTRAUGHT',
];
const WEEKDAY_LABELS = ['MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT', 'SUN'];
const DELTA_KEYS = ['newUsers', 'checkIns', 'chatThreads', 'chatMessages'];

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

/// School short codes: acronym (up to 3 letters) padded with 3-4 random
/// unambiguous alphanumerics to 6 characters.
const shortCodeRe = (prefix) =>
  new RegExp(`^${prefix}[${SHORT_CODE_CHARSET}]{${6 - prefix.length}}$`);

const todayIso = new Date().toISOString().slice(0, 10);
const firstDateOf = (days) =>
  new Date(Date.parse(`${todayIso}T00:00:00Z`) - (days - 1) * DAY_MS)
    .toISOString()
    .slice(0, 10);
const utcDay = new Date(`${todayIso}T00:00:00Z`).getUTCDay();
const todayWeekday = WEEKDAY_LABELS[(utcDay === 0 ? 7 : utcDay) - 1];

function seriesShape(analytics, days) {
  return (
    analytics?.windowDays === days &&
    analytics?.series?.length === days &&
    analytics.series[0]?.date === firstDateOf(days) &&
    analytics.series[days - 1]?.date === todayIso &&
    analytics.series.every(
      (day, index) =>
        index === 0 || day.date > analytics.series[index - 1].date,
    )
  );
}

function deltasShape(analytics) {
  return DELTA_KEYS.every((key) => {
    const delta = analytics?.deltas?.[key];
    return (
      typeof delta?.current === 'number' &&
      typeof delta?.previous === 'number' &&
      (delta.pct === null || typeof delta.pct === 'number') &&
      (delta.previous === 0) === (delta.pct === null)
    );
  });
}

function moodShape(analytics) {
  return (
    typeof analytics?.mood?.total === 'number' &&
    Object.keys(analytics.mood.distribution).length === MOOD_IDS.length &&
    MOOD_IDS.every(
      (mood) => typeof analytics.mood.distribution[mood] === 'number',
    )
  );
}

function weekdayShape(analytics) {
  return (
    analytics?.weekday?.length === 7 &&
    analytics.weekday.map((bar) => bar.weekday).join(',') ===
      WEEKDAY_LABELS.join(',') &&
    analytics.weekday.every((bar) => typeof bar.count === 'number')
  );
}

const feedItemShape = (item) =>
  Boolean(item.id) &&
  Boolean(item.action) &&
  ['schools', 'people', 'chat'].includes(item.kind) &&
  Boolean(item.createdAt) &&
  (item.actor === null || (item.actor.id && item.actor.name)) &&
  (item.school === null ||
    (item.school.id && item.school.name && item.school.shortCode));

// ---------------------------------------------------------------------------
async function main() {
  const started = Date.now();
  const admin = makeActor('Admin');
  const schoolAdmin = makeActor('SchoolAdmin');
  const studentA = makeActor('StudentA');
  const anon = null;

  // ---------------------------------------------------------------- act 0
  act('Act 0 — preflight, clean slate, platform admin bootstrap');

  let res = await api(anon, 'GET', '/api/health/auth');
  check(
    'API + auth reachable',
    res.status === 200 && data(res)?.service === 'auth',
    `status ${res.status}`,
  );
  const ping = await db('SELECT 1 AS ok');
  check('database reachable', ping.rows[0]?.ok === 1);

  await db(
    `DELETE FROM chat_thread WHERE "schoolId" IN (SELECT id FROM school WHERE name = ANY($1))`,
    [SCHOOL_NAMES],
  );
  const usersDeleted = await db('DELETE FROM "user" WHERE email = ANY($1)', [
    ALL_EMAILS,
  ]);
  const schoolsDeleted = await db(
    'DELETE FROM school WHERE name = ANY($1)',
    [SCHOOL_NAMES],
  );
  await db('DELETE FROM verification WHERE identifier = ANY($1)', [
    ALL_EMAILS,
  ]);
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
  check(
    'admin profile role PLATFORM_ADMIN',
    data(adminMe)?.role === 'PLATFORM_ADMIN',
  );

  // ---------------------------------------------------------------- act 1
  act('Act 1 — platform console: schools, analytics windows, register gauges');

  res = await api(admin, 'POST', '/api/v1/schools', {
    name: SCHOOL_A.name,
    defaultPassword: SCHOOL_A.defaultPassword,
  });
  check('school A created (Cape Coast College)', res.status === 201, `status ${res.status}`);
  const schoolA = data(res);
  check(
    'school A short code is acronym-derived (CCC + 3)',
    shortCodeRe('CCC').test(schoolA?.shortCode ?? ''),
    schoolA?.shortCode,
  );
  check('school A starts ACTIVE', schoolA?.status === 'ACTIVE');

  res = await api(admin, 'POST', '/api/v1/schools', {
    name: SCHOOL_B.name,
    defaultPassword: SCHOOL_B.defaultPassword,
  });
  check('school B created (Kumasi High School)', res.status === 201, `status ${res.status}`);
  const schoolB = data(res);
  check(
    'school B short code is acronym-derived (KHS + 3)',
    shortCodeRe('KHS').test(schoolB?.shortCode ?? ''),
    schoolB?.shortCode,
  );

  res = await api(admin, 'GET', '/api/v1/admin/analytics');
  let analytics = data(res);
  check(
    'platform analytics defaults to the 14-day window',
    res.status === 200 && seriesShape(analytics, 14),
    `windowDays=${analytics?.windowDays} series=${analytics?.series?.length}`,
  );

  res = await api(admin, 'GET', '/api/v1/admin/analytics?days=30');
  check(
    '30-day window honored',
    res.status === 200 && seriesShape(data(res), 30),
    `windowDays=${data(res)?.windowDays}`,
  );
  analytics = data(res);

  res = await api(admin, 'GET', '/api/v1/admin/analytics?days=90');
  check(
    '90-day window honored',
    res.status === 200 && seriesShape(data(res), 90),
    `windowDays=${data(res)?.windowDays}`,
  );

  res = await api(admin, 'GET', '/api/v1/admin/analytics?days=7');
  check(
    'off-ladder window falls back to 14',
    res.status === 200 && data(res)?.windowDays === 14,
    `windowDays=${data(res)?.windowDays}`,
  );
  res = await api(admin, 'GET', '/api/v1/admin/analytics?days=abc');
  check(
    'non-numeric window falls back to 14',
    res.status === 200 && data(res)?.windowDays === 14,
    `windowDays=${data(res)?.windowDays}`,
  );

  check(
    'four series counters on every day bucket',
    analytics?.series?.every((day) =>
      DELTA_KEYS.every((key) => typeof day[key] === 'number'),
    ),
  );
  check(
    'deltas are fixed 7d-vs-previous-7d (pct null only when no baseline)',
    deltasShape(analytics),
    JSON.stringify(analytics?.deltas),
  );
  check(
    'mood rolls up to the eight student faces',
    moodShape(analytics),
    JSON.stringify(analytics?.mood?.distribution),
  );
  check(
    'weekday bars are MON..SUN in order',
    weekdayShape(analytics),
    analytics?.weekday?.map((bar) => bar.weekday).join(','),
  );

  res = await api(admin, 'GET', '/api/v1/schools');
  const schoolRows = data(res)?.items ?? [];
  const rowA = schoolRows.find((school) => school.id === schoolA.id);
  const rowB = schoolRows.find((school) => school.id === schoolB.id);
  check(
    'enriched school register exposes the live gauges',
    res.status === 200 &&
      typeof rowA?.students === 'number' &&
      typeof rowA?.professionals === 'number' &&
      typeof rowA?.pendingChats === 'number' &&
      rowA?._count?.users === 0,
  );
  check(
    'schools with no users yet: zero gauges + null last activity',
    rowA?.students === 0 &&
      rowA?.pendingChats === 0 &&
      rowA?.lastActivityAt === null &&
      rowB?.students === 0 &&
      rowB?.lastActivityAt === null,
  );

  // ---------------------------------------------------------------- act 2
  act('Act 2 — school admin provisioning, forced first password, owner-only fence');

  res = await api(admin, 'POST', `/api/v1/schools/${schoolA.id}/admins`, {
    name: SCHOOL_ADMIN.name,
    email: SCHOOL_ADMIN.email,
  });
  const enrolledAdmin = data(res);
  check(
    'platform owner provisions a school admin (201 + verification sent)',
    res.status === 201 &&
      enrolledAdmin?.verificationEmailSent === true &&
      enrolledAdmin?.user?.role === 'SCHOOL_ADMIN',
    `status ${res.status}`,
  );
  const schoolAdminId = enrolledAdmin?.user?.id;

  const adminVerifyUrl = await devVerificationUrl(anon, SCHOOL_ADMIN.email);
  check('verification link dispatched for the school admin', Boolean(adminVerifyUrl));
  let target = new URL(adminVerifyUrl);
  res = await api(
    schoolAdmin,
    'GET',
    `${target.pathname}${target.search}`,
    undefined,
    { redirect: 'manual' },
  );
  check(
    'verification link accepted',
    [200, 302].includes(res.status),
    `status ${res.status}`,
  );

  res = await api(schoolAdmin, 'POST', '/api/auth/sign-in/email', {
    email: SCHOOL_ADMIN.email,
    password: SCHOOL_A.defaultPassword,
  });
  check(
    'school admin signs in with the school default password',
    res.status === 200,
    `status ${res.status}`,
  );
  res = await api(schoolAdmin, 'GET', '/api/v1/users/me');
  const adminProfile = data(res);
  check(
    'profile: SCHOOL_ADMIN at the school, forced change pending',
    res.status === 200 &&
      adminProfile?.role === 'SCHOOL_ADMIN' &&
      adminProfile?.school?.id === schoolA.id &&
      adminProfile?.mustChangePassword === true,
    `school=${adminProfile?.school?.shortCode} mustChange=${adminProfile?.mustChangePassword}`,
  );

  res = await api(schoolAdmin, 'GET', `/api/v1/schools/${schoolA.id}/users`);
  check(
    'school admin blocked until the change (403 PASSWORD_CHANGE_REQUIRED)',
    res.status === 403 &&
      JSON.stringify(res.body).includes('PASSWORD_CHANGE_REQUIRED'),
    `status ${res.status}`,
  );

  res = await api(schoolAdmin, 'POST', '/api/v1/auth/first-password', {
    newPassword: SCHOOL_ADMIN.password,
  });
  check(
    'school admin sets a personal password (no old password)',
    res.status === 200 && data(res)?.passwordChanged === true,
    `status ${res.status}`,
  );
  res = await api(schoolAdmin, 'GET', `/api/v1/schools/${schoolA.id}/users`);
  check(
    'school workspace allowed after the change',
    res.status === 200 && Array.isArray(data(res)?.items),
    `status ${res.status}`,
  );

  const throwawayAdmin = makeActor('throwaway-admin');
  res = await api(throwawayAdmin, 'POST', '/api/auth/sign-in/email', {
    email: SCHOOL_ADMIN.email,
    password: SCHOOL_A.defaultPassword,
  });
  check('default password dead after the change', res.status === 401, `status ${res.status}`);
  res = await api(throwawayAdmin, 'POST', '/api/auth/sign-in/email', {
    email: SCHOOL_ADMIN.email,
    password: SCHOOL_ADMIN.password,
  });
  check('personal password works', res.status === 200, `status ${res.status}`);

  res = await api(schoolAdmin, 'POST', `/api/v1/schools/${schoolA.id}/admins`, {
    name: 'Peer Admin',
    email: 'peer.admin@dashboards.natlas.test',
  });
  check(
    'school admin cannot mint peers (403 on the owner-only route)',
    res.status === 403,
    `status ${res.status}`,
  );

  // ---------------------------------------------------------------- act 3
  act('Act 3 — student onboarding, mid-state tile, check-in, chat request');

  res = await api(schoolAdmin, 'POST', `/api/v1/schools/${schoolA.id}/students`, {
    email: STUDENT_A.email,
    firstName: 'Yaa',
    lastName: 'Asante',
    classLabel: STUDENT_A.classLabel,
  });
  const enrolledStudent = data(res);
  check(
    'school admin onboards a student',
    res.status === 201 && enrolledStudent?.verificationEmailSent === true,
    `status ${res.status}`,
  );
  const studentAId = enrolledStudent?.user?.id;
  check(
    `student code follows the school short code (${schoolA.shortCode}-####)`,
    new RegExp(`^${schoolA.shortCode}-\\d{4}$`).test(
      enrolledStudent?.studentCode ?? '',
    ),
    enrolledStudent?.studentCode,
  );

  res = await api(schoolAdmin, 'GET', `/api/v1/schools/${schoolA.id}/analytics`);
  const midAnalytics = data(res);
  check(
    'school analytics mid-onboarding: roster {students:1, admins:1}',
    res.status === 200 &&
      midAnalytics?.roster?.students === 1 &&
      midAnalytics?.roster?.professionals === 0 &&
      midAnalytics?.roster?.admins === 1 &&
      midAnalytics?.roster?.deactivated === 0,
    JSON.stringify(midAnalytics?.roster),
  );
  check(
    'onboarding tile: 1 of 2 incomplete → 50%',
    midAnalytics?.onboarding?.incomplete === 1 &&
      midAnalytics?.onboarding?.percentComplete === 50,
    JSON.stringify(midAnalytics?.onboarding),
  );

  const studentVerifyUrl = await devVerificationUrl(anon, STUDENT_A.email);
  check('verification link dispatched for the student', Boolean(studentVerifyUrl));
  target = new URL(studentVerifyUrl);
  res = await api(studentA, 'GET', `${target.pathname}${target.search}`, undefined, {
    redirect: 'manual',
  });
  check('student verification link accepted', [200, 302].includes(res.status), `status ${res.status}`);

  res = await api(studentA, 'POST', '/api/auth/sign-in/email', {
    email: STUDENT_A.email,
    password: SCHOOL_A.defaultPassword,
  });
  check('student signs in with the school default password', res.status === 200, `status ${res.status}`);
  res = await api(studentA, 'GET', '/api/v1/users/me');
  check(
    'student profile shows school + forced change',
    data(res)?.role === 'STUDENT' &&
      data(res)?.school?.id === schoolA.id &&
      data(res)?.mustChangePassword === true,
  );
  res = await api(studentA, 'POST', '/api/v1/auth/first-password', {
    newPassword: STUDENT_A.password,
  });
  check('student sets a personal password', res.status === 200 && data(res)?.passwordChanged === true);

  res = await api(studentA, 'POST', '/api/v1/check-ins', {
    feeling: 'ANXIOUS',
    intensity: 'A_LOT',
    description: 'Exams are piling up and I keep losing sleep.',
    triggers: ['exams', 'sleep'],
  });
  check('student check-in created', res.status === 201, `status ${res.status}`);
  const checkInId = data(res)?.id;

  res = await api(studentA, 'POST', '/api/v1/chat/threads', {
    note: 'I would like to talk to someone about exams.',
    checkInId,
  });
  check(
    'student chat request lands in the pool (201 PENDING)',
    res.status === 201 && data(res)?.status === 'PENDING',
    `status ${res.status}`,
  );
  const threadA = data(res);

  // ---------------------------------------------------------------- act 4
  act('Act 4 — analytics with data: rostered school vs untouched school');

  res = await api(schoolAdmin, 'GET', `/api/v1/schools/${schoolA.id}/analytics`);
  const schoolData = data(res);
  check(
    'school analytics carries the full shape',
    res.status === 200 &&
      schoolData?.windowDays === 14 &&
      Array.isArray(schoolData?.series) &&
      schoolData?.deltas &&
      schoolData?.mood &&
      schoolData?.weekday &&
      schoolData?.roster &&
      schoolData?.onboarding,
  );
  check('roster settles at {students:1, admins:1, deactivated:0}', schoolData?.roster?.students === 1 && schoolData?.roster?.admins === 1 && schoolData?.roster?.deactivated === 0);
  check(
    'school fully onboarded after the first-password change (100%)',
    schoolData?.onboarding?.incomplete === 0 &&
      schoolData?.onboarding?.percentComplete === 100,
    JSON.stringify(schoolData?.onboarding),
  );
  const todayCell = schoolData?.series?.find((day) => day.date === todayIso);
  check(
    "today's bucket counts the day's story",
    todayCell?.newUsers >= 2 &&
      todayCell?.checkIns >= 1 &&
      todayCell?.chatThreads >= 1 &&
      todayCell?.chatMessages >= 1,
    JSON.stringify(todayCell),
  );
  check(
    'mood donut reflects the check-in (ANXIOUS → STRANGE)',
    schoolData?.mood?.total === 1 &&
      schoolData?.mood?.distribution?.STRANGE === 1,
    JSON.stringify(schoolData?.mood),
  );
  check(
    "weekday bars raise today's bar",
    schoolData?.weekday?.find((bar) => bar.weekday === todayWeekday)?.count >= 1,
    `${todayWeekday}=${schoolData?.weekday?.find((bar) => bar.weekday === todayWeekday)?.count}`,
  );
  res = await api(schoolAdmin, 'GET', `/api/v1/schools/${schoolA.id}/analytics?days=90`);
  check(
    'school analytics honors the window ladder too',
    res.status === 200 && seriesShape(data(res), 90),
    `windowDays=${data(res)?.windowDays}`,
  );

  res = await api(admin, 'GET', `/api/v1/schools/${schoolB.id}/analytics`);
  const bAnalytics = data(res);
  check(
    "school B sees zero of school A's story (window cells all 0)",
    res.status === 200 &&
      bAnalytics?.roster?.students === 0 &&
      bAnalytics?.mood?.total === 0 &&
      bAnalytics?.series?.every(
        (day) =>
          day.newUsers === 0 &&
          day.checkIns === 0 &&
          day.chatThreads === 0 &&
          day.chatMessages === 0,
      ),
  );

  res = await api(admin, 'GET', '/api/v1/admin/analytics');
  const platformData = data(res);
  const platformToday = platformData?.series?.find((day) => day.date === todayIso);
  check(
    "platform analytics carries school A's day too",
    platformToday?.newUsers >= 3 &&
      platformToday?.checkIns >= 1 &&
      platformToday?.chatThreads >= 1 &&
      platformData?.mood?.distribution?.STRANGE >= 1,
    JSON.stringify(platformToday),
  );

  // ---------------------------------------------------------------- act 5
  act('Act 5 — registers & feeds: settings, threads, lists, activity, reset');

  res = await api(schoolAdmin, 'GET', `/api/v1/schools/${schoolA.id}/settings`);
  const settingsA = data(res);
  check(
    'settings identity panel (name, code, status, createdAt, hasDefaultPassword)',
    res.status === 200 &&
      settingsA?.id === schoolA.id &&
      settingsA?.name === SCHOOL_A.name &&
      settingsA?.shortCode === schoolA.shortCode &&
      settingsA?.status === 'ACTIVE' &&
      typeof settingsA?.createdAt === 'string' &&
      settingsA?.hasDefaultPassword === true,
  );
  check(
    'settings never leak a password or hash',
    !JSON.stringify(settingsA).toLowerCase().includes('hash') &&
      !JSON.stringify(settingsA).includes(SCHOOL_A.defaultPassword),
  );
  res = await api(schoolAdmin, 'PATCH', `/api/v1/schools/${schoolA.id}/settings`, {
    defaultPassword: UPDATED_DEFAULT,
  });
  check(
    'school admin updates the default password',
    res.status === 200 && data(res)?.defaultPasswordUpdated === true,
    `status ${res.status}`,
  );

  res = await api(schoolAdmin, 'GET', `/api/v1/schools/${schoolA.id}/chat-threads`);
  let threadItems = data(res)?.items ?? [];
  check(
    'chat register lists the pending thread with lifecycle stamps',
    res.status === 200 &&
      threadItems.length === 1 &&
      threadItems[0].id === threadA.id &&
      threadItems[0].status === 'PENDING' &&
      threadItems[0].claimedAt === null &&
      threadItems[0].closedAt === null &&
      threadItems[0].student?.id === studentAId &&
      threadItems[0].student?.name === STUDENT_A.name &&
      threadItems[0].professional === null &&
      typeof threadItems[0].lastMessageAt === 'string' &&
      threadItems[0].messageCount >= 1,
    JSON.stringify(threadItems[0]),
  );
  res = await api(schoolAdmin, 'GET', `/api/v1/schools/${schoolA.id}/chat-threads?status=ACTIVE`);
  check('status filter: no ACTIVE threads yet', res.status === 200 && (data(res)?.items ?? []).length === 0);
  res = await api(schoolAdmin, 'GET', `/api/v1/schools/${schoolA.id}/chat-threads?status=PENDING&limit=1`);
  threadItems = data(res)?.items ?? [];
  check(
    'status + limit filters return the pending thread',
    res.status === 200 && threadItems.length === 1 && threadItems[0].id === threadA.id,
  );
  res = await api(schoolAdmin, 'GET', `/api/v1/schools/${schoolA.id}/chat-threads?status=BOGUS`);
  check('unknown status filter refused (422)', res.status === 422, `status ${res.status}`);

  res = await api(admin, 'POST', `/api/v1/schools/${schoolB.id}/students`, {
    email: STUDENT_B.email,
    firstName: 'Kwame',
    lastName: 'Osei',
    classLabel: STUDENT_B.classLabel,
  });
  const studentBEnrollment = data(res);
  check('platform admin onboards into school B', res.status === 201, `status ${res.status}`);
  const studentBId = studentBEnrollment?.user?.id;
  res = await api(admin, 'GET', `/api/v1/schools/${schoolB.id}/chat-threads`);
  check('school B chat register stays empty', res.status === 200 && (data(res)?.items ?? []).length === 0);
  res = await api(admin, 'GET', `/api/v1/schools/${schoolB.id}/analytics`);
  check(
    'school B roster: 1 unverified student → 0% onboarded',
    data(res)?.roster?.students === 1 &&
      data(res)?.onboarding?.incomplete === 1 &&
      data(res)?.onboarding?.percentComplete === 0,
    JSON.stringify(data(res)?.onboarding),
  );

  res = await api(admin, 'GET', '/api/v1/schools');
  const rows = data(res)?.items ?? [];
  const freshA = rows.find((school) => school.id === schoolA.id);
  const freshB = rows.find((school) => school.id === schoolB.id);
  check(
    'register gauges after activity (A: 2 users, 1 pending; B: 1 user)',
    freshA?.students === 1 &&
      freshA?.professionals === 0 &&
      freshA?.pendingChats === 1 &&
      freshA?._count?.users === 2 &&
      freshB?.students === 1 &&
      freshB?.pendingChats === 0,
  );
  check(
    'last activity: school A has sessions, school B never signed in',
    typeof freshA?.lastActivityAt === 'string' && freshB?.lastActivityAt === null,
    `A=${freshA?.lastActivityAt} B=${freshB?.lastActivityAt}`,
  );

  res = await api(admin, 'GET', `/api/v1/admin/users?q=${encodeURIComponent(STUDENT_A.email)}`);
  const search = data(res);
  check(
    'user search by email resolves the student with school identity',
    res.status === 200 &&
      search?.total === 1 &&
      search?.items?.[0]?.role === 'STUDENT' &&
      search?.items?.[0]?.schoolId === schoolA.id &&
      search?.items?.[0]?.school?.shortCode === schoolA.shortCode,
    `total=${search?.total}`,
  );
  res = await api(admin, 'GET', `/api/v1/admin/users?role=SCHOOL_ADMIN&schoolId=${schoolA.id}`);
  const adminFilter = data(res);
  check(
    'role + school filters pin the school admin',
    res.status === 200 &&
      adminFilter?.total === 1 &&
      adminFilter?.items?.[0]?.id === schoolAdminId &&
      adminFilter?.items?.[0]?.role === 'SCHOOL_ADMIN',
  );
  res = await api(admin, 'GET', '/api/v1/admin/users?limit=1');
  const paged = data(res);
  check(
    'paging: limit respected, total present',
    res.status === 200 &&
      paged?.items?.length === 1 &&
      typeof paged?.total === 'number' &&
      paged.total >= 4,
    `total=${paged?.total}`,
  );
  res = await api(admin, 'GET', '/api/v1/admin/users?role=BOGUS');
  check('unknown role filter refused (422)', res.status === 422, `status ${res.status}`);

  res = await api(admin, 'GET', '/api/v1/admin/activity');
  const feed = data(res)?.items ?? [];
  check(
    'platform activity feed shape (actor + school labels resolved)',
    res.status === 200 && feed.length >= 4 && feed.every(feedItemShape),
    `items=${feed.length}`,
  );
  const createdRow = feed.find(
    (item) => item.action === 'school.created' && item.school?.id === schoolA.id,
  );
  check(
    'school.created lands under schools with the owner as actor',
    createdRow?.kind === 'schools' &&
      createdRow?.actor?.name === ADMIN.name &&
      createdRow?.meta?.name === SCHOOL_A.name,
  );
  const adminEnrollmentRow = feed.find(
    (item) =>
      item.action === 'school.admin_enrolled' && item.school?.id === schoolA.id,
  );
  check(
    'admin enrolment lands under people',
    adminEnrollmentRow?.kind === 'people' &&
      adminEnrollmentRow?.entityId === schoolAdminId,
  );
  const threadRow = feed.find(
    (item) => item.action === 'chat.thread_created' && item.school?.id === schoolA.id,
  );
  check(
    'chat thread creation lands under chat',
    threadRow?.kind === 'chat' && threadRow?.entityId === threadA.id,
  );

  for (const kind of ['schools', 'people', 'chat']) {
    res = await api(admin, 'GET', `/api/v1/admin/activity?kind=${kind}`);
    const items = data(res)?.items ?? [];
    check(
      `kind=${kind} filters to its tab`,
      res.status === 200 && items.length >= 1 && items.every((item) => item.kind === kind),
      `items=${items.length}`,
    );
  }
  res = await api(admin, 'GET', '/api/v1/admin/activity?kind=bogus');
  check('unknown activity kind refused (422)', res.status === 422, `status ${res.status}`);
  res = await api(admin, 'GET', '/api/v1/admin/activity?limit=1');
  check('activity limit respected', res.status === 200 && (data(res)?.items ?? []).length === 1);

  res = await api(schoolAdmin, 'GET', `/api/v1/schools/${schoolA.id}/activity`);
  const schoolFeed = data(res)?.items ?? [];
  check(
    'school feed carries only school A rows',
    res.status === 200 &&
      schoolFeed.length >= 3 &&
      schoolFeed.every((item) => item.school?.id === schoolA.id) &&
      schoolFeed.some((item) => item.action === 'chat.thread_created') &&
      schoolFeed.some((item) => item.action === 'school.admin_enrolled'),
    `items=${schoolFeed.length}`,
  );
  res = await api(schoolAdmin, 'GET', `/api/v1/schools/${schoolA.id}/activity?kind=bogus`);
  check('unknown kind refused on the school feed too (422)', res.status === 422);

  res = await api(admin, 'GET', `/api/v1/schools/${schoolB.id}/activity`);
  const bFeed = data(res)?.items ?? [];
  check(
    "school B feed stays in school B (no school A thread)",
    res.status === 200 &&
      bFeed.length >= 1 &&
      bFeed.every((item) => item.school?.id === schoolB.id) &&
      !bFeed.some(
        (item) => item.action === 'chat.thread_created' && item.entityId === threadA.id,
      ),
  );

  res = await api(
    schoolAdmin,
    'POST',
    `/api/v1/schools/${schoolA.id}/users/${studentAId}/reset-password`,
  );
  check(
    'reset puts the student back on the school default',
    [200, 201].includes(res.status) && data(res)?.passwordReset === true,
    `status ${res.status}`,
  );
  res = await api(studentA, 'GET', '/api/v1/users/me');
  check('reset revokes the student sessions (401)', res.status === 401, `status ${res.status}`);
  res = await api(schoolAdmin, 'GET', `/api/v1/schools/${schoolA.id}/analytics`);
  check(
    'reset flags onboarding incomplete again (1 of 2 → 50%)',
    data(res)?.onboarding?.incomplete === 1 &&
      data(res)?.onboarding?.percentComplete === 50,
    JSON.stringify(data(res)?.onboarding),
  );
  res = await api(studentA, 'POST', '/api/auth/sign-in/email', {
    email: STUDENT_A.email,
    password: UPDATED_DEFAULT,
  });
  check('student signs in with the updated school default', res.status === 200, `status ${res.status}`);
  res = await api(studentA, 'POST', '/api/v1/auth/first-password', {
    newPassword: STUDENT_A.password,
  });
  check('student re-sets the personal password', res.status === 200 && data(res)?.passwordChanged === true);
  res = await api(schoolAdmin, 'GET', `/api/v1/schools/${schoolA.id}/analytics`);
  check(
    'school fully onboarded again (100%)',
    data(res)?.onboarding?.incomplete === 0 &&
      data(res)?.onboarding?.percentComplete === 100,
    JSON.stringify(data(res)?.onboarding),
  );
  res = await api(
    schoolAdmin,
    'POST',
    `/api/v1/schools/${schoolA.id}/users/${schoolAdminId}/reset-password`,
  );
  check(
    'self-reset refused (403 SELF_TARGET_FORBIDDEN)',
    res.status === 403 && JSON.stringify(res.body).includes('SELF_TARGET_FORBIDDEN'),
    `status ${res.status}`,
  );

  // ---------------------------------------------------------------- act 6
  act('Act 6 — role fences and cross-school walls');

  for (const path of [
    '/api/v1/admin/overview',
    '/api/v1/admin/users',
    '/api/v1/admin/analytics',
    '/api/v1/admin/activity',
  ]) {
    res = await api(schoolAdmin, 'GET', path);
    check(`school admin refused on ${path} (403)`, res.status === 403, `status ${res.status}`);
  }

  res = await api(schoolAdmin, 'GET', `/api/v1/schools/${schoolB.id}/analytics`);
  check(
    'cross-school analytics refused (403 SCHOOL_ACCESS_DENIED)',
    res.status === 403 && JSON.stringify(res.body).includes('SCHOOL_ACCESS_DENIED'),
    `status ${res.status}`,
  );
  res = await api(schoolAdmin, 'GET', `/api/v1/schools/${schoolB.id}/settings`);
  check('cross-school settings refused (403)', res.status === 403, `status ${res.status}`);
  res = await api(schoolAdmin, 'GET', `/api/v1/schools/${schoolB.id}/chat-threads`);
  check('cross-school chat register refused (403)', res.status === 403, `status ${res.status}`);
  res = await api(schoolAdmin, 'GET', `/api/v1/schools/${schoolB.id}/activity`);
  check('cross-school activity refused (403)', res.status === 403, `status ${res.status}`);
  res = await api(
    schoolAdmin,
    'POST',
    `/api/v1/schools/${schoolA.id}/users/${studentBId}/reset-password`,
  );
  check(
    'foreign user under the own-school path → 404 like a missing one',
    res.status === 404,
    `status ${res.status}`,
  );

  const ghostSchoolId = randomUUID();
  res = await api(admin, 'GET', `/api/v1/schools/${ghostSchoolId}/analytics`);
  check('unknown school analytics → 404', res.status === 404, `status ${res.status}`);
  res = await api(admin, 'GET', `/api/v1/schools/${ghostSchoolId}/settings`);
  check('unknown school settings → 404', res.status === 404, `status ${res.status}`);

  res = await api(anon, 'GET', '/api/v1/admin/analytics');
  check('anonymous refused (401)', res.status === 401, `status ${res.status}`);

  // ------------------------------------------------------------- summary
  const total = passed + failed;
  const seconds = Math.round((Date.now() - started) / 1000);
  console.log(
    `\n=== E2E DASHBOARDS RESULT: ${passed}/${total} assertions passed${failed ? ` — ${failed} FAILED` : ' ✓'} (${seconds}s) ===\n`,
  );
  console.log(`(platform admin bootstrap email for reruns: ${ADMIN.email})`);
}

main()
  .catch((error) => {
    console.error('\nE2E dashboards crashed:', error?.message ?? error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await pool.end();
  });

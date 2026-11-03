import 'dotenv/config';
import 'dotenv-expand';
import { PrismaPg } from '@prisma/adapter-pg';
import {
  Prisma,
  PrismaClient,
  ApprovalNamespace,
  ContentKind,
  ContentStatus,
  UserRole,
} from '@prisma/client';
import { hashPassword } from 'better-auth/crypto';
import { ACTIVITY_CATALOG } from '../src/ai/activities/activities.config.js';

const connectionString =
  process.env.DATABASE_URL && !process.env.DATABASE_URL.includes('${')
    ? process.env.DATABASE_URL
    : `postgresql://${process.env.DB_USER ?? 'postgres'}:${process.env.DB_PASSWORD ?? 'postgres'}@${process.env.DB_HOST ?? 'localhost'}:${process.env.DB_PORT ?? '5432'}/${process.env.DB_NAME ?? 'natlas'}?schema=public`;

const adapter = new PrismaPg({ connectionString });
const prisma = new PrismaClient({ adapter });

/**
 * Bootstrap-only owner accounts: creates the PLATFORM_ADMIN(s) from env
 * credentials when missing. PLATFORM_ADMIN_EMAIL and PLATFORM_ADMIN_NAME
 * accept comma-separated lists, matched by position (an entry without a
 * name falls back to a generic one). Each password is applied on first
 * creation and then never touched again, so a seed re-run can not clobber a
 * password the owner changed in-app. Missing env vars skip the step, keeping
 * the seed safe for environments that do not run the platform console.
 */
async function ensurePlatformAdmin() {
  const emails = (process.env.PLATFORM_ADMIN_EMAIL ?? '')
    .split(',')
    .map((email) => email.trim())
    .filter(Boolean);
  const password = process.env.PLATFORM_ADMIN_PASSWORD;
  if (emails.length === 0 || !password) {
    console.log(
      'Platform admin bootstrap skipped (PLATFORM_ADMIN_EMAIL/PASSWORD unset).',
    );
    return;
  }
  const names = (process.env.PLATFORM_ADMIN_NAME ?? '')
    .split(',')
    .map((name) => name.trim());

  for (const [index, email] of emails.entries()) {
    await ensurePlatformAdminAccount(
      email,
      names[index] || 'Soul Nurture Admin',
      password,
    );
  }
}

async function ensurePlatformAdminAccount(
  email: string,
  name: string,
  password: string,
) {
  const existing = await prisma.user.findFirst({
    where: { email: { equals: email, mode: 'insensitive' } },
    select: { id: true, role: true, emailVerified: true },
  });

  let userId: string;
  if (existing) {
    userId = existing.id;
    if (
      existing.role !== UserRole.PLATFORM_ADMIN ||
      !existing.emailVerified
    ) {
      await prisma.user.update({
        where: { id: userId },
        data: { role: UserRole.PLATFORM_ADMIN, emailVerified: true },
      });
    }
  } else {
    const created = await prisma.user.create({
      data: {
        name,
        email,
        role: UserRole.PLATFORM_ADMIN,
        emailVerified: true,
      },
      select: { id: true },
    });
    userId = created.id;
  }

  // Better Auth credential model: sign-in looks the account up by
  // providerId='credential' and accountId=<user id> (see UsersService).
  const credential = await prisma.account.findFirst({
    where: { userId, providerId: 'credential' },
    select: { id: true },
  });
  if (!credential) {
    await prisma.account.create({
      data: {
        userId,
        providerId: 'credential',
        accountId: userId,
        password: await hashPassword(password),
      },
    });
  }

  console.log(`Platform admin ready: ${email}`);
}

/** Unreviewed demo catalogue rows this seed used to publish under `approved: true`. */
const RETIRED_DEMO_RESOURCE_TITLES = [
  'Navigating Exam Stress Without Cracking',
  'The "It\'s Not All On You" Reframe',
  '4-7-8 Chill Breath Toolkit',
  'Palm-Wine & Calm Soundscape',
  'Friendships Without the Fear',
];

async function main() {
  await ensurePlatformAdmin();

  // Doc B §2 honesty fix: these five catalogue rows were written by this seed
  // with placeholder media (cdn.example.com) and never reviewed by anyone. They
  // are withdrawn from the student surface instead of deleted, because student
  // toolbox rows already point at them. A reviewer re-publishes by approving a
  // WN-* register row and its replacement resource, not by re-running this seed.
  for (const title of RETIRED_DEMO_RESOURCE_TITLES) {
    await prisma.wellbeingResource.updateMany({
      where: { title },
      data: { active: false, approved: false },
    });
  }

  for (const activity of ACTIVITY_CATALOG) {
    // Idempotent by slug. Only approved + active activities are ever
    // student-visible or eligible for intent-driven recommendations.
    const data = {
      ...activity,
      steps: activity.steps as unknown as Prisma.InputJsonValue,
      active: true,
      approved: true,
    };
    await prisma.wellbeingActivity.upsert({
      where: { slug: activity.slug },
      create: data,
      update: data,
    });
  }

  const supportPeople = [
    {
      name: 'Mrs. Adebayo',
      type: 'COUNSELLOR' as const,
      title: 'Lead School Counsellor',
      availabilityLabel: 'Available Today',
      availableToday: true,
      imageUrl: 'https://cdn.example.com/staff/adebayo.jpg',
      active: true,
    },
    {
      name: 'Dr. Okafor',
      type: 'PSYCHOLOGIST' as const,
      title: 'School Psychologist',
      availabilityLabel: 'Mon–Fri, 9am–4pm',
      availableToday: false,
      imageUrl: 'https://cdn.example.com/staff/okafor.jpg',
      active: true,
    },
  ];

  for (const p of supportPeople) {
    const existing = await prisma.supportPerson.findFirst({
      where: { name: p.name, type: p.type, professionalId: null },
    });
    if (existing) {
      await prisma.supportPerson.update({
        where: { id: existing.id },
        data: p,
      });
    } else {
      await prisma.supportPerson.create({ data: p });
    }
  }

  // Ensure a student profile + privacy default for an existing user, if present.
  const user = await prisma.user.findFirst({ include: { studentProfile: true } });
  if (user && !user.studentProfile) {
    await prisma.studentProfile.create({
      data: {
        userId: user.id,
        firstName: user.name.split(' ')[0] || user.name,
        lastName: user.name.split(' ').slice(1).join(' ') || null,
        displayName: user.name.split(' ')[0] || user.name,
      },
    });
  }

  await ensureContentRegistry();
}

/**
 * Structural content register (Doc C §6/§7). Establishes every known code as a
 * versioned row with its OPERATIVE status, so the gating machinery is real and
 * testable before any reviewer copy is imported: EMO/CP wellbeing prompts are
 * CONTENT_REVIEW_REQUIRED (invisible until the psychologist signs the exact
 * version), CP-09…CP-17 (the direct safety questions) are BLOCKED (resolve()
 * refuses them, the keyword floor stays the safety net), WN-* are
 * CONTENT_REVIEW_REQUIRED. The payload carries only a reviewPending marker —
 * the actual wording, response options and twelve resource bodies come from the
 * supplied Doc B/C copy and are imported in Slices 2–3, never invented here.
 * Create-only: a re-run must not clobber a status a reviewer already advanced.
 */
async function ensureContentRegistry() {
  const pending = {
    reviewPending: true,
    note: 'Structural register row; reviewer copy imports from Doc B/C once supplied (D1/D6).',
  } as Prisma.InputJsonValue;

  const rows: Array<{
    code: string;
    kind: ContentKind;
    namespace: ApprovalNamespace;
    status: ContentStatus;
    payload?: Prisma.InputJsonValue;
  }> = [
    ...zeroPadded('EMO-', 8).map((code) => ({
      code,
      kind: ContentKind.EMOTION_TERM,
      namespace: ApprovalNamespace.EDUCATION,
      status: ContentStatus.CONTENT_REVIEW_REQUIRED,
    })),
    ...zeroPadded('CP-', 8).map((code) => ({
      code,
      kind: ContentKind.CHECKIN_PROMPT,
      namespace: ApprovalNamespace.WELLBEING,
      status: ContentStatus.CONTENT_REVIEW_REQUIRED,
    })),
    ...zeroPadded('CP-', 17, 9).map((code) => ({
      code,
      kind: ContentKind.SAFEGUARDING_PROMPT,
      namespace: ApprovalNamespace.SAFEGUARDING,
      status: ContentStatus.BLOCKED,
    })),
    ...zeroPadded('CP-', 22, 18).map((code) => ({
      code,
      kind: ContentKind.CHECKIN_PROMPT,
      namespace: ApprovalNamespace.WELLBEING,
      status: ContentStatus.CONTENT_REVIEW_REQUIRED,
    })),
    ...zeroPadded('WN-', 12, 1, 2).map((code) => ({
      code,
      kind: ContentKind.WELLBEING_RESOURCE,
      namespace: ApprovalNamespace.WELLBEING,
      status: ContentStatus.CONTENT_REVIEW_REQUIRED,
    })),
    // Doc B §3 topic taxonomy. Six labels and four of their WN-* mappings are
    // quoted in the reviewed handoffs; the remaining two labels of the mandated
    // eight were never supplied, so they are NOT invented here and the live
    // ResourceCategory enum keeps serving the chips until a reviewer closes the
    // gap (D6). Status stays CONTENT_REVIEW_REQUIRED: quoted copy, not approval.
    ...[
      { code: 'CAT-STEADIER', label: 'Help me feel steadier', resources: ['WN-02', 'WN-03'] },
      { code: 'CAT-ONE_STEP', label: 'Take one small step', resources: ['WN-04', 'WN-12'] },
      { code: 'CAT-DIFFICULT_MOMENT', label: 'Handle a difficult moment', resources: ['WN-06', 'WN-09'] },
      { code: 'CAT-HEAVY', label: 'When things feel heavy', resources: ['WN-07', 'WN-08'] },
      { code: 'CAT-UNDERSTAND_FEELINGS', label: 'Understand my feelings', resources: [] as string[] },
      { code: 'CAT-REST', label: 'Prepare for rest', resources: [] as string[] },
    ].map((category) => ({
      code: category.code,
      kind: ContentKind.CATEGORY,
      namespace: ApprovalNamespace.WELLBEING,
      status: ContentStatus.CONTENT_REVIEW_REQUIRED,
      payload: {
        reviewPending: true,
        label: category.label,
        resources: category.resources,
        note: category.resources.length
          ? 'Label and mapping quoted from the reviewed handoff; not a release approval.'
          : 'Label quoted, but the reviewed text supplies no resource mapping for it (D6).',
      } as Prisma.InputJsonValue,
    })),
    // Response options whose wording is quoted in the reviewed handoff. They are
    // registered so `assertAskable` recognises the codes, and stay
    // CONTENT_REVIEW_REQUIRED because quoting copy is not approving it (D1).
    ...[
      ['CP-02-1', 'A little'],
      ['CP-02-2', 'Moderate'],
      ['CP-02-3', 'Strong'],
      ['CP-02-4', 'Very strong'],
      ['CP-02-5', "I don't want to say"],
      ['EMO-FB-1', 'something else'],
      ['EMO-FB-2', 'mixed'],
      ['EMO-FB-3', 'not sure'],
      ['EMO-FB-4', 'prefer not to say'],
      ['EMO-FB-5', 'skip'],
    ].map(([code, label]) => ({
      code,
      kind: ContentKind.RESPONSE_OPTION,
      namespace: ApprovalNamespace.WELLBEING,
      status: ContentStatus.CONTENT_REVIEW_REQUIRED,
      payload: {
        reviewPending: true,
        label,
        note: 'Label quoted from the reviewed handoff for the check-in library; not a release approval (D1).',
      } as Prisma.InputJsonValue,
    })),
  ];

  for (const row of rows) {
    await prisma.contentItem.upsert({
      where: {
        code_majorVersion_minorVersion_patchVersion_locale: {
          code: row.code,
          majorVersion: 1,
          minorVersion: 0,
          patchVersion: 0,
          locale: 'en',
        },
      },
      create: { ...row, payload: row.payload ?? pending, locale: 'en' },
      update: {},
    });
  }
  console.log(`Content register ensured (${rows.length} codes).`);
}

/** CP-01…CP-08 style codes, zero-padded to `width` (default 2). */
function zeroPadded(
  prefix: string,
  to: number,
  from = 1,
  width = 2,
): string[] {
  const out: string[] = [];
  for (let n = from; n <= to; n += 1) out.push(`${prefix}${String(n).padStart(width, '0')}`);
  return out;
}

main()
  .then(async () => {
    await prisma.$disconnect();
  })
  .catch(async (e) => {
    console.error(e);
    await prisma.$disconnect();
    process.exit(1);
  });

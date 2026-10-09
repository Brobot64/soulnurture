import 'dotenv/config';
import 'dotenv-expand';
import { PrismaPg } from '@prisma/adapter-pg';
import {
  Prisma,
  PrismaClient,
  ResourceCategory,
  ResourceType,
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

async function main() {
  await ensurePlatformAdmin();

  const resources = [
    {
      title: 'Navigating Exam Stress Without Cracking',
      description: 'Micro-reset breath and body scan practice grounded in your body, not perfection.',
      type: ResourceType.AUDIO_GUIDE,
      category: ResourceCategory.EXAM_STRESS,
      badge: 'Audio Guide',
      durationMinutes: 3,
      durationLabel: '3 min listen',
      ctaLabel: 'Listen Guide',
      mediaUrl: 'https://cdn.example.com/audio/exam-stress-breath.mp3',
      tags: ['School Strategies', 'Stress Release'],
    },
    {
      title: 'The "It\'s Not All On You" Reframe',
      description: 'A short article on separating your worth from a single result.',
      type: ResourceType.ARTICLE,
      category: ResourceCategory.IDENTITY,
      badge: 'Article',
      ctaLabel: 'Read',
      tags: ['Self-Worth', 'Cultural Pressure Nuance'],
    },
    {
      title: '4-7-8 Chill Breath Toolkit',
      description: 'Box-breathing progression for panic that feels tight in the chest.',
      type: ResourceType.SOMATIC_EXERCISE,
      category: ResourceCategory.GROUNDING,
      badge: 'Somatic',
      durationMinutes: 2,
      durationLabel: '2 min',
      ctaLabel: 'Try Now',
      tags: ['Panic', 'SOS Release'],
    },
    {
      title: 'Palm-Wine & Calm Soundscape',
      description: 'Low-fi ambient mix to settle the nervous system while studying.',
      type: ResourceType.SOUNDSCAPE,
      category: ResourceCategory.GROUNDING,
      badge: 'Soundscape',
      durationMinutes: 10,
      durationLabel: '10 min loop',
      ctaLabel: 'Play',
      mediaUrl: 'https://cdn.example.com/audio/palm-wine-calm.mp3',
      tags: ['Focus', 'Sleep', 'Grounding'],
    },
    {
      title: 'Friendships Without the Fear',
      description: 'Small steps to reconnect when social anxiety feels loud.',
      type: ResourceType.INTERACTIVE,
      category: ResourceCategory.FRIENDSHIPS,
      badge: 'Interactive',
      ctaLabel: 'Explore',
      tags: ['Social Anxiety', 'Peer Dynamics'],
    },
  ];

  for (const r of resources) {
    // Only approved + active resources are ever student-visible; catalogue
    // reviewers approve by keeping approved=true here.
    const data = { ...r, approved: true, active: true };
    const existing = await prisma.wellbeingResource.findFirst({
      where: { title: data.title },
    });
    if (existing) {
      await prisma.wellbeingResource.update({
        where: { id: existing.id },
        data,
      });
    } else {
      await prisma.wellbeingResource.create({ data });
    }
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
      where: { name: p.name, type: p.type },
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

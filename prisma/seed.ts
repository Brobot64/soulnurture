import 'dotenv/config';
import 'dotenv-expand';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient, ResourceCategory, ResourceType } from '@prisma/client';

const connectionString =
  process.env.DATABASE_URL && !process.env.DATABASE_URL.includes('${')
    ? process.env.DATABASE_URL
    : `postgresql://${process.env.DB_USER ?? 'postgres'}:${process.env.DB_PASSWORD ?? 'postgres'}@${process.env.DB_HOST ?? 'localhost'}:${process.env.DB_PORT ?? '5432'}/${process.env.DB_NAME ?? 'natlas'}?schema=public`;

const adapter = new PrismaPg({ connectionString });
const prisma = new PrismaClient({ adapter });

async function main() {
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

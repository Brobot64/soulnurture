import 'dotenv/config';
import 'dotenv-expand';
import { PrismaPg } from '@prisma/adapter-pg';
import {
  Prisma,
  PrismaClient,
  ApprovalNamespace,
  ContentKind,
  ContentStatus,
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

/** Unreviewed demo catalogue rows this seed used to publish under `approved: true`. */
const RETIRED_DEMO_RESOURCE_TITLES = [
  'Navigating Exam Stress Without Cracking',
  'The "It\'s Not All On You" Reframe',
  '4-7-8 Chill Breath Toolkit',
  'Palm-Wine & Calm Soundscape',
  'Friendships Without the Fear',
];

/**
 * The date the product owner recorded the Doc B §3/§4 library as released, and
 * the identity credited as the reviewer on every register row it advances.
 * Provenance is a date, not the moment a deploy happened to run.
 */
const LIBRARY_APPROVED_AT = new Date('2026-11-06T00:00:00Z');
const LIBRARY_APPROVED_BY = 'PRODUCT_OWNER';

/**
 * Doc B §3 — the eight approved student-facing categories and the resources
 * mapped into each. Titles, labels and mappings are quoted from the reviewed
 * handoff; nothing here is a new grouping.
 *
 * `category` is the `ResourceCategory` value that carries the label, so the
 * register row and the live row can never drift apart, and `code` keeps the six
 * CAT-* codes already registered on file rather than renaming them into
 * duplicates.
 */
const APPROVED_RESOURCE_CATEGORIES = [
  { code: 'CAT-UNDERSTAND_FEELINGS', category: 'FEELINGS', label: 'Understand my feelings', resources: ['WN-01'] },
  { code: 'CAT-STEADIER', category: 'STEADIER', label: 'Help me feel steadier', resources: ['WN-02', 'WN-03'] },
  { code: 'CAT-ONE_STEP', category: 'ONE_STEP', label: 'Take one small step', resources: ['WN-04', 'WN-12'] },
  { code: 'CAT-KINDER_SELF', category: 'KINDNESS', label: 'Be kinder to myself', resources: ['WN-05'] },
  { code: 'CAT-DIFFICULT_MOMENT', category: 'DIFFICULT_MOMENT', label: 'Handle a difficult moment', resources: ['WN-06', 'WN-09'] },
  { code: 'CAT-HEAVY', category: 'HEAVY', label: 'When things feel heavy', resources: ['WN-07', 'WN-08'] },
  { code: 'CAT-TALK', category: 'ASK_FOR_SUPPORT', label: 'Talk to someone', resources: ['WN-10'] },
  { code: 'CAT-REST', category: 'REST', label: 'Prepare for rest', resources: ['WN-11'] },
] as const;

/**
 * Doc B §4 — the twelve approved entries, quoted exactly: title, "Use when"
 * wording and estimated time.
 *
 * The "Use when" sentence is the card description, because US-WR-D03 says the
 * short description must be based on it and it is the only approved prose for
 * these entries. It is therefore NOT duplicated into `intendedSituation`, which
 * would print the same sentence twice on the detail screen.
 *
 * What Doc B §3 supplies beyond the card line is the exercise itself: the
 * numbered steps, the optional reflection and the safety note. Those are copied
 * here verbatim — §1 forbids inventing coping content and US-WR-D04 forbids
 * paraphrasing activity steps into production, so the wording below is the
 * reviewed wording, not a summary of it. The extracted §3 list numbering runs
 * straight through the whole library (WN-02 starts at 5); each resource
 * restarts at 1 in the document itself, and `instructions` stores the steps
 * unnumbered because the detail template numbers them.
 *
 * `mediaUrl` stays null — no approved audio or external asset exists.
 */
const APPROVED_WELLBEING_RESOURCES = [
  {
    code: 'WN-01',
    title: 'Name What You’re Feeling',
    useWhen: 'When feelings feel confusing, mixed or hard to explain',
    estimatedTime: '2–4 minutes',
    steps: [
      'Pause for a moment. You do not have to explain everything perfectly.',
      'Choose one or more words that come close to what you feel: sad, worried, angry, lonely, embarrassed, relieved, excited, numb, confused, or “something else.”',
      'Notice how strong the feeling seems right now: a little, medium, or a lot. There is no right answer.',
      'If it helps, finish this sentence: “I think I may be feeling ___ because ___.” You can leave the reason blank.',
    ],
    reflection:
      'What would help you most right now: to be heard, to understand the feeling, to calm your body, to solve a problem, or to reach someone?',
    safety:
      'Feelings are information, not proof that a thought is true or that something is wrong with you. If you feel unsafe or overwhelmed, seek support from a trusted adult or appropriate professional.',
  },
  {
    code: 'WN-02',
    title: 'Grounding: Notice the Present',
    useWhen: 'When overwhelmed, distracted or caught in a stressful moment',
    estimatedTime: '1–3 minutes',
    steps: [
      'If it feels comfortable, place both feet on the floor or notice where your body is supported.',
      'Name five things you can see, four things you can feel, three things you can hear, two things you can smell, and one thing you can taste. You can adapt or skip any step.',
      'Look around and name where you are and one thing that tells you about the present moment.',
      'Ask yourself: “What is one small, safe next step I can take?”',
    ],
    reflection:
      'Did anything change in your attention or comfort level? It is okay if it did not.',
    safety:
      'If focusing on your senses makes you feel worse, stop and choose another activity, such as looking at a familiar object or contacting someone supportive.',
  },
  {
    code: 'WN-03',
    title: 'Gentle Breathing Pause',
    useWhen: 'When the body feels tense or hurried',
    estimatedTime: '1–2 minutes',
    steps: [
      'Sit or stand in a comfortable position. Let your shoulders rest if you can.',
      'Breathe naturally. If comfortable, breathe in gently and let the breath out slowly, without forcing or holding it.',
      'Repeat for a few breaths while noticing the chair, floor or other support beneath you.',
      'Stop whenever you want and return to normal breathing.',
    ],
    reflection:
      'Would a quiet pause, a drink of water, a short walk, or talking to someone be more helpful now?',
    safety:
      'Do not force deep breathing or hold your breath. Stop if you feel dizzy, breathless or uncomfortable. This exercise is not a substitute for medical help or urgent support.',
  },
  {
    code: 'WN-04',
    title: 'Break a Problem into Smaller Steps',
    useWhen: 'When schoolwork, responsibilities or decisions feel too big',
    estimatedTime: '3–5 minutes',
    steps: [
      'Write or think of the problem in one sentence.',
      'Separate what you can influence from what you cannot control right now.',
      'Choose one action that takes about five to ten minutes, such as opening the assignment, listing questions, or asking a teacher for clarification.',
      'Decide when you will try that action. If you need help, identify one person to ask.',
    ],
    reflection: 'What is the smallest useful next step—not the whole solution?',
    safety:
      'Some problems need adult help or a change in circumstances, not just better planning. If the issue involves bullying, threats, abuse or feeling unsafe, tell a trusted adult or designated school support person.',
  },
  {
    code: 'WN-05',
    title: 'Respond to Yourself with Kindness',
    useWhen: 'After a mistake, disappointment or harsh self-criticism',
    estimatedTime: '2–4 minutes',
    steps: [
      'Notice the words you are using toward yourself, without judging yourself for having them.',
      'Ask: “Would I say this exact thing to a friend who was struggling?”',
      'Try a more balanced sentence: “This is difficult, and I can learn one thing from it,” or “One mistake does not describe my whole self.”',
      'Choose one supportive action: rest, practise, apologise if needed, ask for help, or try again later.',
    ],
    reflection:
      'What would be both kind and honest to tell yourself about this situation?',
    safety:
      'Self-kindness does not mean ignoring harm or avoiding responsibility. It means addressing the situation without attacking your worth as a person.',
  },
  {
    code: 'WN-06',
    title: 'When Anger Is Rising',
    useWhen: 'When irritation or anger is getting stronger',
    estimatedTime: '2–5 minutes',
    steps: [
      'If safe, pause the conversation or move to a calmer place.',
      'Notice early body signals such as a tight jaw, hot face, fast heartbeat or clenched hands.',
      'Give yourself time before sending a message or making a decision. Try walking, drinking water, or slowly counting while you settle.',
      'When ready, describe the issue using “I” language: “I felt ___ when ___ happened. I need ___.”',
      'If anyone may be hurt, create distance and contact a trusted adult or appropriate support person.',
    ],
    reflection:
      'What boundary, need or concern might the anger be pointing to?',
    safety:
      'Do not encourage a student to confront a person who may be violent or unsafe. Safety comes first; involve a trusted adult or safeguarding professional.',
  },
  {
    code: 'WN-07',
    title: 'A Small Step Through Sadness',
    useWhen: 'When feeling low, disappointed, lonely or unmotivated',
    estimatedTime: '3–10 minutes',
    steps: [
      'You do not need to force yourself to feel happy. Name what today feels like.',
      'Choose one manageable action: wash your face, eat or drink something if needed, step outside safely, listen to calming music, or complete one small task.',
      'Consider one connection: message a trusted person, sit near someone safe, or ask for company.',
      'Notice whether you need rest, practical help, a conversation, or professional support.',
    ],
    reflection:
      'What is one gentle thing you can do for yourself in the next ten minutes?',
    safety:
      'If sadness persists, disrupts daily life, or becomes difficult to manage, encourage speaking with a qualified professional or trusted adult. If the student mentions self-harm or not wanting to live, follow the approved urgent safeguarding pathway.',
  },
  {
    code: 'WN-08',
    title: 'Grief and Missing Someone',
    useWhen: 'After a death, separation or another significant loss',
    estimatedTime: 'Flexible',
    steps: [
      'There is no single correct way to grieve. You may feel sad, angry, numb, confused, relieved, or different feelings at different times.',
      'If you want, choose a way to remember the person or what was lost: write a memory, draw, say a prayer if that fits your beliefs, look at a meaningful object, or talk with someone safe.',
      'Let yourself take breaks. You do not have to share details before you are ready.',
      'Think of one person who could listen without pressuring you to “move on.”',
    ],
    reflection:
      'Would you like to share a memory, talk about what feels hardest, or find someone supportive to speak with?',
    safety:
      'Do not set a timetable for grief or imply that grief follows fixed stages. If grief is accompanied by danger, severe distress or thoughts of self-harm, follow the appropriate human-support pathway.',
  },
  {
    code: 'WN-09',
    title: 'Handling Peer Conflict or Bullying',
    useWhen: 'When experiencing exclusion, insults, harassment or conflict',
    estimatedTime: '3–5 minutes',
    steps: [
      'First ask: “Am I safe right now?” If not, move toward a safer place and seek adult help.',
      'If it is safe, write down what happened, when it happened and who was present. Keep records only in a way that does not put you at further risk.',
      'Choose a trusted adult, teacher, counsellor, caregiver or designated safeguarding contact to tell.',
      'You do not have to handle repeated bullying alone or prove that you can tolerate it.',
      'If online, consider saving relevant evidence and using platform reporting/blocking tools when safe to do so.',
    ],
    reflection:
      'Who is one adult or support person you could tell, and what would make it easier to start?',
    safety:
      'Do not advise retaliation, public exposure, or confronting a group alone. Follow school safeguarding policy for threats, harassment, discrimination, violence or repeated bullying.',
  },
  {
    code: 'WN-10',
    title: 'Ask for Support: A Message Starter',
    useWhen: 'When it is hard to tell someone you need help',
    estimatedTime: '2 minutes',
    steps: [
      'Choose someone who is likely to listen and help you stay safe.',
      'Use or adapt this message: “I have been finding things difficult lately. I do not need you to solve everything immediately, but I would like you to listen and help me work out what to do next.”',
      'If speaking feels difficult, consider writing a note or asking another trusted person to join the conversation.',
      'If the first person does not respond helpfully, try another trusted adult or appropriate professional.',
    ],
    reflection:
      'Would you like help choosing words for a teacher, counsellor, caregiver or friend?',
    safety:
      'Do not promise that every adult will respond well. If the first person is unsafe, involved in the harm, or dismisses a serious concern, help the student identify another safe route.',
  },
  {
    code: 'WN-11',
    title: 'A Simple Sleep Wind-Down',
    useWhen: 'When preparing for rest and thoughts are busy',
    estimatedTime: '5–10 minutes',
    steps: [
      'If possible, choose a roughly consistent time to begin winding down.',
      'Put school tasks or worries on paper and write one small next step for tomorrow.',
      'Try a quiet activity such as reading, gentle stretching, calm audio or preparing clothes and materials for the next day.',
      'If thoughts return, remind yourself: “I have written this down; I can return to it tomorrow.”',
    ],
    reflection:
      'What is one thing you can set aside for tomorrow, and one thing that helps you feel settled?',
    safety:
      'Do not frame sleep difficulty as a personal failure. Persistent sleep problems, severe distress, or symptoms affecting daily functioning should be discussed with a qualified professional or healthcare provider.',
  },
  {
    code: 'WN-12',
    title: 'Choose a Coping Plan for the Next Hour',
    useWhen: 'When unsure what kind of help is needed',
    estimatedTime: '2–3 minutes',
    steps: [
      'Choose what feels closest: I need to calm my body; understand a feeling; solve a practical problem; connect with someone; or get help to stay safe.',
      'Choose one small action that matches your need.',
      'Choose a person or service you can contact if the first step is not enough.',
      'After trying it, check: “Am I a little safer or more supported? What do I need next?”',
    ],
    reflection: 'Which next step feels manageable right now?',
    safety:
      'If the student is in immediate danger, may harm themselves or someone else, or reports abuse or another urgent safeguarding concern, do not keep them in a self-help flow. Use the approved escalation process.',
  },
] as const;

const categoryFor = (resourceCode: string) =>
  APPROVED_RESOURCE_CATEGORIES.find((entry) =>
    (entry.resources as readonly string[]).includes(resourceCode),
  );

/**
 * The twelve catalogue rows, keyed by their register code so a re-run updates
 * copy instead of publishing a second row under the same code.
 *
 * They are created unpublished. `approveWellbeingLibrary()` below is what
 * publishes a row, and only for a code the register actually approves, so the
 * register stays the review record and this stays the content store.
 */
async function ensureWellbeingResourceLibrary() {
  for (const resource of APPROVED_WELLBEING_RESOURCES) {
    const category = categoryFor(resource.code);
    if (!category) throw new Error(`${resource.code} has no approved category mapping`);
    const copy = {
      title: resource.title,
      description: resource.useWhen,
      durationLabel: resource.estimatedTime,
      category: category.category,
      // Doc B §2/US-WR-D02: the approved content defines no delivery format, so
      // no row claims one. The column is not nullable and the surfaces no
      // longer print it; TOOLKIT_ITEM is the listing-equals-what-you-get value.
      type: ResourceType.TOOLKIT_ITEM,
      instructions: [...resource.steps],
      reflectionPrompt: resource.reflection,
      // Doc B §3 writes every "Safety note" as guidance for the reviewer or the
      // responding adult ("do not encourage a student to confront…", "follow the
      // approved escalation process"), not as copy addressed to the reader. The
      // detail screen renders this column to the student under "Good to know",
      // so it stays empty until the psychologist rewrites these in the
      // student's own voice — see docs/HANDOFF.md.
      safetyNote: null,
    };
    await prisma.wellbeingResource.upsert({
      where: { contentCode: resource.code },
      create: { ...copy, contentCode: resource.code, active: false, approved: false },
      // Copy refresh only. The publish flags are the register's answer, so a
      // re-seed must never re-publish something a reviewer withdrew.
      update: copy,
    });
  }
}

/**
 * The approval write, expressed as data the owner already signed rather than as
 * a boolean the seed author set.
 *
 * Doc C §6 already records the `WN-01 to WN-12` package as APPROVED, and the
 * product owner confirmed the library released on 2026-11-06; what the register
 * lacked was the row status. This advances exactly those codes, and only out of
 * DRAFT / CONTENT_REVIEW_REQUIRED, so a reviewer who set BLOCKED or RETIRED
 * keeps their answer through every future deploy.
 */
async function approveWellbeingLibrary() {
  const entries = [
    ...APPROVED_WELLBEING_RESOURCES.map((resource) => ({
      code: resource.code,
      kind: ContentKind.WELLBEING_RESOURCE,
      payload: {
        reviewPending: false,
        title: resource.title,
        note: 'Title, intended-situation wording and duration quoted from Doc B §4; steps and reflection quoted from Doc B §3; released by the product owner.',
      } as Prisma.InputJsonValue,
    })),
    ...APPROVED_RESOURCE_CATEGORIES.map((category) => ({
      code: category.code,
      kind: ContentKind.CATEGORY,
      payload: {
        reviewPending: false,
        label: category.label,
        category: category.category,
        resources: [...category.resources],
        note: 'Label and mapping quoted from Doc B §3; released by the product owner.',
      } as Prisma.InputJsonValue,
    })),
  ];

  let advanced = 0;
  for (const entry of entries) {
    const result = await prisma.contentItem.updateMany({
      where: {
        code: entry.code,
        kind: entry.kind,
        status: { in: [ContentStatus.DRAFT, ContentStatus.CONTENT_REVIEW_REQUIRED] },
      },
      data: {
        status: ContentStatus.APPROVED_ACTIVE,
        approvedBy: LIBRARY_APPROVED_BY,
        approvedAt: LIBRARY_APPROVED_AT,
        effectiveFrom: LIBRARY_APPROVED_AT,
        payload: entry.payload,
      },
    });
    advanced += result.count;
  }

  // Publishing follows the register rather than leading it: a WN-* row is live
  // while its code is approved, and drops out of the catalogue the moment it
  // is not — which is also how a reviewer withdraws one entry.
  const approvedCodes = await prisma.contentItem.findMany({
    where: { kind: ContentKind.WELLBEING_RESOURCE, status: ContentStatus.APPROVED_ACTIVE },
    select: { code: true },
  });
  const codes = approvedCodes.map((row) => row.code);
  await prisma.wellbeingResource.updateMany({
    where: { contentCode: { in: codes } },
    data: { active: true, approved: true },
  });
  await prisma.wellbeingResource.updateMany({
    where: { contentCode: { not: null, notIn: codes } },
    data: { active: false, approved: false },
  });

  console.log(
    `Wellbeing library approved (${advanced} register rows advanced, ${codes.length} WN codes live).`,
  );
}


async function main() {
  await ensurePlatformAdmin();

  // Doc B §2 honesty fix: these five catalogue rows were written by this seed
  // with placeholder media (cdn.example.com) and never reviewed by anyone. They
  // are withdrawn from the student surface instead of deleted, because student
  // toolbox rows already point at them. Doc B US-WR-D03 orders exactly this:
  // placeholder titles are replaced by the twelve approved entries below, not
  // re-labelled and kept.
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
  await ensureWellbeingResourceLibrary();
  await approveWellbeingLibrary();
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
    // Doc B §3 topic taxonomy: all eight approved labels and their WN-*
    // mappings are quoted in the reviewed handoff, so nothing here is a
    // proposed grouping. They are registered as CONTENT_REVIEW_REQUIRED
    // because quoting copy is not the same act as approving it;
    // `approveWellbeingLibrary()` below carries the recorded approval as a
    // separate, guarded write, which also means a re-run can never undo a
    // reviewer's BLOCKED or RETIRED answer.
    ...APPROVED_RESOURCE_CATEGORIES.map((category) => ({
      code: category.code,
      kind: ContentKind.CATEGORY,
      namespace: ApprovalNamespace.WELLBEING,
      status: ContentStatus.CONTENT_REVIEW_REQUIRED,
      payload: {
        reviewPending: true,
        label: category.label,
        category: category.category,
        resources: [...category.resources],
        note: 'Label and mapping quoted from the reviewed handoff; not a release approval.',
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

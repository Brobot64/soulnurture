/**
 * AI capabilities and limits explanation — a protected MVP requirement
 * (coordination report §10: preserved in every scope outcome).
 *
 * This copy IS the consent instrument, so it is versioned: accepting stores a
 * ConsentRecord for `ai-disclosure-vN` together with the ids of the statements
 * the student ticked, which is what lets a school prove exactly what each
 * student saw and agreed to. Bumping AI_DISCLOSURE_VERSION therefore
 * re-prompts every existing student once.
 */
export const AI_DISCLOSURE_VERSION = 'v2';

export const AI_DISCLOSURE_CONSENT_VERSION = `ai-disclosure-${AI_DISCLOSURE_VERSION}`;

export const AI_DISCLOSURE_TITLE = 'Before you chat with Soul Nurture AI';

export const AI_DISCLOSURE_INTRO =
  'Soul Nurture AI is here to listen. First, please read how it works and what it cannot do — it takes about a minute.';

export interface AiDisclosureSection {
  /** Stable id — used as an anchor and kept in the consent audit trail. */
  id: string;
  heading: string;
  items: string[];
}

export interface AiDisclosureGroup {
  id: string;
  title: string;
  summary: string;
  sections: AiDisclosureSection[];
}

export interface AiDisclosureAgreement {
  id: string;
  label: string;
}

/** "Read before you start" — the safety, privacy and AI-use essentials. */
export const AI_DISCLOSURE_ESSENTIALS: AiDisclosureGroup = {
  id: 'read-before-you-start',
  title: 'Read before you start',
  summary: 'The important safety, privacy and AI-use points. Please read all of them.',
  sections: [
    {
      id: 'what-it-is',
      heading: 'What Soul Nurture AI is',
      items: [
        'Soul Nurture AI is an AI-supported wellbeing tool for school life. It listens, reflects back what you share, and suggests small healthy steps.',
        'It is not a person. It is not a psychologist, counsellor, doctor, parent or guardian, and it is not an emergency service.',
        'It can never replace the care of a real person who knows you.',
      ],
    },
    {
      id: 'what-it-cannot-do',
      heading: 'What the AI cannot do',
      items: [
        'AI can make mistakes. It can misunderstand you, or say something that is simply not true.',
        'It cannot diagnose a mental health condition, or any other illness.',
        'It cannot give you therapy, medical advice, or emergency help.',
        'If a reply feels wrong or unhelpful, you do not have to follow it — talk to a person you trust instead.',
      ],
    },
    {
      id: 'get-human-help',
      heading: 'Get human help now if you need it',
      items: [
        'If you are in danger, or thinking about hurting yourself or someone else, tell a trusted adult straight away.',
        'In an emergency, call your local emergency number or go to the nearest hospital. Do not wait on this chat.',
        'Inside a chat, tap "I would like to talk to someone" at any time and we will help you reach a person at your school.',
        'Choosing not to chat changes nothing about the help you can get — the Support page is always open to you.',
      ],
    },
    {
      id: 'privacy-in-short',
      heading: 'Your privacy in short',
      items: [
        'Your chat and check-ins are saved to your private school record. Other students cannot see them.',
        'If our safety rules are triggered, your school counselling team is alerted with your name, your class, and a short piece of the message that triggered it — so someone can check on you.',
        'Please do not type passwords, money details, or other people\u2019s private information into the chat.',
      ],
    },
  ],
};

/** "About this chat" — the deeper explanation, available on demand. */
export const AI_DISCLOSURE_ABOUT: AiDisclosureGroup = {
  id: 'about-this-chat',
  title: 'About this chat',
  summary: 'More detail on what this tool does, how it works, and what happens to what you share.',
  sections: [
    {
      id: 'what-it-supports',
      heading: 'What Soul Nurture AI can support you with',
      items: [
        'Emotional check-ins — a short, regular check on how you are feeling.',
        'Guided reflection — gentle questions that help you think through what is on your mind.',
        'Emotional literacy — words for what you feel, so it is easier to name it.',
        'Psychoeducation — simple, accurate information about feelings, stress and wellbeing.',
        'Coping and wellbeing strategies — breathing, grounding and other small steps you can try.',
        'Help-seeking — knowing when and how to ask for help.',
        'Connecting you with the right human support at your school.',
      ],
    },
    {
      id: 'how-it-works',
      heading: 'How the AI works',
      items: [
        'You type or speak, and a large language model writes a supportive reply in your language.',
        'Every reply is checked against our safety rules before you see it. Things it must never say — like labelling or diagnosing you — are blocked and replaced with safe guidance.',
        'A reflection chat is short on purpose: it wraps up after a few turns so you always leave with a clear next step.',
        'It only knows what you share here plus your school check-in details. It is not someone who remembers your whole life.',
      ],
    },
    {
      id: 'what-we-collect',
      heading: 'What information may be collected',
      items: [
        'Your messages and the AI\u2019s replies, with the date and time of each.',
        'Your check-in answers: the feeling you picked, how strong it was, and anything you wrote.',
        'Safety alerts raised by a conversation, and any support request you send.',
        'Basic school details: your name, your class and your preferred language.',
        'Your consent records — including this one.',
      ],
    },
    {
      id: 'how-we-protect',
      heading: 'How your information is protected',
      items: [
        'Your information is stored on your school\u2019s secure server and travels over an encrypted connection.',
        'You can only open your own conversations — every request is checked against your account.',
        'What you write is sent to our AI provider so it can reply. It sees your first name and your message, not your whole school record.',
        'Consent, safety alerts and support requests are logged, so the school can review how you were helped.',
      ],
    },
    {
      id: 'when-we-escalate',
      heading: 'When we may need to escalate',
      items: [
        'If a conversation suggests you may be at risk of harm, we tell your school\u2019s counselling or safeguarding team — even if you would rather we did not.',
        'Your safety comes before privacy. That is true of every wellbeing service, and of every adult who cares about you.',
        'Where we can, we will tell you this is happening and help you reach that person yourself.',
      ],
    },
    {
      id: 'human-support',
      heading: 'How to ask for a human',
      items: [
        'Tap "I would like to talk to someone" in a chat, or open the Support page, and pick a person from your school\u2019s support list.',
        'You choose when: in the next day or two, today during a study period, or right now because you do not feel safe.',
        'You can also speak directly with a teacher, counsellor, parent or guardian you trust — no chat needed.',
      ],
    },
  ],
};

export const AI_DISCLOSURE_GROUPS: AiDisclosureGroup[] = [
  AI_DISCLOSURE_ESSENTIALS,
  AI_DISCLOSURE_ABOUT,
];

/** The statements the student must tick — all of them, or there is no consent. */
export const AI_DISCLOSURE_AGREEMENTS: AiDisclosureAgreement[] = [
  {
    id: 'ai-limits',
    label:
      'I understand that Soul Nurture AI is an AI tool. It is not a psychologist, counsellor, doctor, parent/guardian or emergency service, it cannot diagnose me, and it cannot give me therapy or emergency help.',
  },
  {
    id: 'ai-mistakes',
    label:
      'I understand that AI can make mistakes, and that if I am in danger or need urgent help I will go to a trusted adult or an emergency service instead of relying on this chat.',
  },
  {
    id: 'privacy-safeguarding',
    label:
      'I understand that my chat and check-ins are saved, and that if my school is worried about my safety the people who protect students may be told — including a short part of what I wrote.',
  },
];

export const AI_DISCLOSURE_AGREEMENT_IDS = AI_DISCLOSURE_AGREEMENTS.map(
  (agreement) => agreement.id,
);

export const AI_DISCLOSURE_CONFIRM_LABEL =
  'I understand and agree to use Soul Nurture AI';

export const AI_DISCLOSURE_DECLINE_LABEL = 'Not now';

/** Flattened plain text — for API consumers, screen readers and printouts. */
function flattenDisclosure(): string {
  return AI_DISCLOSURE_GROUPS.map((group) =>
    [
      `${group.title} — ${group.summary}`,
      ...group.sections.map((section) =>
        [`\n${section.heading}`, ...section.items.map((item) => `- ${item}`)].join(
          '\n',
        ),
      ),
    ].join('\n'),
  ).join('\n\n');
}

export const AI_DISCLOSURE_TEXT = flattenDisclosure();

export function aiDisclosureView() {
  return {
    version: AI_DISCLOSURE_VERSION,
    consentVersion: AI_DISCLOSURE_CONSENT_VERSION,
    title: AI_DISCLOSURE_TITLE,
    intro: AI_DISCLOSURE_INTRO,
    groups: AI_DISCLOSURE_GROUPS,
    agreements: AI_DISCLOSURE_AGREEMENTS,
    confirmLabel: AI_DISCLOSURE_CONFIRM_LABEL,
    declineLabel: AI_DISCLOSURE_DECLINE_LABEL,
    text: AI_DISCLOSURE_TEXT,
  };
}

export type AiDisclosureView = ReturnType<typeof aiDisclosureView>;

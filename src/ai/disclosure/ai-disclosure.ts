/**
 * AI capabilities and limits explanation — a protected MVP requirement
 * (coordination report §10: preserved in every scope outcome).
 *
 * The text is versioned; acknowledging stores a ConsentRecord with version
 * `ai-disclosure-v1` so the school can prove each student saw it.
 */
export const AI_DISCLOSURE_VERSION = 'v1';

export const AI_DISCLOSURE_CONSENT_VERSION = `ai-disclosure-${AI_DISCLOSURE_VERSION}`;

export const AI_DISCLOSURE_TITLE =
  'Meeting Soul Nurture AI — what it can do, and what it cannot';

export const AI_DISCLOSURE_TEXT = `Soul Nurture AI is a supportive listening companion for school life.

What it can do:
- Listen without judgement and keep a private space for your feelings.
- Reflect back what you share and suggest small, healthy next steps.
- Offer breathing and grounding activities, and link you to wellbeing resources your school has approved.
- When things are heavy, help you reach a human at your school at any time.

What it cannot do:
- It is not a person, and it holds no memory of you beyond this conversation.
- It is not a therapist, psychologist, doctor or counsellor, and it does not diagnose anything.
- It cannot sign approvals, issue certificates, or make promises about a professional's time.
- It cannot keep you safe by itself — if you are in danger, tell a person right away.

How to reach a human at any time:
- In a check-in conversation, ask for support and choose a person you trust from your school's support list.
- In an emergency, tell an adult you trust immediately.`;

export function aiDisclosureView() {
  return {
    version: AI_DISCLOSURE_VERSION,
    consentVersion: AI_DISCLOSURE_CONSENT_VERSION,
    title: AI_DISCLOSURE_TITLE,
    text: AI_DISCLOSURE_TEXT,
  };
}

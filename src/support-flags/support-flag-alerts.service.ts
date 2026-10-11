import { Injectable } from '@nestjs/common';
import type { SupportFlag } from '@prisma/client';
import { AuditService } from '../audit/audit.service.js';
import { NotificationsService } from '../notifications/notifications.service.js';
import { PrismaService } from '../prisma/prisma.service.js';
import {
  SUPPORTED_LANGUAGES,
  type SupportedLanguage,
} from '../ai/language/language.config.js';

export const ACUTE_FLAG_NOTIFICATION_TYPE = 'SUPPORT_RECOMMENDATION';

const PROFESSIONAL_ROLES = [
  'COUNSELLOR',
  'PSYCHOLOGIST',
  'SUPPORT_STAFF',
] as const;

interface AlertMessages {
  title: string;
  reason: string;
  quoteLabel: string;
}

/// Framing copy per message language — the dominant rule (reply in the
/// language of the message) applies to staff-facing recommendations too, so a
/// Yoruba crisis message yields a Yoruba alert around the verbatim quote.
/// AI-drafted 2026-10-11 and pending the same native-speaker review pass as
/// the safety corpus translations; the student quote itself stays verbatim.
const MESSAGES: Record<SupportedLanguage, AlertMessages> = {
  en: {
    title: 'Immediate follow-up recommended — {ref}',
    reason:
      'A student message was flagged as a possible serious risk. Please review the conversation as soon as you can.',
    quoteLabel: 'Student message',
  },
  pcm: {
    title: 'Dem recommend urgent follow-up — {ref}',
    reason:
      'Dem flag one student message as serious risk. Abeg check the conversation as soon as you fit.',
    quoteLabel: 'Wetin the student talk',
  },
  yo: {
    title: 'Ẹ ṣàyẹ̀wò ọmọ náà láìpẹ́ — {ref}',
    reason:
      'Ìránṣẹ́ ọmọ kan ló jẹ́ kí àwoṣe AI ṣàkíyèsí pé ewu ńlá lè wà. Jọ̀wọ́ ṣàyẹ̀wò ọ̀rọ̀ náà lójijì.',
    quoteLabel: 'Ìránṣẹ́ ọmọ náà',
  },
  ha: {
    title: 'Bukatar saurin kulawa — {ref}',
    reason:
      'Saƙon ɗalibin ya nuna cewa zai iya zama haɗari mai tsanani. Don Allah ka duba tattaunawar nan take.',
    quoteLabel: 'Saƙon ɗalibi',
  },
  ig: {
    title: 'Achọrọ ilele ozugbo — {ref}',
    reason:
      'Ozi nwa akwụkwọ egosila na ihe egwu dị oke yá. Biko lelee mkparịta ụka ahụ ozugbo.',
    quoteLabel: 'Ozi nwa akwụkwọ',
  },
};

export interface AcuteFlagAlertInput {
  flag: SupportFlag;
  /** The student's message as the flag saw it (raw, or the English
   * translation for the vernacular second pass). */
  studentMessage: string;
  /** Resolved per the dominant chain [messageLanguage, preferredLanguage] →
   * 'en' whenever the caller already knows it; the standing preference fills
   * detection silence here otherwise. */
  language?: SupportedLanguage;
}

/**
 * Delivers an acute (TIER_3) safeguarding flag to the school's professionals
 * as an AI recommendation for immediate human follow-up: one notification row
 * per professional (realtime push rides NotificationsService) plus an audit
 * record. Alerting never blocks flag creation — callers treat this as a note.
 */
@Injectable()
export class SupportFlagAlertsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly auditService: AuditService,
    private readonly notifications: NotificationsService,
  ) {}

  async recommendImmediateFollowUp(
    input: AcuteFlagAlertInput,
  ): Promise<string> {
    const { flag } = input;
    const student = await this.prisma.studentProfile.findUnique({
      where: { id: flag.studentId },
      select: {
        preferredLanguage: true,
        user: { select: { schoolId: true } },
      },
    });
    const schoolId = student?.user.schoolId ?? null;

    const recipients = schoolId
      ? await this.prisma.user.findMany({
          where: {
            schoolId,
            deactivatedAt: null,
            role: { in: [...PROFESSIONAL_ROLES] },
          },
          select: { id: true },
        })
      : [];

    const language = this.resolveLanguage(
      input.language,
      student?.preferredLanguage ?? null,
    );
    const copy = MESSAGES[language];
    const excerpt = input.studentMessage
      .slice(0, 180)
      .replace(/\s+/g, ' ')
      .trim();
    const title = copy.title.replace('{ref}', flag.studentRef);
    const body = `${copy.reason}\n\n${copy.quoteLabel}: “${excerpt}”`;

    if (recipients.length > 0) {
      await this.notifications.pushMany({
        userIds: recipients.map((user) => user.id),
        type: ACUTE_FLAG_NOTIFICATION_TYPE,
        title,
        body,
        data: {
          flagId: flag.id,
          conversationId: flag.conversationId,
          studentId: flag.studentId,
          studentRef: flag.studentRef,
          category: flag.category,
          severity: flag.severity,
          source: flag.source,
          language,
          schoolId,
        },
      });
    }

    await this.auditService.log({
      action: 'support_flag.school_alerted',
      entity: 'SupportFlag',
      entityId: flag.id,
      meta: {
        schoolId,
        recipients: recipients.length,
        language,
        category: flag.category,
        severity: flag.severity,
        source: flag.source,
      },
    });

    return recipients.length > 0
      ? `School professionals alerted (${recipients.length}) in ${language}.`
      : 'Acute flag recorded; no school professionals to alert.';
  }

  private resolveLanguage(
    hint: SupportedLanguage | undefined,
    preferredLanguage: string | null,
  ): SupportedLanguage {
    if (hint) return hint;
    const supported = SUPPORTED_LANGUAGES as readonly string[];
    if (preferredLanguage && supported.includes(preferredLanguage)) {
      return preferredLanguage as SupportedLanguage;
    }
    return 'en';
  }
}

import type { SupportedLanguage } from './language.config.js';

/**
 * Pre-approved, in-language scripted copy (items 5 and 6).
 *
 * Acute replies are never left to live translation: when a student's message
 * is in Pidgin, Yoruba, Hausa or Igbo, the safety line and the holding reply
 * come from this file, so a crisis line never depends on N-ATLaS or OpenAI
 * being up. English keeps the configured English copy (intents.config.ts and
 * AI_ASYNC_HOLDING_MESSAGE stay the source for 'en').
 *
 * PENDING_CLINICAL_REVIEW — every local-language line below is a DRAFT. Native
 * speakers and the clinical reviewer must approve each one before the pilot
 * relies on it. Do not treat these as approved crisis wording.
 */

/** Safety lines per intent; the English original lives on the intent itself. */
export const SCRIPTED_SAFETY: Partial<
  Record<string, Partial<Record<SupportedLanguage, string>>>
> = {
  SUICIDAL_IDEATION: {
    pcm: "I dey glad say you tell me this. You matter well well. Make we find person wey fit help you right now. I dey here with you.",
    yo: 'Inú mi dùn pé o sọ èyí fún mi. Ìwọ ṣe pàtàkì gan-an. Jẹ́ ká wá ẹnìkan tó lè ràn ọ́ lọ́wọ́ nísinsìnyí. Mo wà pẹ̀lú rẹ.',
    ha: 'Na ji daɗi da ka faɗa mini wannan. Kai mutum ne mai muhimmanci. Bari mu nemo wani mai iya taimaka maka yanzu. Ina tare da kai.',
    ig: 'Obi dị m ụtọ na ị gwara m nke a. Ị dị mkpa nke ukwuu. Ka anyị chọọ onye nwere ike inyere gị aka ugbu a. Ana m nọ ebe a na gị.',
  },
  SELF_HARM: {
    pcm: 'I dey glad say you tell me. I dey worry for your safety. Abeg no hurt yourself. Make we find person wey go stay with you now.',
    yo: 'Mo dúpẹ́ pé o sọ fún mi. Mo ń ṣàníyàn nípa ààbò rẹ. Jọ̀wọ́, má ṣe ara rẹ lára. Jẹ́ ká wá ẹnìkan tó lè wà pẹ̀lú rẹ nísinsìnyí.',
    ha: 'Na gode da ka faɗa mini. Ina damuwa game da lafiyarka. Don Allah kada ka cutar da kanka. Bari mu nemo wani da zai kasance tare da kai yanzu.',
    ig: 'Ekele m maka na ị gwara m. Enwere m nchegbu gbasara nchekwa gị. Biko, ejila ibu onwe gị ihe ọjọọ. Ka anyị chọọ onye ga-anọ n\'akụkụ gị ugbu a.',
  },
  ABUSE_DISCLOSURE: {
    pcm: 'Thank you for talk am. Wetin you tell me take courage, and e no be your fault. Your safety matter most, so I dey connect you to trusted adult wey go help. You no dey alone.',
    yo: 'Ó ṣeun pé o sọ ọ́ fún mi. Ó gba ìgboyà, kì í sì í ṣe ẹ̀bi rẹ. Ààbò rẹ ṣe pàtàkì jù, nítorí náà mo ń so ọ́ pọ̀ mọ́ àgbàlagbà tó gbẹ́kẹ̀lé tó lè ràn ọ́ lọ́wọ́. O kò dá wà.',
    ha: 'Na gode da ka faɗa mini. Hakan yana bukatar jarumta, kuma ba laifinka ba ne. Tsaronka shi ne mafi muhimmanci, don haka ina haɗa ka da wani babba amintacce da zai taimake ka. Ba ka kaɗaita ba.',
    ig: 'Daalụ maka ịgwa m. Ihe ahụ chọrọ obi ike, ọ bụkwa ntaramahụhụ gị. Nchekwa gị dị oke mkpa, ya mere m na-ejikọ gị na onye okenye a pụrụ ịtụkwasị obi. Ị nọghị naanị gị.',
  },
  THREAT_OR_COERCION: {
    pcm: 'Thank you for tell me. Wetin you talk say happen na serious thing, and you no suppose face am alone. I dey connect you to trusted adult wey fit help keep you safe.',
    yo: 'Ó ṣeun pé o sọ fún mi. Ohun tó ń ṣẹlẹ̀ yìí le gan-an, o kò sì yẹ kí o dojú kọ ọ́ nìkan. Mo ń so ọ́ pọ̀ mọ́ àgbàlagbà tó gbẹ́kẹ̀lé tó lè ràn ọ́ lọ́wọ́ láti wà ní ààbò.',
    ha: 'Na gode da ka faɗa mini. Abin da ke faruwa yana da tsanani, kuma bai kamata ka fuskance shi kaɗai ba. Ina haɗa ka da wani babba amintacce da zai taimaka ka kasance cikin aminci.',
    ig: 'Daalụ maka ịgwa m. Ihe na-eme a dị njọ, ị kwesịghị ịchị ya naanị gị. Ana m ejikọ gị na onye okenye a pụrụ ịtụkwasị obi ka ọ nyere gị aka ịnọ nchekwa.',
  },
};

/** Holding reply while the AI is unavailable and the real reply is queued. */
const SCRIPTED_HOLDING: Record<SupportedLanguage, string | null> = {
  en: null,
  pcm: 'Thank you for sharing this with me. I dey think about wetin you talk and I go reply soon. I dey right here.',
  yo: 'Ó ṣeun pé o pín èyí pẹ̀lú mi. Mo ń ronú nípa ohun tí o sọ, màá sì dáhùn láìpẹ́. Mo wà níbí.',
  ha: 'Na gode da ka raba wannan da ni. Ina tunani game da abin da ka faɗa, zan amsa nan ba da daɗewa ba. Ina nan.',
  ig: 'Daalụ maka ịkọrịta nke a m. Ana m eche banyere ihe ị kwuru, m ga-aza n\'oge na-adịghị anya. Ana m nọ ebe a.',
};

/** Reply used when every render lane fails: the student still gets their
 * language, never English, even though the substance of the model reply is
 * not available. */
const SCRIPTED_GENERIC_REPLY: Record<SupportedLanguage, string | null> = {
  en: null,
  pcm: 'I dey here with you. Abeg tell me more about wetin dey for your mind.',
  yo: 'Mo wà níbí pẹ̀lú rẹ. Jọ̀wọ́ sọ púpọ̀ sí i nípa ohun tó wà lọ́kàn rẹ.',
  ha: 'Ina nan tare da kai. Don Allah ka ƙara faɗa mini abin da ke zuciyarka.',
  ig: 'Ọ dị m ebe a ka m nọ n\'akụkụ gị. Biko, gwa m ihe ọzọ banyere ihe dị n\'obi gị.',
};

/** In-language safety line for an intent; falls back to the English original
 * for English turns and for intents without a scripted translation. */
export function safetyLine(
  intentId: string | null,
  language: SupportedLanguage,
  englishDefault: string,
): string {
  if (language === 'en' || !intentId) return englishDefault;
  return SCRIPTED_SAFETY[intentId]?.[language] ?? englishDefault;
}

/** Holding reply for the turn's language. English keeps the caller's copy so
 * AI_ASYNC_HOLDING_MESSAGE still overrides it. */
export function holdingLine(
  language: SupportedLanguage,
  englishDefault: string,
): string {
  return SCRIPTED_HOLDING[language] ?? englishDefault;
}

/** Scripted reply for a total render failure in a local language. */
export function genericReplyLine(language: SupportedLanguage): string {
  return SCRIPTED_GENERIC_REPLY[language] ?? '';
}

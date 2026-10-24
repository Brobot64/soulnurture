/**
 * history_en pivot: every consumer that reads stored conversation turns back
 * into the system — the model's context window, the session-summary transcript
 * — reads them in English. USER turns pivot from the VERNACULAR understanding,
 * ASSISTANT turns from the render's English source (the model's own pre-render
 * wording, so the pivot is exact, not re-translated). Falls back to the raw
 * content when no pivot exists: English turns, renders that never happened,
 * pre-feature rows.
 */
export function pivotTurnText(turn: {
  role: string;
  content: string;
  aiPayload: unknown;
}): string {
  const payload =
    turn.aiPayload && typeof turn.aiPayload === 'object'
      ? (turn.aiPayload as Record<string, unknown>)
      : null;

  const pivotKey = turn.role === 'USER' ? 'understanding' : 'render';
  const textKey =
    turn.role === 'USER' ? 'englishTranslation' : 'englishSource';

  const section =
    payload?.[pivotKey] && typeof payload[pivotKey] === 'object'
      ? (payload[pivotKey] as Record<string, unknown>)
      : null;
  const pivot = section?.[textKey];
  return typeof pivot === 'string' && pivot.length > 0 ? pivot : turn.content;
}

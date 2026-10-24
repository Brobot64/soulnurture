import type { ConfigService } from '@nestjs/config';
import type { AiConfig } from '../config/ai.config.js';
import type { NatlasLlmProvider } from '../providers/natlas/natlas-llm.provider.js';
import type { AiUsageMeterService } from '../providers/usage-meter.service.js';
import { ReplyRendererService } from './reply-renderer.service.js';

/** Live N-ATLaS sometimes hands the English back unchanged when asked for
 * Pidgin, or English prose for Yoruba. A render must be in the target language
 * to count; otherwise the next lane is tried. */
const ENGLISH =
  'I hear you, and I am glad you told me. Can you tell me a bit more about what is on your mind?';

const aiConfig = {
  openai: { model: 'gpt-test' },
  language: { renderMaxOutputTokens: 400 },
} as unknown as AiConfig;


describe('ReplyRendererService — the render must be in the target language', () => {
  let natlas: { configured: boolean; completeText: ReturnType<typeof vi.fn> };
  let config: { get: ReturnType<typeof vi.fn> };
  let fetchMock: ReturnType<typeof vi.fn>;

  const make = () =>
    new ReplyRendererService(
      config as unknown as ConfigService,
      natlas as unknown as NatlasLlmProvider,
      { record: vi.fn().mockResolvedValue(undefined) } as unknown as AiUsageMeterService,
      aiConfig,
    );

  beforeEach(() => {
    natlas = { configured: true, completeText: vi.fn() };
    config = { get: vi.fn().mockReturnValue(undefined) };
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('rejects an N-ATLaS render that echoes the English reply and returns null without OpenAI', async () => {
    natlas.completeText.mockResolvedValue({ text: ENGLISH, usage: {} });

    expect(await make().render({ englishReply: ENGLISH, language: 'pcm' })).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('rejects an English-looking N-ATLaS render for a Yoruba target', async () => {
    natlas.completeText.mockResolvedValue({
      text: 'Thank you for telling me. I am here with you and we can talk more about school.',
      usage: {},
    });

    expect(await make().render({ englishReply: ENGLISH, language: 'yo' })).toBeNull();
  });

  it('rejects a render that echoes the English behind a label ("Nigerian Pidgin reply: …")', async () => {
    natlas.completeText.mockResolvedValue({
      text: `Nigerian Pidgin reply:\n${ENGLISH}`,
      usage: {},
    });

    expect(await make().render({ englishReply: ENGLISH, language: 'pcm' })).toBeNull();
  });

  it('rejects a render in another local language for a Pidgin target (live: Yoruba text for a Pidgin reply)', async () => {
    natlas.completeText.mockResolvedValue({
      text: 'A gboi, we yabụ i yin. Iwọ yoo fẹ lati sọ diẹ sii nipa ohun ti o wa lori ọkan rẹ?',
      usage: {},
    });

    expect(await make().render({ englishReply: ENGLISH, language: 'pcm' })).toBeNull();
  });

  it('rejects a Pidgin target render with no Pidgin evidence (live: Igbo text with no diacritics)', async () => {
    natlas.completeText.mockResolvedValue({
      text: 'A gbo e, na im gbo e. Kedu ihe di ya n\'obi?',
      usage: {},
    });

    expect(await make().render({ englishReply: ENGLISH, language: 'pcm' })).toBeNull();
  });

  it('rejects a Pidgin render with a single marker and Yoruba words (live: "Nan, mo gbo ehm, e don tire e.")', async () => {
    natlas.completeText.mockResolvedValue({
      text: 'Nan, mo gbo ehm, e don tire e.',
      usage: {},
    });

    expect(await make().render({ englishReply: ENGLISH, language: 'pcm' })).toBeNull();
  });

  it('rejects a degenerate render that repeats one phrase (live: a Pidgin turn came back looping)', async () => {
    const looping = Array(5).fill('ebe e na-ewute gi, ebe e na-ewute gi,').join(' ');
    natlas.completeText.mockResolvedValue({ text: looping, usage: {} });

    expect(await make().render({ englishReply: ENGLISH, language: 'pcm' })).toBeNull();
  });

  it('rejects a render far longer than the English it translates', async () => {
    natlas.completeText.mockResolvedValue({ text: ENGLISH.repeat(3), usage: {} });

    expect(await make().render({ englishReply: ENGLISH, language: 'pcm' })).toBeNull();
  });

  it('strips a leading language label from a good render before it reaches the student', async () => {
    natlas.completeText.mockResolvedValue({
      text: 'Nigerian Pidgin reply:\nI dey here with you. Abeg tell me more about wetin dey for your mind.',
      usage: {},
    });

    const out = await make().render({ englishReply: ENGLISH, language: 'pcm' });
    expect(out?.rendered).toBe('I dey here with you. Abeg tell me more about wetin dey for your mind.');
  });

  it('accepts a real Yoruba render from N-ATLaS', async () => {
    natlas.completeText.mockResolvedValue({
      text: 'Mo wà níbí pẹ̀lú rẹ. Ṣé o lè sọ fún mi díẹ̀ síi nípa ohun tó ń ṣe lọ́kàn rẹ?',
      usage: {},
    });

    const out = await make().render({ englishReply: ENGLISH, language: 'yo' });
    expect(out?.via).toBe('n-atlas-local');
  });

  it('when N-ATLaS echoes the English, OpenAI is never asked to render (N-ATLaS-only)', async () => {
    config.get.mockImplementation((key: string) => (key === 'OPENAI_API_KEY' ? 'sk-test' : undefined));
    natlas.completeText.mockResolvedValue({ text: ENGLISH, usage: {} });

    const out = await make().render({ englishReply: ENGLISH, language: 'yo' });
    expect(out).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

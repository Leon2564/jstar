import { describe, expect, it } from 'vitest';
import { DATE_RULES, VOICE_RULES, jstDay, voiceAllowance, voiceLeft } from '../src/rules';
import { sceneProblems, zSceneScript, type SceneScript } from '../src/scenes/schema';
import { MAIN_SCENES } from '../src/scenes';
import { SceneStepReq, TtsReq, VoiceExtendReq } from '../src/contracts';
import { VOICE_INPUT } from '../src/voice';

/** Voice minutes (#74): the allowance, what is left, the JST day it belongs to, and the paid extension in scripts. */
const at = (iso: string) => Date.parse(iso);
const pass = '2099-01-01T00:00:00Z';

describe('voice minutes (#74)', () => {
  it('free and pass minutes, plus every extension bought that day', () => {
    const now = at('2026-10-01T03:00:00Z');
    expect(voiceAllowance(null, 0, now)).toBe(VOICE_RULES.freeMinutesPerDay * 60);
    expect(voiceAllowance(pass, 0, now)).toBe(VOICE_RULES.passMinutesPerDay * 60);
    expect(voiceAllowance(null, 2, now)).toBe((VOICE_RULES.freeMinutesPerDay + 2 * VOICE_RULES.extendMinutes) * 60);
    // An expired pass is no pass.
    expect(voiceAllowance('2026-09-30T00:00:00Z', 0, now)).toBe(VOICE_RULES.freeMinutesPerDay * 60);
  });

  it('seconds used today come off; never below zero', () => {
    const now = at('2026-10-01T03:00:00Z');
    const day = jstDay(now);
    expect(voiceLeft({ day, usedSeconds: 125, extensions: 0 }, null, now)).toBe(VOICE_RULES.freeMinutesPerDay * 60 - 125);
    expect(voiceLeft({ day, usedSeconds: 99_999, extensions: 0 }, null, now)).toBe(0);
    expect(voiceLeft({ day, usedSeconds: VOICE_RULES.freeMinutesPerDay * 60, extensions: 1 }, null, now)).toBe(VOICE_RULES.extendMinutes * 60);
    expect(voiceLeft(null, null, now)).toBe(VOICE_RULES.freeMinutesPerDay * 60);
  });

  it('resets at 0:00 JST, not at UTC midnight', () => {
    // 23:59 JST on 10/1 is 14:59 UTC; one minute later it is 10/2 in Japan.
    const before = at('2026-10-01T14:59:00Z');
    const after = at('2026-10-01T15:00:00Z');
    const spent = { day: jstDay(before), usedSeconds: VOICE_RULES.freeMinutesPerDay * 60, extensions: VOICE_RULES.extendsPerDay };
    expect(jstDay(before)).toBe('2026-10-01');
    expect(jstDay(after)).toBe('2026-10-02');
    expect(voiceLeft(spent, null, before)).toBe(VOICE_RULES.extendsPerDay * VOICE_RULES.extendMinutes * 60);
    // Yesterday's seconds and extensions are gone at once.
    expect(voiceLeft(spent, null, after)).toBe(VOICE_RULES.freeMinutesPerDay * 60);
  });

  it("アリス's date extension is the voice extension", () => {
    expect(DATE_RULES.extendMinutes).toBe(VOICE_RULES.extendMinutes);
    const greenhouse = MAIN_SCENES.find((s) => s.meta.id === 'night-greenhouse')!;
    const extend = greenhouse.steps.find((s) => s.id === 'extend');
    expect(extend?.type === 'choice' && extend.options.find((o) => o.id === 'extend')?.pay).toBe('extend');
    expect(sceneProblems(greenhouse)).toEqual([]);
  });

  it('a paid option must lengthen the date by exactly the extension, and never be the only way on', () => {
    const T = (s: string) => ({ ja: s, 'zh-Hant': s, en: s });
    const script = (seconds: number, both = false): SceneScript => zSceneScript.parse({
      meta: { id: 'paid', star: 'alice', title: T('paid'), trigger: { slots: ['night'] } },
      steps: [
        { id: 'wide', type: 'clip', shot: 'wide', media: 'alice-hero' },
        { id: 'ask', type: 'choice', options: [
          { id: 'more', next: 'end', pay: 'extend', effect: { timer: { seconds, add: true } }, label: T('more') },
          { id: 'bye', next: 'end', label: T('bye'), ...(both ? { pay: 'extend', effect: { timer: { seconds, add: true } } } : {}) }
        ] },
        { id: 'end', type: 'end' }
      ]
    });
    expect(sceneProblems(script(DATE_RULES.extendMinutes * 60))).toEqual([]);
    expect(sceneProblems(script(600))).toEqual(['ask: more pays for an extension but does not add DATE_RULES.extendMinutes']);
    expect(sceneProblems(script(DATE_RULES.extendMinutes * 60, true))).toEqual(['ask: every option costs points']);
  });

  it('requests: ids, text length and the reported mic time are bounded', () => {
    expect(VoiceExtendReq.safeParse({ requestId: 'short' }).success).toBe(false);
    expect(VoiceExtendReq.safeParse({ requestId: '0b8f6c1e-5a47-4a53-9d53-2f1f1c6f7a10' }).success).toBe(true);
    expect(TtsReq.safeParse({ star: 'alice', text: 'あ'.repeat(VOICE_RULES.ttsMaxChars + 1), requestId: 'line-1234:0' }).success).toBe(false);
    expect(SceneStepReq.safeParse({ runId: 'r', seq: 0, input: 'hi', voiceMs: VOICE_INPUT.maxMs + 1 }).success).toBe(false);
    expect(SceneStepReq.safeParse({ runId: 'r', seq: 0, input: 'hi', voiceMs: 4200 }).success).toBe(true);
  });
});

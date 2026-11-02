import { describe, expect, it } from 'vitest';
import { LINES } from '../src/lines';
import { lineToSay, needsRuntimeVoice } from '../src/scenes/speech';
import type { LineStep, SceneText } from '../src/scenes/schema';

/** A line file's text as written, before #83 linked her recordings into it. */
const unvoiced = ({ voice: _v, unnamed, ...t }: SceneText): SceneText => ({ ...t, ...(unnamed ? { unnamed: unvoiced(unnamed) } : {}) });
const named = unvoiced(LINES.mahiro.confession.accept[1]);
const step = (text: SceneText, extra: Partial<LineStep> = {}): LineStep => ({ id: 'l', type: 'line', text, ...extra });
const o = (runtimeVoice: boolean, lang = 'ja') => ({ lang, name: 'けんた', runtimeVoice });

describe('what she says for a line, and how (#73 runtime voice, #83 recordings)', () => {
  it('a line with his name is spoken at runtime when her runtime voice can speak', () => {
    expect(needsRuntimeVoice(named)).toBe(true);
    const said = lineToSay(step(named), o(true));
    expect(said).toEqual({ text: named.ja.replace('{name}', 'けんた'), runtime: true });
  });

  it('with the runtime voice off, it says the same moment without his name once that is recorded', () => {
    const recorded = { ...named, unnamed: { ...named.unnamed!, voice: '/voice/scene/mahiro/abc.mp3' } };
    expect(lineToSay(step(recorded), o(false))).toEqual({ text: named.unnamed!.ja, voice: '/voice/scene/mahiro/abc.mp3', runtime: false });
    expect(lineToSay(step(recorded), o(false, 'ko')).text).toBe(named.unnamed!.ko);
    // Not recorded yet: his name stays in the subtitle, nothing plays.
    expect(lineToSay(step(named), o(false, 'en'))).toEqual({ text: named.en.replace('{name}', 'けんた'), runtime: false });
  });

  it('with no name of his known, the line without it — never a name filled in from his account (round 10)', () => {
    for (const lang of ['ja', 'en', 'ko', 'zh-Hant']) {
      const said = lineToSay(step(named), { lang, name: '', runtimeVoice: true, you: 'きみ' });
      expect(said.text).toBe((named.unnamed as Record<string, string>)[lang] ?? named.unnamed!.ja);
      expect(said.text).not.toContain('{name}');
    }
    const bare = { ja: '{name}、ありがとう', 'zh-Hant': '{name}，謝謝', en: 'Thank you, {name}', ko: '{name}, 고마워' };
    expect(lineToSay(step(bare), { lang: 'en', name: '', runtimeVoice: false, you: 'you' }).text).toBe('Thank you, you');
  });

  it('a recorded line plays its recording; her free-talk reply and `tts` lines use the runtime voice or are subtitles', () => {
    const plain = unvoiced(LINES.mahiro.confession.accept[0]);
    expect(lineToSay(step(plain, { voice: '/voice/scene/mahiro/x.mp3' }), o(true))).toEqual({ text: plain.ja, voice: '/voice/scene/mahiro/x.mp3', runtime: false });
    expect(lineToSay(step(plain, { agent: true }), o(true)).runtime).toBe(true);
    expect(lineToSay(step(plain, { tts: true }), o(false))).toEqual({ text: plain.ja, runtime: false });
    expect(lineToSay(step(plain), o(true))).toEqual({ text: plain.ja, runtime: false });
    // A text from a line file carries its recording on the text (#83).
    expect(lineToSay(step({ ...plain, voice: '/voice/scene/mahiro/y.mp3' }), o(false)).voice).toBe('/voice/scene/mahiro/y.mp3');
  });

  it('Korean reads Korean, and falls back to English where a text has none', () => {
    expect(lineToSay(step(named), o(true, 'ko')).text).toBe(named.ko!.replace('{name}', 'けんた'));
    const noKo = { ja: 'やあ', 'zh-Hant': '嗨', en: 'Hi' };
    expect(lineToSay(step(noKo), o(false, 'ko')).text).toBe('Hi');
  });
});

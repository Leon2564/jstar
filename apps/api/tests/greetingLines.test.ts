import { describe, expect, it } from 'vitest';
import { STAR_IDS } from '@jstar/shared';
import { inLanguage } from '@jstar/shared/domain';
import { GREETING_LINES } from '../src/lib/greetingLines';
import { fillCall, greetingTemplate } from '../src/lib/greetingTemplate';

const LANGS = ['ja', 'zh-Hant', 'en', 'ko'] as const;
const HOURS = { 'early morning': '2026-10-14T21:30:00Z', morning: '2026-10-15T00:00:00Z', daytime: '2026-10-15T04:00:00Z', evening: '2026-10-15T10:00:00Z', 'late night': '2026-10-15T14:00:00Z' };

/** Round 11: うんぱい and えいみ said まひろ's written greeting word for word. */
describe('her own written greeting, in her voice', () => {
  it('no two talents share a line, in any language, at any hour or gap', () => {
    for (const lang of LANGS) {
      const all = (star: (typeof STAR_IDS)[number]) => {
        const t = GREETING_LINES[star][lang];
        return [t.first, t.same, t.long, t.close, ...Object.values(t.next)];
      };
      const seen = new Map<string, string>();
      for (const star of STAR_IDS) for (const line of all(star)) {
        expect(seen.get(line), `${lang} ${star}: ${line}`).toBeUndefined();
        seen.set(line, star);
      }
    }
  });

  it('by her hour and their relationship, in his language — Korean in her register, no kana outside Japanese', () => {
    for (const star of STAR_IDS) for (const lang of LANGS) for (const [part, at] of Object.entries(HOURS)) {
      const line = greetingTemplate(lang, 1, null, new Date(at), null, star);
      expect(line, `${star} ${lang} ${part}`).toBe(fillCall(GREETING_LINES[star][lang].next[part as keyof typeof HOURS], null, lang, GREETING_LINES[star][lang].you));
      expect(line).not.toContain('{call}');
      // Round 13: no "Welcome back, you." / 「어서 와, 너.」 — outside Japanese no name means no address.
      if (lang !== 'ja') expect(line).not.toMatch(/[,，、]\s*(you|너|你)[.!?。！？]|^(you|너|你)[,，]/);
      if (lang !== 'ja') expect(inLanguage(line, lang, []), `${star} ${lang}: ${line}`).toBe(true);
    }
    // Close (ambiguous and on): she says she missed him; new: she does not.
    expect(greetingTemplate('ja', 1, 'ケン', new Date(HOURS.evening), null, 'nana', 'lover')).toBe('おかえり、ケン！今日はどんな一日だった？えへへ、会いたかったんだ。');
    expect(greetingTemplate('ja', 1, 'ケン', new Date(HOURS.evening), null, 'nana', 'familiar')).toBe('おかえり、ケン！今日はどんな一日だった？');
    expect(greetingTemplate('en', null, null, new Date(HOURS.evening), 'rain', 'unpai')).toBe("It's raining here. Mm, nice to meet you. I'm Unpai. …So you came.");
    // Her Korean register: アリス polite (해요체), the others casual (반말).
    for (const line of Object.values(GREETING_LINES.alice.ko.next)) expect(line).toMatch(/요[.?!…]*$|어요|에요|세요/);
    for (const star of ['mahiro', 'nana', 'eimi', 'unpai'] as const) for (const line of Object.values(GREETING_LINES[star].ko.next)) expect(line).not.toMatch(/요[.?!]*$|습니다/);
  });
});

describe('her weather words in her own register (round 13)', () => {
  it('アリス polite in ja and ko, the other four casual — never a casual opener on a polite line', async () => {
    const { withWeather } = await import('../src/lib/greetingTemplate');
    expect(withWeather('また来てくれたんですね。', 'ja', 'rain', 'before', 'alice')).toBe('雨、降っていますね。また来てくれたんですね。');
    expect(withWeather('또 와 주셨네요.', 'ko', 'rain', 'before', 'alice')).toBe('비가 오네요. 또 와 주셨네요.');
    expect(withWeather('おかえり！', 'ja', 'rain', 'before', 'nana')).toBe('雨、降ってるね。おかえり！');
    for (const weather of ['rain', 'snow', 'first_snow', 'alert'] as const) {
      expect(withWeather('x', 'ja', weather, 'before', 'alice')).toMatch(/ます|ました|です|ください/);
      expect(withWeather('x', 'ko', weather, 'before', 'alice')).toMatch(/요[.!…]/);
      for (const star of ['mahiro', 'nana', 'eimi', 'unpai'] as const) expect(withWeather('x', 'ko', weather, 'before', star)).not.toMatch(/요[.!…]/);
    }
    // Her whole written greeting in the rain: one register.
    for (const at of Object.values(HOURS)) expect(greetingTemplate('ja', 1, null, new Date(at), 'rain', 'alice')).toMatch(/^雨、降っていますね。/);
  });
});

describe('his name in her written greeting (round 13)', () => {
  it('his kana name in Latin / Hangul for en / ko, as stored for ja / zh-Hant (U-10); "you" / 너 only when he has none', async () => {
    const { nameIn } = await import('@jstar/shared/kanaName');
    expect([nameIn('ケンタ', 'en'), nameIn('ケンタ', 'ko'), nameIn('しょうた', 'ko'), nameIn('ケンタ', 'zh-Hant'), nameIn('健太', 'en'), nameIn('ケンタ', 'ja')]).toEqual(['Kenta', '켄타', '쇼타', 'ケンタ', '健太', 'ケンタ']);
    const evening = new Date(HOURS.evening);
    expect(greetingTemplate('en', 1, nameIn('ケンタ', 'en'), evening, null, 'mahiro')).toBe('Welcome back, Kenta. You worked hard today.');
    expect(greetingTemplate('ko', 1, nameIn('ケンタ', 'ko'), evening, null, 'mahiro')).toBe('어서 와, 켄타. 오늘도 수고했어.');
    expect(greetingTemplate('en', 1, null, evening, null, 'mahiro')).toBe('Welcome back. You worked hard today.');
    expect(greetingTemplate('ko', 1, null, evening, null, 'mahiro')).toBe('어서 와. 오늘도 수고했어.');
  });
});

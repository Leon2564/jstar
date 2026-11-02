import { describe, expect, it } from 'vitest';
import { promiseLine, STAR_IDS } from '@jstar/shared';

/** Round 13: the missed-promise line was the same words for all five, so アリス lost her polite voice. */
describe('her promise lines, in her voice', () => {
  it('each talent says the missed line her own way, in four languages', () => {
    for (const lang of ['ja', 'zh-Hant', 'en', 'ko']) {
      const lines = STAR_IDS.map((star) => promiseLine('missed', lang, 'X', { star }));
      expect(new Set(lines).size, lang).toBe(STAR_IDS.length);
      for (const line of lines) expect(line).toContain('X');
    }
    expect(promiseLine('missed', 'ja', 'X', { star: 'alice' })).toMatch(/ませんでした.*ません.*ますか/);
    expect(promiseLine('missed', 'ko', 'X', { star: 'alice' })).toMatch(/요\?$/);
    for (const kind of ['early', 'yesterday', 'due'] as const) expect(promiseLine(kind, 'ja', 'X', { star: 'alice' })).toMatch(/ます|ました|です/);
  });

  it('a promise made in Japanese is still named in his language — by its time on his clock', () => {
    const o = { star: 'nana' as const, dueAt: '2026-10-15T12:00:00.000Z' };
    expect(promiseLine('missed', 'en', '夜9時、ここで待ってる', o)).toBe("Our 21:00 promise — we missed it last time…! But I'm not mad at all, okay? Let's promise again — for real this time!");
    expect(promiseLine('missed', 'zh-Hant', '夜9時、ここで待ってる', { ...o, tz: 'Asia/Taipei' })).toMatch(/^我們約好的20:00，/);
    expect(promiseLine('early', 'en', '夜9時、ここで待ってる', { dueAt: o.dueAt })).toBe('You came. You remembered our promise — our 21:00 promise.');
    expect(promiseLine('missed', 'ko', '夜9時、ここで待ってる', o)).toMatch(/^21:00 약속, /);
    // In his language already: quoted as it was made.
    expect(promiseLine('missed', 'en', '9 pm, right here with you', o)).toContain('"9 pm, right here with you"');
  });
});

import { describe, expect, it } from 'vitest';
import { STAR_IDS } from '../src';
import { touchLine, touchStageOf, type TouchLines } from '../src/touch';
import touch from '../src/touch.json';

const TOUCH_LINES = touch as TouchLines;

const KANA = /[ぁ-ゖァ-ヺ]/;

describe('her reaction to his touch in pure view (QA #5, U-36)', () => {
  it('three lines for each closeness, in every language, with no kana outside Japanese and no greeting', () => {
    for (const star of STAR_IDS) {
      for (const stage of ['early', 'close', 'lover'] as const) {
        const set = TOUCH_LINES[star][stage];
        expect(set).toHaveLength(3);
        for (const l of set) {
          for (const lang of ['ja', 'zh-Hant', 'en', 'ko'] as const) expect(l[lang].trim(), `${star} ${stage} ${lang}`).toBeTruthy();
          for (const lang of ['zh-Hant', 'en', 'ko'] as const) expect(l[lang], `${star} ${stage} ${lang}`).not.toMatch(KANA);
          expect(l['zh-Hant']).not.toMatch(/初次見面|午餐/);
        }
      }
    }
  });

  it('follows how close they are, and never says the same line twice in a row', () => {
    expect([touchStageOf('new'), touchStageOf('familiar'), touchStageOf('ambiguous'), touchStageOf('confession_ready'), touchStageOf('lover'), touchStageOf(null)])
      .toEqual(['early', 'early', 'close', 'close', 'lover', 'early']);
    expect(touchLine(TOUCH_LINES, 'mahiro', 'new', 0, 'zh-Hant')).toBe('咦？……怎麼了，突然碰我。');
    expect(touchLine(TOUCH_LINES, 'mahiro', 'lover', 0, 'en')).toBe(TOUCH_LINES.mahiro.lover[0].en);
    for (let n = 0; n < 6; n++) expect(touchLine(TOUCH_LINES, 'nana', 'familiar', n, 'zh-Hant')).not.toBe(touchLine(TOUCH_LINES, 'nana', 'familiar', n + 1, 'zh-Hant'));
  });
});

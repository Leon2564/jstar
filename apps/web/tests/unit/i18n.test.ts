import { describe, expect, it } from 'vitest';
import { LANGS, detectLang, ensureLang, translate } from '../../src/i18n';
import { zhHant } from '../../src/i18n/zhHant';
import { en } from '../../src/i18n/en';
import { ko } from '../../src/i18n/ko';
import { ja, type Dict } from '../../src/i18n/ja';
const DICTS: Record<string, Dict> = { ja, 'zh-Hant': zhHant, en, ko };

const vars = (s: string) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort().join(',');

describe('i18n dictionaries', () => {
  for (const lang of LANGS) {
    it(`${lang}: same keys as ja, no empty strings, same placeholders`, () => {
      const d = DICTS[lang];
      expect(Object.keys(d).sort()).toEqual(Object.keys(ja).sort());
      for (const [k, v] of Object.entries(d)) {
        expect(v.trim(), `${lang} ${k} empty`).not.toBe('');
        expect(vars(v), `${lang} ${k} placeholders`).toBe(vars(ja[k as keyof typeof ja]));
      }
    });
  }
  it('non-Japanese locales do not fall back to Japanese kana in UI strings (spot check)', () => {
    for (const lang of ['en', 'ko'] as const) {
      for (const [k, v] of Object.entries(DICTS[lang])) {
        if (k === 'lang.name') continue;
        expect(/[\u3040-\u30ff]/.test(v), `${lang} ${k} contains kana: ${v}`).toBe(false);
      }
    }
  });
  it('interpolates variables and leaves unknown ones intact', async () => {
    await ensureLang('en'); await ensureLang('ko');
    expect(translate('en', 'trial.left', { n: 2 })).toBe('2 left');
    expect(translate('ko', 'trial.left', { n: 2 })).toBe('2통 남음');
    expect(translate('en', 'trial.left')).toBe('{n} left');
  });
  it.each([['zh-TW', 'zh-Hant'], ['zh-HK', 'zh-Hant'], ['zh-CN', 'zh-Hant'], ['ko-KR', 'ko'], ['en-US', 'en'], ['ja-JP', 'ja'], ['fr-FR', 'ja'], [undefined, 'ja']])('detects %s → %s', (nav, want) => {
    expect(detectLang(nav)).toBe(want);
  });
});

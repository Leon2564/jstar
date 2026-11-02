import { describe, expect, it, beforeAll } from 'vitest';
import { scriptLang } from '@jstar/shared/domain';
import { answerLine } from '../../src/components/confessionMemories';
import { DICTS, ensureLang, translate, type Key, type Lang } from '../../src/i18n';

// N-21: his kept answer to her confession, in a language other than the page's, is his words labelled as such.
const tFor = (lang: Lang) => Object.assign((k: Key, v?: Record<string, string | number>) => translate(lang, k, v), { lang }) as never;

describe('his answer, in the language he said it (N-21)', () => {
  beforeAll(async () => { await ensureLang('en'); await ensureLang('ko'); await ensureLang('zh-Hant'); expect(DICTS.en).toBeTruthy(); });

  it('tells the language by its script', () => {
    expect(['ずっと好きだった', '좋아해', '我也喜歡你', 'I love you too', '❤️'].map(scriptLang)).toEqual(['ja', 'ko', 'zh-Hant', 'en', null]);
  });

  it('the same language: as before; another: quoted and labelled with its language, in the page\'s words', () => {
    expect(answerLine('ずっと好きだった', tFor('ja'))).toBe('あなたの答え：「ずっと好きだった」');
    expect(answerLine('ずっと好きだった', tFor('en'))).toBe('Your answer (Japanese): “ずっと好きだった”');
    expect(answerLine('I love you too', tFor('ja'))).toBe('あなたの答え（英語）：「I love you too」');
    expect(answerLine('ずっと好きだった', tFor('ko'))).toBe('당신의 대답(일본어): 「ずっと好きだった」');
  });
});

import { describe, expect, it } from 'vitest';
import { HER_MESSAGE_KINDS, HER_MESSAGE_LINES, fitHerMessage, fitSceneReply, herMessageLine, perDayOf, withoutGoodMorning } from '../src/herMessages';
import { HER_MESSAGE_RULES, SCENE_RULES } from '../src/rules';
import { LANGS } from '../src/domain';

describe('her messages (#58)', () => {
  it('has her own line for every kind in every language, each within the strict length and free of anything outside the app', () => {
    for (const kind of HER_MESSAGE_KINDS) {
      for (const lang of LANGS) {
        const lines = HER_MESSAGE_LINES[kind][lang];
        expect(lines.length, `${kind}/${lang}`).toBeGreaterThanOrEqual(3);
        for (const line of lines) {
          expect([...line].length, line).toBeLessThanOrEqual(HER_MESSAGE_RULES.maxChars[lang]);
          expect(fitHerMessage(line, lang)).toBe(line);
          expect(line).not.toMatch(/https?:|@|\d{3,}|LINE|電話/);
        }
      }
    }
  });

  it('picks the same fallback line for the same message, and Japanese for an unknown language', () => {
    expect(herMessageLine('dream', 'en', 'u|d|dream')).toBe(herMessageLine('dream', 'en', 'u|d|dream'));
    expect(HER_MESSAGE_LINES.note.ja).toContain(herMessageLine('note', 'fr', 'x'));
  });

  it('C-room R6: her dream line says good morning only in the morning; sent at 11:10 it opens with the dream', () => {
    for (const lang of ['ja', 'zh-Hant', 'en', 'ko'] as const) {
      for (let i = 0; i < 40; i++) {
        const seed = `u${i}|2026-10-05|dream`;
        expect(herMessageLine('dream', lang, seed, 8)).toBe(herMessageLine('dream', lang, seed));
        const late = herMessageLine('dream', lang, seed, 11);
        expect(late).not.toMatch(/おはよう|早安|good morning|좋은 아침/i);
        expect(late).not.toMatch(/^[…\s]/);
        expect(late.length).toBeGreaterThan(8);
      }
    }
    expect(withoutGoodMorning('Good morning, and thank you for yesterday. …Showing up in my dreams too?')).toBe('Thank you for yesterday. …Showing up in my dreams too?');
    expect(withoutGoodMorning('早安。……昨晚，你出現在我的夢裡。')).toBe('昨晚，你出現在我的夢裡。');
    // Her other lines are never touched.
    expect(herMessageLine('note', 'ja', 'x', 15)).toBe(herMessageLine('note', 'ja', 'x'));
  });

  it('cuts a long line at a sentence end, or gives it up', () => {
    const max = HER_MESSAGE_RULES.maxChars.en;
    expect(fitHerMessage(`${'a'.repeat(100)}. ${'b'.repeat(100)}`, 'en')).toBe(`${'a'.repeat(100)}.`);
    expect(fitHerMessage('a'.repeat(max + 1), 'en')).toBeNull();
    expect(fitHerMessage('  hi\n there  ', 'en')).toBe('hi there');
  });

  it('allows as many a day as his setting says', () => {
    expect([perDayOf('normal'), perDayOf('less'), perDayOf('off')]).toEqual([HER_MESSAGE_RULES.perDay, HER_MESSAGE_RULES.lessPerDay, 0]);
  });
});

describe('her reply inside a scene fits three subtitle lines (M4)', () => {
  it('keeps a short reply, and cuts a long one at a sentence end within SCENE_RULES.replyMaxChars', () => {
    expect(fitSceneReply('  ふふ、おかえり。\n今日もおつかれさま。 ', 'ja')).toBe('ふふ、おかえり。 今日もおつかれさま。');
    const long = 'ふふ、そんなこと言われたら照れちゃうな。でもね、わたしもずっと同じこと考えてたんだよ。今日は雨だったから、窓の外ばっかり見てて、あなたのことばかり思い出してた。';
    const cut = fitSceneReply(long, 'ja');
    expect([...cut].length).toBeLessThanOrEqual(SCENE_RULES.replyMaxChars.ja);
    expect(cut).toBe('ふふ、そんなこと言われたら照れちゃうな。でもね、わたしもずっと同じこと考えてたんだよ。');
    const en = 'Mm, you really know how to make me smile. I was thinking the same thing all evening, watching the rain on the window and wondering when you would come back to me tonight.';
    expect(fitSceneReply(en, 'en')).toBe('Mm, you really know how to make me smile.');
    for (const lang of LANGS) expect([...fitSceneReply(long + long, lang)].length, lang).toBeLessThanOrEqual(SCENE_RULES.replyMaxChars[lang]);
  });

  it('without a sentence end it cuts at a pause, else hard — with 「…」, never empty', () => {
    const run = '今日はね、雨の音を聞きながら、あなたのことを考えて、窓の外の街の灯りをずっと見ていて、それからまた雨の音を聞いていて、あなたの声を思い出していたの';
    const cut = fitSceneReply(run, 'zh-Hant');
    expect(cut.endsWith('…')).toBe(true);
    expect([...cut].length).toBeLessThanOrEqual(SCENE_RULES.replyMaxChars['zh-Hant']);
    expect(cut).not.toMatch(/、…$/);
    expect(fitSceneReply('あ'.repeat(200), 'ja')).toBe(`${'あ'.repeat(SCENE_RULES.replyMaxChars.ja - 1)}…`);
  });
});

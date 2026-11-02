import { describe, expect, it } from 'vitest';
import { PROMISE_LINES, dueFrom, inPromiseWindow, keepLineKind, promiseLine } from '../src/promises';
import { PROMISE_RULES } from '../src/rules';
import { LINES } from '../src/lines';
import { STAR_IDS } from '../src/domain';

const at = (s: string) => Date.parse(s);

describe('promises (#59)', () => {
  it('reads her scripts\' relative times', () => {
    expect(dueFrom('+12h', at('2026-09-26T12:00:00Z'))).toBe('2026-09-27T00:00:00.000Z');
    expect(dueFrom('+1d', at('2026-09-26T12:00:00Z'))).toBe('2026-09-27T12:00:00.000Z');
    expect(dueFrom('tomorrow', 0)).toBeNull();
    // Every proposal line has a time the API can make a promise from.
    for (const star of STAR_IDS) for (const l of LINES[star].promises) expect(dueFrom(l.due, 0), `${star}/${l.id}`).not.toBeNull();
  });

  it('keeps a promise within three hours either side of its time', () => {
    const due = '2026-09-27T12:00:00.000Z';
    expect(inPromiseWindow(due, at(due) - PROMISE_RULES.windowMs)).toBe(true);
    expect(inPromiseWindow(due, at(due) + PROMISE_RULES.windowMs)).toBe(true);
    expect(inPromiseWindow(due, at(due) - PROMISE_RULES.windowMs - 1)).toBe(false);
    expect(inPromiseWindow(due, at(due) + PROMISE_RULES.windowMs + 1)).toBe(false);
  });

  it('picks her line by when he came: early, the day after it was made, or at its time', () => {
    const p = { dueAt: '2026-09-27T12:00:00.000Z', madeAt: '2026-09-26T11:00:00.000Z' }; // made 9/26 20:00 JST, due 9/27 21:00 JST
    expect(keepLineKind(p, at('2026-09-27T11:00:00Z'))).toBe('early');
    expect(keepLineKind(p, at('2026-09-27T12:30:00Z'))).toBe('yesterday');
    expect(keepLineKind({ ...p, madeAt: '2026-09-27T01:00:00.000Z' }, at('2026-09-27T12:30:00Z'))).toBe('due');
    // 9/27 23:30 JST → 9/28 00:30 JST: made two JST days before by then.
    expect(keepLineKind(p, at('2026-09-27T15:30:00Z'))).toBe('due');
  });

  it('quotes the promise in her line, in every language, and never reproaches a missed one', () => {
    expect(promiseLine('yesterday', 'ja', '夜9時、朗読を聞かせる')).toBe('昨日の約束、覚えてる？「夜9時、朗読を聞かせる」……ちゃんと、待ってたよ。');
    expect(promiseLine('due', 'fr', 'x')).toBe(promiseLine('due', 'ja', 'x'));
    for (const kind of Object.keys(PROMISE_LINES) as (keyof typeof PROMISE_LINES)[]) {
      for (const lang of ['ja', 'zh-Hant', 'en', 'ko']) expect(promiseLine(kind, lang, 'P'), `${kind}/${lang}`).toContain('P');
    }
    expect(PROMISE_LINES.missed.ja).not.toMatch(/なんで|ひどい|約束したのに/);
  });
});

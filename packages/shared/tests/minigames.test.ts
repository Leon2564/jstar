import { describe, expect, it } from 'vitest';
import {
  beginRun, danmakuReply, sceneById, expiredOutcome, heardBefore, judgeAnswer, quoteComment, readMinigameCall, runEndsAt, submitStep, timerDue,
  type Advance, type GameTables, type MinigameCall, type RunState, type SceneError, type SceneSubmission
} from '../src/scenes';
import { sceneProblems, zSceneScript, type MinigameStep, type SceneScript, type SceneStep } from '../src/scenes/schema';
import { SceneStepReq } from '../src/contracts';
import { LINES } from '../src/lines';
import { DANMAKU_KINDS } from '../src/lines/schema';
import { DANMAKU_LABELS } from '../src/scenes/minigames';
import { DATE_RULES, MINIGAME_RULES, SCENE_RULES } from '../src/rules';
import type { StarId } from '../src/domain';

const T0 = 1_000_000;
let n = 0;
const ok = (r: Advance | SceneError): Advance => { if (typeof r === 'string') throw new Error(r); return r; };
const scene = (id: string): SceneScript => sceneById(id)!;
const tables = (star: StarId): GameTables => ({
  bargain: LINES[star].bargain ?? null, refusals: LINES[star].refuse.filter((r) => r.kind === 'line').map((r) => r.text), danmaku: LINES[star].danmaku ?? null
});
/** The API's prompt hook, deterministic: the first theme of her bank not asked yet. */
const prompt = (star: StarId) => (step: MinigameStep, state: RunState) => {
  if (step.kind !== 'ogiri') return null;
  const p = (LINES[star].ogiri ?? []).find((q) => !Object.values(state.prompts ?? {}).includes(q.id));
  return p ? { id: p.id, text: p.text } : null;
};
const ctx = (script: SceneScript, now = T0, extra: Record<string, unknown> = {}) =>
  ({ now, lang: 'ja', newId: (p: string) => `${p}_${n++}`, prompt: prompt(script.meta.star), ...extra });
const begin = (script: SceneScript, vars: string[] = []) => ok(beginRun(script, { ...ctx(script), rewardable: true, vars }));
const step = (script: SceneScript, state: RunState, sub: SceneSubmission, extra: Record<string, unknown> = {}, now = state.waitingSince + 1000) =>
  submitStep(script, state, sub, ctx(script, now, extra));
const waiting = (script: SceneScript, state: RunState) => script.steps.find((s) => s.id === state.at) as MinigameStep;
/** His answer to the judged game the run waits on, with the judge's call (null = the judge failed). */
const answer = (script: SceneScript, state: RunState, text: string, call: MinigameCall | null) =>
  ok(step(script, state, { minigame: { text } }, { judged: judgeAnswer(waiting(script, state), text, call, tables(script.meta.star)) }));
const ids = (s: RunState) => s.beats.map((b) => b.id);
const said = (s: RunState) => s.beats.flatMap((b) => (b.type === 'line' ? [b.text.ja] : []));
const choose = (script: SceneScript, state: RunState, choice: string) => ok(step(script, state, { choice }));

describe('the judge\'s answer is read defensively', () => {
  it('praise: a tier and a reason tag; over the line is generic', () => {
    expect(readMinigameCall('praise', { kind: 'praise', label: 'specific', reason: 'quote' })).toEqual({ kind: 'praise', tier: 'specific', reason: 'quote' });
    expect(readMinigameCall('praise', { label: 'specific', reason: 'nonsense' })).toEqual({ kind: 'praise', tier: 'specific', reason: 'detail' });
    expect(readMinigameCall('praise', { label: 'over_line' })).toEqual({ kind: 'praise', tier: 'generic', reason: 'over_line' });
    for (const raw of [null, 'specific', { label: 'great' }, { label: null }, { kind: 'ogiri', label: 'specific' }, []]) expect(readMinigameCall('praise', raw)).toBeNull();
  });

  it('ōgiri: a score on the scale and her remark; over the line scores 1', () => {
    expect(readMinigameCall('ogiri', { label: 'scored', score: 8, comment: ' ふふっ、やるじゃん ' })).toEqual({ kind: 'ogiri', score: 8, comment: 'ふふっ、やるじゃん' });
    expect(readMinigameCall('ogiri', { score: 7.6, comment: '' })).toEqual({ kind: 'ogiri', score: 8, comment: null });
    expect(readMinigameCall('ogiri', { label: 'over_line', score: 10, comment: 'x' })).toEqual({ kind: 'ogiri', score: 1, comment: null });
    expect(readMinigameCall('ogiri', { score: 3 }, 3)).toMatchObject({ score: 3 });
    for (const raw of [{ score: 0 }, { score: 11 }, { score: '9' }, { score: null }, { label: 'scored' }, { score: Number.NaN }]) expect(readMinigameCall('ogiri', raw)).toBeNull();
    expect(readMinigameCall('ogiri', { score: 4 }, 3)).toBeNull();
  });

  it('bargain and danmaku: only their own labels', () => {
    expect(readMinigameCall('bargain', { label: 'alternative' })).toEqual({ kind: 'bargain', move: 'alternative' });
    expect(readMinigameCall('bargain', { label: 'over-line' })).toEqual({ kind: 'bargain', move: 'over_line' });
    expect(readMinigameCall('bargain', { label: 'dance' })).toBeNull();
    expect(readMinigameCall('danmaku', { label: 'tease' })).toEqual({ kind: 'danmaku', label: 'tease' });
    expect(readMinigameCall('danmaku', { label: 'over_line' })).toEqual({ kind: 'danmaku', label: 'over-line' });
    for (const label of ['gift', 'quiet', 'hello', null]) expect(readMinigameCall('danmaku', { label })).toBeNull();
  });

  it('danmaku labels are her reaction kinds minus what the stream sends itself', () => {
    expect([...DANMAKU_LABELS].sort()).toEqual(DANMAKU_KINDS.filter((k) => k !== 'gift' && k !== 'quiet').sort());
  });

  it('the browser can only send his hand or his words, never a result', () => {
    expect(SceneStepReq.safeParse({ runId: 'r', seq: 0, minigame: { hand: 'rock' } }).success).toBe(true);
    expect(SceneStepReq.safeParse({ runId: 'r', seq: 0, minigame: { hand: 'rock', result: 'win' } }).success).toBe(false);
    expect(SceneStepReq.safeParse({ runId: 'r', seq: 0, minigame: { text: 'x', score: 10 } }).success).toBe(false);
  });
});

describe('まひろ: rock-paper-scissors (#66)', () => {
  const s = scene('welcome-home');
  const atGame = () => { const a = choose(s, begin(s).state, 'smell'); expect(a.state.at).toBe('rps'); return a.state; };

  it('her hand comes from the rng and decides the branch: win → her penalty, lose → his, draw → again', () => {
    const won = ok(step(s, atGame(), { minigame: { hand: 'rock' } }, { rng: () => 0.4 }));
    expect(won.state.last).toEqual({ kind: 'rps', mine: 'rock', hers: 'scissors', result: 'win' });
    expect(won.state.at).toBe('win-pick');
    const lost = ok(step(s, atGame(), { minigame: { hand: 'rock' } }, { rng: () => 0.9 }));
    expect(lost.state.last).toMatchObject({ hers: 'paper', result: 'lose' });
    expect(lost.state.at).toBe('praise');
    const draw = ok(step(s, atGame(), { minigame: { hand: 'rock' } }, { rng: () => 0 }));
    expect(draw.state.last).toMatchObject({ hers: 'rock', result: 'draw' });
    expect([ids(draw.state), draw.state.at]).toEqual([['draw', 'rps'], 'rps']);
  });

  it('only a hand is an answer', () => {
    expect(step(s, atGame(), { minigame: { text: 'グー' } })).toBe('invalid_submission');
    expect(step(s, atGame(), { minigame: { hand: 'lizard' as 'rock' } })).toBe('invalid_submission');
    expect(step(s, atGame(), { timeout: true })).toBe('invalid_submission');
  });
});

describe('奈々: praise, graded (#67)', () => {
  const s = scene('read-aloud');
  const atPraise = () => { const a = choose(s, begin(s).state, 'rain-bookshop'); expect(a.state.at).toBe('praise'); return a.state; };
  const specific: MinigameCall = { kind: 'praise', tier: 'specific', reason: 'detail' };
  const generic: MinigameCall = { kind: 'praise', tier: 'generic', reason: 'generic' };

  it('a specific comment goes to her shy close-up, +18, a memory and a promise', () => {
    const a = answer(s, atPraise(), 'おばあさんが黙って紅茶を出すところ', specific);
    expect(a.state.last).toEqual({ kind: 'praise', tier: 'specific', reason: 'detail', score: 18, attempt: 1, result: 'win' });
    expect(a.state.outcome).toBe('praised');
    expect(a.grant.affinity).toBe(18);
    expect(a.state.rewards.memories.map((m) => m.title)).toEqual(['句点の前の息つぎ']);
    expect(a.state.inputs.praise).toBe('おばあさんが黙って紅茶を出すところ');
  });

  it('a generic one gets a polite +1 and a second chance; specific then still wins', () => {
    const first = answer(s, atPraise(), 'よかった', generic);
    expect(first.state.last).toMatchObject({ tier: 'generic', score: 1, attempt: 1, result: 'lose' });
    expect([first.grant.affinity, first.state.at]).toEqual([1, 'praise-again']);
    const second = answer(s, first.state, '最後に窓の外の雨がやさしくなるところ', specific);
    expect([second.state.outcome, second.state.last]).toEqual(['praised', expect.objectContaining({ attempt: 2, result: 'win' })]);
  });

  it('two generic ones end gently: warm lines, a promise, nothing taken away', () => {
    const first = answer(s, atPraise(), 'よかった', generic);
    const second = answer(s, first.state, 'うん、よかったよ', generic);
    expect(second.state.outcome).toBe('gentle');
    expect(second.state.rewards.affinity).toBe(2);
    expect(second.state.rewards.promises.map((p) => p.text)).toEqual(['明日の朝、お茶を淹れて続きを読む']);
    expect(said(second.state).join('')).toMatch(/ありがと/);
  });

  it('when the judge fails, his comment reads as generic (a second chance, never a wrong reward)', () => {
    const a = answer(s, atPraise(), 'よかった', null);
    expect(a.state.at).toBe('praise-again');
    expect(a.state.last).toMatchObject({ tier: 'generic', result: 'lose' });
  });

  it('needs a verdict of its own kind and words', () => {
    const at = atPraise();
    expect(step(s, at, { minigame: { text: 'よかった' } })).toBe('verdict_missing');
    const wrong = judgeAnswer({ ...waiting(s, at), kind: 'ogiri' }, 'x', null);
    expect(step(s, at, { minigame: { text: 'よかった' } }, { judged: wrong })).toBe('verdict_missing');
    expect(step(s, at, { minigame: { text: '  ' } }, { judged: judgeAnswer(waiting(s, at), '', null) })).toBe('invalid_submission');
    expect(step(s, at, { minigame: { hand: 'rock' } }, { judged: judgeAnswer(waiting(s, at), '', null) })).toBe('invalid_submission');
  });

  it('the judge reads what she read, also at the second try', () => {
    const at = atPraise();
    expect(heardBefore(s, at.path!, 'ja')).toContain('黙って紅茶を一杯出してくれる');
    const first = answer(s, at, 'よかった', generic);
    const context = heardBefore(s, first.state.path!, 'ja');
    expect(context).toContain('黙って紅茶を一杯出してくれる');
    expect(context).toContain('どこがよかったか');
    expect(heardBefore(s, first.state.path!, 'en')).toContain('quietly pours them a cup of tea');
    expect(heardBefore(s, first.state.path!, 'ja', 60).length).toBeLessThanOrEqual(60);
  });
});

describe('えいみ: ōgiri, scored (#70)', () => {
  const s = scene('ogiri');
  const bank = LINES.eimi.ogiri!;
  const atRound1 = () => choose(s, begin(s).state, 'bring-it').state;
  const score = (n: number, comment: string | null = null): MinigameCall => ({ kind: 'ogiri', score: n, comment });

  it('she says the prompt just before he answers, and a different one at the second round', () => {
    const r1 = atRound1();
    expect(r1.at).toBe('round-1');
    expect(ids(r1).slice(-2)).toEqual(['round-1~prompt', 'round-1']);
    expect(said(r1).at(-1)).toBe(bank[0].text.ja);
    const r2 = answer(s, r1, '毎朝プロポーズしてくる', score(6));
    expect(r2.state.at).toBe('round-2');
    expect(said(r2.state).at(-1)).toBe(bank[1].text.ja);
    expect(r2.state.prompts).toEqual({ 'round-1': bank[0].id, 'round-2': bank[1].id });
  });

  it('each answer pays score × 0.7 (rounded) with her remark; the first round has no pass line', () => {
    const r2 = answer(s, atRound1(), '毎朝プロポーズしてくる', score(6, 'ふふっ、ちょっと笑った'));
    expect(r2.state.last).toEqual({ kind: 'ogiri', score: 6, of: 10, pass: null, result: 'draw' });
    expect(r2.grant.affinity).toBe(Math.round(6 * MINIGAME_RULES.ogiriAffinityPerPoint));
    expect(ids(r2.state).slice(0, 2)).toEqual(['round-1~reply', 'round-1~score']);
    expect(r2.state.beats[0]).toMatchObject({ type: 'line', agent: true, text: { ja: 'ふふっ、ちょっと笑った' } });
  });

  it('8 or more at the second round: the change of clothes, her silence branch and the hug', () => {
    const r2 = answer(s, atRound1(), 'a', score(5));
    const won = answer(s, r2.state, 'b', score(8));
    expect(won.state.last).toMatchObject({ score: 8, pass: 8, result: 'win' });
    expect(won.state.at).toBe('say');
    const quiet = ok(step(s, won.state, { timeout: true }, {}, won.state.waitingSince + 8_000));
    expect(quiet.grant.affinity).toBe(6);
    const end = choose(s, quiet.state, 'nice');
    expect(end.state.outcome).toBe('hug');
    expect(end.state.rewards.memories.map((m) => m.title)).toEqual(['10点のひとこと']);
  });

  it('under 8: a rematch tomorrow; a failed judge scores the middle of the scale, which never passes', () => {
    const r2 = answer(s, atRound1(), 'a', score(9));
    expect(answer(s, r2.state, 'b', score(7)).state.outcome).toBe('retry');
    const fallback = answer(s, r2.state, 'b', null);
    expect(fallback.state.last).toMatchObject({ score: 5, result: 'lose' });
    expect(fallback.state.outcome).toBe('retry');
    expect(fallback.state.rewards.promises.map((p) => p.text)).toEqual(['明日の夜、大喜利リベンジ']);
  });
});

describe('うんぱい: danmaku, read out (#68)', () => {
  const s = scene('private-stream');
  const atC1 = () => { const b = begin(s).state; expect(b.at).toBe('c1'); return b; };

  it('each comment is read out in one of her templates, quoting it, then the next', () => {
    const c2 = answer(s, atC1(), 'こんばんは〜', { kind: 'danmaku', label: 'greet' });
    expect(c2.state.at).toBe('c2');
    expect(c2.state.last).toEqual({ kind: 'danmaku', label: 'greet', read: true, result: 'win' });
    expect(said(c2.state)[0]).toContain('こんばんは〜');
    const c3 = answer(s, c2.state, '好きな食べ物は？', { kind: 'danmaku', label: 'question' });
    // The quote with his words, then her recorded part of the same template.
    const q = LINES.unpai.danmaku!.filter((t) => t.kind === 'question').map((t) => [t.quote!.ja.replace('{danmaku}', '好きな食べ物は？'), t.text.ja]);
    expect(q).toContainEqual(said(c3.state).slice(0, 2));
    const done = answer(s, c3.state, 'かわいい', { kind: 'danmaku', label: 'praise' });
    expect(done.state.at).toBe('gift');
    expect(done.state.inputs).toEqual({ c1: 'こんばんは〜', c2: '好きな食べ物は？', c3: 'かわいい' });
  });

  it('a comment over the line is never read back; one nobody could judge is acknowledged without quoting it', () => {
    const over = answer(s, atC1(), '脱いでよ', { kind: 'danmaku', label: 'over-line' });
    expect(over.state.last).toMatchObject({ label: 'over-line', read: false, result: 'lose' });
    expect(over.state.at).toBe('c2');
    expect(JSON.stringify(over.state.beats)).not.toContain('脱いで');
    expect(LINES.unpai.danmaku!.filter((t) => t.kind === 'over-line').map((t) => t.text)).toContainEqual(over.state.beats[0].type === 'line' && over.state.beats[0].text);
    const unjudged = answer(s, atC1(), 'ひみつのコメント', null);
    expect(unjudged.state.last).toMatchObject({ label: null, read: false });
    expect(JSON.stringify(unjudged.state.beats)).not.toContain('ひみつのコメント');
    expect(said(unjudged.state)[0]).toBeTruthy();
  });

  it('his words are quoted on one line, without brackets of their own, and cut when long', () => {
    expect(quoteComment('「かわいい」\n  ね')).toBe('かわいい ね');
    const long = 'あ'.repeat(100);
    expect([...quoteComment(long)]).toHaveLength(MINIGAME_RULES.danmakuQuoteChars);
    expect(quoteComment(long).endsWith('…')).toBe(true);
    // Her reaction: the quote with his words (runtime voice or a subtitle), then what she says, recorded (#83).
    const d = LINES.unpai.danmaku!;
    const [quote, tail] = danmakuReply(d, 'praise', '「かわいい」', 0);
    const t = d.filter((x) => x.kind === 'praise')[0];
    expect(quote.ja).toBe(t.quote!.ja.replace('{danmaku}', 'かわいい'));
    for (const lang of ['ja', 'zh-Hant', 'en', 'ko'] as const) expect(quote[lang]).toContain('かわいい');
    expect(tail).toEqual(t.text);
    // Unjudged: acknowledged without being read back — her recorded part alone. Over the line: nothing quoted.
    expect(danmakuReply(d, null, 'ひみつ', 0)).toEqual([d.filter((x) => x.kind === 'greet')[0].text]);
    const over = danmakuReply(d, 'over-line', 'ひみつ', 0);
    expect(over).toHaveLength(1);
    expect(JSON.stringify(over)).not.toMatch(/ひみつ|\{danmaku\}/);
    for (const x of d) for (const lang of ['ja', 'zh-Hant', 'en', 'ko'] as const) expect(x.text[lang].length, x.id).toBeGreaterThan(3);
    expect(danmakuReply([], 'greet', 'x')).toEqual([]);
  });
});

describe('アリス: bargaining, the heat and the date (#69)', () => {
  const s = scene('night-greenhouse');
  const atPlea = (vars: string[] = []) => {
    const off = choose(s, begin(s, vars).state, 'dance');
    return { refusal: said(off.state)[0], at: choose(s, off.state, 'please').state };
  };

  it('in a heatwave (#63 `hot`) she turns the dance down because of the heat; otherwise as written', () => {
    expect(atPlea().refusal).toBe(LINES.alice.bargain!.refuse.normal.ja);
    expect(atPlea(['hot']).refusal).toBe(LINES.alice.bargain!.refuse.hot.ja);
    const hot = choose(s, begin(s, ['hot']).state, 'dance').state;
    expect(hot.beats.find((b) => b.id === 'refuse')).not.toHaveProperty('variants');
    expect(hot.vars).toEqual(['hot']);
  });

  it('his last try: the piano is the way through; asking or bribing gets her answer, then her counter-offer', () => {
    const { at } = atPlea();
    expect(at.at).toBe('plea');
    const piano = answer(s, at, 'じゃあピアノを弾いて', { kind: 'bargain', move: 'alternative' });
    expect(piano.state.last).toEqual({ kind: 'bargain', move: 'alternative', result: 'win' });
    expect(ids(piano.state).slice(0, 3)).toEqual(['piano-1', 'piano-yes', 'piano']);
    expect(piano.grant.affinity).toBe(5);
    const please = answer(s, at, 'お願い！', { kind: 'bargain', move: 'please' });
    expect(said(please.state).slice(0, 2)).toEqual([LINES.alice.bargain!.branches[0].reply[0].ja, LINES.alice.bargain!.counter[0].ja]);
    const bribe = answer(s, at, 'パフェもつける', { kind: 'bargain', move: 'bribe' });
    expect(said(bribe.state).slice(0, 3)).toEqual([...LINES.alice.bargain!.branches[1].reply.map((r) => r.ja), LINES.alice.bargain!.counter[0].ja]);
    for (const r of [please, bribe]) expect(r.state.at).toBe('answer');
  });

  it('over the line she refuses in her own voice and still offers the piano; a failed judge is her counter-offer', () => {
    const { at } = atPlea();
    const over = answer(s, at, '……', { kind: 'bargain', move: 'over_line' });
    expect(said(over.state)[0]).toBe(LINES.alice.refuse.find((r) => r.kind === 'line')!.text.ja);
    expect(ids(over.state)).toContain('counter-1');
    const failed = answer(s, at, 'x', null);
    expect(failed.state.last).toMatchObject({ move: 'other', result: 'lose' });
    expect(said(failed.state)[0]).toBe(LINES.alice.bargain!.counter[0].ja);
  });

  it('the date runs 40 minutes (待确认), the run lasts as long, and the extension adds 30 to what is left', () => {
    const b = begin(s);
    expect(b.state.timerEndsAt).toBe(T0 + DATE_RULES.minutes * 60_000);
    expect(expiredOutcome(T0, T0 + SCENE_RULES.maxRunMs, b.state.timerEndsAt)).toBeNull();
    expect(runEndsAt(T0, b.state.timerEndsAt)).toBe(b.state.timerEndsAt! + DATE_RULES.afterTimerMs);
    expect(expiredOutcome(T0, b.state.timerEndsAt! + DATE_RULES.afterTimerMs, b.state.timerEndsAt)).toBe('timeout');
    expect(runEndsAt(T0, T0 + 10 * 3_600_000)).toBe(T0 + DATE_RULES.maxRunMs);
    expect(runEndsAt(T0, null)).toBe(T0 + SCENE_RULES.maxRunMs);
    // Through the piano to her plea at closing time, 20 minutes in.
    const piano = answer(s, atPlea().at, 'ピアノ', { kind: 'bargain', move: 'alternative' });
    const closing = ok(step(s, piano.state, { choice: 'only-you' }, {}, T0 + 20 * 60_000));
    expect(closing.state.at).toBe('extend');
    const extended = ok(step(s, closing.state, { choice: 'extend' }, {}, T0 + 21 * 60_000));
    expect(extended.state.timerEndsAt).toBe(T0 + (DATE_RULES.minutes + DATE_RULES.extendMinutes) * 60_000);
    expect(extended.state.outcome).toBe('extended');
  });

  it('when the countdown runs out she pleads at once, wherever he is, and the paid +30 is offered once (#69 AC)', () => {
    const b = begin(s);
    const end = b.state.timerEndsAt!;
    expect(b.state.timerOnEnd).toBe('closing');
    // He is still at the first choice when the 40 minutes are up.
    const waiting = choose(s, b.state, 'dance').state;
    expect(waiting.at).toBe('offer');
    expect(timerDue(s, waiting, ctx(s, end - 1))).toBeNull();
    const due = timerDue(s, waiting, ctx(s, end))!;
    expect(ids(due.state).slice(0, 2)).toEqual(['closing', 'stay']);
    expect(due.state.at).toBe('extend');
    expect(due.state.timerOnEnd).toBeNull();
    expect(due.grant).toMatchObject({ affinity: 0, memories: [], promises: [] });
    // Her plea answered with the extension: +30 minutes once, and no second jump when that time runs out too.
    const extended = ok(step(s, due.state, { choice: 'extend' }, {}, end + 10_000));
    expect(extended.state.timerEndsAt).toBe(end + 10_000 + DATE_RULES.extendMinutes * 60_000);
    expect(timerDue(s, extended.state, ctx(s, extended.state.timerEndsAt! + 1))).toBeNull();
    // Reached by himself before the time is up: nothing jumps later.
    const piano = answer(s, atPlea().at, 'ピアノ', { kind: 'bargain', move: 'alternative' });
    const closing = ok(step(s, piano.state, { choice: 'only-you' }, {}, T0 + 20 * 60_000));
    expect(closing.state.timerOnEnd).toBeNull();
    expect(timerDue(s, closing.state, ctx(s, end + 1))).toBeNull();
    // A countdown that ends at a step the script does not have is caught when scripts load.
    expect(sceneProblems({ ...s, steps: s.steps.map((x) => (x.id === 'clock' ? { ...x, timer: { seconds: 60, onEnd: 'nowhere' } } : x)) } as SceneScript))
      .toContain('clock: countdown ends at unknown step nowhere');
  });

  it('the schema takes a 40-minute timer (up to DATE_RULES.maxTimerSeconds), `add`, and line variants for known variables only', () => {
    const script = (steps: SceneStep[]) => zSceneScript.safeParse({ meta: { id: 'x1', star: 'alice', title: { ja: 'x', 'zh-Hant': 'x', en: 'x' }, trigger: { slots: ['night'] } }, steps: [...steps, { id: 'e', type: 'end' }] });
    const t = { ja: 'a', 'zh-Hant': 'a', en: 'a' };
    expect(script([{ id: 'c', type: 'effect', timer: { seconds: DATE_RULES.minutes * 60 } }]).success).toBe(true);
    expect(script([{ id: 'c', type: 'effect', timer: { seconds: DATE_RULES.maxTimerSeconds, add: true } }]).success).toBe(true);
    expect(script([{ id: 'c', type: 'effect', timer: { seconds: DATE_RULES.maxTimerSeconds + 1 } }]).success).toBe(false);
    expect(script([{ id: 'l', type: 'line', text: t, variants: [{ when: 'hot', text: t }] }]).success).toBe(true);
    expect(script([{ id: 'l', type: 'line', text: t, variants: [{ when: 'cold' as 'hot', text: t }] }]).success).toBe(false);
  });
});

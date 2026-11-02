import { describe, expect, it } from 'vitest';
import { STAR_IDS } from '../src/domain';
import { CONFESSION_RULES } from '../src/rules';
import {
  afterAnswer, answerOfOutcome, confessionHour, confessionOf, confessionOffered, confessionSceneId, confessionStatus, freshConfession, guessAnswer, readVerdict,
  type ConfessionAnswer
} from '../src/confession';
import { CONFESSION_SCENES, confessionSceneById } from '../src/scenes/confession';
import { SCENES, beginRun, sceneOffered, submitStep, triggerProblems, upcomingMedia, type Advance, type SceneError } from '../src/scenes';
import { parseScene } from '../src/scenes/schema';
import { LINES } from '../src/lines';

let n = 0;
const ctx = (extra: Record<string, unknown> = {}) => ({ now: 1_000_000, lang: 'ja', newId: (p: string) => `${p}_${n++}`, ...extra });
const ok = (r: Advance | SceneError): Advance => { if (typeof r === 'string') throw new Error(r); return r; };
/** 2026-10-09 in JST at the given hour. */
const at = (h: number) => Date.parse(`2026-10-09T${String(h).padStart(2, '0')}:30:00+09:00`);

describe('confession scenes (#55)', () => {
  it('two per talent, built from her lines, valid scripts, kept out of the web entry bundle', () => {
    expect(CONFESSION_SCENES).toHaveLength(STAR_IDS.length * 2);
    for (const s of CONFESSION_SCENES) {
      expect(() => parseScene(s), s.meta.id).not.toThrow();
      expect(confessionOf(s.meta.id)).toEqual({ star: s.meta.star, again: s.meta.id.endsWith('-again') });
      expect(confessionSceneById(s.meta.id)).toBe(s);
      // Evening and night only; the relationship must be at confession_ready (the API checks the exact stage).
      expect(s.meta.trigger).toEqual({ slots: ['evening', 'night'], stage: 'confession_ready' });
      // Her own clips (#55): wide at sunset, close for the confession (and while he answers), the hug on his yes.
      expect(s.steps.filter((x) => x.type === 'clip').map((x) => x.type === 'clip' && x.media)).toEqual(['wide', 'close', 'yes'].map((k) => `${s.meta.star}-confession-${k}`));
      expect(s.meta.idle).toBe(`${s.meta.star}-confession-close`);
    }
    expect(SCENES.some((s) => confessionOf(s.meta.id))).toBe(false);
  });

  it('says her lines in order: opening (or her retry line), the confession, the question', () => {
    const l = LINES.mahiro.confession;
    const first = ok(beginRun(confessionSceneById('confession-mahiro')!, { ...ctx(), rewardable: true }));
    const said = first.state.beats.flatMap((b) => (b.type === 'line' ? [b.text.ja] : []));
    expect(said).toEqual([...l.opening, ...l.confess, l.ask].map((t) => t.ja));
    expect(first.state.at).toBe('answer');
    const again = ok(beginRun(confessionSceneById('confession-mahiro-again')!, { ...ctx(), rewardable: true }));
    expect(again.state.beats.find((b) => b.type === 'line')).toMatchObject({ text: l.retry });
    // The hug behind his yes is buffered while he answers.
    expect(upcomingMedia(confessionSceneById('confession-mahiro')!, first.state)).toEqual(['mahiro-confession-yes']);
  });

  it('while her lines are drafts the scenes are demo-only; reviewed, they are offered everywhere', () => {
    for (const s of CONFESSION_SCENES) {
      const draft = LINES[s.meta.star].draft;
      expect(sceneOffered(s.meta, true)).toBe(true);
      expect(sceneOffered(s.meta, false)).toBe(!draft);
    }
    expect(confessionOffered(true, false)).toBe(false);
    expect(confessionOffered(true, true)).toBe(true);
    expect(confessionOffered(false, false)).toBe(true);
  });

  it('branches on the verdict: yes grants the memory card, not yet and no end gently, silence counts for nothing', () => {
    const script = confessionSceneById('confession-nana')!;
    const begun = ok(beginRun(script, { ...ctx(), rewardable: true }));
    expect(submitStep(script, begun.state, { input: 'はい' }, ctx())).toBe('verdict_missing');
    const cases: [ConfessionAnswer, string, number][] = [['accept', 'accepted', 1], ['not_yet', 'not_yet', 0], ['decline', 'declined', 0]];
    for (const [verdict, outcome, cards] of cases) {
      const moved = ok(submitStep(script, begun.state, { input: 'answer' }, ctx({ verdict })));
      expect(moved.state.outcome).toBe(outcome);
      expect(answerOfOutcome(moved.state.outcome)).toBe(verdict);
      expect(moved.grant.memories).toHaveLength(cards);
      expect(moved.state.inputs.answer).toBe('answer');
    }
    const yes = ok(submitStep(script, begun.state, { input: 'yes' }, ctx({ verdict: 'accept' })));
    expect(yes.grant).toMatchObject({ affinity: CONFESSION_RULES.acceptAffinity, memories: [{ title: '告白' }] });
    expect(yes.state.beats.filter((b) => b.type === 'line').map((b) => b.type === 'line' && b.text.ja)).toEqual(LINES.nana.confession.accept.map((t) => t.ja));
    // His yes plays her hug once, then her answer.
    expect(yes.state.beats.filter((b) => b.type === 'clip').map((b) => b.type === 'clip' && b.media)).toEqual(['nana-confession-yes']);
    const quiet = ok(submitStep(script, begun.state, { timeout: true }, { ...ctx(), now: 1_000_000 + 301_000 }));
    expect(quiet.state.outcome).toBe('quiet');
    expect(answerOfOutcome('quiet')).toBeNull();
  });

  it('opens in the evening and at night only', () => {
    const meta = confessionSceneById('confession-eimi')!.meta;
    const base = { weather: null, stage: 'confession_ready' as const, owns: () => false, routine: null };
    expect(triggerProblems(meta, { ...base, slot: 'day' })).toEqual(['slot']);
    expect(triggerProblems(meta, { ...base, slot: 'evening' })).toEqual([]);
    expect(triggerProblems(meta, { ...base, slot: 'night', stage: 'ambiguous' })).toEqual(['stage']);
    expect([at(16), at(17), at(23), at(4), at(5)].map(confessionHour)).toEqual([false, true, true, true, false]);
  });
});

describe('confession status', () => {
  const ready = { stage: 'confession_ready' as const, daysTogether: 7 };
  it('only at confession_ready; due at first, the room opens on it tonight', () => {
    expect(confessionStatus('mahiro', { stage: 'ambiguous', daysTogether: 7 }, null, at(20))).toBeNull();
    expect(confessionStatus('mahiro', { stage: 'lover', daysTogether: 9 }, null, at(20))).toBeNull();
    expect(confessionStatus('mahiro', ready, null, at(12))).toEqual({ phase: 'due', sceneId: 'confession-mahiro', tonight: false, reachedToday: false });
    expect(confessionStatus('mahiro', ready, null, at(20))).toMatchObject({ phase: 'due', tonight: true });
  });

  it('not yet: never again the same day; again two days together later, with her retry scene', () => {
    const s = afterAnswer(freshConfession(), 'not_yet', 7, at(20));
    expect(s).toMatchObject({ tries: 1, lastAnswer: 'not_yet', answeredDays: 7, answeredOn: '2026-10-09' });
    expect(confessionStatus('mahiro', ready, s, at(22))?.phase).toBe('waiting');
    const nextDay = at(20) + 86_400_000;
    expect(confessionStatus('mahiro', { ...ready, daysTogether: 8 }, s, nextDay)?.phase).toBe('waiting');
    // Calendar days do not count, days together do.
    expect(confessionStatus('mahiro', { ...ready, daysTogether: 8 }, s, nextDay + 5 * 86_400_000)?.phase).toBe('waiting');
    expect(confessionStatus('mahiro', { ...ready, daysTogether: 9 }, s, nextDay + 86_400_000)).toMatchObject({ phase: 'due', sceneId: 'confession-mahiro-again' });
  });

  it('after the third answer that is not yes she stops asking; he can bring it up himself from the next day', () => {
    let s = freshConfession();
    for (let i = 0; i < CONFESSION_RULES.maxAsks; i++) s = afterAnswer(s, i % 2 ? 'decline' : 'not_yet', 7 + i * 2, at(20) + i * 2 * 86_400_000);
    const last = at(20) + (CONFESSION_RULES.maxAsks - 1) * 2 * 86_400_000;
    expect(confessionStatus('mahiro', { ...ready, daysTogether: 20 }, s, last)?.phase).toBe('waiting');
    expect(confessionStatus('mahiro', { ...ready, daysTogether: 20 }, s, last + 86_400_000)?.phase).toBe('open');
  });

  it('remembers that tonight’s moment was already reached (no second automatic opening)', () => {
    const s = { ...freshConfession(), reachedRound: 0, reachedOn: '2026-10-09' };
    expect(confessionStatus('mahiro', ready, s, at(21))?.reachedToday).toBe(true);
    expect(confessionStatus('mahiro', ready, s, at(21) + 86_400_000)?.reachedToday).toBe(false);
  });

  it('scene ids round-trip and nothing else parses as one', () => {
    for (const star of STAR_IDS) for (const again of [false, true]) expect(confessionOf(confessionSceneId(star, again))).toEqual({ star, again });
    expect(confessionOf('confession-someone')).toBeNull();
    expect(confessionOf('demo-evening')).toBeNull();
  });
});

describe('reading his answer', () => {
  it.each([
    ['はい、よろしくお願いします', 'accept'], ['うん、なりたい', 'accept'], ['もちろん！大好きだよ', 'accept'], ['Yes, of course', 'accept'], ['I love you too', 'accept'],
    ['我願意', 'accept'], ['當然好啊', 'accept'],
    ['まだ考えさせて', 'not_yet'], ['うーん、もう少し時間がほしい', 'not_yet'], ['Not yet, I need some time', 'not_yet'], ['讓我再想想', 'not_yet'],
    ['ごめん、友達のままでいたい', 'decline'], ['好きだけど、ごめんね', 'decline'], ["Sorry, I can't", 'decline'], ['對不起，我們還是做朋友吧', 'decline'],
    ['今日は雨だったね', 'not_yet'], ['', 'not_yet'], ['Yes, no doubt', 'accept']
  ] as const)('%s → %s', (text, answer) => {
    expect(guessAnswer(text)).toBe(answer);
  });

  it('only a well-formed, confident accept is an accept; anything else from the model reads as not yet', () => {
    expect(readVerdict({ answer: 'accept', confident: true })).toEqual({ answer: 'accept', confident: true });
    expect(readVerdict({ answer: 'accept', confident: false })).toEqual({ answer: 'not_yet', confident: false });
    expect(readVerdict({ answer: 'accept' })).toEqual({ answer: 'not_yet', confident: false });
    expect(readVerdict({ answer: 'decline', confident: false }).answer).toBe('decline');
    for (const junk of [null, undefined, 'accept', 42, {}, { answer: 'yes', confident: true }, { answer: ['accept'] }]) {
      expect(readVerdict(junk).answer, JSON.stringify(junk)).toBe('not_yet');
    }
  });
});

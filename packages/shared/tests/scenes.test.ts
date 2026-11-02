import { describe, expect, it } from 'vitest';
import { SCENES, beginRun, decideRps, endRun, expiredOutcome, jstSlot, sceneById, submitStep, triggerProblems, upcomingMedia, type Advance, type RunState, type SceneError } from '../src/scenes';
import { parseScene, sceneProblems, zSceneScript, type SceneScript } from '../src/scenes/schema';
import { SceneStepReq } from '../src/contracts';
import { SCENE_RULES } from '../src/rules';

const T = (s: string) => ({ ja: s, 'zh-Hant': s, en: s });
let n = 0;
const ctx = (now = 1_000_000, extra: Record<string, unknown> = {}) => ({ now, lang: 'ja', newId: (p: string) => `${p}_${n++}`, ...extra });
const ok = (r: Advance | SceneError): Advance => { if (typeof r === 'string') throw new Error(r); return r; };

/** A small script with every step type: choice branches, a text input, rock-paper-scissors and free talk. */
const TOY: SceneScript = parseScene({
  meta: { id: 'toy', star: 'nana', title: T('toy'), trigger: { slots: ['night'], stage: 'familiar' } },
  steps: [
    { id: 'wide', type: 'clip', shot: 'wide', media: 'nana-hero' },
    { id: 'hi', type: 'line', text: T('hi') },
    { id: 'ask', type: 'choice', timeout: 20, onTimeout: 'quiet', options: [
      { id: 'a', label: T('A'), next: 'la', effect: { affinity: 5 } },
      { id: 'b', label: T('B'), next: 'lb' }
    ] },
    { id: 'la', type: 'line', text: T('a'), next: 'close' },
    { id: 'lb', type: 'line', text: T('b'), next: 'name' },
    { id: 'quiet', type: 'line', text: T('...'), next: 'close' },
    { id: 'name', type: 'input', mode: 'text', timeout: 30, next: 'game' },
    { id: 'game', type: 'minigame', kind: 'rps', config: {}, next: 'close', outcomes: { win: 'won' } },
    { id: 'won', type: 'effect', affinity: 1, timer: { seconds: 90 }, next: 'close' },
    { id: 'close', type: 'clip', shot: 'close', media: 'nana-breath' },
    { id: 'talk', type: 'input', mode: 'free', timeout: 60, next: 'reward' },
    { id: 'reward', type: 'effect', affinity: 10, memory: { title: { ja: '夜', 'zh-Hant': '夜晚', en: 'Night' } }, promise: { text: T('tomorrow'), due: '+1d' } },
    { id: 'end', type: 'end' }
  ]
});

const start = (rewardable = true) => ok(beginRun(TOY, { ...ctx(), rewardable }));

describe('scene scripts', () => {
  it('every bundled script passes the schema and the structural checks, with three languages', () => {
    expect(SCENES.length).toBeGreaterThan(0);
    for (const s of SCENES) {
      expect(() => parseScene(s), s.meta.id).not.toThrow();
      expect(sceneById(s.meta.id)).toBe(s);
    }
    expect(new Set(SCENES.map((s) => s.meta.id)).size).toBe(SCENES.length);
  });

  it('the demo scene is wide → empty → close, has a choice and free talk, and pays a memory card', () => {
    const demo = sceneById('demo-evening')!;
    const shots = demo.steps.flatMap((s) => (s.type === 'clip' ? [s.shot] : []));
    expect(shots).toEqual(['wide', 'empty', 'close']);
    expect(demo.steps.some((s) => s.type === 'choice')).toBe(true);
    expect(demo.steps.some((s) => s.type === 'input' && s.mode === 'free')).toBe(true);
    expect(demo.steps.some((s) => s.type === 'effect' && s.memory)).toBe(true);
    expect(demo.meta.demo).toBe(true);
  });

  it('rejects broken scripts: unknown targets, loops without a wait, missing languages, a timeout without a target', () => {
    const bad = (steps: unknown[]) => zSceneScript.safeParse({ meta: { id: 'x1', star: 'eimi', title: T('x'), trigger: { slots: ['day'] } }, steps });
    expect(bad([{ id: 'a', type: 'line', text: { ja: 'a', en: 'a' } }, { id: 'e', type: 'end' }]).success).toBe(false);
    expect(bad([{ id: 'a', type: 'choice', timeout: 10, options: [{ id: 'x', label: T('x'), next: 'e' }, { id: 'y', label: T('y'), next: 'e' }] }, { id: 'e', type: 'end' }]).success).toBe(false);
    expect(bad([{ id: 'a', type: 'line', text: T('a'), voice: '/voice/x.mp3', tts: true }, { id: 'e', type: 'end' }]).success).toBe(false);
    const loop = zSceneScript.parse({ meta: { id: 'x2', star: 'eimi', title: T('x'), trigger: { slots: ['day'] } }, steps: [
      { id: 'a', type: 'line', text: T('a'), next: 'b' }, { id: 'b', type: 'line', text: T('b'), next: 'a' }, { id: 'c', type: 'choice', options: [{ id: 'x', label: T('x'), next: 'nowhere' }, { id: 'y', label: T('y'), next: 'a' }] }
    ] });
    const problems = sceneProblems(loop);
    expect(problems).toContain('a: automatic loop');
    expect(problems).toContain('c: unknown target nowhere');
    expect(problems).toContain('no reachable end');
  });

  it('the step request carries exactly one answer', () => {
    expect(SceneStepReq.safeParse({ runId: 'r', seq: 0, choice: 'a' }).success).toBe(true);
    expect(SceneStepReq.safeParse({ runId: 'r', seq: 0 }).success).toBe(false);
    expect(SceneStepReq.safeParse({ runId: 'r', seq: 0, choice: 'a', timeout: true }).success).toBe(false);
  });
});

describe('scene engine', () => {
  it('plays the automatic steps up to the first choice', () => {
    const { state } = start();
    expect(state.beats.map((b) => b.id)).toEqual(['wide', 'hi', 'ask']);
    expect(state.at).toBe('ask');
    expect(upcomingMedia(TOY, state)).toEqual(['nana-breath']);
  });

  it('branches on the choice, with the option reward as its own beat', () => {
    const a = ok(submitStep(TOY, start().state, { choice: 'a' }, ctx()));
    expect(a.state.beats.map((b) => b.id)).toEqual(['ask~a', 'la', 'close', 'talk']);
    expect(a.grant.affinity).toBe(5);
    const b = ok(submitStep(TOY, start().state, { choice: 'b' }, ctx()));
    expect(b.state.beats.map((x) => x.id)).toEqual(['lb', 'name']);
    expect(b.grant.affinity).toBe(0);
    expect(submitStep(TOY, start().state, { choice: 'zzz' }, ctx())).toBe('unknown_option');
    expect(submitStep(TOY, start().state, { input: 'hi' }, ctx())).toBe('invalid_submission');
  });

  it('takes a timeout only once the countdown has run out', () => {
    const s = start().state;
    expect(submitStep(TOY, s, { timeout: true }, ctx(s.waitingSince + 5_000))).toBe('too_early');
    const late = ok(submitStep(TOY, s, { timeout: true }, ctx(s.waitingSince + 20_000 - SCENE_RULES.timeoutGraceMs)));
    expect(late.state.beats.map((b) => b.id)).toEqual(['quiet', 'close', 'talk']);
  });

  it('keeps text answers, decides rock-paper-scissors itself, and routes by the result', () => {
    let s = ok(submitStep(TOY, start().state, { choice: 'b' }, ctx())).state;
    s = ok(submitStep(TOY, s, { input: '  ケンタ  ' }, ctx())).state;
    expect(s.inputs.name).toBe('ケンタ');
    expect(s.at).toBe('game');
    // rng 0.34 → her hand is scissors: rock wins.
    const won = ok(submitStep(TOY, s, { minigame: { hand: 'rock' } }, ctx(2_000_000, { rng: () => 0.34 })));
    expect(won.state.last).toEqual({ kind: 'rps', mine: 'rock', hers: 'scissors', result: 'win' });
    expect(won.state.beats.map((b) => b.id)).toEqual(['won', 'close', 'talk']);
    expect(won.state.timerEndsAt).toBe(2_000_000 + 90_000);
    const lost = ok(submitStep(TOY, s, { minigame: { hand: 'paper' } }, ctx(2_000_000, { rng: () => 0.34 })));
    expect(lost.state.last?.result).toBe('lose');
    expect(lost.state.beats[0].id).toBe('close');
    expect(decideRps('rock', () => 0).result).toBe('draw');
  });

  it('free talk needs her reply from the chat path and plays it as her line', () => {
    const s = ok(submitStep(TOY, start().state, { choice: 'a' }, ctx())).state;
    expect(submitStep(TOY, s, { input: 'hello' }, ctx())).toBe('free_reply_missing');
    const done = ok(submitStep(TOY, s, { input: 'hello' }, ctx(3_000_000, { free: { reply: 'おかえり', directive: { jumpTo: 'end' } } })));
    const reply = done.state.beats[0];
    expect(reply).toMatchObject({ id: 'talk~reply', type: 'line', agent: true, text: { ja: 'おかえり' } });
    // #65 is not built: a directive never steers the scene yet.
    expect(done.state.beats.map((b) => b.id)).toEqual(['talk~reply', 'reward', 'end']);
    expect(done.state.ended).toBe(true);
    expect(done.state.outcome).toBe('complete');
    expect(done.grant.affinity).toBe(10);
    expect(done.grant.memories).toMatchObject([{ title: '夜' }]);
    expect(done.grant.promises[0]).toEqual({ text: 'tomorrow', dueAt: new Date(3_000_000 + 86_400_000).toISOString() });
    expect(done.state.rewards.affinity).toBe(15);
    expect(done.state.freeTurns).toBe(1);
    expect(submitStep(TOY, done.state, { choice: 'a' }, ctx())).toBe('run_ended');
  });

  it('grants nothing on a run that is not rewardable, but still plays', () => {
    let s: RunState = start(false).state;
    const a = ok(submitStep(TOY, s, { choice: 'a' }, ctx()));
    expect(a.grant).toEqual({ affinity: 0, variantXp: 0, memories: [], promises: [] });
    s = ok(submitStep(TOY, a.state, { input: 'x' }, ctx(1, { free: { reply: 'r' } }))).state;
    expect(s.ended).toBe(true);
    expect(s.rewards.memories).toEqual([]);
  });

  it('ends by leaving without taking anything back, and expires after 30 minutes', () => {
    const a = ok(submitStep(TOY, start().state, { choice: 'a' }, ctx()));
    const left = endRun(a.state, 'left', 5);
    expect(left).toMatchObject({ ended: true, outcome: 'left' });
    expect(left.rewards.affinity).toBe(5);
    expect(endRun(left, 'idle', 6).outcome).toBe('left');
    expect(expiredOutcome(0, SCENE_RULES.maxRunMs - 1)).toBeNull();
    expect(expiredOutcome(0, SCENE_RULES.maxRunMs)).toBe('timeout');
  });

  it('checks trigger conditions, keeping conditions without data locked', () => {
    const base = { slot: 'night' as const, weather: null, stage: 'familiar' as const, owns: () => false, routine: null };
    expect(triggerProblems(TOY.meta, base)).toEqual([]);
    expect(triggerProblems(TOY.meta, { ...base, slot: 'day', stage: 'new' })).toEqual(['slot', 'stage']);
    // A later stage keeps the scene open; confession_ready still counts as the ambiguous stage it follows.
    expect(triggerProblems(TOY.meta, { ...base, stage: 'lover' })).toEqual([]);
    expect(triggerProblems({ ...TOY.meta, trigger: { slots: ['night' as const], stage: 'ambiguous' as const } }, { ...base, stage: 'confession_ready' })).toEqual([]);
    const rainy = { ...TOY.meta, trigger: { slots: ['night' as const], weather: ['rain' as const], variantCard: 's1-nana-30' } };
    expect(triggerProblems(rainy, base)).toEqual(['weather', 'variant_card']);
    expect(triggerProblems(rainy, { ...base, weather: 'rain', owns: (id) => id === 's1-nana-30' })).toEqual([]);
    // 21:00 JST is 12:00 UTC.
    expect(jstSlot(Date.UTC(2026, 8, 26, 12, 0))).toBe('night');
    expect(jstSlot(Date.UTC(2026, 8, 26, 22, 0))).toBe('morning');
  });
});

describe('a scene memory card in the language of the moment (N-20)', () => {
  it('finds the title by its scene, or among her scenes, and leaves a chat card as it is', async () => {
    const { sceneMemoryTitle } = await import('../src/scenes');
    expect(sceneMemoryTitle('おかえりの夜', 'en', 'demo-evening')).toBe('A Night Back Home');
    expect(sceneMemoryTitle('A Night Back Home', 'ko', 'demo-evening')).toBe('돌아온 밤');
    expect(sceneMemoryTitle('おかえりの夜', 'zh-Hant', null, 'mahiro')).toBe('歡迎回家的夜晚');
    expect(sceneMemoryTitle('寒い夜のおかえり', 'en', null, 'mahiro')).toBe('寒い夜のおかえり');
  });
});

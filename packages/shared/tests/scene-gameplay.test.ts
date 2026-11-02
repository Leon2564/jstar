import { describe, expect, it } from 'vitest';
import { beginRun, submitStep, upcomingMedia, type Advance, type GiftGame, type SceneError, type SceneStep } from '../src/scenes';
import { parseScene, sceneProblems, zSceneScript, type SceneScript } from '../src/scenes/schema';
import { MAIN_SCENES as DRAFT_SCENES, sceneById as draftById, pendingMedia, previewScript } from '../src/scenes';
import { SYSTEM_SCENES, openSystemScenes, promisePayoff, systemSceneById, systemSceneOf } from '../src/scenes/system';
import { SceneStepReq } from '../src/contracts';

const T = (s: string) => ({ ja: s, 'zh-Hant': s, en: s });
let n = 0;
const ctx = (now = 1_000_000, extra: Record<string, unknown> = {}) => ({ now, lang: 'ja', newId: (p: string) => `${p}_${n++}`, ...extra });
const ok = (r: Advance | SceneError): Advance => { if (typeof r === 'string') throw new Error(r); return r; };

/** A small script: a live stream that goes off air, a gift he picks, her reward outfit, a memory card and promises. */
const STREAM: SceneScript = parseScene({
  meta: { id: 'toy-stream', star: 'unpai', title: T('toy'), trigger: { slots: ['night'] } },
  steps: [
    { id: 'wide', type: 'clip', shot: 'wide', media: 'unpai-hero' },
    { id: 'on', type: 'effect', live: true },
    { id: 'hi', type: 'line', text: T('hi') },
    { id: 'gift', type: 'choice', timeout: 30, onTimeout: 'quiet', options: [
      { id: 'give', label: T('give'), next: 'thanks', gift: 'pick' },
      { id: 'flowers', label: T('flowers'), next: 'thanks', gift: 'bouquet' },
      { id: 'clap', label: T('clap'), next: 'thanks', effect: { affinity: 2 } }
    ] },
    { id: 'quiet', type: 'line', text: T('...'), next: 'thanks' },
    { id: 'thanks', type: 'line', text: T('thanks') },
    { id: 'off', type: 'effect', live: false },
    { id: 'close', type: 'clip', shot: 'close', media: 'unpai-breath', variants: [{ when: 'variant', media: 'unpai-variant-close' }] },
    { id: 'ask', type: 'choice', options: [{ id: 'a', label: T('a'), next: 'reward' }, { id: 'b', label: T('b'), next: 'reward' }] },
    { id: 'reward', type: 'effect', affinity: 10, memory: { title: T('memory') },
      promise: { text: T('tomorrow morning'), due: '+12h', kind: 'wakeup' } },
    { id: 'end', type: 'end' }
  ]
});

const bouquet: GiftGame = { kind: 'gift', giftId: 'bouquet', taste: 'plain', xp: 6, result: 'win' };
const gift = (g: GiftGame = bouquet) => ({ gift: { result: g, reply: [T(`thanks for the ${g.giftId}`)] } });

describe('memory stills (#51)', () => {
  it('a memory card takes the clip on screen when it is made — as played, the variant footage when he owns it', () => {
    const begun = ok(beginRun(STREAM, { ...ctx(), rewardable: true }));
    expect(begun.state.shot).toBe('unpai-hero');
    const past = ok(submitStep(STREAM, begun.state, { choice: 'clap' }, ctx()));
    expect(past.state.shot).toBe('unpai-breath');
    const end = ok(submitStep(STREAM, past.state, { choice: 'a' }, ctx()));
    expect(end.grant.memories).toEqual([expect.objectContaining({ title: 'memory', still: 'unpai-breath' })]);

    const owned = ok(beginRun(STREAM, { ...ctx(), rewardable: true, vars: ['variant'] }));
    const later = ok(submitStep(STREAM, ok(submitStep(STREAM, owned.state, { choice: 'clap' }, ctx())).state, { choice: 'b' }, ctx()));
    expect(later.grant.memories[0].still).toBe('unpai-variant-close');
  });

  it('a card made before any clip has no still', () => {
    const bare = parseScene({
      meta: { id: 'toy-bare', star: 'nana', title: T('x'), trigger: { slots: ['night'] } },
      steps: [{ id: 'm', type: 'effect', memory: { title: T('m') } }, { id: 'c', type: 'choice', options: [{ id: 'a', label: T('a'), next: 'e' }, { id: 'b', label: T('b'), next: 'e' }] }, { id: 'e', type: 'end' }]
    });
    expect(ok(beginRun(bare, { ...ctx(), rewardable: true })).grant.memories[0].still).toBeUndefined();
  });
});

describe('her variant footage (#70)', () => {
  it('plays the variant clip when he owns her card, keeping the shot as written as its fallback; the ordinary one otherwise', () => {
    const clipOf = (a: Advance) => a.state.beats.find((b): b is Extract<SceneStep, { type: 'clip' }> => b.type === 'clip' && b.id === 'close');
    const plain = ok(submitStep(STREAM, ok(beginRun(STREAM, { ...ctx(), rewardable: true })).state, { choice: 'clap' }, ctx()));
    expect(clipOf(plain)).toEqual({ id: 'close', type: 'clip', shot: 'close', media: 'unpai-breath' });
    const owned = ok(submitStep(STREAM, ok(beginRun(STREAM, { ...ctx(), rewardable: true, vars: ['variant'] })).state, { choice: 'clap' }, ctx()));
    expect(clipOf(owned)).toEqual({ id: 'close', type: 'clip', shot: 'close', media: 'unpai-variant-close', fallback: 'unpai-breath' });
  });

  it('fetches ahead the clip this run will cut to', () => {
    const owned = ok(beginRun(STREAM, { ...ctx(), rewardable: true, vars: ['variant'] }));
    expect(upcomingMedia(STREAM, owned.state)).toEqual(['unpai-variant-close']);
    expect(upcomingMedia(STREAM, ok(beginRun(STREAM, { ...ctx(), rewardable: true })).state)).toEqual(['unpai-breath']);
  });

  it('えいみ\'s reward outfit is her variant card\'s footage when he owns it, and she says so', () => {
    const ogiri = draftById('ogiri')!;
    const byId = (id: string) => ogiri.steps.find((s) => s.id === id)!;
    expect(byId('return')).toMatchObject({ media: 'eimi-scene-ogiri-return', variants: [{ when: 'variant', media: 'eimi-variant-enter' }] });
    expect(byId('twirl')).toMatchObject({ media: 'eimi-scene-ogiri-twirl', variants: [{ when: 'variant', media: 'eimi-variant-close' }] });
    expect(byId('how')).toMatchObject({ variants: [{ when: 'variant' }] });
  });

  it('a preview keeps variant footage that exists (#81 made it), and drops footage still to come: the shot as written plays', () => {
    const ogiri = draftById('ogiri')!;
    // Every clip is made (#80's twirl, #81's variant footage): the preview is the script as written.
    expect(previewScript(ogiri)).toBe(ogiri);
    expect(ogiri.steps.find((s) => s.id === 'twirl')).toMatchObject({ media: 'eimi-scene-ogiri-twirl', variants: [{ when: 'variant', media: 'eimi-variant-close' }] });
    expect(pendingMedia([ogiri])).not.toContain('eimi-variant-close');
    expect(pendingMedia([ogiri])).not.toContain('eimi-variant-enter');
    // Footage not made yet is dropped rather than stood in for, so owning the card never shows a stand-in.
    const later = previewScript({ ...STREAM, steps: STREAM.steps.map((s) => (s.id === 'close' && s.type === 'clip' ? { ...s, variants: [{ when: 'variant' as const, media: 'unpai-scene-toy-stream-close' }] } : s)) });
    const close = later.steps.find((s) => s.id === 'close')!;
    expect(close).toMatchObject({ media: 'unpai-breath' });
    expect(close).not.toHaveProperty('variants');
    // Footage that exists is kept.
    const live = previewScript({ ...STREAM, steps: STREAM.steps.map((s) => (s.id === 'close' && s.type === 'clip' ? { ...s, variants: [{ when: 'variant' as const, media: 'unpai-night' }] } : s)) });
    expect(live.steps.find((s) => s.id === 'close')).toMatchObject({ variants: [{ media: 'unpai-night' }] });
  });
});

describe('うんぱい\'s private stream (#68)', () => {
  it('the live overlay goes up at the start and comes down when she ends the stream', () => {
    const begun = ok(beginRun(STREAM, { ...ctx(), rewardable: true }));
    expect(begun.state.live).toBe(true);
    const off = ok(submitStep(STREAM, begun.state, { choice: 'clap' }, ctx()));
    expect(off.state.live).toBe(false);
    // The effect beats carry it, so the player takes it down at that very moment.
    expect(off.state.beats.find((b) => b.id === 'off')).toMatchObject({ type: 'effect', live: false });
  });

  it('a gift he picks is paid outside the engine, and she thanks him before the scene goes on', () => {
    const begun = ok(beginRun(STREAM, { ...ctx(), rewardable: true })).state;
    const given = ok(submitStep(STREAM, begun, { choice: 'give', gift: 'bouquet' }, ctx(1, gift())));
    expect(given.state.last).toEqual(bouquet);
    expect(given.state.beats.map((b) => b.id).slice(0, 2)).toEqual(['gift~gift', 'thanks']);
    expect(given.state.beats[0]).toMatchObject({ type: 'line', text: T('thanks for the bouquet') });
    // The gift's XP is paid with the gift, never again as the run's affinity.
    expect(given.grant.affinity).toBe(0);
    // A fixed gift option names its own gift.
    expect(ok(submitStep(STREAM, begun, { choice: 'flowers' }, ctx(1, gift()))).state.last).toEqual(bouquet);
  });

  it('refuses a gift that was not paid for, not the one picked, or one sent with an ordinary option', () => {
    const begun = ok(beginRun(STREAM, { ...ctx(), rewardable: true })).state;
    expect(submitStep(STREAM, begun, { choice: 'give' }, ctx(1, gift()))).toBe('invalid_submission');
    expect(submitStep(STREAM, begun, { choice: 'give', gift: 'bouquet' }, ctx())).toBe('gift_missing');
    expect(submitStep(STREAM, begun, { choice: 'give', gift: 'teddy' }, ctx(1, gift()))).toBe('gift_missing');
    expect(submitStep(STREAM, begun, { choice: 'flowers', gift: 'teddy' }, ctx(1, gift()))).toBe('invalid_submission');
    expect(submitStep(STREAM, begun, { choice: 'clap', gift: 'bouquet' }, ctx())).toBe('invalid_submission');
  });

  it('a gift option has no affinity of its own, and a choice always has a free answer', () => {
    const script = (options: unknown[]) => zSceneScript.parse({
      meta: { id: 'x-gift', star: 'unpai', title: T('x'), trigger: { slots: ['night'] } },
      steps: [{ id: 'c', type: 'choice', options }, { id: 'e', type: 'end' }]
    });
    expect(sceneProblems(script([{ id: 'a', label: T('a'), next: 'e', gift: 'pick', effect: { affinity: 6 } }, { id: 'b', label: T('b'), next: 'e' }])))
      .toContain('c: a is a gift with affinity of its own');
    expect(sceneProblems(script([{ id: 'a', label: T('a'), next: 'e', gift: 'pick' }, { id: 'b', label: T('b'), next: 'e', gift: 'bouquet' }])))
      .toContain('c: every option costs points');
    expect(zSceneScript.safeParse({ meta: { id: 'x-gift', star: 'unpai', title: T('x'), trigger: { slots: ['night'] } },
      steps: [{ id: 'c', type: 'choice', options: [{ id: 'a', label: T('a'), next: 'e', gift: 'diamonds' }, { id: 'b', label: T('b'), next: 'e' }] }, { id: 'e', type: 'end' }] }).success).toBe(false);
  });

  it('the stream script: live from the first shot, three comments, a gift from the sheet, then off air before the alley', () => {
    const s = draftById('private-stream')!;
    const ids = s.steps.map((x) => x.id);
    expect(s.steps[ids.indexOf('on-air')]).toMatchObject({ type: 'effect', live: true });
    expect(ids.indexOf('on-air')).toBeLessThan(ids.indexOf('c1'));
    const giftStep = s.steps.find((x) => x.id === 'gift');
    expect(giftStep?.type === 'choice' && giftStep.options.find((o) => o.gift)).toMatchObject({ gift: 'pick' });
    expect(ids.indexOf('off')).toBeLessThan(ids.indexOf('off-air'));
    expect(ids.indexOf('off-air')).toBeLessThan(ids.indexOf('alley'));
  });

  it('the step request carries a gift only with a choice', () => {
    expect(SceneStepReq.safeParse({ runId: 'r', seq: 0, choice: 'gift', gift: 'bouquet' }).success).toBe(true);
    expect(SceneStepReq.safeParse({ runId: 'r', seq: 0, input: 'x', gift: 'bouquet' }).success).toBe(false);
    expect(SceneStepReq.safeParse({ runId: 'r', seq: 0, choice: 'gift', gift: 'diamonds' }).success).toBe(false);
  });
});

describe('promises that pay off in the morning (#57, #66, #67)', () => {
  it('a promise keeps its kind and the scene that keeps it', () => {
    const begun = ok(beginRun(STREAM, { ...ctx(), rewardable: true }));
    const end = ok(submitStep(STREAM, ok(submitStep(STREAM, begun.state, { choice: 'clap' }, ctx())).state, { choice: 'a' }, ctx()));
    expect(end.grant.promises).toEqual([expect.objectContaining({ text: 'tomorrow morning', kind: 'wakeup' })]);
  });

  it('まひろ\'s 「明日の朝、起こしてあげる」 is a wake-up promise; 奈々\'s tea is kept by her morning, not the evening again', () => {
    const promises = (id: string) => draftById(id)!.steps.flatMap((s) => (s.type === 'effect' && s.promise ? [s.promise] : []));
    expect(promises('welcome-home').length).toBeGreaterThan(0);
    for (const p of promises('welcome-home')) expect(p.kind).toBe('wakeup');
    for (const id of ['read-aloud', 'read-aloud-rain']) {
      expect(promises(id).length).toBeGreaterThan(0);
      for (const p of promises(id)) expect(p.scene).toBe('promise-morning-nana');
    }
    // Every scene a promise names exists.
    for (const s of DRAFT_SCENES) {
      for (const st of s.steps) if (st.type === 'effect' && st.promise?.scene) expect(systemSceneById(st.promise.scene) ?? draftById(st.promise.scene), st.promise.scene).toBeTruthy();
    }
  });

  it('her morning opens for a promise that names it, in its window, and only then', () => {
    const now = Date.UTC(2026, 8, 28, 0, 0); // 09:00 JST
    const p = { kind: 'scene' as const, sceneId: 'promise-morning-nana', status: 'open', dueAt: new Date(now + 3_600_000).toISOString(), keptAt: null };
    expect(promisePayoff(p, now)).toBe('promiseMorning');
    expect(promisePayoff({ ...p, sceneId: null }, now)).toBe('promiseKept');
    expect(promisePayoff({ ...p, sceneId: 'read-aloud' }, now)).toBeNull();
    expect(promisePayoff({ ...p, kind: 'wakeup' }, now)).toBeNull();
    expect(promisePayoff({ ...p, dueAt: new Date(now + 5 * 3_600_000).toISOString() }, now)).toBeNull();
    expect(promisePayoff({ ...p, status: 'kept', keptAt: new Date(now - 60_000).toISOString() }, now)).toBe('promiseMorning');
    expect(openSystemScenes({ star: 'nana', now, calendar: [], weather: [], promiseKept: false, promiseMorning: true })).toEqual(['promise-morning-nana']);
  });

  it('her morning: the room in the morning light, then her in her morning look keeping it; by morning or day', () => {
    for (const s of SYSTEM_SCENES.filter((x) => systemSceneOf(x.meta.id)?.kind === 'promiseMorning')) {
      const clips = s.steps.flatMap((x) => (x.type === 'clip' ? [`${x.shot}:${x.media}`] : []));
      expect(clips, s.meta.id).toEqual([`empty:${s.meta.star}-morning`, `wide:${s.meta.star}-sys-promise-morning-wide`, `close:${s.meta.star}-sys-promise-morning-close`]);
      expect(s.meta.idle).toBe(`${s.meta.star}-sys-promise-morning-wide`);
      expect(s.meta.trigger.slots).toEqual(['morning', 'day']);
    }
    expect(systemSceneById('promise-morning-nana')!.steps.filter((x) => x.type === 'line').length).toBe(3);
  });
});

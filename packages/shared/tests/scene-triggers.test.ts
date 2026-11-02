import { describe, expect, it } from 'vitest';
import { TRIGGER_RULES } from '../src/rules';
import {
  SCENES, beginRun, chooseOffer, emptyOfferHistory, isTimeEvent, nextAfterFree, offerableScenes, offersPaused, offersPausedUntil, proposalKind, sceneById,
  MAIN_SCENES, sceneMedia, sceneOffered, submitStep, type Advance, type OfferHistory, type SceneError
} from '../src/scenes';
import { parseScene, sceneProblems, zSceneScript, type InputStep, type SceneMeta, type SceneScript } from '../src/scenes/schema';
import { VARIANT_SCENES } from '../src/scenes/variantScenes';

const demo = sceneById('demo-evening')!;
const ok = (r: Advance | SceneError): Advance => { if (typeof r === 'string') throw new Error(r); return r; };
let n = 0;
const ctx = (now: number, directive?: unknown) => ({ now, lang: 'ja', newId: (p: string) => `${p}_${n++}`, free: { reply: 'ふふ', directive: directive as { jumpTo: string } | null } });

/** Walks the demo scene to its free-talk step. */
function atTalk(now: number) {
  const first = ok(beginRun(demo, { ...ctx(now), rewardable: true }));
  return ok(submitStep(demo, first.state, { choice: 'missed' }, ctx(now))).state;
}

describe('what may be offered (#65)', () => {
  it('the publish rule: production only reviewed scenes with every clip; demo mode everything', () => {
    // Today production plays the five (#80's clips made) and her variant scenes (#81's); the demo scene never leaves
    // demo mode.
    expect(offerableScenes(SCENES, true).map((s) => s.meta.id)).toEqual(SCENES.map((s) => s.meta.id));
    expect(offerableScenes(SCENES, false).map((s) => s.meta.id)).toEqual([...MAIN_SCENES, ...VARIANT_SCENES].map((s) => s.meta.id));
    for (const s of MAIN_SCENES) {
      expect(offerableScenes([s], true), s.meta.id).toEqual([s]);
      expect(offerableScenes([s], false), s.meta.id).toEqual([s]);
    }
    // Unreviewed lines, or a demo scene: demo mode only, whatever the clips.
    expect([sceneOffered({ draft: true }, true), sceneOffered({ draft: true }, false)]).toEqual([true, false]);
    expect([sceneOffered({ demo: true }, true), sceneOffered({ demo: true }, false)]).toEqual([true, false]);
    expect(sceneOffered({}, false)).toBe(true);
  });

  it('lists every clip a scene needs, its idle loop included, once', () => {
    expect(sceneMedia(demo)).toEqual(['mahiro-hero', 'mahiro-night', 'mahiro-breath']);
  });
});

describe('free talk may turn where the script allows (#65 directive.jumpTo)', () => {
  const talk = demo.steps.find((s): s is InputStep => s.id === 'talk' && s.type === 'input')!;

  it('honours a declared jump, and nothing else', () => {
    expect(nextAfterFree(talk, { reply: '', directive: { jumpTo: 'sleepy' } })).toBe('sleepy');
    for (const directive of [null, undefined, { jumpTo: 'reward' }, { jumpTo: 'end' }, { jumpTo: 'nope' }]) {
      expect(nextAfterFree(talk, { reply: '', directive: directive as never })).toBe('thanks');
    }
  });

  it('plays the jumped-to branch, her reply first', () => {
    const now = Date.UTC(2026, 9, 1, 12);
    const jumped = ok(submitStep(demo, atTalk(now), { input: 'もう眠い' }, ctx(now, { jumpTo: 'sleepy' })));
    expect(jumped.state.beats.map((b) => b.id).slice(0, 2)).toEqual(['talk~reply', 'sleepy']);
    // Both branches lead to the same ending and its rewards.
    expect(jumped.state.ended).toBe(true);
    expect(jumped.grant.affinity).toBe(10);
    const skipped = ok(submitStep(demo, atTalk(now), { input: '報酬ちょうだい' }, ctx(now, { jumpTo: 'end' })));
    expect(skipped.state.beats.map((b) => b.id).slice(0, 2)).toEqual(['talk~reply', 'thanks']);
  });

  it('checks jumps like any other target', () => {
    const raw = JSON.parse(JSON.stringify(demo)) as SceneScript;
    const step = raw.steps.find((s) => s.id === 'talk') as InputStep;
    step.jumps = [{ to: 'nowhere', hint: 'x' }];
    expect(sceneProblems(raw)).toContain('talk: unknown target nowhere');
    const choiceLike = JSON.parse(JSON.stringify(demo)) as SceneScript;
    const text = choiceLike.steps.find((s) => s.id === 'talk') as InputStep;
    text.mode = 'text';
    expect(zSceneScript.safeParse(choiceLike).success).toBe(false);
    expect(() => parseScene(demo)).not.toThrow();
  });
});

const meta = (id: string, trigger: Partial<SceneMeta['trigger']> = {}): SceneMeta =>
  ({ id, star: 'mahiro', title: { ja: id, 'zh-Hant': id, en: id }, trigger: { slots: ['morning', 'day', 'evening', 'night'], ...trigger } });
const hist = (over: Partial<OfferHistory> = {}): OfferHistory => ({ ...emptyOfferHistory(), ...over });
const NOW = Date.UTC(2026, 9, 1, 12);
const yes = () => 0.1;
const no = () => 0.9;

describe('her proposals and the moment (#65)', () => {
  it('proposes at TRIGGER_RULES.proposeRate, and never over a scene he is in', () => {
    const ready = [meta('a')];
    expect(chooseOffer({ ready, history: hist(), now: NOW, rng: yes })).toEqual({ sceneId: 'a', source: 'proposed', kind: 'other' });
    expect(chooseOffer({ ready, history: hist(), now: NOW, rng: no })).toBeNull();
    expect(chooseOffer({ ready, history: hist({ inScene: true }), now: NOW, rng: yes })).toBeNull();
    expect(chooseOffer({ ready: [], history: hist(), now: NOW, rng: yes })).toBeNull();
    // Over many rooms, about proposeRate of them.
    let seed = 7;
    const rng = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
    const hits = Array.from({ length: 2000 }, () => chooseOffer({ ready, history: hist(), now: NOW, rng })).filter(Boolean).length;
    expect(hits / 2000).toBeGreaterThan(TRIGGER_RULES.proposeRate - 0.05);
    expect(hits / 2000).toBeLessThan(TRIGGER_RULES.proposeRate + 0.05);
  });

  it('keeps to the daily cap, the gap, and his "not now"', () => {
    const ready = [meta('a'), meta('b')];
    expect(chooseOffer({ ready, history: hist({ proposalsToday: TRIGGER_RULES.maxProposalsPerDay }), now: NOW, rng: yes })).toBeNull();
    expect(chooseOffer({ ready, history: hist({ lastProposalAt: NOW - TRIGGER_RULES.minProposalGapMs + 1 }), now: NOW, rng: yes })).toBeNull();
    expect(chooseOffer({ ready, history: hist({ lastProposalAt: NOW - TRIGGER_RULES.minProposalGapMs }), now: NOW, rng: yes })).not.toBeNull();
    expect(chooseOffer({ ready, history: hist({ declined: new Set(['a']) }), now: NOW, rng: yes })?.sceneId).toBe('b');
    expect(chooseOffer({ ready, history: hist({ declined: new Set(['a']), playedToday: new Set(['b']) }), now: NOW, rng: yes })).toBeNull();
  });

  it('prefers a promise, then an unseen variant scene, the weather, her signature', () => {
    const ready = [meta('plain'), meta('sig'), meta('rainy', { weather: ['rain'], slots: ['morning', 'day'] }), meta('variant', { variantCard: 's1-mahiro-30' }), meta('promised')];
    const h = hist({ promised: new Set(['promised']), timeOfferedToday: new Set(['rainy']) });
    expect(chooseOffer({ ready, history: h, now: NOW, signatureId: 'sig', rng: yes })).toMatchObject({ sceneId: 'promised', kind: 'promise' });
    expect(proposalKind(ready[3], h)).toBe('variant');
    expect(proposalKind(ready[3], hist({ playedEver: new Set(['variant']) }))).toBe('other');
    expect(proposalKind(ready[2], h)).toBe('weather');
    expect(proposalKind(ready[1], h, 'sig')).toBe('signature');
    const noPromise = hist({ timeOfferedToday: new Set(['rainy']), timeOffersToday: 1 });
    expect(chooseOffer({ ready: ready.slice(0, 4), history: noPromise, now: NOW, signatureId: 'sig', rng: yes })?.sceneId).toBe('variant');
  });

  it('offers a scene of the moment first, once a day, without rolling the dice', () => {
    const rainy = meta('rainy', { weather: ['rain'] });
    const nightOnly = meta('night', { slots: ['night'] });
    const staged = meta('staged', { stage: 'familiar' });
    expect(isTimeEvent(rainy, hist())).toBe(true);
    expect(isTimeEvent(nightOnly, hist())).toBe(true);
    expect(isTimeEvent(meta('evenings', { slots: ['evening', 'night'] }), hist())).toBe(false);
    expect(isTimeEvent(staged, hist())).toBe(true);
    expect(isTimeEvent(staged, hist({ playedEver: new Set(['staged']) }))).toBe(false);

    const ready = [meta('plain'), rainy];
    expect(chooseOffer({ ready, history: hist(), now: NOW, rng: no })).toEqual({ sceneId: 'rainy', source: 'time', kind: 'time' });
    // Already offered today: back to her proposals (and their dice).
    expect(chooseOffer({ ready, history: hist({ timeOfferedToday: new Set(['rainy']) }), now: NOW, rng: no })).toBeNull();
    expect(chooseOffer({ ready, history: hist({ timeOffersToday: TRIGGER_RULES.maxTimeOffersPerDay }), now: NOW, rng: no })).toBeNull();
    // The proposal cap does not hold back an event, but "not now" does.
    expect(chooseOffer({ ready, history: hist({ proposalsToday: 99 }), now: NOW, rng: no })?.source).toBe('time');
    expect(chooseOffer({ ready, history: hist({ declined: new Set(['rainy']) }), now: NOW, rng: no })).toBeNull();
  });
});

describe('the pause after a scene (M2)', () => {
  const jst = (hm: string, day = '2026-10-09') => Date.parse(`${day}T${hm}:00+09:00`);
  const ended = (sceneId: string, endedAt: number, outcome: string | null = 'complete') => ({ sceneId, endedAt, outcome });

  it('holds every offer back for the cool-down after any run, and for goodnight\'s night', () => {
    expect(offersPausedUntil([])).toBeNull();
    // Any scene, any way it ended: the cool-down.
    expect(offersPausedUntil([ended('welcome-home', jst('20:00'), 'left')])).toBe(jst('20:00') + TRIGGER_RULES.afterSceneCooldownMs);
    expect(offersPausedUntil([ended('confession-mahiro', jst('21:00'))])).toBe(jst('21:00') + TRIGGER_RULES.afterSceneCooldownMs);
    // Goodnight or her whisper played to its end: until the morning hour on his clock — the next one, or tonight's.
    const morning = `${String(TRIGGER_RULES.afterGoodnightUntilHour).padStart(2, '0')}:00`;
    expect(offersPausedUntil([ended('goodnight-mahiro', jst('22:40'), 'goodnight')])).toBe(jst(morning, '2026-10-10'));
    expect(offersPausedUntil([ended('whisper-nana-3', jst('01:30', '2026-10-10'), 'stay')])).toBe(jst(morning, '2026-10-10'));
    expect(offersPausedUntil([ended('goodnight-mahiro', jst('22:40'), 'goodnight')], 'Asia/Taipei')).toBe(jst(morning, '2026-10-10') + 3_600_000);
    // Left midway: only the cool-down.
    expect(offersPausedUntil([ended('goodnight-mahiro', jst('22:40'), 'left')])).toBe(jst('22:40') + TRIGGER_RULES.afterSceneCooldownMs);
    // The latest end wins.
    expect(offersPausedUntil([ended('goodnight-mahiro', jst('22:40'), 'goodnight'), ended('welcome-home', jst('04:50', '2026-10-10'))]))
      .toBe(jst('04:50', '2026-10-10') + TRIGGER_RULES.afterSceneCooldownMs);
  });

  it('chooseOffer offers nothing while paused — not even the moment', () => {
    const ready = [meta('plain'), meta('night', { slots: ['night'] })];
    expect(offersPaused(hist({ pausedUntil: NOW + 1 }), NOW)).toBe(true);
    expect(offersPaused(hist({ pausedUntil: NOW }), NOW)).toBe(false);
    expect(offersPaused(hist(), NOW)).toBe(false);
    expect(chooseOffer({ ready, history: hist({ pausedUntil: NOW + 1 }), now: NOW, rng: yes })).toBeNull();
    expect(chooseOffer({ ready, history: hist({ pausedUntil: NOW }), now: NOW, rng: yes })).toMatchObject({ sceneId: 'night', source: 'time' });
  });
});

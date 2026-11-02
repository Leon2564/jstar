import { describe, expect, it } from 'vitest';
import { CATALOG } from '../src/catalog';
import { STAR_IDS, type StarId } from '../src/domain';
import { VARIANT_CARDS, VARIANT_RULES } from '../src/rules';
import { canPinHome, inviteNight, variantCardOf, variantHomeWeight } from '../src/variants';
import { LINES } from '../src/lines';
import {
  beginRun, judgeAnswer, sceneById, sceneOffered, scenePlayable, submitStep, triggerProblems, targetsOf,
  type Advance, type Judged, type MinigameCall, type RunState, type SceneError, type SceneSubmission, type TriggerContext
} from '../src/scenes';
import { isPendingMedia, previewScript } from '../src/scenes/media';
import { parseScene, sceneProblems, type SceneScript, type SceneStep } from '../src/scenes/schema';
import {
  PENDING_VARIANT_CLIPS, VARIANT_SCENES, VARIANT_SCENE_FILES, variantClips, variantSceneById, variantSceneId, variantSceneOf
} from '../src/scenes/variantScenes';

const LAYERS = [1, 3, 6, 10];
/** Her own clips a variant scene may use without #81: the empty room at night, her in the room, her close loop. */
const OWN = (star: StarId) => new Set([`${star}-night`, `${star}-hero`, `${star}-breath`]);

function texts(node: unknown): Record<string, string>[] {
  if (Array.isArray(node)) return node.flatMap(texts);
  if (node && typeof node === 'object') {
    const o = node as Record<string, unknown>;
    if ('ja' in o) return [o as Record<string, string>];
    return Object.values(o).flatMap(texts);
  }
  return [];
}

let n = 0;
const ok = (r: Advance | SceneError): Advance => { if (typeof r === 'string') throw new Error(r); return r; };
const ctx = (now: number, star: StarId) => ({
  now, lang: 'ja', newId: (p: string) => `${p}_${n++}`, free: { reply: '…' },
  prompt: (step: { kind: string }) => (step.kind === 'ogiri' ? (LINES[star].ogiri ?? [])[0] ?? null : null)
});
const OGIRI: MinigameCall[] = [{ kind: 'ogiri', score: 9, comment: null }, { kind: 'ogiri', score: 2, comment: null }];

function answers(step: SceneStep): { sub: SceneSubmission; rng?: () => number; judged?: Judged }[] {
  if (step.type === 'choice') return [...step.options.map((o) => ({ sub: { choice: o.id } })), ...(step.onTimeout ? [{ sub: { timeout: true } as const }] : [])];
  if (step.type === 'input') return [{ sub: { input: 'きょうは楽しかった' } }, ...(step.onTimeout ? [{ sub: { timeout: true } as const }] : [])];
  if (step.type === 'minigame' && step.kind === 'rps') return [0, 0.4, 0.8].map((r) => ({ sub: { minigame: { hand: 'rock' } }, rng: () => r }));
  if (step.type === 'minigame') return OGIRI.map((call) => ({ sub: { minigame: { text: 'ひとこと' } }, judged: judgeAnswer(step, 'ひとこと', call) }));
  return [];
}

/** Every path the engine can take; returns each finished run with the steps it passed. */
function playAll(script: SceneScript): { state: RunState; path: string[] }[] {
  const done: { state: RunState; path: string[] }[] = [];
  const walk = (state: RunState, path: string[], depth: number) => {
    if (depth > 40) throw new Error(`${script.meta.id}: path too long`);
    if (state.ended) { done.push({ state, path }); return; }
    const step = script.steps.find((s) => s.id === state.at)!;
    for (const { sub, rng, judged } of answers(step)) {
      const next = ok(submitStep(script, state, sub, { ...ctx(state.waitingSince + 301_000, script.meta.star), rng, judged }));
      if (!next.state.ended && path.includes(next.state.at)) continue; // rps draw loops back: once is enough
      walk(next.state, [...path, ...next.state.beats.map((b) => b.id)], depth + 1);
    }
  };
  const first = ok(beginRun(script, { ...ctx(1_000_000, script.meta.star), rewardable: true }));
  walk(first.state, first.state.beats.map((b) => b.id), 0);
  return done;
}

const trigger = (patch: Partial<TriggerContext> = {}): TriggerContext =>
  ({ slot: 'evening', weather: null, stage: 'new', owns: () => true, routine: null, ...patch });

describe('her variant scenes (#76): twenty scripts, four layers each', () => {
  it('five talents × layers 1 / 3 / 6 / 10, at the ids catalog.ts reserves for them', () => {
    expect(VARIANT_SCENE_FILES).toHaveLength(20);
    expect(VARIANT_SCENE_FILES.map((s) => s.meta.id).sort()).toEqual(STAR_IDS.flatMap((star) => LAYERS.map((l) => variantSceneId(star, l))).sort());
    for (const card of CATALOG.filter((c) => c.variant)) {
      expect(card.variant!.layers.map((l) => variantSceneById(l.scene)?.meta.trigger.variantLayer), card.id).toEqual(LAYERS);
      const clips = variantClips(card.star);
      expect([card.variant!.enterClip, card.variant!.closeClip, card.variant!.homeVideo]).toEqual([clips.enter, clips.close, clips.home]);
    }
    expect(LAYERS).toEqual([...VARIANT_RULES.layerLevels]);
    for (const s of VARIANT_SCENE_FILES) expect(variantSceneOf(s.meta.id)).toEqual({ star: s.meta.star, layer: s.meta.trigger.variantLayer });
    expect([variantSceneOf('variant-eimi-2'), variantSceneOf('variant-nobody-1'), variantSceneOf('ogiri')]).toEqual([null, null, null]);
  });

  it('name no card: each takes her talent\'s from VARIANT_CARDS (the pick lives in one place)', () => {
    for (const s of VARIANT_SCENE_FILES) expect(s.meta.trigger.variantCard, s.meta.id).toBeUndefined();
    for (const star of STAR_IDS) {
      const card = CATALOG.find((c) => c.star === star && c.variant)?.id ?? null;
      expect(variantCardOf(star), star).toBe(card);
      for (const s of VARIANT_SCENES.filter((x) => x.meta.star === star)) expect(s.meta.trigger.variantCard).toBe(card);
    }
    expect(VARIANT_SCENES).toHaveLength(VARIANT_CARDS.length * LAYERS.length);
  });

  it('every script parses, every branch reaches an end, every text has ja / zh-Hant / en', () => {
    for (const s of VARIANT_SCENES) {
      expect(() => parseScene(s), s.meta.id).not.toThrow();
      expect(sceneProblems(s), s.meta.id).toEqual([]);
      for (const t of texts(s)) for (const lang of ['ja', 'zh-Hant', 'en']) expect(t[lang]?.trim(), `${s.meta.id} ${t.ja}`).toBeTruthy();
      // Short, like the #82 drafts.
      expect(s.steps.length, s.meta.id).toBeLessThanOrEqual(16);
    }
    // A file on its own lacks its card, and the structural check says so.
    expect(sceneProblems(VARIANT_SCENE_FILES[0])).toContain('variant layer without its card');
  });

  it('every clip is her own existing one or one of her variant clips (#81, all made)', () => {
    expect(PENDING_VARIANT_CLIPS).toEqual([]);
    for (const s of VARIANT_SCENES) {
      const star = s.meta.star;
      const mine = new Set([...Object.values(variantClips(star)), ...OWN(star)]);
      for (const step of s.steps) if (step.type === 'clip') expect(mine.has(step.media), `${s.meta.id} ${step.media}`).toBe(true);
      expect(s.meta.idle).toBe(variantClips(star).home);
      // Layer 1 is the reveal: she walks into her empty room wearing it.
      if (s.meta.trigger.variantLayer === 1) expect(s.steps.filter((x) => x.type === 'clip').map((x) => x.type === 'clip' && x.media).slice(0, 2)).toEqual([`${star}-night`, variantClips(star).enter]);
    }
  });

  it('a preview plays them as written now that nothing is pending, idle loop included', () => {
    for (const s of VARIANT_SCENES) {
      const p = previewScript(s);
      expect(p.meta.idle).toBe(s.meta.idle);
      for (const step of p.steps) if (step.type === 'clip') expect(isPendingMedia(step.media), `${s.meta.id} ${step.media}`).toBe(false);
      expect(p.steps.map((x) => x.id)).toEqual(s.steps.map((x) => x.id));
    }
  });

  it('reviewed and in SCENES; #81\'s clips exist, so they play everywhere — and a pending clip would make one demo-only again', () => {
    for (const s of VARIANT_SCENES) {
      expect(s.meta.draft).toBeUndefined();
      expect(sceneById(s.meta.id)).toBe(s);
      expect(sceneOffered(s.meta, false)).toBe(true);
      expect(scenePlayable(s, false), s.meta.id).toBe(true);
      expect(scenePlayable(s, true), s.meta.id).toBe(true);
      // The rule still holds: a clip still to be made (a #80 scene clip, say) keeps it on the test site.
      const pending = { ...s, steps: s.steps.map((x) => (x.type === 'clip' ? { ...x, media: `${s.meta.star}-scene-${s.meta.id}-wide` } : x)) };
      expect(isPendingMedia(`${s.meta.star}-scene-${s.meta.id}-wide`)).toBe(true);
      expect(scenePlayable(pending, false), s.meta.id).toBe(false);
      expect(scenePlayable(pending, true), s.meta.id).toBe(true);
    }
  });

  it('open by her variant card\'s own level: 1 / 3 / 6 / 10', () => {
    const eimi = LAYERS.map((l) => variantSceneById(variantSceneId('eimi', l))!.meta);
    const open = (level: number | null, owns = true) =>
      eimi.filter((m) => !triggerProblems(m, trigger({ owns: () => owns, ...(level === null ? {} : { variantLevel: () => level }) })).length).map((m) => m.trigger.variantLayer);
    expect(open(1)).toEqual([1]);
    expect(open(2)).toEqual([1]);
    expect(open(3)).toEqual([1, 3]);
    expect(open(5)).toEqual([1, 3]);
    expect(open(6)).toEqual([1, 3, 6]);
    expect(open(9)).toEqual([1, 3, 6]);
    expect(open(10)).toEqual([1, 3, 6, 10]);
    // Without the level known, only the reveal; without the card, nothing.
    expect(open(null)).toEqual([1]);
    expect(open(10, false)).toEqual([]);
    expect(triggerProblems(eimi[3], trigger({ owns: () => false }))).toEqual(['variant_card', 'variant_level']);
    expect(triggerProblems(eimi[2], trigger({ variantLevel: () => 3 }))).toEqual(['variant_level']);
    // Evening and night, like her invite.
    expect(triggerProblems(eimi[0], trigger({ slot: 'morning' }))).toEqual(['slot']);
  });

  it('play through the engine: every path pays the variant XP at its end; the reveal and the hug are memory cards', () => {
    for (const s of VARIANT_SCENES) {
      const runs = playAll(s);
      expect(runs.length, s.meta.id).toBeGreaterThan(0);
      for (const { state } of runs) {
        expect(state.rewards.variantXp, `${s.meta.id} → ${state.outcome}`).toBe(VARIANT_RULES.sceneEndXp);
        expect(state.rewards.affinity).toBeGreaterThan(0);
        expect(state.rewards.memories.length, s.meta.id).toBe([1, 10].includes(s.meta.trigger.variantLayer!) ? 1 : 0);
      }
    }
  });

  it('she stops anything beyond a close shot, a whisper or a hug — in character, at no cost to him', () => {
    for (const star of STAR_IDS) {
      for (const [layer, from, to] of [[6, 'ask', 'too-near'], [10, 'ask', 'beyond']] as const) {
        const s = variantSceneById(variantSceneId(star, layer))!;
        const step = s.steps.find((x) => x.id === from)!;
        expect(step.type === 'choice' && step.options.some((o) => o.next === to), `${s.meta.id}`).toBe(true);
        const runs = playAll(s).filter((r) => r.path.includes(to));
        expect(runs.length, s.meta.id).toBeGreaterThan(0);
        for (const r of runs) expect(r.state.rewards.variantXp).toBe(VARIANT_RULES.sceneEndXp);
      }
    }
  });

  it('every step is reachable, and the scripts never step outside their own ids', () => {
    for (const s of VARIANT_SCENES) {
      const ids = s.steps.map((x) => x.id);
      const seen = new Set<string>();
      const stack = [ids[0]];
      while (stack.length) {
        const id = stack.pop()!;
        if (seen.has(id)) continue;
        seen.add(id);
        stack.push(...targetsOf(s.steps[ids.indexOf(id)], ids[ids.indexOf(id) + 1]));
      }
      expect(ids.filter((id) => !seen.has(id)), s.meta.id).toEqual([]);
    }
  });
});

describe('the draw-night invite and her home (#76)', () => {
  const jst = (day: string, h: number, m = 0) => Date.parse(`${day}T${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:00+09:00`);
  it('a night runs 18:00–05:00 JST and belongs to the day that started at 05:00', () => {
    expect(inviteNight(jst('2026-10-05', 12))).toEqual({ day: '2026-10-05', since: new Date(jst('2026-10-05', 5)).toISOString(), open: false });
    expect(inviteNight(jst('2026-10-05', 18))).toMatchObject({ day: '2026-10-05', open: true });
    expect(inviteNight(jst('2026-10-05', 23, 59))).toMatchObject({ day: '2026-10-05', open: true });
    expect(inviteNight(jst('2026-10-06', 2))).toMatchObject({ day: '2026-10-05', open: true });
    expect(inviteNight(jst('2026-10-06', 5))).toMatchObject({ day: '2026-10-06', open: false });
  });

  it('her variant look weighs more as its level rises, and may be pinned from level 10', () => {
    expect([1, 2, 6, 10, 12].map(variantHomeWeight)).toEqual([1, 1.25, 2.25, 3.25, 3.25]);
    expect([1, 9, 10].map(canPinHome)).toEqual([false, false, true]);
  });
});

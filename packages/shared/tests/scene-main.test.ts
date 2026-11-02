import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  MAIN_SCENES, SCENES, beginRun, judgeAnswer, sceneById, sceneOffered, scenePlayable, submitStep, targetsOf,
  type Advance, type GameTables, type Judged, type MinigameCall, type RunState, type SceneError, type SceneSubmission
} from '../src/scenes';
import { LANDED_SCENE_CLIPS, PENDING_MEDIA_PATTERN, mediaReady, pendingMedia, previewScript, sceneClips } from '../src/scenes/media';
import { sceneProblems, zSceneScript, type SceneScript, type SceneStep } from '../src/scenes/schema';
import { LINES } from '../src/lines';
import { VARIANT_SCENE_FILES, variantClips } from '../src/scenes/variantScenes';
import { DATE_RULES } from '../src/rules';

const DIR = join(__dirname, '../src/scenes');
const byId = (id: string) => MAIN_SCENES.find((s) => s.meta.id === id)!;
/** A line file's text without her recording (#83): the scene step carries the voice, not its text. */
const unvoiced = ({ voice: _v, ...t }: { voice?: string } & Record<string, unknown>) => t;
/** Existing catalogue families a script may use without #80 (apps/web/src/data/media.gen.ts). */
const LIVE_FAMILIES = new Set(['hero', 'night', 'breath', 'day', 'morning']);

/** Every three-language text in a script or line file. */
function texts(node: unknown): Record<string, string>[] {
  if (Array.isArray(node)) return node.flatMap(texts);
  if (node && typeof node === 'object') {
    const o = node as Record<string, unknown>;
    if ('ja' in o) return [o as Record<string, string>];
    return Object.values(o).flatMap(texts);
  }
  return [];
}

/** Steps from which no end can be reached, following every branch (outcomes the engine does not decide yet included). */
function deadEnds(script: SceneScript): string[] {
  const ids = script.steps.map((s) => s.id);
  const map = new Map(script.steps.map((s) => [s.id, s]));
  const after = (id: string) => script.steps[ids.indexOf(id) + 1]?.id;
  const ends = (from: string) => {
    const seen = new Set<string>();
    const stack = [from];
    while (stack.length) {
      const id = stack.pop()!;
      if (seen.has(id)) continue;
      seen.add(id);
      const s = map.get(id)!;
      if (s.type === 'end') return true;
      stack.push(...targetsOf(s, after(id)));
    }
    return false;
  };
  return ids.filter((id) => !ends(id));
}

let n = 0;
/** Her lines the games read, as the API passes them (apps/api/src/lib/minigames.ts). */
const tables = (star: SceneScript['meta']['star']): GameTables => ({
  bargain: LINES[star].bargain ?? null, refusals: LINES[star].refuse.filter((r) => r.kind === 'line').map((r) => r.text), danmaku: LINES[star].danmaku ?? null
});
const prompt = (star: SceneScript['meta']['star']) => (step: { kind: string }, state: RunState) => {
  const bank = LINES[star].ogiri ?? [];
  const p = step.kind === 'ogiri' ? bank.find((q) => !Object.values(state.prompts ?? {}).includes(q.id)) : undefined;
  return p ? { id: p.id, text: p.text } : null;
};
const ctx = (now: number, star: SceneScript['meta']['star'] = 'mahiro') => ({ now, lang: 'ja', newId: (p: string) => `${p}_${n++}`, free: { reply: '…' }, prompt: prompt(star) });
const ok = (r: Advance | SceneError): Advance => { if (typeof r === 'string') throw new Error(r); return r; };

/** A judge's pass and fail for each judged game (#67–#70). */
const VERDICTS: Record<string, MinigameCall[]> = {
  praise: [{ kind: 'praise', tier: 'specific', reason: 'detail' }, { kind: 'praise', tier: 'generic', reason: 'generic' }],
  ogiri: [{ kind: 'ogiri', score: 9, comment: 'ふふっ' }, { kind: 'ogiri', score: 3, comment: null }],
  bargain: [{ kind: 'bargain', move: 'alternative' }, { kind: 'bargain', move: 'please' }, { kind: 'bargain', move: 'over_line' }],
  danmaku: [{ kind: 'danmaku', label: 'greet' }, { kind: 'danmaku', label: 'over-line' }]
};

/** Every answer the waiting step accepts (rps forced to each result through the rng; judged games passed and failed). */
/** A gift he gives inside a scene (#68), paid for outside the engine; she thanks him for it. */
const GIFT = { result: { kind: 'gift' as const, giftId: 'bouquet' as const, taste: 'plain' as const, xp: 6, result: 'win' as const }, reply: [{ ja: 'ありがと', 'zh-Hant': '謝謝', en: 'Thanks' }] };

function answers(step: SceneStep, star: SceneScript['meta']['star']): { sub: SceneSubmission; rng?: () => number; judged?: Judged; gift?: typeof GIFT }[] {
  if (step.type === 'choice') {
    return [
      ...step.options.map((o) => (o.gift ? { sub: { choice: o.id, gift: 'bouquet' }, gift: GIFT } : { sub: { choice: o.id } })),
      ...(step.onTimeout ? [{ sub: { timeout: true } as const }] : [])
    ];
  }
  if (step.type === 'input') return [{ sub: { input: '今日はいい日だった' } }, ...(step.onTimeout ? [{ sub: { timeout: true } as const }] : [])];
  if (step.type === 'minigame' && step.kind === 'rps') return [0, 0.4, 0.8].map((r) => ({ sub: { minigame: { hand: 'rock' } }, rng: () => r }));
  if (step.type === 'minigame') {
    return VERDICTS[step.kind].map((call) => ({ sub: { minigame: { text: 'ひとこと' } }, judged: judgeAnswer(step, 'ひとこと', call, tables(star)) }));
  }
  return [];
}

/** Plays every path the engine can take today; returns the finished runs. */
function playAll(script: SceneScript): RunState[] {
  const done: RunState[] = [];
  const walk = (state: RunState, seen: string[], depth: number) => {
    if (depth > 60) throw new Error(`${script.meta.id}: path too long`);
    if (state.ended) { done.push(state); return; }
    const step = script.steps.find((s) => s.id === state.at)!;
    for (const { sub, rng, judged, gift } of answers(step, script.meta.star)) {
      const next = ok(submitStep(script, state, sub, { ...ctx(state.waitingSince + 301_000, script.meta.star), rng, judged, gift }));
      if (!next.state.ended && seen.includes(next.state.at)) continue; // a loop back (rps draw): once is enough
      walk(next.state, [...seen, next.state.at], depth + 1);
    }
  };
  const first = ok(beginRun(script, { ...ctx(1_000_000, script.meta.star), rewardable: true })).state;
  walk(first, [first.at], 0);
  return done;
}

describe('the five scenes\' scripts (#82)', () => {
  it('there is one main scene per talent (#66–#70), plus 奈々\'s rainy opening', () => {
    expect(MAIN_SCENES.map((s) => `${s.meta.star}/${s.meta.id}`).sort()).toEqual([
      'alice/night-greenhouse', 'eimi/ogiri', 'mahiro/welcome-home', 'nana/read-aloud', 'nana/read-aloud-rain', 'unpai/private-stream'
    ]);
  });

  it('every script passes zod and sceneProblems(), and every branch can still reach an end', () => {
    for (const s of MAIN_SCENES) {
      const parsed = zSceneScript.safeParse(s);
      expect(parsed.success, `${s.meta.id}: ${parsed.success ? '' : parsed.error.message}`).toBe(true);
      expect(sceneProblems(s), s.meta.id).toEqual([]);
      expect(deadEnds(s), s.meta.id).toEqual([]);
    }
  });

  it('every text has Japanese, Traditional Chinese, English and Korean', () => {
    for (const s of MAIN_SCENES) {
      const all = texts(s);
      expect(all.length, s.meta.id).toBeGreaterThan(20);
      for (const t of all) for (const lang of ['ja', 'zh-Hant', 'en', 'ko']) expect(t[lang]?.trim(), `${s.meta.id} ${t.ja} [${lang}]`).toBeTruthy();
    }
  });

  it('every file on disk is listed exactly once, where its path says', () => {
    // Her variant scenes are in SCENES with her card filled in (a talent without a variant card has none there).
    const listed = new Map([...SCENES, ...VARIANT_SCENE_FILES].map((s) => [`${s.meta.star}/${s.meta.id}`, s]));
    const files = readdirSync(DIR, { withFileTypes: true }).filter((d) => d.isDirectory())
      .flatMap((d) => readdirSync(join(DIR, d.name)).filter((f) => f.endsWith('.json')).map((f) => `${d.name}/${f.replace(/\.json$/, '')}`));
    expect(files.sort()).toEqual([...listed.keys()].sort());
    expect(new Set(SCENES.map((s) => s.meta.id)).size).toBe(SCENES.length);
  });

  it('the publish rule: reviewed and in SCENES, and #80\'s clips exist, so production plays them as well as demo mode', () => {
    for (const s of MAIN_SCENES) {
      expect(s.meta.draft, s.meta.id).toBeUndefined();
      expect(sceneById(s.meta.id), s.meta.id).toBe(s);
      expect(sceneOffered(s.meta, false), s.meta.id).toBe(true);
      expect(mediaReady(s), s.meta.id).toBe(true);
      expect(scenePlayable(s, false), s.meta.id).toBe(true);
      expect(scenePlayable(s, true), s.meta.id).toBe(true);
      // A shot still to be made keeps it demo-only until it lands.
      const later = { ...s, steps: s.steps.map((x) => (x.type === 'clip' && PENDING_MEDIA_PATTERN.test(x.media) ? { ...x, media: `${x.media}-v2` } : x)) };
      expect(mediaReady(later), s.meta.id).toBe(false);
      expect([scenePlayable(later, false), scenePlayable(later, true)], s.meta.id).toEqual([false, true]);
      // Unreviewed lines keep it demo-only, whatever the clips.
      expect(scenePlayable({ ...s, meta: { ...s.meta, draft: true } }, false), s.meta.id).toBe(false);
    }
    for (const s of SCENES) expect(s.meta.draft, s.meta.id).toBeFalsy();
    // The demo gate is unchanged: demo scenes in demo mode only, ordinary scenes everywhere.
    const demo = sceneById('demo-evening')!;
    expect([scenePlayable(demo, true), scenePlayable(demo, false)]).toEqual([true, false]);
    expect(sceneOffered({}, false)).toBe(true);
  });

  it('clips are her own: existing catalogue families, or #80\'s scene clips `<star>-scene-<id>-<shot>`', () => {
    for (const s of MAIN_SCENES) {
      for (const step of s.steps) {
        if (step.type !== 'clip') continue;
        const [star, family] = step.media.split('-');
        expect(star, `${s.meta.id} ${step.media}`).toBe(s.meta.star);
        if (PENDING_MEDIA_PATTERN.test(step.media)) expect(step.media.startsWith(`${s.meta.star}-scene-${s.meta.id.replace(/-rain$/, '')}-`), step.media).toBe(true);
        else expect(LIVE_FAMILIES.has(family), `${s.meta.id} ${step.media}`).toBe(true);
        // #70: her reward outfit when he owns her variant card is #81's footage, which exists — never pending.
        for (const v of step.variants ?? []) {
          expect(Object.values(variantClips(s.meta.star)), `${s.meta.id} ${v.media}`).toContain(v.media);
          expect(pendingMedia([{ ...s, steps: [{ ...step, media: `${s.meta.star}-hero` }] }]), v.media).toEqual([]);
        }
      }
      expect(s.meta.idle).toBe(`${s.meta.star}-hero`);
    }
    // The list #80 made (docs: PR for #82). Changing a clip id here means a new clip in tools/media shots/scenes-v11.ts.
    expect(sceneClips(MAIN_SCENES)).toEqual([
      'alice-scene-night-greenhouse-flowers', 'alice-scene-night-greenhouse-hands', 'alice-scene-night-greenhouse-piano', 'alice-scene-night-greenhouse-piano-prop', 'alice-scene-night-greenhouse-sleeve',
      'eimi-scene-ogiri-empty', 'eimi-scene-ogiri-hug', 'eimi-scene-ogiri-leave', 'eimi-scene-ogiri-perfume', 'eimi-scene-ogiri-return', 'eimi-scene-ogiri-twirl',
      'mahiro-scene-welcome-home-close', 'mahiro-scene-welcome-home-coffee', 'mahiro-scene-welcome-home-cup', 'mahiro-scene-welcome-home-pout', 'mahiro-scene-welcome-home-rps',
      'nana-scene-read-aloud-book', 'nana-scene-read-aloud-lookup', 'nana-scene-read-aloud-read', 'nana-scene-read-aloud-shy',
      'unpai-scene-private-stream-headphones', 'unpai-scene-private-stream-headphones-prop', 'unpai-scene-private-stream-leave', 'unpai-scene-private-stream-run', 'unpai-scene-private-stream-share'
    ]);
    // One-shot clips (she enters, leaves, glides to her hands) play once and hold their last frame; a clip the next
    // clip cuts from holds long enough to be seen (a hold of 0 would cut away at once).
    for (const s of MAIN_SCENES) {
      s.steps.forEach((st, i) => {
        if (st.type !== 'clip' || !/-(cup|run|leave|return|flowers|hug|lookup|hands)$/.test(st.media)) return;
        expect(st.loop, `${s.meta.id} ${st.id}`).toBe(false);
        if (s.steps[i + 1]?.type === 'clip') expect(st.hold, `${s.meta.id} ${st.id}`).toBeGreaterThanOrEqual(4);
      });
    }
    // All made (#80): nothing is pending.
    expect([...LANDED_SCENE_CLIPS].sort()).toEqual(sceneClips(MAIN_SCENES));
    expect(pendingMedia(MAIN_SCENES)).toEqual([]);
  });

  it('uses the mini-game each issue names', () => {
    const kinds = (id: string) => [...new Set(byId(id).steps.flatMap((s) => (s.type === 'minigame' ? [s.kind] : [])))];
    expect(kinds('welcome-home')).toEqual(['rps']);
    expect(kinds('read-aloud')).toEqual(['praise']);
    expect(kinds('private-stream')).toEqual(['danmaku']);
    expect(kinds('night-greenhouse')).toEqual(['bargain']);
    expect(kinds('ogiri')).toEqual(['ogiri']);
    expect(byId('private-stream').steps.filter((s) => s.type === 'minigame')).toHaveLength(3);
  });

  it('plays through the engine, judged games passed and failed: every path ends with a memory card or a promise', () => {
    const outcomes: Record<string, string[]> = {};
    for (const s of MAIN_SCENES) {
      const runs = playAll(s);
      expect(runs.length, s.meta.id).toBeGreaterThan(0);
      for (const r of runs) expect(r.rewards.memories.length + r.rewards.promises.length, `${s.meta.id} → ${r.outcome}`).toBeGreaterThan(0);
      outcomes[s.meta.id] = [...new Set(runs.map((r) => r.outcome!))].sort();
    }
    // まひろ: the three branches of #66 (won → closer / wake; lost → praise).
    expect(outcomes['welcome-home']).toEqual(['closer', 'praise', 'wake']);
    expect(outcomes['night-greenhouse']).toEqual(['extended', 'tomorrow']);
    // 奈々 #67: a specific praise (at the first or the second try), or two generic ones and her gentle ending.
    expect(outcomes['read-aloud']).toEqual(['gentle', 'praised']);
    // えいみ #70: 8 or more at the second prompt → the costume and the hug; under it → a rematch tomorrow.
    expect(outcomes['ogiri']).toEqual(['hug', 'retry']);
    expect(outcomes['private-stream']).toEqual(['complete']);
  });

  it('奈々: the rainy version differs only in its opening, and reads her readings word for word', () => {
    const [dry, wet] = [byId('read-aloud'), byId('read-aloud-rain')];
    expect(wet.meta.trigger.weather).toEqual(['rain']);
    expect(dry.meta.trigger.weather).toBeUndefined();
    const strip = (s: SceneScript) => s.steps.filter((x) => x.id !== 'open');
    expect(strip(wet)).toEqual(strip(dry));
    expect(JSON.stringify(dry.steps.find((x) => x.id === 'open'))).not.toMatch(/雨|rain/i);
    expect(JSON.stringify(wet.steps.find((x) => x.id === 'open'))).toMatch(/雨/);
    const lines = dry.steps.flatMap((s) => (s.type === 'line' ? [s.text] : []));
    for (const reading of LINES.nana.readings!) {
      const at = lines.findIndex((l) => l.ja === reading.paragraphs[0].ja);
      expect(at, reading.id).toBeGreaterThan(-1);
      expect(lines.slice(at, at + reading.paragraphs.length)).toEqual(reading.paragraphs.map(unvoiced));
    }
  });

  it('a scene plays as written once its clips exist (#80); a clip still pending gets her own stand-in in demo mode', () => {
    for (const s of MAIN_SCENES) {
      const p = previewScript(s);
      expect(p.meta).toEqual(s.meta);
      expect(pendingMedia([p])).toEqual([]);
      expect(previewScript(p)).toBe(p);
      expect(p.steps).toEqual(s.steps);
    }
    // A shot not made yet (say, one added to a scene later) stands in with her hero / breath / night clip.
    const s = MAIN_SCENES[0];
    const clips = s.steps.flatMap((x, i) => (x.type === 'clip' && PENDING_MEDIA_PATTERN.test(x.media) ? [i] : []));
    const draft = { ...s, steps: s.steps.map((x, i) => (clips.includes(i) && x.type === 'clip' ? { ...x, media: `${x.media}-v2` } : x)) } as SceneScript;
    expect(pendingMedia([draft])).toHaveLength(new Set(clips.map((i) => (s.steps[i] as { media: string }).media)).size);
    const p = previewScript(draft);
    expect(pendingMedia([p])).toEqual([]);
    p.steps.forEach((step, i) => {
      const was = draft.steps[i];
      if (step.type !== 'clip' || was.type !== 'clip') { expect(step).toEqual(was); return; }
      if (!clips.includes(i)) expect(step.media).toBe(was.media);
      else expect(step.media).toBe(`${s.meta.star}-${{ wide: 'hero', enter: 'hero', close: 'breath', detail: 'breath', empty: 'night' }[was.shot]}`);
    });
  });

  it('アリス: a heatwave changes her refusal (#63), the date runs 40 minutes and the extension adds 30 (#69)', () => {
    const scene = byId('night-greenhouse');
    const refuse = scene.steps.find((s) => s.id === 'refuse');
    expect(refuse?.type === 'line' && refuse.variants).toEqual([{ when: 'hot', text: LINES.alice.bargain!.refuse.hot }]);
    const clock = scene.steps.find((s) => s.id === 'clock');
    expect(clock?.type === 'effect' && clock.timer).toEqual({ seconds: DATE_RULES.minutes * 60, onEnd: 'closing' }); // #69: her plea the moment it ends
    const extend = scene.steps.find((s) => s.id === 'extend');
    expect(extend?.type === 'choice' && extend.options[0].effect?.timer).toEqual({ seconds: DATE_RULES.extendMinutes * 60, add: true });
    const plea = scene.steps.find((s) => s.id === 'plea');
    expect(plea?.type === 'minigame' && plea.outcomes).toEqual({ win: 'piano-1', lose: 'counter-1' });
  });

  it('アリス: the three bargains of her tree each get their own answer and all end at the piano', () => {
    const scene = byId('night-greenhouse');
    const tree = LINES.alice.bargain!;
    const offer = scene.steps.find((s) => s.id === 'offer');
    expect(offer?.type === 'choice' && offer.options.map((o) => o.label)).toEqual(tree.branches.map((b) => b.offer));
    const lines = scene.steps.flatMap((s) => (s.type === 'line' ? [s.text] : []));
    for (const b of tree.branches) for (const r of b.reply) expect(lines).toContainEqual(unvoiced(r));
    expect(lines).toContainEqual(unvoiced(tree.refuse.normal));
    expect(lines).toContainEqual(unvoiced(tree.push));
    // From each branch's first answer, the piano is on every way forward.
    const ids = scene.steps.map((s) => s.id);
    const map = new Map(scene.steps.map((s) => [s.id, s]));
    const reachesPiano = (from: string, seen = new Set<string>()): boolean => {
      if (from === 'piano') return true;
      if (seen.has(from)) return false;
      seen.add(from);
      const s = map.get(from)!;
      const next = [...new Set(targetsOf(s, scene.steps[ids.indexOf(from) + 1]?.id))];
      return next.length > 0 && next.every((t) => reachesPiano(t, seen));
    };
    for (const b of tree.branches) expect(reachesPiano(`${b.id}-1`), b.id).toBe(true);
  });
});

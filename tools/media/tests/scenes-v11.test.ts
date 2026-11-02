import { describe, expect, it } from 'vitest';
import { MAIN_SCENES } from '../../../packages/shared/src/scenes';
import { sceneClips } from '../../../packages/shared/src/scenes/media';
import { SHOTS, anchorsOf, hasPerson, presenceOf, validate } from '../src/manifest';
import { personPrompt, stillPrompt } from '../src/scene-clips';
import { HOME_V11_KEYFRAMES, HOME_V11_SHOTS } from '../src/shots/home-v11';
import { RUN_16X9_CAMERA, SCENE_V11_KEYFRAMES, SCENE_V11_SHOTS, SCENE_V11_WIDE_SHOTS, v1, v1w } from '../src/shots/scenes-v11';

const shot = (id: string) => SHOTS.find((s) => s.id === id)!;

describe('v1.1 scene clips (#80)', () => {
  it('makes exactly the five scenes\' own clips, in 9:16 at 1080p, encoded hq', () => {
    expect(SCENE_V11_SHOTS.map((s) => s.id.replace(/-9x16$/, '')).sort()).toEqual(sceneClips(MAIN_SCENES));
    for (const s of SCENE_V11_SHOTS) expect([s.ratio, s.resolution, s.model, s.encode], s.id).toEqual(['9:16', '1080p', 'sd25', 'hq']);
    for (const s of SCENE_V11_SHOTS.filter((x) => x.loop)) expect(s.xfade, s.id).toBe(0);
    expect(validate(SHOTS)).toEqual([]);
  });

  it('starts every clip that follows her hero loop on the v1 hero frame, and chains clip-to-clip cuts', () => {
    for (const star of ['mahiro', 'alice', 'eimi'] as const) {
      const first = SCENE_V11_SHOTS.filter((s) => s.star === star).map((s) => anchorsOf(s).first);
      expect(first, star).toContainEqual({ keyframe: v1(star) });
    }
    // えいみ: leave → empty room → back in the gown → twirl, each on the frame the previous one ended on.
    expect(anchorsOf(shot('eimi-scene-ogiri-empty-9x16')).first).toEqual({ rendered: 'eimi-scene-ogiri-leave-9x16' });
    expect(anchorsOf(shot('eimi-scene-ogiri-return-9x16'))).toEqual({ first: { rendered: 'eimi-scene-ogiri-leave-9x16' }, last: { keyframe: 'eimi-v11-gown-9x16' } });
    expect(anchorsOf(shot('eimi-scene-ogiri-twirl-9x16')).first).toEqual({ keyframe: 'eimi-v11-gown-9x16' });
    // うんぱい: the empty alley (her night loop, where the scene cut to) → she runs in → the headphones.
    expect(anchorsOf(shot('unpai-scene-private-stream-run-9x16')).first).toEqual({ still: 'unpai-v11-alley-9x16' });
    expect(anchorsOf(shot('unpai-scene-private-stream-headphones-9x16')).first).toEqual(anchorsOf(shot('unpai-scene-private-stream-run-9x16')).last);
    expect(SCENE_V11_SHOTS.map(presenceOf).filter((p) => p !== 'on')).toEqual(['empty', 'empty', 'enters', 'exits', 'empty', 'enters', 'exits', 'empty', 'empty', 'exits', 'empty']);
    // うんぱい now runs out of the frame before the empty alley, as the storyboard has it.
    expect(anchorsOf(shot('unpai-scene-private-stream-leave-9x16')).first).toEqual({ keyframe: v1('unpai') });
  });

  it('loops every shot the scene waits on, on one still', () => {
    for (const s of SCENE_V11_SHOTS.filter((x) => x.loop)) expect(JSON.stringify(anchorsOf(s).first), s.id).toBe(JSON.stringify(anchorsOf(s).last));
  });

  it('never describes her hair or outfit in words: her look comes from the v1 frame (the #79 まひろ drifted to wavy hair)', () => {
    const hair = /\b(bob|wavy|waves|curls?|burgundy|wine-red|jet-black|caramel|shoulder-length|chin-length)\b/i;
    for (const s of SCENE_V11_SHOTS) expect(s.prompt, s.id).not.toMatch(hair);
    for (const k of SCENE_V11_KEYFRAMES.filter((x) => x.person)) {
      expect(k.brief, k.name).not.toMatch(/\b(bob|wavy|waves|burgundy|jet-black|caramel)\b/i);
      expect(personPrompt(k), k.name).toMatch(/Keep her hair exactly as in reference image 2/);
      // Every still of her is made from her v1 frame or from a still made from it.
      const root = k.ratio === '16:9' ? v1w(k.star) : v1(k.star);
      let from = k.from;
      for (let i = 0; i < 3 && from !== root; i++) from = SCENE_V11_KEYFRAMES.find((x) => x.name === from)!.from;
      expect(from, k.name).toBe(root);
    }
  });

  it('keeps the tone: clothed, no emotional cues Seedance plays as eyes-closed smiles, no people in the empty shots', () => {
    const cues = /happy|glad|delighted|blissful|eyes smile|glances? down|looks? down|loving|shy smile warms/i;
    const bare = /\b(camisole|strap|strapless|off-the-shoulder|bare shoulders?|cleavage|slit|lingerie|nude|naked)\b/i;
    for (const s of SCENE_V11_SHOTS) {
      expect(s.prompt, s.id).not.toMatch(cues);
      expect(s.prompt, s.id).not.toMatch(bare);
      if (s.category !== 'character') expect(s.prompt, s.id).toMatch(/no people/i);
      if (s.category !== 'character') expect(hasPerson(anchorsOf(s).first), s.id).toBe(false);
    }
    for (const k of SCENE_V11_KEYFRAMES) expect(`${k.brief} ${k.wearing ?? ''}`, k.name).not.toMatch(bare);
    for (const k of SCENE_V11_KEYFRAMES.filter((x) => !x.person && !x.extract)) expect(stillPrompt(k)).toMatch(/No people at all/);
  });

  it('has 16:9 versions of the wide shots, chained like the 9:16 ones', () => {
    expect(SCENE_V11_WIDE_SHOTS.map((s) => s.id).sort()).toEqual([
      'alice-scene-night-greenhouse-flowers-16x9', 'eimi-scene-ogiri-empty-16x9', 'eimi-scene-ogiri-leave-16x9', 'eimi-scene-ogiri-return-16x9',
      'mahiro-scene-welcome-home-cup-16x9', 'unpai-scene-private-stream-leave-16x9', 'unpai-scene-private-stream-run-16x9'
    ]);
    for (const s of SCENE_V11_WIDE_SHOTS) {
      expect([s.ratio, s.resolution, s.encode], s.id).toEqual(['16:9', '1080p', 'hq']);
      // The same action as its 9:16 twin, and 9:16 stills never open or close a 16:9 clip. うんぱい's run is the one
      // exception: its 16:9 stills do not share a camera, so the camera travels instead of cutting (RUN_16X9_CAMERA).
      const twin = shot(s.id.replace(/-16x9$/, '-9x16')).prompt;
      if (s.id === 'unpai-scene-private-stream-run-16x9') {
        expect(s.prompt).toContain(RUN_16X9_CAMERA);
        expect(s.prompt).not.toMatch(/camera never moves|Locked-off/);
        expect(s.prompt.split('\n').slice(1, -2)).toEqual(twin.split('\n').slice(1, -2));
      } else expect(s.prompt, s.id).toBe(twin);
      for (const a of Object.values(anchorsOf(s))) if (a && !('rendered' in a)) expect(JSON.stringify(a), s.id).not.toMatch(/9x16/);
    }
    expect(anchorsOf(shot('eimi-scene-ogiri-return-16x9'))).toEqual({ first: { rendered: 'eimi-scene-ogiri-leave-16x9' }, last: { keyframe: 'eimi-v11-gown-16x9' } });
  });
});

describe('her everyday clips (#80 full scope): mornings, seated base loops, close talking loop', () => {
  const STARS = ['mahiro', 'nana', 'unpai', 'alice', 'eimi'] as const;

  it('makes the morning, idle and talking loops for all five, locked on one still, encoded hq', () => {
    expect(HOME_V11_SHOTS.map((s) => s.id).sort()).toEqual(STARS.flatMap((s) => [
      `${s}-hero-morning-16x9`, `${s}-hero-morning-9x16`, `${s}-idle-16x9`, `${s}-idle-9x16`, `${s}-talk-16x9`, `${s}-talk-9x16`, `${s}-talkclose-9x16`
    ]).sort());
    for (const s of HOME_V11_SHOTS) {
      expect([s.loop, s.xfade, s.duration, s.encode, s.resolution], s.id).toEqual([true, 0, 8, 'hq', '1080p']);
      expect(JSON.stringify(anchorsOf(s).first), s.id).toBe(JSON.stringify(anchorsOf(s).last));
    }
    expect(validate(SHOTS)).toEqual([]);
  });

  it('locks idle and talk to her v1 hero frame (the scenes\' wide shot), and the close talk to the keyframe her breathing loop opens on', () => {
    for (const star of STARS) {
      expect(anchorsOf(shot(`${star}-idle-9x16`)).first).toEqual({ keyframe: v1(star) });
      expect(anchorsOf(shot(`${star}-talk-16x9`)).first).toEqual({ keyframe: v1w(star) });
      expect(anchorsOf(shot(`${star}-talkclose-9x16`)).first).toEqual({ keyframe: `${star}-breath-9x16` });
      // Lips move only in the talking loops; the rest keep her closed-mouth look.
      expect(shot(`${star}-talk-9x16`).prompt).toMatch(/lips move/);
      for (const id of [`${star}-idle-9x16`, `${star}-hero-morning-9x16`]) expect(shot(id).prompt, id).toMatch(/She does not speak/);
    }
  });

  it('keeps the morning actions away from what Seedance plays as eyes-closed smiles (media:check, 2026-09-29)', () => {
    // アリス no longer sips her tea; えいみ's 16:9 loop has no smile cue while she turns the bottle (her 9:16 one keeps it).
    for (const r of ['9x16', '16x9']) expect(shot(`alice-hero-morning-${r}`).prompt).toMatch(/without drinking/);
    expect(shot('eimi-hero-morning-16x9').prompt).not.toMatch(/confident closed-mouth smile/);
    expect(shot('eimi-hero-morning-9x16').prompt).toMatch(/confident closed-mouth smile/);
    for (const r of ['9x16', '16x9']) expect(shot(`nana-hero-morning-${r}`).retimeMax).toBe(0.45);
    expect(shot('mahiro-hero-morning-9x16').retimeMax).toBeUndefined();
  });

  it('builds each morning room as a people-free set from her published morning room, then puts her in it from her v1 frame', () => {
    for (const star of STARS) {
      for (const r of ['9x16', '16x9'] as const) {
        const room = HOME_V11_KEYFRAMES.find((k) => k.name === `${star}-v11-morningroom-${r}`)!;
        const her = HOME_V11_KEYFRAMES.find((k) => k.name === `${star}-v11-morning-${r}`)!;
        expect(room.person, room.name).toBe(false);
        expect(stillPrompt(room)).toMatch(/No people at all/);
        expect([her.person, her.from, her.camera], her.name).toEqual([true, r === '9x16' ? v1(star) : v1w(star), room.name]);
        expect(personPrompt(her), her.name).toMatch(/she is now in a different place/);
      }
      expect(HOME_V11_KEYFRAMES.find((k) => k.name === `${star}-v11-morningroom-9x16`)!.from).toBe(`${star}-morning-9x16-poster`);
    }
  });
});

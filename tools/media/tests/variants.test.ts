import { describe, expect, it } from 'vitest';
import { variantDef } from '../../../packages/shared/src/catalog';
import { VARIANT_CARDS } from '../../../packages/shared/src/rules';
import { SHOTS, STARS, anchorsOf, presenceOf, validate } from '../src/manifest';
import { VARIANT_KEYFRAMES, VARIANT_LOOKS, VARIANT_SHOTS, variantStill } from '../src/shots/variants-v11';
import { closePrompt, home16Prompt, homePrompt } from '../src/variant-keyframes';

describe('variant-card clips (#81)', () => {
  it('makes the clips the app looks up for every variant card: all three in portrait, the home idle also in landscape', () => {
    for (const star of STARS) {
      const d = variantDef(star);
      for (const base of [d.enterClip, d.closeClip, d.homeVideo]) expect(SHOTS.map((s) => s.id), base).toContain(`${base}-9x16`);
      expect(SHOTS.map((s) => s.id)).toContain(`${d.homeVideo}-16x9`);
    }
    expect(VARIANT_SHOTS).toHaveLength(20);
    expect(VARIANT_SHOTS.every((s) => s.encode === 'hq' && (!s.loop || s.xfade === 0))).toBe(true);
    expect(VARIANT_LOOKS.map((v) => v.card).sort()).toEqual([...VARIANT_CARDS].sort());
    expect(validate(SHOTS)).toEqual([]);
  });
  it('walks in from her empty night room onto the still the home loop is locked to', () => {
    for (const star of STARS) {
      const enter = SHOTS.find((s) => s.id === `${star}-variant-enter-9x16`)!, home = SHOTS.find((s) => s.id === `${star}-variant-home-9x16`)!, close = SHOTS.find((s) => s.id === `${star}-variant-close-9x16`)!;
      expect(anchorsOf(enter)).toEqual({ first: { still: variantStill.room(star) }, last: { keyframe: variantStill.home(star) } });
      expect(anchorsOf(home)).toEqual({ first: { keyframe: variantStill.home(star) }, last: { keyframe: variantStill.home(star) } });
      expect(anchorsOf(close)).toEqual({ first: { keyframe: variantStill.close(star) }, last: { keyframe: variantStill.close(star) } });
      expect([enter, close, home].map(presenceOf)).toEqual(['enters', 'on', 'on']);
      expect(home.loop && close.loop && !enter.loop).toBe(true);
      const wide = SHOTS.find((s) => s.id === `${star}-variant-home-16x9`)!;
      expect(wide.ratio).toBe('16:9');
      expect(anchorsOf(wide)).toEqual({ first: { keyframe: variantStill.home16(star) }, last: { keyframe: variantStill.home16(star) } });
      expect(wide.prompt).toBe(home.prompt);
      expect(VARIANT_KEYFRAMES.find((k) => k.name === variantStill.room16(star))).toMatchObject({ ratio: '16:9', person: false, from: `${star}-night-16x9` });
    }
  });
  it('keeps emotional cues out and the outfits clothed', () => {
    const bare = /\b(camisole|strap|strapless|off-the-shoulder|bare shoulders?|cleavage|slit|swimsuit|lingerie|see-through)\b/i;
    for (const s of VARIANT_SHOTS) expect(s.prompt, s.id).not.toMatch(/happy|glad|delighted|blissful|eyes smile|excited|shy|loving|glances? down/i);
    for (const v of VARIANT_LOOKS) expect(`${v.outfit} ${v.prop}`, v.star).not.toMatch(bare);
    for (const k of VARIANT_KEYFRAMES) expect(k.wearing ?? '', k.name).not.toMatch(bare);
  });
  it('takes her face and hair from the v1 hero, the outfit from the card, the room as the base picture', () => {
    const v = VARIANT_LOOKS.find((x) => x.star === 'nana')!;
    const home = homePrompt(v), close = closePrompt(v, ['eyes smaller']);
    expect(home).toMatch(/Reference image 3 is the base picture/);
    expect(home).toMatch(/reference image 2 shows the outfit/i);
    expect(home).toContain(v.hair);
    expect(home).toMatch(/glasses as in reference image 1\./);
    expect(close).toMatch(/Reference image 2 is the base picture/);
    expect(close).toMatch(/Corrections from the previous attempt \(fix these\): eyes smaller/);
    const wide = home16Prompt(v);
    expect(wide).toMatch(/Horizontal 16:9 frame/);
    expect(wide).toMatch(/Reference image 3 is the base picture/);
    expect(wide).toMatch(/Reference image 4 is a photograph of this same woman in this same outfit/);
    expect(wide).toMatch(/horizontal centre of the frame/);
    expect(wide).not.toContain(v.roomNote!); // the 9:16 room note names furniture where the 9:16 frame has it
  });
});

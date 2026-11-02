import { describe, expect, it } from 'vitest';
import { BANNED, build } from '../src/catalog';
import { MOMENT_OVERRIDE, NO_GO, PILOT, QUALITY, allSpecs, homeMoment, promptV2 } from '../src/cards-v2';
import { PACK_PHOTOS, SETS } from '../src/cards-v2-pack';

describe('card art v2 (the pack as set and light reference, never its poses)', () => {
  it('the pilot is the five UR variant cards, one per talent, each tied to a UR photo of the pack', async () => {
    const cards = await build();
    expect(PILOT.map((s) => s.id).sort()).toEqual(cards.filter((c) => c.tier === 'UR').map((c) => c.id).sort());
    for (const s of PILOT) {
      expect(s.ref.tier).toBe('UR');
      expect(s.ref.file).toMatch(/^20260925_レタッチ済カード\/➂UR\/【UR】.+\.jpg$/);
      expect(s.poseNote).toMatch(/^pack pose not used: /);
    }
  });

  it('what is asked for never names anything on the no-go list, and every prompt forbids the whole list', async () => {
    const cards = await build();
    for (const s of PILOT) {
      const asked = [s.set, s.light, s.framing, s.styling ?? '', s.pose, s.outfit, s.prop ?? ''].join(' ');
      expect(asked).not.toMatch(BANNED);
      expect(asked).not.toMatch(/\b(kneel|crouch|lying|recline|lingerie|stocking|bare|off-shoulder|strapless|maid|bunny|choker)/i);
      const p = promptV2(cards.find((c) => c.id === s.id)!, s, 5);
      for (const n of NO_GO) expect(p).toContain(n);
      expect(p).toContain('Fully and modestly clothed');
      expect(p).not.toMatch(/Mahiro|Nana|Unpai|Alice|Eimi/);
    }
  });

  it('all 150 cards map to a pack photo of the same talent and tier, and the catalog cards keep their moment', async () => {
    const cards = await build();
    const specs = await allSpecs();
    expect(specs.map((s) => s.id).sort()).toEqual(cards.map((c) => c.id).sort());
    expect(specs.slice(0, 5).map((s) => s.id.endsWith('-30'))).toEqual([true, true, true, true, true]);
    expect(PACK_PHOTOS).toHaveLength(110);
    for (const s of specs.filter((x) => x.moment)) {
      const c = cards.find((x) => x.id === s.id)!;
      const p = PACK_PHOTOS.find((x) => x.file === s.ref.file)!;
      expect(p.star).toBe(c.star);
      expect(p.tier).toBe(c.tier);
      expect(SETS[p.set]).toBeDefined();
      const asked = [s.moment, s.set, s.light, s.styling ?? ''].join(' ');
      expect(asked).not.toMatch(BANNED);
      expect(asked).not.toMatch(/\b(lying|lies|curled|kneel|crouch|reclin|lingerie|stocking|maid|bunny|choker)/i);
      for (const n of NO_GO) expect(promptV2(c, s, 5)).toContain(n);
    }
    for (const t of ['UR', 'SSR', 'SR'] as const) expect(QUALITY[t]).toBe('high');
  });

  it('only home moments borrow a pack set for her room; cafés, hotels and balconies keep their place', () => {
    expect(homeMoment(MOMENT_OVERRIDE['s1-mahiro-28'])).toBe(true);
    expect(homeMoment('Mahiro at a café window seat on a rainy afternoon')).toBe(false);
    expect(homeMoment('Eimi in a velvet armchair in a hotel suite at night')).toBe(false);
    expect(homeMoment('Mahiro hanging white sheets on a sunny apartment balcony')).toBe(false);
  });

  it('the variant cards keep the #81 outfits the variant clips show', () => {
    const outfit = Object.fromEntries(PILOT.map((s) => [s.id, s.outfit]));
    expect(outfit['s1-mahiro-30']).toMatch(/cream cable-knit cardigan/);
    expect(outfit['s1-nana-30']).toMatch(/lavender knit top/);
    expect(outfit['s1-unpai-30']).toMatch(/navy varsity jacket with rose-pink sleeves/);
    expect(outfit['s1-alice-30']).toMatch(/white lace blouse with a high neck/);
    expect(outfit['s1-eimi-30']).toMatch(/rose satin evening gown/);
  });
});

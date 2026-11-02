import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { CATALOG, CATALOG_BY_ID, catalogProblems } from '../src/catalog';
import {
  POOL_IDS, RULES, STAR_IDS, VARIANT_CARDS, VARIANT_RULES, disclosure, drawLucky, drawPulls, duplicateGain, isExchangeable,
  isVariantCard, nextLayer, poolCards, seeded, unlockedLayers, variantGain, variantLevel, variantLevelOf, variantProgress, variantState
} from '../src';
import { zSceneId } from '../src/scenes/schema';

const sha = (v: unknown) => createHash('sha256').update(JSON.stringify(v)).digest('hex');

describe('variant cards (#75)', () => {
  it('provisional selection (#84 decides): one per talent, each her only UR, carried by the catalogue', () => {
    expect(VARIANT_CARDS).toHaveLength(STAR_IDS.length);
    for (const star of STAR_IDS) {
      const mine = VARIANT_CARDS.map((id) => CATALOG_BY_ID[id]).filter((c) => c.star === star);
      expect(mine, star).toHaveLength(1);
      expect(mine[0].rarity).toBe('UR');
      expect(mine[0].id).toBe(CATALOG.find((c) => c.star === star && c.rarity === 'UR')!.id);
    }
    expect(CATALOG.filter((c) => c.variant).map((c) => c.id).sort()).toEqual([...VARIANT_CARDS].sort());
    expect(catalogProblems()).toEqual([]);
  });

  it('every variant has its scenes by level and valid ids for scripts and media', () => {
    for (const id of VARIANT_CARDS) {
      const v = CATALOG_BY_ID[id].variant!;
      expect(v.layers.map((l) => l.level)).toEqual([1, 3, 6, 10]);
      expect(v.scene).toBe(v.layers[0].scene);
      for (const s of [v.scene, ...v.layers.map((l) => l.scene)]) expect(zSceneId.safeParse(s).success, s).toBe(true);
      for (const m of [v.enterClip, v.closeClip, v.homeVideo]) expect(m).toMatch(/^[a-z0-9-]{3,80}$/);
    }
  });

  it('the structural check catches a bad selection', () => {
    expect(catalogProblems(CATALOG, [...VARIANT_CARDS, 's1-nope-01'])).toContain('variant s1-nope-01: no such card');
    expect(catalogProblems(CATALOG, ['s1-mahiro-30'])).toContain('variant s1-nana-30: not selected');
    const twice = CATALOG.map((c) => (c.id === 's1-mahiro-29' ? { ...c, variant: CATALOG_BY_ID['s1-mahiro-30'].variant } : c));
    expect(catalogProblems(twice, [...VARIANT_CARDS, 's1-mahiro-29'])).toContain('mahiro variants: 2 (want at most 1)');
    expect(catalogProblems(CATALOG.map(({ variant: _v, ...c }) => c), [])).toEqual([]);
  });

  it('levels 1 / 3 / 6 / 10 start at 0 / 100 / 400 / 1000 XP and open the four layers', () => {
    expect([0, 100, 400, 1000].map(variantLevel)).toEqual([1, 3, 6, 10]);
    expect([99, 399, 999, 5000].map(variantLevel)).toEqual([2, 5, 9, 10]);
    for (let xp = 1; xp < 1200; xp++) expect(variantLevel(xp)).toBeGreaterThanOrEqual(variantLevel(xp - 1));
    expect(unlockedLayers(1)).toEqual([1]);
    expect(unlockedLayers(5)).toEqual([1, 3]);
    expect(unlockedLayers(10)).toEqual([1, 3, 6, 10]);
    expect([nextLayer(1), nextLayer(3), nextLayer(9), nextLayer(10)]).toEqual([3, 6, 10, null]);
    expect(variantProgress(75)).toBeCloseTo(0.5);
    expect(variantProgress(1000)).toBe(1);
  });

  it('a level once reached stays, so a raised threshold never closes an open layer', () => {
    expect(variantLevelOf(120, 6)).toBe(6);
    expect(variantState({ xp: 120, level: 6, kokoro: 100 })).toMatchObject({ level: 6, layers: [1, 3, 6], nextLayer: 10, progress: 0 });
    expect(variantState(null)).toEqual({ level: 1, xp: 0, kokoro: 0, progress: 0, layers: [1], nextLayer: 3, pinned: false });
  });

  it('a duplicate is 心意 +100 as variant XP; half of any variant XP also counts for the main relationship', () => {
    expect(duplicateGain()).toEqual({ xp: 100, kokoro: 100, mainXp: 50 });
    expect(variantGain(VARIANT_RULES.sceneEndXp)).toEqual({ xp: 30, kokoro: 0, mainXp: 15 });
    expect(variantGain(7)).toEqual({ xp: 7, kokoro: 0, mainXp: 3 });
    // The main share is XP and nothing else: the stage machine (#54) gates stages by days, which no gain carries.
    expect(Object.keys(variantGain(1000)).sort()).toEqual(['kokoro', 'mainXp', 'xp']);
  });

  it('the shard exchange offers any SSR and the variant cards, nothing else', () => {
    const offered = CATALOG.filter(isExchangeable);
    expect(offered.filter((c) => c.rarity !== 'SSR').map((c) => c.id).sort()).toEqual([...VARIANT_CARDS].sort());
    expect(offered.filter((c) => c.rarity === 'SSR')).toHaveLength(20);
    expect(isVariantCard('s1-eimi-30')).toBe(true);
    expect(isVariantCard('s1-eimi-29')).toBe(false);
  });
});

/**
 * Compliance (docs/compliance-jp.md §3): variants must not change a published rate or a replayed draw. The fingerprints
 * below were taken on release/v1.1 before the variant model existed; the same seeds must still give the same cards.
 */
describe('variants leave the draws alone', () => {
  it('the published rates are unchanged, and a variant is drawn at the per-card rate of its tier', () => {
    const rates = POOL_IDS.map((id) => ({ id, ...disclosure(poolCards(id, CATALOG)) }));
    expect(sha(rates)).toBe('6469b23cb0c7846c5ab83cf4eb312de0433a7a830438a091828ba4129b099cf0');
    expect(disclosure(CATALOG).rows.find((r) => r.tier === 'UR')).toMatchObject({ rate: RULES.rates.UR, cards: 5, perCard: RULES.rates.UR / 5 });
  });

  it('the same seeds replay the same draws as before variants', () => {
    const draws = POOL_IDS.flatMap((pool) => Array.from({ length: 300 }, (_, s) => {
      const r = drawPulls(s % 2 ? 10 : 1, poolCards(pool, CATALOG), seeded(s), s % 80);
      return [r.drawn.map((d) => `${d.tier}:${d.card.id}`), r.pity];
    }));
    const lucky = Array.from({ length: 300 }, (_, s) => drawLucky(CATALOG, seeded(s)).map((d) => `${d.tier}:${d.card.id}`));
    expect(sha(draws)).toBe('25540998873031bcb7e0102414a990d33fc70a558ae76ed2a3914341f77a6854');
    expect(sha(lucky)).toBe('3a12d0ee20b9001d02ea659b3cbf18c69606ed7174f0f6f8d8647b72bd4a09c6');
    expect(drawLucky(CATALOG, seeded(42)).map((d) => d.card.id)).toEqual(['s1-unpai-20', 's1-alice-21', 's1-unpai-07', 's1-alice-02', 's1-unpai-21', 's1-eimi-05']);
  });

  it('over many draws, the variants come out at the UR per-card rate', () => {
    const rng = seeded(75);
    let hits = 0;
    const n = 400_000;
    for (let i = 0; i < n / 10; i++) for (const d of drawPulls(10, CATALOG, rng).drawn) if (isVariantCard(d.card.id)) hits++;
    // Pity and the ten-pull guarantee lift UR a little above the base rate; the variants are all five URs.
    expect(hits / n).toBeGreaterThan(RULES.rates.UR * 0.9);
    expect(hits / n).toBeLessThan(RULES.rates.UR * 1.4);
  });
});

import { describe, expect, it } from 'vitest';
import { RARITIES, type Rarity } from '../src/domain';
import { drawPulls, poolCards, seeded, tierCounts } from '../src/gacha';
import { CATALOG } from '../src/catalog';

describe('tierCounts (H1: a draw summary counts every tier)', () => {
  it('counts UR and N too, rarest first, and adds up to the cards drawn', () => {
    const ten: Rarity[] = ['N', 'R', 'UR', 'N', 'SR', 'N', 'R', 'N', 'N', 'N'];
    expect(tierCounts(ten)).toEqual({ total: 10, tiers: [{ tier: 'UR', n: 1 }, { tier: 'SR', n: 1 }, { tier: 'R', n: 2 }, { tier: 'N', n: 6 }] });
    expect(tierCounts([])).toEqual({ total: 0, tiers: [] });
    expect(tierCounts(['SSR']).tiers).toEqual([{ tier: 'SSR', n: 1 }]);
  });
  it('always sums to the total for real draws', () => {
    const rng = seeded(3);
    for (let i = 0; i < 300; i++) {
      const { drawn } = drawPulls(10, poolCards('all', CATALOG), rng, i % 80);
      const c = tierCounts(drawn.map((d) => d.card.rarity));
      expect(c.tiers.reduce((n, x) => n + x.n, 0)).toBe(10);
      expect(c.tiers.map((x) => x.tier)).toEqual(RARITIES.filter((r) => c.tiers.some((x) => x.tier === r)).reverse());
    }
  });
});

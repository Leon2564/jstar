import { describe, expect, it } from 'vitest';
import { pickCard, rollTier } from '@jstar/shared/gacha';
import { pull, seeded } from '../../src/lib/gacha';
import { CARDS, RARITIES, RARITY_ORDER } from '../../src/data/cards';
import { CONFIG } from '../../src/lib/config';

describe('gacha (Star Genesis, five tiers)', () => {
  it('tier distribution matches the published rates (±0.5pt over 200k rolls)', () => {
    const rng = seeded(42);
    const n = 200_000;
    const c: Record<string, number> = {};
    for (let i = 0; i < n; i++) { const t = rollTier(rng); c[t] = (c[t] ?? 0) + 1; }
    for (const t of RARITIES) expect(Math.abs((c[t] ?? 0) / n - CONFIG.rates[t])).toBeLessThan(0.005);
  });
  it('every ten-pull contains at least one SR or better', () => {
    const rng = seeded(7);
    for (let i = 0; i < 3000; i++) {
      const { drawn } = pull(10, 0, 'all', rng);
      expect(drawn).toHaveLength(10);
      expect(drawn.some((d) => RARITY_ORDER[d.card.rarity] >= RARITY_ORDER.SR)).toBe(true);
    }
  });
  it('the pity pull is SSR or better and resets the counter', () => {
    const rng = seeded(9);
    for (let i = 0; i < 500; i++) {
      const { drawn, pity } = pull(1, CONFIG.pityPulls - 1, 'all', rng);
      expect(RARITY_ORDER[drawn[0].card.rarity]).toBeGreaterThanOrEqual(RARITY_ORDER.SSR);
      expect(pity).toBe(0);
    }
  });
  it('a single-talent pool only returns her cards', () => {
    const rng = seeded(5);
    for (let i = 0; i < 300; i++) expect(pull(10, 0, 'star:alice', rng).drawn.every((d) => d.card.star === 'alice')).toBe(true);
  });
  it('picked card always has the requested tier, and survives an RNG at the boundary', () => {
    const rng = seeded(3);
    for (const r of RARITIES) for (let i = 0; i < 100; i++) expect(pickCard(r, rng, CARDS).rarity).toBe(r);
    expect(() => pickCard('N', () => 0.9999999, CARDS)).not.toThrow();
  });
});

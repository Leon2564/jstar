import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { CATALOG } from '../src/catalog';
import {
  DrawReq, EVENT_PROPS, GachaRatesRes, PICKUP_RULES, POOL_IDS, RARITIES, RULES, STAR_IDS, VARIANT_CARDS, disclosure, drawPickupPulls,
  drawPulls, isPickupPoolId, pickupCardOf, pickupCardRates, pickupDisclosure, pickupLive, pickupPoolId, pickupProblems, poolCards, seeded
} from '../src';

/**
 * Pickup pools (#78). Compliance (docs/compliance-jp.md §3): the regular pools' published rates and replayed draws
 * must not move — the fingerprints are the ones taken before variants existed (variants.test.ts) — and a Pickup's
 * rates are computed from its config, add up to exactly 1 and match what the draw function really gives.
 */
const sha = (v: unknown) => createHash('sha256').update(JSON.stringify(v)).digest('hex');
const her = (star: string) => poolCards(`star:${star}` as never, CATALOG);
const eimi = her('eimi');
const odds = { cardId: 's1-eimi-30', share: PICKUP_RULES.share };

describe('the regular pools are untouched by Pickups', () => {
  it('same published rates and same replayed draws as before', () => {
    const rates = POOL_IDS.map((id) => ({ id, ...disclosure(poolCards(id, CATALOG)) }));
    expect(sha(rates)).toBe('6469b23cb0c7846c5ab83cf4eb312de0433a7a830438a091828ba4129b099cf0');
    const draws = POOL_IDS.flatMap((pool) => Array.from({ length: 300 }, (_, s) => {
      const r = drawPulls(s % 2 ? 10 : 1, poolCards(pool, CATALOG), seeded(s), s % 80);
      return [r.drawn.map((d) => `${d.tier}:${d.card.id}`), r.pity];
    }));
    expect(sha(draws)).toBe('25540998873031bcb7e0102414a990d33fc70a558ae76ed2a3914341f77a6854');
  });
});

describe('Pickup odds (#78)', () => {
  it('ratio 待确认 in rules.ts: the variant takes half of SSR-or-better, and every variant can be picked up', () => {
    expect(PICKUP_RULES.share).toBe(0.5);
    for (const id of VARIANT_CARDS) {
      const card = CATALOG.find((c) => c.id === id)!;
      expect(pickupProblems(her(card.star), { cardId: id, share: PICKUP_RULES.share }), id).toEqual([]);
    }
  });

  it('computed from config: every card rate adds up to exactly 1, and SSR-or-better (so the pity) is unchanged', () => {
    for (const star of STAR_IDS) {
      const cards = her(star);
      const byCard = pickupCardRates(cards, { cardId: `s1-${star}-30`, share: PICKUP_RULES.share });
      const sum = [...byCard.values()].reduce((n, r) => n + r, 0);
      expect(Math.abs(sum - 1)).toBeLessThan(1e-12);
      const d = pickupDisclosure(cards, { cardId: `s1-${star}-30`, share: PICKUP_RULES.share });
      expect(Math.abs(d.rows.reduce((n, r) => n + r.rate, 0) - 1)).toBeLessThan(1e-12);
      const top = d.rows.filter((r) => r.tier === 'SSR' || r.tier === 'UR').reduce((n, r) => n + r.rate, 0);
      expect(top).toBeCloseTo(RULES.rates.SSR + RULES.rates.UR, 12);
      expect(d.effectiveTopRate).toBe(disclosure(cards).effectiveTopRate);
      // Below SSR, exactly her regular pool.
      for (const tier of ['N', 'R', 'SR'] as const) expect(d.rows.find((r) => r.tier === tier)).toEqual(disclosure(cards).rows.find((r) => r.tier === tier));
    }
  });

  it('publishes the boosted rate beside the regular one, in round numbers that add up on the page', () => {
    const d = pickupDisclosure(eimi, odds);
    expect(d.pickup).toMatchObject({ cardId: 's1-eimi-30', tier: 'UR', share: 0.5 });
    expect(d.pickup.rate).toBeCloseTo(0.025, 12);
    expect(d.pickup.baseRate).toBeCloseTo(0.005, 12);
    expect(d.pickup.effectiveRate).toBeCloseTo(0.5 * disclosure(eimi).effectiveTopRate, 12);
    const ssr = d.rows.find((r) => r.tier === 'SSR')!;
    expect(ssr.rate).toBeCloseTo(0.025, 12);
    expect(ssr.perCard * ssr.cards).toBeCloseTo(ssr.rate, 12);
    // Tier rows, as shown (percent, 3 decimals), add up to 100 exactly.
    const shown = d.rows.map((r) => Math.round(r.rate * 100000));
    expect(shown.reduce((n, x) => n + x, 0)).toBe(100000);
  });

  it('refuses what would not be a boost, a card outside the pool, a card below SSR, or a share with no room for the others', () => {
    expect(pickupProblems(eimi, { cardId: 's1-mahiro-30', share: 0.5 })).toEqual(['not_in_pool']);
    expect(pickupProblems(eimi, { cardId: 's1-eimi-01', share: 0.5 })).toContain('not_top');
    expect(pickupProblems(eimi, { cardId: 's1-eimi-30', share: 0.05 })).toContain('no_boost');
    expect(pickupProblems(eimi, { cardId: 's1-eimi-30', share: 0 })).toContain('bad_share');
    expect(pickupProblems(eimi, { cardId: 's1-eimi-30', share: 1.2 })).toContain('bad_share');
    expect(pickupProblems(eimi.filter((c) => c.rarity !== 'SSR'), { cardId: 's1-eimi-30', share: 0.5 })).toContain('no_others');
    expect(() => drawPickupPulls(1, eimi, { cardId: 's1-eimi-30', share: 0.05 }, seeded(1))).toThrow(/invalid_pickup/);
  });

  it('draws are reproducible from the seed, and the ten-pull guarantee and pity hold', () => {
    const run = (s: number) => drawPickupPulls(10, eimi, odds, seeded(s), s % 80).drawn.map((d) => `${d.tier}:${d.card.id}`);
    for (let s = 0; s < 50; s++) expect(run(s)).toEqual(run(s));
    expect(sha(Array.from({ length: 200 }, (_, s) => run(s)))).toBe(sha(Array.from({ length: 200 }, (_, s) => run(s))));
    for (let s = 0; s < 300; s++) {
      const r = drawPickupPulls(10, eimi, odds, seeded(s));
      expect(r.drawn.some((d) => d.tier === 'SR' || d.tier === 'SSR' || d.tier === 'UR')).toBe(true);
      expect(r.drawn.every((d) => d.card.star === 'eimi' && d.tier === d.card.rarity)).toBe(true);
    }
    const atPity = drawPickupPulls(1, eimi, odds, seeded(9), RULES.pityPulls - 1);
    expect(['SSR', 'UR']).toContain(atPity.drawn[0].tier);
    expect(atPity.pity).toBe(0);
  });

  it('100,000 draws land on the published rates (±0.5 points, and the picked-up card within 5% of its rate)', () => {
    const d = pickupDisclosure(eimi, odds);
    const rng = seeded(78);
    const n = 100_000;
    const byTier: Record<string, number> = {};
    let picked = 0;
    // A fresh pity counter each pull: the table is per pull, before pity (pity is published separately).
    for (let i = 0; i < n; i++) {
      const [x] = drawPickupPulls(1, eimi, odds, rng, 0).drawn;
      byTier[x.tier] = (byTier[x.tier] ?? 0) + 1;
      if (x.card.id === odds.cardId) picked++;
    }
    for (const row of d.rows) expect(Math.abs((byTier[row.tier] ?? 0) / n - row.rate), row.tier).toBeLessThan(0.005);
    expect(Math.abs(picked / n - d.pickup.rate)).toBeLessThan(0.005);
    expect(Math.abs(picked / n / d.pickup.rate - 1)).toBeLessThan(0.05);
  });

  it('with pity, the picked-up card comes at its published effective rate', () => {
    const d = pickupDisclosure(eimi, odds);
    const rng = seeded(80);
    let pity = 0;
    let picked = 0;
    const n = 200_000;
    for (let i = 0; i < n; i++) {
      const r = drawPickupPulls(1, eimi, odds, rng, pity);
      pity = r.pity;
      if (r.drawn[0].card.id === odds.cardId) picked++;
    }
    expect(Math.abs(picked / n - d.pickup.effectiveRate)).toBeLessThan(0.005);
  });
});

describe('Pickup ids, windows and contracts', () => {
  it('the id names the card and its JST start day', () => {
    const id = pickupPoolId('s1-eimi-30', '2026-09-30T15:00:00.000Z');
    expect(id).toBe('pickup:s1-eimi-30:20261001');
    expect(isPickupPoolId(id)).toBe(true);
    expect(pickupCardOf(id)).toBe('s1-eimi-30');
    for (const bad of ['pickup:', 'pickup:s1-eimi-30', 'star:eimi', 'pickup:S1:20261001', 'pickup:x:2026101']) expect(isPickupPoolId(bad), bad).toBe(false);
  });

  it('is live from its start (inclusive) to its end (exclusive)', () => {
    const p = { startsAt: '2026-10-01T00:00:00+09:00', endsAt: '2026-10-15T00:00:00+09:00' };
    expect(pickupLive(p, Date.parse('2026-09-30T14:59:59Z'))).toBe(false);
    expect(pickupLive(p, Date.parse('2026-09-30T15:00:00Z'))).toBe(true);
    expect(pickupLive(p, Date.parse('2026-10-14T14:59:59Z'))).toBe(true);
    expect(pickupLive(p, Date.parse('2026-10-14T15:00:00Z'))).toBe(false);
  });

  it('a draw may name a Pickup; the rates response carries Pickups beside the regular pools; events stay strict', () => {
    expect(DrawReq.parse({ pool: 'pickup:s1-eimi-30:20261001', count: 10 }).pool).toBe('pickup:s1-eimi-30:20261001');
    expect(DrawReq.parse({ pool: 'all', count: 6 }).count).toBe(6);
    expect(() => DrawReq.parse({ pool: 'pickup:../x', count: 1 })).toThrow();
    const cards = eimi;
    const pools = POOL_IDS.map((id) => ({ id, ...disclosure(poolCards(id, CATALOG)) }));
    const pickups = [{ id: 'pickup:s1-eimi-30:20261001', star: 'eimi', cardId: 's1-eimi-30', startsAt: 'a', endsAt: 'b', live: true, ...pickupDisclosure(cards, odds) }];
    expect(() => GachaRatesRes.parse({ pools, pickups, shardsForExchange: RULES.shardsForExchange })).not.toThrow();
    expect(() => EVENT_PROPS['variant.prompted'].parse({ star: 'eimi', cardId: 's1-eimi-30', via: 'invite' })).not.toThrow();
    expect(() => EVENT_PROPS['variant.prompted'].parse({ star: 'eimi', cardId: 's1-eimi-30', via: 'popup' })).toThrow();
    expect(() => EVENT_PROPS['variant.drawn'].parse({ star: 'eimi', cardId: 's1-eimi-30', pickup: true })).not.toThrow();
    expect(RARITIES).toHaveLength(5);
  });
});

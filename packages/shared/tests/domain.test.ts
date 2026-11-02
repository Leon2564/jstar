import { describe, expect, it } from 'vitest';
import { CATALOG, catalogProblems } from '../src/catalog';
import { DEFAULT_RATES, DEMO_SERIALS, RARITIES, RARITY_ORDER, RULES, disclosure, drawLucky, drawPulls, expectedPullsToTop, floorRates, formatSerial, isValidSerialFormat, levelFromXp, luhnCheckDigit, normalizeSerial, poolCards, ratesSumOk, rollTier, seeded, serialFromPath, serialFromQuery } from '../src';
import type { CardDef } from '../src';

const pool: CardDef[] = CATALOG;


describe('shared domain', () => {
  it('ten-pull always contains SR or better', () => {
    const rng = seeded(11);
    for (let i = 0; i < 2000; i++) expect(drawPulls(10, pool, rng).drawn.some((d) => RARITY_ORDER[d.card.rarity] >= RARITY_ORDER.SR)).toBe(true);
  });
  it('the catalog has 150 cards, 30 per talent, N10 R8 SR7 SSR4 UR1', () => {
    expect(CATALOG).toHaveLength(150);
    expect(catalogProblems()).toEqual([]);
  });
  it('hard pity: the 80th pull without SSR+ is SSR+, and the effective rate beats the base rate', () => {
    const rng = seeded(2);
    for (let i = 0; i < 300; i++) {
      const { drawn, pity } = drawPulls(1, pool, rng, RULES.pityPulls - 1);
      expect(RARITY_ORDER[drawn[0].tier]).toBeGreaterThanOrEqual(RARITY_ORDER.SSR);
      expect(pity).toBe(0);
    }
    expect(1 / expectedPullsToTop()).toBeGreaterThan(DEFAULT_RATES.SSR + DEFAULT_RATES.UR);
    const d = disclosure(poolCards('star:nana', pool));
    expect(d.rows.find((r) => r.tier === 'UR')).toMatchObject({ cards: 1, perCard: 0.005 });
  });
  it('normalizes printed codes: spaces, hyphens, full-width digits', () => {
    expect(normalizeSerial('9990-0000-0011')).toBe('999000000011');
    expect(normalizeSerial(' 9990 0000 0011 ')).toBe('999000000011');
    expect(normalizeSerial('９９９０ー００００ー００１１')).toBe('999000000011');
    expect(formatSerial('999000000011')).toBe('9990-0000-0011');
    expect(formatSerial('99900')).toBe('9990-0');
  });
  it('checks length, leading digit and the Luhn check digit', () => {
    for (const c of DEMO_SERIALS) expect(isValidSerialFormat(c)).toBe(true);
    expect(isValidSerialFormat('999000000012')).toBe(false); // wrong check digit
    expect(isValidSerialFormat('999000000101')).toBe(false); // two digits swapped
    expect(isValidSerialFormat('099900000001')).toBe(false); // leading zero never printed
    expect(isValidSerialFormat('99900000001')).toBe(false);
    expect(isValidSerialFormat('9990000000110')).toBe(false);
    expect(luhnCheckDigit([7, 9, 9, 2, 7, 3, 9, 8, 7, 1])).toBe(3); // textbook example 79927398713
  });
  it('reads a code from the QR query or the per-card QR path, only when well formed', () => {
    expect(serialFromQuery('?code=9990-0000-0011')).toBe('999000000011');
    expect(serialFromQuery('?code=999000000012')).toBeNull();
    expect(serialFromPath('/r/999000000011')).toBe('999000000011');
    expect(serialFromPath('/r/999000000012')).toBeNull();
    expect(serialFromPath('/lucky')).toBeNull();
  });
  it('tier rates sum to one; the first code draw is SR or better', () => {
    expect(ratesSumOk(DEFAULT_RATES)).toBe(true);
    const first = floorRates('SR');
    expect(ratesSumOk(first)).toBe(true);
    expect(first.N + first.R).toBe(0);
    expect(first.SR).toBeCloseTo(0.12 / 0.17, 12);
  });
  it('a lucky code draws six, the first SR or better, at the published rates', () => {
    const rng = seeded(7);
    const tally: Record<string, number> = {};
    for (let i = 0; i < 20000; i++) {
      const d = drawLucky(pool, rng);
      expect(d).toHaveLength(RULES.lucky.drawsPerCode);
      expect(RARITY_ORDER[d[0].card.rarity]).toBeGreaterThanOrEqual(RARITY_ORDER.SR);
      for (const x of d) { expect(x.card.rarity).toBe(x.tier); if (x !== d[0]) tally[x.tier] = (tally[x.tier] ?? 0) + 1; }
    }
    const n = 20000 * 5;
    for (const t of RARITIES) expect(Math.abs((tally[t] ?? 0) / n - DEFAULT_RATES[t])).toBeLessThan(0.006);
  });
  it('the guarantee floor never returns a lower tier', () => {
    const rng = seeded(3);
    for (let i = 0; i < 5000; i++) expect(['SR', 'SSR', 'UR']).toContain(rollTier(rng, DEFAULT_RATES, 'SR'));
  });
  it('the same seed replays the same draw', () => {
    expect(drawLucky(pool, seeded(42)).map((d) => d.card.id)).toEqual(drawLucky(pool, seeded(42)).map((d) => d.card.id));
  });
  it('levels up every 40 xp', () => { expect(levelFromXp(39)).toBe(1); expect(levelFromXp(40)).toBe(2); });
});

describe('age from birthday', () => {
  it('counts full years in JST and rejects impossible dates', async () => {
    const { ageOn } = await import('../src/rules');
    expect(ageOn('2008-09-25', '2026-09-25')).toBe(18);
    expect(ageOn('2008-09-26', '2026-09-25')).toBe(17);
    expect(ageOn('2008-02-29', '2026-02-28')).toBe(17);
    expect(ageOn('2001-02-30')).toBeNull();
    expect(ageOn('1899-12-31')).toBeNull();
    expect(ageOn('2099-01-01')).toBeNull();
  });
});

describe('metrics calendar and events', () => {
  it('adds days across months and starts weeks on Monday, as the metrics SQL does', async () => {
    const { addDays, weekStart } = await import('../src/rules');
    expect(addDays('2026-09-30', 1)).toBe('2026-10-01');
    expect(addDays('2026-03-01', -1)).toBe('2026-02-28');
    expect(weekStart('2026-09-21')).toBe('2026-09-21');
    expect(weekStart('2026-09-26')).toBe('2026-09-21');
    expect(weekStart('2026-09-27')).toBe('2026-09-21');
  });
  it('only accepts ids and enums in event props', async () => {
    const { EVENT_PROPS, EVENT_NAMES } = await import('../src/contracts');
    expect(EVENT_NAMES).toContain('scene.trigger');
    expect(EVENT_PROPS['scene.trigger'].safeParse({ star: 'nana', sceneId: 'reading', source: 'proposed' }).success).toBe(true);
    expect(EVENT_PROPS['scene.trigger'].safeParse({ star: 'nana', sceneId: 'reading', source: 'app' }).success).toBe(false);
    expect(EVENT_PROPS['gift.sent'].safeParse({ star: 'nana', giftId: 'a whole sentence' }).success).toBe(false);
    expect(EVENT_PROPS['alarm.set'].safeParse({ star: 'nana', note: 'x' }).success).toBe(false);
  });
});

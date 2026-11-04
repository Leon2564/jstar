import { RARITIES, RARITY_ORDER, type CardDef, type PoolId, type Rarity, type StarId } from './domain';
export { POOL_IDS, isPoolId, type PoolId } from './domain';
import { RULES } from './rules';

/**
 * Star Genesis draws. One rate table for paid pulls and printed codes; server-side only in production
 * (the seed of every draw is stored so a disputed result can be replayed — docs/compliance-jp.md).
 */
export type TierRates = Record<Rarity, number>;
export const DEFAULT_RATES: TierRates = RULES.rates;

export type Rng = () => number;

/** Rolls a tier; with `floor`, only tiers at or above it, their rates renormalised (guarantees and pity). */
export function rollTier(rng: Rng, rates: TierRates = DEFAULT_RATES, floor: Rarity = 'N'): Rarity {
  const tiers = RARITIES.slice(RARITIES.indexOf(floor));
  const total = tiers.reduce((n, t) => n + rates[t], 0);
  let r = rng() * total;
  for (const t of tiers) { r -= rates[t]; if (r < 0) return t; }
  return tiers[tiers.length - 1];
}

/** A card of this tier from the pool; the nearest lower tier that has cards if none (never throws on a thin pool). */
export function pickCard(rarity: Rarity, rng: Rng, pool: CardDef[]): CardDef {
  for (let i = RARITIES.indexOf(rarity); i >= 0; i--) {
    const list = pool.filter((c) => c.rarity === RARITIES[i]);
    if (list.length) return list[Math.min(list.length - 1, Math.floor(rng() * list.length))];
  }
  return pool[Math.min(pool.length - 1, Math.floor(rng() * pool.length))];
}

export interface Drawn { card: CardDef; tier: Rarity }
const isTop = (t: Rarity) => RARITY_ORDER[t] >= RARITY_ORDER.SSR;

/**
 * `n` pulls starting from a pity counter (pulls since the last SSR or better). The pull that reaches
 * RULES.pityPulls is SSR or better; a ten-pull holds at least one SR or better. Returns the new counter.
 */
export function drawPulls(n: number, pool: CardDef[], rng: Rng, pity = 0, rates: TierRates = DEFAULT_RATES): { drawn: Drawn[]; pity: number } {
  return drawWith(n, rng, pity, rates, (tier) => ({ tier, card: pickCard(tier, rng, pool) }));
}

/**
 * The pull loop every pool shares: tier (with pity and the ten-pull guarantee), then `pick` chooses the card. The
 * regular pools pick exactly as before Pickups existed — same random numbers in the same order, so a stored seed
 * replays the same cards (fingerprints in packages/shared/tests/variants.test.ts and pickup.test.ts).
 */
function drawWith(n: number, rng: Rng, pity: number, rates: TierRates, pick: (tier: Rarity) => Drawn): { drawn: Drawn[]; pity: number } {
  const drawn: Drawn[] = [];
  let counter = pity;
  for (let i = 0; i < n; i++) {
    counter += 1;
    const tier = rollTier(rng, rates, counter >= RULES.pityPulls ? 'SSR' : 'N');
    if (isTop(tier)) counter = 0;
    drawn.push(pick(tier));
  }
  if (n === 10 && drawn.every((d) => RARITY_ORDER[d.tier] < RARITY_ORDER.SR)) {
    const tier = rollTier(rng, rates, 'SR');
    if (isTop(tier)) counter = 0;
    drawn[9] = pick(tier);
  }
  return { drawn, pity: counter };
}

/** One printed code: `n` draws, the first SR or better. */
export function drawLucky(pool: CardDef[], rng: Rng, n: number = RULES.lucky.drawsPerCode, rates: TierRates = DEFAULT_RATES): Drawn[] {
  return Array.from({ length: n }, (_, i) => {
    const tier = rollTier(rng, rates, n > 1 && i === 0 ? 'SR' : 'N');
    return { tier, card: pickCard(tier, rng, pool) };
  });
}

// ---------------------------------------------------------------- pools

export function poolCards(pool: PoolId, cards: CardDef[]): CardDef[] {
  return pool === 'all' ? cards : cards.filter((c) => `star:${c.star}` === pool);
}

// ---------------------------------------------------------------- disclosure (提供割合)

/** Expected pulls to the first SSR or better with hard pity at RULES.pityPulls. */
export function expectedPullsToTop(rates: TierRates = DEFAULT_RATES, pity: number = RULES.pityPulls): number {
  const p = rates.SSR + rates.UR;
  let e = 0;
  for (let k = 1; k <= pity; k++) e += (1 - p) ** (k - 1);
  return e;
}

export interface RateRow { tier: Rarity; rate: number; perCard: number; cards: number }
/** Per-tier and per-card rates of a pool, plus the effective SSR-or-better rate including pity. */
export function disclosure(cards: CardDef[], rates: TierRates = DEFAULT_RATES) {
  const rows: RateRow[] = RARITIES.map((tier) => {
    const n = cards.filter((c) => c.rarity === tier).length;
    return { tier, rate: rates[tier], perCard: n ? rates[tier] / n : 0, cards: n };
  });
  return { rows, pity: RULES.pityPulls, effectiveTopRate: 1 / expectedPullsToTop(rates), firstCodeDraw: floorRates('SR', rates) };
}

/** Rates of a guaranteed draw (e.g. the first draw of a printed code: SR or better). */
export function floorRates(floor: Rarity, rates: TierRates = DEFAULT_RATES): TierRates {
  const tiers = RARITIES.slice(RARITIES.indexOf(floor));
  const total = tiers.reduce((n, t) => n + rates[t], 0);
  return Object.fromEntries(RARITIES.map((t) => [t, tiers.includes(t) ? rates[t] / total : 0])) as TierRates;
}

export function ratesSumOk(rates: TierRates): boolean {
  return Math.abs(RARITIES.reduce((n, r) => n + rates[r], 0) - 1) < 1e-9;
}

// ---------------------------------------------------------------- Pickup (#78)

/**
 * A Pickup: her pool (`star:<id>`) for an announced window, in which one card — her variant — takes `share` of every
 * SSR-or-better draw (PICKUP_RULES). `share` and `rates` are copied in when the admin creates it, so the odds of a
 * Pickup never move while it runs and a stored seed replays under the odds it was drawn with
 * (docs/compliance-jp.md §3).
 */
export interface PickupDef {
  /** `pickup:<cardId>:<YYYYMMDD>` — the JST day it starts. Also the draw log's pool id. */
  id: string;
  cardId: string;
  star: StarId;
  share: number;
  rates: TierRates;
  startsAt: string;
  endsAt: string;
}
export type PickupOdds = Pick<PickupDef, 'cardId' | 'share'>;

export const PICKUP_ID_RE = /^pickup:([a-z0-9][a-z0-9-]{0,63}):(\d{8})$/;
export const isPickupPoolId = (v: unknown): v is string => typeof v === 'string' && PICKUP_ID_RE.test(v);
/** The Pickup's id: the card and the JST day it starts, so one card has at most one Pickup starting on a day. */
export function pickupPoolId(cardId: string, startsAt: string): string {
  const day = new Date(Date.parse(startsAt) + 9 * 3_600_000).toISOString().slice(0, 10).replace(/-/g, '');
  return `pickup:${cardId}:${day}`;
}
/** The card a Pickup id names (history labels, before the Pickup list is loaded). */
export const pickupCardOf = (id: string): string | null => PICKUP_ID_RE.exec(id)?.[1] ?? null;
/** Live from `startsAt` (inclusive) until `endsAt` (exclusive), by the server's clock. */
export const pickupLive = (p: Pick<PickupDef, 'startsAt' | 'endsAt'>, now: number = Date.now()): boolean =>
  Date.parse(p.startsAt) <= now && now < Date.parse(p.endsAt);

const tierCount = (cards: CardDef[], tier: Rarity) => cards.filter((c) => c.rarity === tier).length;
/** A card's rate in a regular pool: its tier's rate shared equally by the tier's cards. */
const baseCardRate = (cards: CardDef[], card: CardDef, rates: TierRates) => rates[card.rarity] / tierCount(cards, card.rarity);

/**
 * Why a card cannot be picked up in this pool at this share; empty = it can. It must be a card of the pool at SSR or
 * better, the share must lie in (0, 1] and leave room for the other top cards (or be 1 when there are none), and the
 * Pickup must raise the card's rate, never lower it.
 */
export function pickupProblems(cards: CardDef[], odds: PickupOdds, rates: TierRates = DEFAULT_RATES): string[] {
  const card = cards.find((c) => c.id === odds.cardId);
  if (!card) return ['not_in_pool'];
  const out: string[] = [];
  if (!isTop(card.rarity)) out.push('not_top');
  if (!(odds.share > 0 && odds.share <= 1)) out.push('bad_share');
  if (odds.share < 1 && !cards.some((c) => isTop(c.rarity) && c.id !== card.id)) out.push('no_others');
  if (isTop(card.rarity) && odds.share * (rates.SSR + rates.UR) < baseCardRate(cards, card, rates) - 1e-12) out.push('no_boost');
  return out;
}

/**
 * Every card's rate in a Pickup: tiers below SSR exactly as in the regular pool; inside SSR-or-better, the picked-up
 * card has `share` of it and the other top cards split the rest in proportion to their regular rates. The rates add
 * up to 1, and the SSR-or-better total (so the pity) is unchanged.
 */
export function pickupCardRates(cards: CardDef[], odds: PickupOdds, rates: TierRates = DEFAULT_RATES): Map<string, number> {
  const top = rates.SSR + rates.UR;
  const others = cards.filter((c) => isTop(c.rarity) && c.id !== odds.cardId);
  const othersBase = others.reduce((n, c) => n + baseCardRate(cards, c, rates), 0);
  const share = others.length ? odds.share : 1;
  return new Map(cards.map((c) => [c.id,
    c.id === odds.cardId ? share * top
      : isTop(c.rarity) ? (1 - share) * top * (baseCardRate(cards, c, rates) / othersBase)
        : baseCardRate(cards, c, rates)]));
}

/** Among the SSR-or-better cards of a Pickup: the picked-up card with its share, else another by its regular rate. */
function pickTop(cards: CardDef[], odds: PickupOdds, rates: TierRates, rng: Rng): CardDef {
  const target = cards.find((c) => c.id === odds.cardId)!;
  const others = cards.filter((c) => isTop(c.rarity) && c.id !== target.id);
  if (!others.length || rng() < odds.share) return target;
  const weights = others.map((c) => baseCardRate(cards, c, rates));
  let r = rng() * weights.reduce((n, w) => n + w, 0);
  for (let i = 0; i < others.length; i++) { r -= weights[i]; if (r < 0) return others[i]; }
  return others[others.length - 1];
}

/**
 * `n` pulls in a Pickup: the same tier roll, pity and ten-pull guarantee as every pool (drawWith); an SSR-or-better
 * pull then goes to the picked-up card with probability `share`. The drawn tier is the card's own rarity.
 * Throws when the Pickup is not valid for this pool (pickupProblems) — the API checks before it charges.
 */
export function drawPickupPulls(n: number, cards: CardDef[], odds: PickupOdds, rng: Rng, pity = 0, rates: TierRates = DEFAULT_RATES): { drawn: Drawn[]; pity: number } {
  const problems = pickupProblems(cards, odds, rates);
  if (problems.length) throw new Error(`invalid_pickup:${problems.join(',')}`);
  return drawWith(n, rng, pity, rates, (tier) => {
    const card = isTop(tier) ? pickTop(cards, odds, rates, rng) : pickCard(tier, rng, cards);
    return { tier: card.rarity, card };
  });
}

/**
 * 提供割合 of a Pickup, computed from its config: per tier (the picked-up card counted in its tier; `perCard` is each
 * other card of the tier), and the picked-up card on its own — its rate here, in the regular pool, its share of
 * SSR or better, and its rate including pity.
 */
export function pickupDisclosure(cards: CardDef[], odds: PickupOdds, rates: TierRates = DEFAULT_RATES) {
  const byCard = pickupCardRates(cards, odds, rates);
  const card = cards.find((c) => c.id === odds.cardId)!;
  const rows: RateRow[] = RARITIES.map((tier) => {
    const inTier = cards.filter((c) => c.rarity === tier);
    const other = inTier.find((c) => c.id !== odds.cardId);
    return { tier, rate: inTier.reduce((n, c) => n + byCard.get(c.id)!, 0), perCard: other ? byCard.get(other.id)! : 0, cards: inTier.length };
  });
  const base = disclosure(cards, rates);
  const rate = byCard.get(card.id)!;
  const share = rate / (rates.SSR + rates.UR);
  return {
    rows, pity: base.pity, effectiveTopRate: base.effectiveTopRate, firstCodeDraw: base.firstCodeDraw,
    pickup: { cardId: card.id, tier: card.rarity, rate, baseRate: baseCardRate(cards, card, rates), share, effectiveRate: share * base.effectiveTopRate }
  };
}

/** Deterministic RNG — used by tests and by the server's audited draw log. */
export function seeded(seed: number): Rng {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * H1 (v1.1.1 acceptance): a draw's cards counted by tier for its summary — every tier (UR, SSR, SR, R, N), rarest first,
 * tiers it has none of left out, so the counts always add up to `total` (a ten-pull with a UR once read SSR 0 / SR 1 / R 2).
 */
export function tierCounts(rarities: readonly Rarity[]): { total: number; tiers: { tier: Rarity; n: number }[] } {
  const tiers = [...RARITIES].reverse().map((tier) => ({ tier, n: rarities.filter((r) => r === tier).length })).filter((x) => x.n > 0);
  return { total: rarities.length, tiers };
}

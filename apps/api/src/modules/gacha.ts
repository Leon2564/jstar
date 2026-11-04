import { randomInt } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import {
  DrawReq, ExchangeReq, POOL_IDS, RULES, disclosure, drawPickupPulls, drawPulls, duplicateGain, isExchangeable, isPickupPoolId, isVariantCard, pickupLive,
  pickupProblems, poolCards, seeded,
  type CardDef, type DrawHistoryResT, type DrawResT, type ExchangeResT, type GachaRatesResT, type PoolId
} from '@jstar/shared';
import { herPool, publishedPickups } from '../lib/pickup';
import { httpError, requireUser } from '../app';
import { newId } from '../lib/crypto';
import type { PlannedCard, UserRow } from '../db/types';

const state = (u: UserRow) => ({ points: u.points, freePulls: u.freePulls, pity: u.pity, shards: u.shards });
/** A card for the store: a variant card carries what a duplicate of it adds (心意, #75); the store applies it only to a duplicate. */
export const planned = (c: Pick<CardDef, 'id' | 'star' | 'rarity'>): PlannedCard =>
  ({ cardId: c.id, star: c.star, duplicateShards: RULES.duplicateShards[c.rarity], ...(isVariantCard(c.id) ? { variant: duplicateGain() } : {}) });
const HISTORY_DAYS = 180;

export async function registerGacha(app: FastifyInstance) {
  /**
   * Server-authoritative draw: the client sends only the pool and how many. Payment, pity, shards, the cards
   * and the draw log are one all-or-nothing step (repos.gacha.draw); the seed is stored for replay.
   */
  app.post('/draw', { config: { rateLimit: { max: 30, timeWindow: '1 minute' } } }, async (req): Promise<DrawResT> => {
    const user = requireUser(req);
    const { pool, count } = DrawReq.parse(req.body);
    // A Pickup (#78) is drawn only while it is live, with the odds stored in it when it was announced.
    const pickup = isPickupPoolId(pool) ? await app.repos.pickups.byId(pool) : null;
    if (isPickupPoolId(pool) && (!pickup || !pickupLive(pickup))) throw httpError('pool_closed', 409);
    const all = await app.repos.cards.all();
    const cards = pickup ? herPool(all, pickup.star) : poolCards(pool as PoolId, all);
    if (!cards.length || (pickup && pickupProblems(cards, pickup, pickup.rates).length)) throw httpError('pool_empty', 409);
    const cost = { points: 0, freePulls: count };

    const seed = randomInt(0, 0xffffffff);
    const { drawn, pity } = pickup
      ? drawPickupPulls(count, cards, pickup, seeded(seed), user.pity, pickup.rates)
      : drawPulls(count, cards, seeded(seed), user.pity);
    const at = new Date().toISOString();
    const drawId = newId('drw');
    const outcome = await app.repos.gacha.draw({
      userId: user.id, cost, expectPity: user.pity, newPity: pity, shardsDelta: 0,
      cards: drawn.map((d) => planned(d.card)),
      draw: { id: drawId, ownerId: user.id, poolId: pool, serialId: null, cardIds: drawn.map((d) => d.card.id), tiers: drawn.map((d) => d.tier), cost: cost.points, seed: String(seed), createdAt: at },
      at
    });
    if (!outcome.ok) {
      if (outcome.reason === 'conflict') throw httpError('draw_in_progress', 409);
      throw httpError('no_free_pull', 409);
    }
    // Variant conversion (#52, #78): one event per variant card drawn, duplicates included; `pickup` marks a Pickup's.
    for (const d of drawn) if (isVariantCard(d.card.id)) await app.recordEvent(user.id, 'variant.drawn', { star: d.card.star, cardId: d.card.id, ...(pickup ? { pickup: true as const } : {}) });
    return {
      cards: drawn.map((d, i) => ({ id: d.card.id, star: d.card.star, rarity: d.card.rarity, isNew: outcome.isNew[i] })),
      wallet: state(outcome.user), drawId
    };
  });

  /** Star Shards → one chosen card. Its rarity decides the cost; duplicates still convert back into their rarity yield. */
  app.post('/exchange', { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } }, async (req): Promise<ExchangeResT> => {
    const user = requireUser(req);
    const { cardId } = ExchangeReq.parse(req.body);
    const card = (await app.repos.cards.all()).find((c) => c.id === cardId);
    if (!card || !isExchangeable(card)) throw httpError('not_exchangeable', 400);
    const shardCost = RULES.exchangeShards[card.rarity];
    if (user.shards < shardCost) throw httpError('insufficient_shards', 402);
    const at = new Date().toISOString();
    const outcome = await app.repos.gacha.draw({
      userId: user.id, cost: { points: 0, freePulls: 0 }, expectPity: user.pity, newPity: user.pity, shardsDelta: -shardCost,
      cards: [planned(card)],
      draw: { id: newId('drw'), ownerId: user.id, poolId: 'exchange', serialId: null, cardIds: [card.id], tiers: [card.rarity], cost: 0, seed: '0', createdAt: at },
      at
    });
    if (!outcome.ok) throw httpError(outcome.reason === 'conflict' ? 'draw_in_progress' : 'insufficient_shards', outcome.reason === 'conflict' ? 409 : 402);
    return { card: { id: card.id, star: card.star, rarity: card.rarity, isNew: outcome.isNew[0] }, wallet: state(outcome.user) };
  });

  /** The signed-in user's draws of the last 180 days, newest first (paid pulls, exchanges and printed codes). */
  app.get('/history', async (req): Promise<DrawHistoryResT> => {
    const user = requireUser(req);
    const since = Date.now() - HISTORY_DAYS * 86_400_000;
    const rows = (await app.repos.draws.forOwner(user.id, 500)).filter((d) => Date.parse(d.createdAt) >= since).reverse();
    return {
      draws: rows.map((d) => ({
        id: d.id, pool: d.serialId ? 'code' : d.poolId, cost: d.cost, createdAt: d.createdAt,
        cards: d.cardIds.map((id, i) => ({ id, rarity: (d.tiers?.[i] ?? 'N') as DrawHistoryResT['draws'][number]['cards'][number]['rarity'] }))
      }))
    };
  });

  /**
   * Published rates (提供割合) per pool: per tier, per card, the pity-adjusted SSR-or-better rate; then every Pickup
   * that is live or scheduled (#78), computed from its stored config — the numbers the draw above uses.
   */
  app.get('/rates', async (): Promise<GachaRatesResT> => {
    const all = await app.repos.cards.all();
    return {
      pools: POOL_IDS.map((id) => ({ id, ...disclosure(poolCards(id, all)) })),
      pickups: await publishedPickups(app.repos),
      shardsForExchange: RULES.shardsForExchange,
      duplicateShards: RULES.duplicateShards,
      exchangeShards: RULES.exchangeShards
    };
  });
}

import type { FastifyInstance } from 'fastify';
import { POOL_IDS, RULES, disclosure, duplicateGain, isVariantCard, poolCards, type CardDef, type DrawHistoryResT, type GachaRatesResT } from '@jstar/shared';
import { publishedPickups } from '../lib/pickup';
import { httpError, requireUser } from '../app';
import type { PlannedCard } from '../db/types';

/** Card copies are issued by redeemed codes; legacy wallet fields remain readable for existing accounts. */
export const planned = (card: Pick<CardDef, 'id' | 'star' | 'rarity'>): PlannedCard => ({
  cardId: card.id,
  star: card.star,
  duplicateShards: 0,
  ...(isVariantCard(card.id) ? { variant: duplicateGain() } : {})
});

const HISTORY_DAYS = 180;

export async function registerGacha(app: FastifyInstance) {
  app.post('/draw', { config: { rateLimit: { max: 30, timeWindow: '1 minute' } } }, async () => {
    throw httpError('code_only', 410);
  });
  app.post('/exchange', { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } }, async () => {
    throw httpError('code_only', 410);
  });
  app.get('/history', async (req): Promise<DrawHistoryResT> => {
    const user = requireUser(req);
    const since = Date.now() - HISTORY_DAYS * 86_400_000;
    const rows = (await app.repos.draws.forOwner(user.id, 500)).filter((draw) => Date.parse(draw.createdAt) >= since).reverse();
    return { draws: rows.map((draw) => ({
      id: draw.id,
      pool: draw.serialId ? 'code' : draw.poolId,
      cost: draw.cost,
      createdAt: draw.createdAt,
      cards: draw.cardIds.map((id, index) => ({ id, rarity: (draw.tiers?.[index] ?? 'N') as DrawHistoryResT['draws'][number]['cards'][number]['rarity'] }))
    })) };
  });
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

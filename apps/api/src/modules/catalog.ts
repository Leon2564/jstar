import type { FastifyInstance } from 'fastify';
import { CardHomePinReq, canPinHome, isVariantCard, variantState, type CardAffectionResT, type CardDef } from '@jstar/shared';
import { httpError, requireUser } from '../app';
import type { UserRow } from '../db/types';

export async function registerCatalog(app: FastifyInstance) {
  /** Public catalogue: card list and the live pool with its published rates. */
  app.get('/cards', async () => ({ cards: await app.repos.cards.all() }));

  /** A variant card by its route id: 404 for an unknown card or one that is not a variant. */
  const variantCard = async (req: { params: unknown }): Promise<CardDef> => {
    const id = String((req.params as { id: string }).id).slice(0, 64);
    const card = (await app.repos.cards.all()).find((c) => c.id === id);
    if (!card) throw httpError('card_not_found', 404);
    if (!isVariantCard(id)) throw httpError('not_a_variant', 404);
    return card;
  };
  const view = async (user: UserRow, card: CardDef): Promise<CardAffectionResT> => {
    const [owned, row] = await Promise.all([app.repos.owned.forUser(user.id), app.repos.cardAffection.get(user.id, card.id)]);
    return { cardId: card.id, star: card.star, owned: owned.some((o) => o.cardId === card.id), variant: variantState(row) };
  };

  /** A variant card's own affinity with him (#75): level, opened layers, 心意, and whether her home keeps it (#76). */
  app.get('/cards/:id/affection', async (req): Promise<CardAffectionResT> => {
    const user = requireUser(req);
    return view(user, await variantCard(req));
  });

  /**
   * Her home keeps this look (#76): from VARIANT_RULES.homePinLevel he may pin his variant card's home loop instead of
   * her rotating looks, and unpin it any time. The web shows the pinned look only while its clip exists.
   */
  app.put('/cards/:id/home-pin', { config: { rateLimit: { max: 20, timeWindow: '1 minute' } } }, async (req): Promise<CardAffectionResT> => {
    const user = requireUser(req);
    const card = await variantCard(req);
    const { pinned } = CardHomePinReq.parse(req.body);
    const [owned, row] = await Promise.all([app.repos.owned.forUser(user.id), app.repos.cardAffection.get(user.id, card.id)]);
    if (!owned.some((o) => o.cardId === card.id)) throw httpError('not_owned', 403);
    if (pinned && !canPinHome(variantState(row).level)) throw httpError('variant_level', 403);
    await app.repos.cardAffection.setPinned(user.id, card.id, pinned);
    return view(user, card);
  });
}

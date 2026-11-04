import type { FastifyInstance } from 'fastify';
import {
  GIFTS, GIFT_RULES, GiftSendReq, GiftsQuery, giftReaction, isVariantCard, jstDay, levelFromXp, loverLevel,
  variantGiftXp, variantState, wishesIn, type GiftId, type GiftSendResT, type GiftTaste, type GiftsResT, type Lang, type StarId
} from '@jstar/shared';
import type { ChatMemoryRow, RelationshipRow, UserRow } from '../db/types';
import { httpError, requireUser } from '../app';
import { newId } from '../lib/crypto';
import { giftPersona } from '../lib/agent';
import { relationships } from '../lib/relationship';
import { factsForAgent, giftName, saveMemory, wishesOf } from '../lib/wishes';
import { planGift } from '../lib/gifts';

/** How far back her own words are searched for the line where she mentioned a gift. */
const WISH_LINE_LOOKBACK = 200;

/**
 * Six gift interactions (#77) trigger her reaction/PV effect without spending chat credits. The daily cap and her
 * XP are still one all-or-nothing step in storage; her reaction comes afterwards and cannot double it.
 */
export async function registerGift(app: FastifyInstance) {
  const rel = relationships(app);

  /** The catalogue for her, with the gifts he has learned she likes. Her other tastes stay hers. */
  app.get('/', async (req): Promise<GiftsResT> => {
    const user = requireUser(req);
    const { star } = GiftsQuery.parse(req.query);
    const [memory, sentToday] = await Promise.all([app.repos.chatMemory.get(user.id, star), app.repos.gifts.countOn(user.id, jstDay())]);
    const known = wishesOf(memory);
    return {
      star, gifts: GIFTS.map((g) => ({ id: g.id, price: 0, known: known.includes(g.id) })),
      sentToday, perDay: GIFT_RULES.perDay, points: user.points
    };
  });

  app.post('/', { config: { rateLimit: { max: 20, timeWindow: '1 minute' } } }, async (req): Promise<GiftSendResT> => {
    const user = requireUser(req);
    const { star, giftId, cardId, lang: asked } = GiftSendReq.parse(req.body);
    const lang = asked ?? user.lang;
    // "Wearing her" (#75): only a variant card of hers that he owns.
    if (cardId) {
      const card = isVariantCard(cardId) ? (await app.repos.cards.all()).find((c) => c.id === cardId) : undefined;
      const owned = card && card.star === star && (await app.repos.owned.forUser(user.id)).some((o) => o.cardId === cardId);
      if (!owned) throw httpError('invalid_card', 400);
    }
    const now = new Date();
    const planned = await planGift(app.repos, user.id, star, giftId, now);
    const { taste, wished, memory } = planned;
    const outcome = await app.repos.gifts.send({
      ...planned.plan,
      // The gift's own XP already goes to her main affinity: the variant's share is not added a second time.
      ...(cardId ? { row: { ...planned.plan.row, cardId }, variant: { cardId, gain: { xp: variantGiftXp(planned.plan.row.xp, taste, wished), kokoro: 0, mainXp: 0 } } } : {})
    });
    if (!outcome.ok) throw outcome.reason === 'limit' ? httpError('gift_limit', 409) : httpError('insufficient_points', 402);
    await app.recordEvent(user.id, 'gift.sent', { star, giftId });

    // XP from a gift is not a day together: the stage moves only if its days were already met (#54).
    const { row, xp: affinityXp } = await rel.advance(user.id, star, now);
    const reaction = await react(user, { star, giftId, taste, wished, lang, memory, row, affinityXp });
    // A liked gift he gave is something he now knows she likes, as much as her mentioning it.
    const known = await saveMemory(app.repos, user.id, star, memory, null, taste === 'liked' ? [giftId] : []);
    const [wallet, variant] = await Promise.all([
      app.repos.users.byId(user.id),
      cardId ? app.repos.cardAffection.get(user.id, cardId) : Promise.resolve(null)
    ]);
    return {
      star, giftId, taste, wished, reaction, affinityXp, level: levelFromXp(affinityXp),
      relationship: await rel.view(user.id, star, row, affinityXp),
      points: (wallet ?? outcome.user).points, freePulls: (wallet ?? outcome.user).freePulls,
      sentToday: outcome.sentToday, perDay: GIFT_RULES.perDay, known,
      variant: cardId ? { cardId, state: variantState(variant) } : null
    };
  });

  /**
   * Her reaction, stored in her chat so she remembers it. The persona service writes it in her voice, aware of her
   * taste and of what she once said about it; her written line is what she says when it cannot answer.
   */
  async function react(
    user: UserRow,
    g: { star: StarId; giftId: GiftId; taste: GiftTaste; wished: boolean; lang: Lang; memory: ChatMemoryRow | null; row: RelationshipRow | null; affinityXp: number }
  ): Promise<string> {
    const fallback = giftReaction(g.star, g.giftId, g.taste, g.wished, g.lang);
    const wishLine = g.wished
      ? (await app.repos.messages.recent(user.id, g.star, WISH_LINE_LOOKBACK)).reverse().find((m) => m.role === 'assistant' && wishesIn(g.star, m.text).includes(g.giftId))?.text ?? null
      : null;
    let text = fallback;
    try {
      text = await giftPersona({
        star: g.star, lang: g.lang, level: levelFromXp(g.affinityXp),
        memory: g.memory ? { facts: factsForAgent(g.memory.facts), summary: g.memory.summary } : null,
        stage: g.row?.stage ?? 'new', daysTogether: g.row?.daysTogether ?? 0, anniversary: g.row?.anniversary ?? null,
        loverLevel: g.row ? loverLevel(g.row, g.affinityXp) : null,
        gift: { id: g.giftId, name: giftName(g.giftId, g.lang) }, taste: g.taste, wished: g.wished, wishLine: wishLine?.slice(0, 300) ?? null, fallback
      });
    } catch (err) {
      app.log.warn({ err }, 'gift_reaction_fallback');
    }
    const at = new Date().toISOString();
    await app.repos.messages.add({ id: newId('msg'), ownerId: user.id, star: g.star, role: 'assistant', text, createdAt: at });
    return text;
  }
}

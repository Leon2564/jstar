import { GIFT_RULES, giftById, giftReaction, giftXp, jstDay, tasteOf, type GiftId, type GiftTaste, type StarId } from '@jstar/shared';
import type { SceneText } from '@jstar/shared/scenes';
import type { ChatMemoryRow, GiftPlan, Repos } from '../db/types';
import { httpError } from '../app';
import { newId } from './crypto';
import { wishesOf } from './wishes';

/**
 * A gift (#77) as it will be bought, from the gift sheet (`POST /v1/gift`) or inside a scene (#68, うんぱい's stream:
 * the scene step buys it together with the run's move). Planning reads only; the store's one atomic step decides.
 */
export interface PlannedGift {
  plan: GiftPlan;
  taste: GiftTaste;
  /** She once said she wanted it, and he remembered (her_wishes). */
  wished: boolean;
  /** His chat memory with her, as read for this gift (her tastes are saved back from it afterwards). */
  memory: ChatMemoryRow | null;
}

export async function planGift(repos: Repos, userId: string, star: StarId, giftId: GiftId, now: Date, variant?: GiftPlan['variant']): Promise<PlannedGift> {
  const gift = giftById(giftId)!;
  const memory = await repos.chatMemory.get(userId, star);
  const taste = tasteOf(star, giftId);
  const wished = taste === 'liked' && wishesOf(memory).includes(giftId);
  const xp = giftXp(giftId, taste);
  return {
    plan: {
      row: { id: newId('gft'), userId, star, giftId, cardId: variant?.cardId ?? null, price: gift.price, xp, taste, day: jstDay(now), createdAt: now.toISOString() },
      perDay: GIFT_RULES.perDay,
      ...(variant ? { variant } : {})
    },
    taste, wished, memory
  };
}

/** Why the store would refuse this gift now — 402 `insufficient_points`, 409 `gift_limit` — or null. */
export async function giftRefusal(repos: Repos, plan: GiftPlan): Promise<Error | null> {
  const [user, sent] = await Promise.all([repos.users.byId(plan.row.userId), repos.gifts.countOn(plan.row.userId, plan.row.day)]);
  if (sent >= plan.perDay) return httpError('gift_limit', 409);
  if (!user || user.points < plan.row.price) return httpError('insufficient_points', 402);
  return null;
}

/** Her written reaction (#77 GIFT_REACTIONS), in the languages a scene line carries. */
export const giftReactionText = (star: StarId, g: Pick<PlannedGift, 'taste' | 'wished'> & { giftId: GiftId }): SceneText => ({
  ja: giftReaction(star, g.giftId, g.taste, g.wished, 'ja'),
  'zh-Hant': giftReaction(star, g.giftId, g.taste, g.wished, 'zh-Hant'),
  en: giftReaction(star, g.giftId, g.taste, g.wished, 'en'),
  ko: giftReaction(star, g.giftId, g.taste, g.wished, 'ko')
});

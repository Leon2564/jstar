/**
 * Gifts (#77), in the service layer's shape (see api.ts): the API in server mode, the same shared rules in the browser
 * in prototype mode. Its own module so it loads with the gift sheet, not with the entry bundle.
 */
import { GIFT_RULES, jstDay } from '@jstar/shared/rules';
import { levelFromXp } from '@jstar/shared/domain';
import { freshRelationship, viewOf } from '@jstar/shared/relationship';
import type { GiftSendResT, GiftsResT } from '@jstar/shared/contracts';
import type { GiftId } from '@jstar/shared/gifts';
import type { StarId } from '../data/cast';
import type { AppState } from '../lib/state';
import type { Lang } from '../i18n';
import { ApiError, http, serverMode } from './http';

const latency = () => new Promise((r) => setTimeout(r, (window as unknown as { __E2E__?: boolean }).__E2E__ ? 20 : 350));
const fail = (code: string, status: number): never => { throw new ApiError(code, status); };

/**
 * Prototype mode's gift bookkeeping, for this page session only: the daily count and what he learned she likes. The
 * API keeps both for real (and its chat memory hears her tastes in conversation); offline he learns by giving.
 */
const localGifts: { day: string; sent: number; known: Partial<Record<StarId, GiftId[]>> } = { day: '', sent: 0, known: {} };

/** The catalogue for her with what he knows she likes; null on failure (the sheet then says so). */
export async function gifts(state: Pick<AppState, 'points'>, star: StarId, localSession = false): Promise<GiftsResT | null> {
  if (serverMode() && !localSession) { try { return await http.gifts(star); } catch { return null; } }
  const { GIFTS } = await import('@jstar/shared/gifts');
  const known = localGifts.known[star] ?? [];
  return {
    star, gifts: GIFTS.map((g) => ({ id: g.id, price: g.price, known: known.includes(g.id) })),
    sentToday: localGifts.day === jstDay() ? localGifts.sent : 0, perDay: GIFT_RULES.perDay, points: state.points
  };
}

/** Gives her a gift: the server decides everything; prototype mode applies the same shared rules in the browser. */
export async function sendGift(state: AppState, star: StarId, giftId: GiftId, lang: Lang, localSession = false): Promise<GiftSendResT> {
  if (serverMode() && !localSession) return http.giftSend(star, giftId, lang);
  await latency();
  // Her tastes load only here, so the entry bundle never gives them away.
  const [{ giftById }, { tasteOf, giftXp, giftReaction }] = await Promise.all([import('@jstar/shared/gifts'), import('@jstar/shared/tastes')]);
  const gift = giftById(giftId);
  if (!gift) return fail('invalid_request', 400);
  if (state.points < gift.price) return fail('insufficient_points', 402);
  if (localGifts.day !== jstDay()) Object.assign(localGifts, { day: jstDay(), sent: 0 });
  if (localGifts.sent >= GIFT_RULES.perDay) fail('gift_limit', 409);
  const taste = tasteOf(star, giftId);
  const known = localGifts.known[star] ?? [];
  const wished = taste === 'liked' && known.includes(giftId);
  localGifts.sent += 1;
  if (taste === 'liked' && !wished) localGifts.known[star] = [...known, giftId];
  const xp = state.affinity[star] + giftXp(giftId, taste);
  return {
    star, giftId, taste, wished, reaction: giftReaction(star, giftId, taste, wished, lang), affinityXp: xp, level: levelFromXp(xp),
    // The store runs the stage machine for prototype mode (a gift is XP, not a day together).
    relationship: viewOf(star, state.rel[star] ?? freshRelationship(new Date().toISOString()), xp),
    points: state.points - gift.price, freePulls: state.freePulls, sentToday: localGifts.sent, perDay: GIFT_RULES.perDay,
    known: localGifts.known[star] ?? [], variant: null
  };
}

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  PICKUP_RULES, RULES, VARIANT_CARDS, jstDay, localText, pickupDisclosure, pickupLive, pickupPoolId, pickupProblems, poolCards,
  type CardDef, type ChatPickupT, type Lang, type PickupRatesT, type StarId
} from '@jstar/shared';
import { LINES } from '@jstar/shared/lines';
import type { PickupRow, Repos, UserRow } from '../db/types';
import type { AgentOutfitOption, AgentSceneOption } from './agent';
import { linesUsable } from './wakeup';
import { offerableFor } from './sceneTriggers';

/**
 * Pickups (#78, docs/requirements.md §14.2): her own pool for an announced window, with her variant card at
 * PICKUP_RULES.share of SSR or better — and the way her chat leads to one. Odds and draws: packages/shared/src/gacha.ts.
 * Compliance (docs/compliance-jp.md §3.1): the odds are copied into the Pickup when it is created, published on the pool
 * and on 提供割合 from the moment it is scheduled, and never change while it runs.
 */

/** Her 30 cards: a Pickup is always her regular pool with one card boosted. */
export const herPool = (all: CardDef[], star: StarId) => poolCards(`star:${star}`, all);

/** 提供割合 of one Pickup, computed from its stored config. */
export function pickupRates(p: PickupRow, all: CardDef[], now = Date.now()): PickupRatesT {
  return {
    id: p.id, star: p.star, cardId: p.cardId, startsAt: p.startsAt, endsAt: p.endsAt, live: pickupLive(p, now),
    ...pickupDisclosure(herPool(all, p.star), p, p.rates)
  };
}

/** Pickups that are live or still to come, soonest first: what 提供割合 announces and the gacha page offers. */
export async function publishedPickups(repos: Repos, now = Date.now()): Promise<PickupRatesT[]> {
  const [rows, all] = await Promise.all([repos.pickups.all(), repos.cards.all()]);
  return rows.filter((p) => Date.parse(p.endsAt) > now).map((p) => pickupRates(p, all, now));
}

/** The live Pickup of a card, if any. */
export async function livePickupOf(repos: Repos, cardId: string, now = Date.now()): Promise<PickupRow | null> {
  return (await repos.pickups.all()).find((p) => p.cardId === cardId && pickupLive(p, now)) ?? null;
}

/**
 * The admin's schedule for a Pickup, checked: a variant card, a window of at most PICKUP_RULES.maxDays that has not
 * already ended, no overlap with another Pickup of the same card, and odds that really raise the card
 * (pickupProblems). Once it has started, only its end may move; the odds of an existing Pickup are never rewritten.
 * Returns the row to store, or an error code.
 */
export async function planPickup(repos: Repos, req: { cardId: string; startsAt: string; endsAt: string }, actorId: string, now = Date.now()):
  Promise<{ ok: true; row: PickupRow; created: boolean } | { ok: false; error: string }> {
  const all = await repos.cards.all();
  const card = all.find((c) => c.id === req.cardId);
  if (!card || !VARIANT_CARDS.includes(card.id)) return { ok: false, error: 'not_a_variant' };
  const start = Date.parse(req.startsAt);
  const end = Date.parse(req.endsAt);
  if (!(end > start)) return { ok: false, error: 'bad_window' };
  if (end - start > PICKUP_RULES.maxDays * 86_400_000) return { ok: false, error: 'window_too_long' };
  const id = pickupPoolId(card.id, new Date(start).toISOString());
  const existing = await repos.pickups.byId(id);
  const others = (await repos.pickups.all()).filter((p) => p.cardId === card.id && p.id !== id);
  if (others.some((p) => Date.parse(p.startsAt) < end && start < Date.parse(p.endsAt))) return { ok: false, error: 'pickup_overlap' };
  if (existing) {
    if (Date.parse(existing.startsAt) <= now && Date.parse(existing.startsAt) !== start) return { ok: false, error: 'pickup_started' };
    // Ending it now (or at a time already past) is how the admin stops one early.
    return { ok: true, created: false, row: { ...existing, startsAt: new Date(start).toISOString(), endsAt: new Date(end).toISOString() } };
  }
  if (end <= now) return { ok: false, error: 'already_ended' };
  const rates = { ...RULES.rates };
  const odds = { cardId: card.id, share: PICKUP_RULES.share };
  const problems = pickupProblems(herPool(all, card.star), odds, rates);
  if (problems.length) return { ok: false, error: `invalid_pickup:${problems.join(',')}` };
  return {
    ok: true, created: true,
    row: { id, cardId: card.id, star: card.star, share: odds.share, rates, startsAt: new Date(start).toISOString(), endsAt: new Date(end).toISOString(), createdAt: new Date(now).toISOString(), createdBy: actorId }
  };
}

// ---------------------------------------------------------------- her chat leads to it

/**
 * Her invitation lines (#82) that may introduce a Pickup: the first two of her three. The third frames it as "only
 * now / this month", which is the countdown pressure #78 rules out, so it is never used for this.
 */
const INVITE_LINES = [0, 1] as const;

/**
 * Whether she may bring up this Pickup on her own this turn (PICKUP_RULES.invite, 待确认): reviewed lines (drafts on the
 * test site only), no Pickup shown to him in her chat within `gapMs`, fewer than `perPickup` invitations for this
 * Pickup, then a roll of `rate`. Whether the moment is right (he is not upset, tired or curt) is the persona
 * service's call on the turn itself.
 */
export async function mayInvite(app: FastifyInstance, userId: string, star: StarId, pickup: PickupRow, now: number, rng: () => number): Promise<boolean> {
  if (!linesUsable(star, app.demo)) return false;
  const since = Math.min(now - PICKUP_RULES.invite.gapMs, Date.parse(pickup.startsAt));
  const shown = await app.repos.events.ofUser(userId, 'variant.prompted', jstDay(since));
  if (shown.some((e) => Date.parse(e.createdAt) > now - PICKUP_RULES.invite.gapMs)) return false;
  const invited = shown.filter((e) => e.props.via === 'invite' && e.props.cardId === pickup.cardId && e.createdAt >= pickup.startsAt).length;
  if (invited >= PICKUP_RULES.invite.perPickup) return false;
  return rng() < PICKUP_RULES.invite.rate;
}

/** One of her invitation lines for this card, in his language (the model's example; the stub's words). */
export function inviteLine(star: StarId, lang: Lang, seed: number): string {
  const lines = LINES[star].variantInvite;
  return localText(lines[INVITE_LINES[Math.abs(seed) % INVITE_LINES.length]], lang);
}

/**
 * Her variant cards for this turn's intent pass (#65 `outfit:<cardId>`) and her own mention (#78). A failure costs
 * the turn its outfit talk, never the turn itself (the caller catches).
 */
export async function outfitOptions(app: FastifyInstance, user: UserRow, star: StarId, lang: Lang, scenes: AgentSceneOption[], now = Date.now(), rng: () => number = Math.random): Promise<AgentOutfitOption[]> {
  const [all, owned, pickups] = await Promise.all([app.repos.cards.all(), app.repos.owned.forUser(user.id), app.repos.pickups.all()]);
  const mine = all.filter((c) => c.star === star && VARIANT_CARDS.includes(c.id));
  const scripts = offerableFor(app, star);
  const out: AgentOutfitOption[] = [];
  for (const card of mine) {
    const has = owned.some((o) => o.cardId === card.id);
    const pickup = pickups.find((p) => p.cardId === card.id && pickupLive(p, now)) ?? null;
    // Asking for an outfit he has starts its variant scene when one is ready (#76).
    const script = scripts.find((s) => s.meta.trigger.variantCard === card.id);
    const sceneId = has && script && scenes.some((o) => o.id === script.meta.id && o.ready) ? script.meta.id : null;
    const invite = !has && !!pickup && out.every((o) => !o.invite) && (await mayInvite(app, user.id, star, pickup, now, rng));
    out.push({
      cardId: card.id, title: localText(card.title, lang), owned: has, pickup: !!pickup, invite,
      line: invite ? inviteLine(star, lang, Math.floor(rng() * 1000)) : null, sceneId
    });
  }
  return out;
}

/** What the persona service may send back for an outfit: `pickup` = he asked about one he lacks; `invite` = she brought it up. */
export const zOutfitDirective = z.object({ outfit: z.string().max(64), action: z.enum(['pickup', 'invite']) });

/**
 * The link under her line, if the agent's outfit directive holds: a listed card he does not own, a live Pickup, and
 * for `invite` only the card this turn allowed. Untrusted until here, like every directive.
 */
export async function pickupForTurn(repos: Repos, star: StarId, directive: unknown, outfits: AgentOutfitOption[], now = Date.now()): Promise<ChatPickupT | null> {
  const d = zOutfitDirective.safeParse(directive);
  if (!d.success) return null;
  const option = outfits.find((o) => o.cardId === d.data.outfit);
  if (!option || option.owned || !option.pickup) return null;
  if (d.data.action === 'invite' && !option.invite) return null;
  const live = await livePickupOf(repos, option.cardId, now);
  return live ? { poolId: live.id, cardId: live.cardId, star, via: d.data.action === 'invite' ? 'invite' : 'ask' } : null;
}

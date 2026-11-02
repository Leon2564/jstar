import { createHash } from 'node:crypto';
import { STAR_IDS, inviteNight, localText, variantCardOf, type StarId } from '@jstar/shared';
import { LINES, type StarLines } from '@jstar/shared/lines';
import { textsOf } from '../lib/inboxText';
import { variantSceneId } from '@jstar/shared/scenes/variantIds';
import { scenePlayable } from '@jstar/shared/scenes';
import { VARIANT_SCENES } from '@jstar/shared/scenes/variantScenes';
import type { InboxRow } from '../db/types';
import type { TickJob } from '../lib/tick';

/** Invite rows are found by this id prefix (owned.uninvited, inbox.withPrefix); the rest of the id says whose card it was. */
export const VARIANT_INVITE_PREFIX = 'vi_';
/** Her `variantInvite` line that is the invitation itself (#82: the other two are teasers for before he has it, #78). */
export const INVITE_LINE = 1;
/** New variant owners per run; the rest wait for the next tick (five minutes later), still inside the same night. */
const BATCH = 500;

/** One invite per user and variant card, ever: the id is derived from both, so the insert refuses a second. */
export const variantInviteId = (userId: string, cardId: string) =>
  `${VARIANT_INVITE_PREFIX}${createHash('sha256').update(`${userId}|${cardId}`).digest().toString('base64url').slice(0, 22)}`;

/**
 * The draw-night invite (#76): the evening he first gets her variant card — a draw, a Pickup, a printed code, the
 * shard exchange — she writes 「新しい服、届いたの。見てくれる？」 (her own words, lines/<star>.json `variantInvite`),
 * and opening it offers her first variant scene (`payload.sceneId`, the reveal).
 *
 * - "That evening": VARIANT_RULES.invite — a card first owned since this morning's 05:00 JST is invited from 18:00
 *   (at once when it came in the evening or at night). Only the night it came: never the next day, and a duplicate
 *   never counts (it keeps the first-owned time).
 * - Once per user and card (`variantInviteId`), however many ticks overlap.
 * - Only while her reveal can be played in this mode (the publish rule, `scenePlayable`: reviewed, and every clip
 *   exists — #81's since 2026-09-28) and her lines may be used (reviewed, not `draft`). Both hold today, so production
 *   sends it as well as the test site and demos.
 *
 * Before `inbox.deliver` in JOBS, so the invite and its push go out in the same tick.
 */
export function variantInvitesJob(lines: Record<StarId, StarLines> = LINES, batch = BATCH): TickJob {
  const reveal = new Map(VARIANT_SCENES.filter((s) => s.meta.trigger.variantLayer === 1).map((s) => [s.meta.star, s]));
  return {
    name: 'variant.invite',
    everyMs: 5 * 60_000 - 30_000,
    async run({ repos, now, signal, demo }) {
      const stars = STAR_IDS.filter((star) => {
        const scene = reveal.get(star);
        return !!scene && scenePlayable(scene, !!demo) && (!lines[star].draft || !!demo);
      });
      if (!stars.length) return { off: true };
      const night = inviteNight(now.getTime());
      if (!night.open) return { night: night.day, open: false };

      const cards = new Map(stars.flatMap((star) => { const card = variantCardOf(star); return card ? [[card, star] as const] : []; }));
      // Only owners not yet invited (and not banned or deleted), with their language: whoever is invited this tick
      // drops out of the next one, so a night with more than `batch` new owners is worked through tick by tick.
      const fresh = await repos.owned.uninvited([...cards.keys()], night.since, VARIANT_INVITE_PREFIX, batch);
      const at = now.toISOString();
      let n = 0;
      for (const o of fresh) {
        if (signal.aborted) break;
        const star = cards.get(o.cardId);
        if (!star) continue;
        const row: InboxRow = {
          id: variantInviteId(o.userId, o.cardId), userId: o.userId, star, kind: 'event',
          payload: { text: localText(lines[star].variantInvite[INVITE_LINE], o.lang), texts: textsOf(lines[star].variantInvite[INVITE_LINE]), event: 'variant', cardId: o.cardId, sceneId: variantSceneId(star, 1) },
          dueAt: at, deliveredAt: null, readAt: null, createdAt: at
        };
        if (await repos.inbox.addOnce(row)) n++;
      }
      return { night: night.day, candidates: fresh.length, sent: n };
    }
  };
}

export const variantInvites = variantInvitesJob();

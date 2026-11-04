import type { FastifyInstance } from 'fastify';
import { RULES, SerialRedeemReq, type RedemptionHistoryResT, drawLucky, extendPass, isVariantCard, normalizeSerial, poolCards, seeded, type DrawnCardT, type PoolId, type SerialRedeemResT } from '@jstar/shared';
import { ACTIVE_CARD_IDS } from '@jstar/shared/catalog';
import { env } from '../env';
import { hashSerial, newId } from '../lib/crypto';
import { deviceOf, httpError, requireHuman, requireUser } from '../app';
import { planned } from './gacha';

/**
 * Failed-attempt lockout (docs/requirements.md §5). A device locks after `serialMaxFailures`; an IP gets a larger
 * budget because a whole venue can share one (card events, shop Wi-Fi) and one person's typos must not lock everyone.
 * Process memory is enough for the single-instance demo; production moves this to Redis so instances share it.
 */
const IP_FAILURE_FACTOR = 4;
const TURNSTILE_AFTER_FAILURES = 2;

function createLockout() {
  const failures = new Map<string, { count: number; lockedUntil: number }>();
  const limitFor = (key: string) => (key.startsWith('ip:') ? RULES.serialMaxFailures * IP_FAILURE_FACTOR : RULES.serialMaxFailures);
  return {
    /** Wrong codes so far on the most-failed key (they reset when a lock starts). */
    failures: (keys: string[]) => Math.max(0, ...keys.map((k) => failures.get(k)?.count ?? 0)),
    lockedUntil: (keys: string[], now: number) => Math.max(0, ...keys.map((k) => failures.get(k)?.lockedUntil ?? 0).filter((t) => t > now)),
    fail(keys: string[], now: number) {
      for (const k of keys) {
        const row = failures.get(k) ?? { count: 0, lockedUntil: 0 };
        row.count += 1;
        if (row.count >= limitFor(k)) { row.count = 0; row.lockedUntil = now + RULES.serialLockMs; }
        failures.set(k, row);
      }
    }
  };
}

export async function registerSerial(app: FastifyInstance) {
  const lockout = createLockout();
  app.post('/verify', { config: { rateLimit: { max: 10, timeWindow: '10 minutes' } } }, async (req, reply) => {
    const device = deviceOf(req);
    const now = Date.now();
    const keys = [`ip:${req.ip}`, ...(device ? [`dev:${device}`] : []), ...(req.user ? [`usr:${req.user.id}`] : [])];
    const until = lockout.lockedUntil(keys, now);
    if (until) { reply.header('retry-after', String(Math.ceil((until - now) / 1000))); throw httpError('serial_locked', 429); }
    if (lockout.failures(keys) >= TURNSTILE_AFTER_FAILURES) await requireHuman(app, req);
    const { code } = SerialRedeemReq.parse({ code: normalizeSerial((req.body as { code?: string })?.code ?? '') });
    const row = await app.repos.serials.byHash(hashSerial(code, env.SERIAL_HMAC_KEY));
    if (!row) { lockout.fail(keys, now); throw httpError('serial_not_found', 404); }
    if (row.redeemedAt) throw httpError('serial_already_used', 409);
    return { valid: true as const };
  });
  /**
   * Redeem the code on a physical lucky card: RULES.lucky.drawsPerCode cards (the first SR or better) and the
   * pass days of its batch. Visitors may redeem too: cards and days wait on their device and move to the account
   * at sign-up, so the first experience is never blocked by a form. Validity, single use and the draw are
   * decided here, never on the client; the seed is stored so a disputed result can be replayed.
   */
  app.post('/redeem', { config: { rateLimit: { max: 10, timeWindow: '10 minutes' } } }, async (req, reply): Promise<SerialRedeemResT> => {
    const device = deviceOf(req);
    if (!req.user && !device) throw httpError('device_id_required', 400);
    const now = Date.now();
    const keys = [`ip:${req.ip}`, ...(device ? [`dev:${device}`] : []), ...(req.user ? [`usr:${req.user.id}`] : [])];
    const until = lockout.lockedUntil(keys, now);
    if (until) {
      reply.header('retry-after', String(Math.ceil((until - now) / 1000)));
      throw httpError('serial_locked', 429);
    }

    // After two wrong codes the next attempt must pass a bot check: guessing codes is the attack this route faces.
    if (lockout.failures(keys) >= TURNSTILE_AFTER_FAILURES) await requireHuman(app, req);

    // A typo the check digit catches is not a guess at a code, so it does not count towards the lockout.
    const { code } = SerialRedeemReq.parse({ code: normalizeSerial((req.body as { code?: string })?.code ?? '') });
    const row = await app.repos.serials.byHash(hashSerial(code, env.SERIAL_HMAC_KEY));
    if (!row) { lockout.fail(keys, now); throw httpError('serial_not_found', 404); }
    if (row.redeemedAt) throw httpError('serial_already_used', 409);

    const choice = req.body as { count?: number; pool?: string };
    const count = choice.count === 1 || choice.count === 6 ? choice.count : 6;
    const poolId = choice.pool === 'all' || ['mahiro', 'nana', 'unpai', 'alice', 'eimi'].some((star) => choice.pool === `star:${star}`)
      ? choice.pool as PoolId : 'all';
    const pool = poolCards(poolId, await app.repos.cards.all()).filter((card) => ACTIVE_CARD_IDS.has(card.id));
    if (!pool.length) throw httpError('pool_empty', 409);
    const seed = (now ^ Math.floor(Math.random() * 0xffffffff)) >>> 0;
    const drawn = drawLucky(pool, seeded(seed), count);
    const at = new Date(now).toISOString();
    const user = req.user;
    const ownerId = user ? user.id : `device:${device}`;
    const drawId = newId('drw');
    const passUntil = user ? (row.trialDays > 0 ? extendPass(user.passUntil, row.trialDays, now) : user.passUntil) : null;
    const outcome = await app.repos.lucky.redeem({
      serialId: row.id,
      owner: user ? { userId: user.id } : { device: device! },
      cards: drawn.map((d) => planned(d.card)),
      passUntil,
      trialDays: row.trialDays,
      bondXp: RULES.lucky.duplicateBondXp,
      draw: { id: drawId, ownerId, poolId, serialId: row.id, cardIds: drawn.map((d) => d.card.id), tiers: drawn.map((d) => d.tier), cost: 0, seed: String(seed), createdAt: at },
      at
    });
    // Lost the race to a parallel request with the same code: nothing of ours was written.
    if (!outcome.ok) throw httpError('serial_already_used', 409);

    let isNew = outcome.isNew;
    if (!user) {
      // A visitor's cards are new unless an earlier code on this device (or this one) already gave them.
      const seen = new Set((await app.repos.devices.get(device!)).redemptions.filter((r) => r.serialId !== row.id).flatMap((r) => r.cardIds));
      isNew = drawn.map((d) => { const first = !seen.has(d.card.id); seen.add(d.card.id); return first; });
    }
    // A visitor has no account to count the event for; the funnel starts at a prompt, which needs one anyway.
    if (user) for (const d of drawn) if (isVariantCard(d.card.id)) await app.recordEvent(user.id, 'variant.drawn', { star: d.card.star, cardId: d.card.id });
    if (user && !(await app.repos.users.adjustWallet(user.id, { points: RULES.serialPoints }))) throw httpError('wallet_update_failed', 409);
    await app.repos.audit.add({ id: newId('aud'), actorId: user?.id ?? `device:${device}`, action: 'serial.redeem', target: row.id, meta: { drawId, cards: drawn.map((d) => d.card.id) }, createdAt: at });
    const cards: DrawnCardT[] = drawn.map((d, i) => ({ id: d.card.id, star: d.card.star, rarity: d.card.rarity, isNew: isNew[i] }));
    return { cards, trialDays: row.trialDays, claimed: !!user, passUntil, drawId, pointsGranted: RULES.serialPoints };
  });

  /** 兑换记录: every printed code this account redeemed or claimed from its device, with the cards it drew. */
  app.get('/history', async (req): Promise<RedemptionHistoryResT> => {
    const user = requireUser(req);
    const rarity = new Map((await app.repos.cards.all()).map((c) => [c.id, c.rarity]));
    return {
      redemptions: (await app.repos.draws.codesForOwner(user.id)).map((d) => ({
        serialId: d.serialId!, drawId: d.id, createdAt: d.createdAt,
        cards: d.cardIds.map((id, i) => ({ id, rarity: (d.tiers?.[i] ?? rarity.get(id) ?? 'N') as RedemptionHistoryResT['redemptions'][number]['cards'][number]['rarity'] }))
      }))
    };
  });
}

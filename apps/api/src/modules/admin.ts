import type { FastifyInstance } from 'fastify';
import {
  AdminCardUpsertReq, AdminGrantReq, AdminMetricsQuery, AdminPickupReq, AdminSerialBatchReq, AdminVoidReq, addDays, isValidSerialFormat, jstDay, luhnCheckDigit, normalizeSerial, weekStart,
  type AdminMetricsResT, type AdminPickupsResT, type MetricsCountsT
} from '@jstar/shared';
import { pickupRates, planPickup } from '../lib/pickup';
import { httpError, requireAdmin } from '../app';
import { env } from '../env';
import { hashSerial, newId } from '../lib/crypto';
import { VOID, zeroCounts, type SerialRow } from '../db/types';
import { randomInt } from 'node:crypto';

/** Same shape as the printed codes (tools/luckcards): 12 digits, first 1–9, Luhn check digit last. */
function generateCode(): string {
  const digits = [randomInt(1, 10), ...Array.from({ length: 10 }, () => randomInt(0, 10))];
  return digits.join('') + luhnCheckDigit(digits);
}

export async function registerAdmin(app: FastifyInstance) {
  app.get('/cards', async (req) => { requireAdmin(req); return { cards: await app.repos.cards.all() }; });

  app.put('/cards', async (req) => {
    const actor = requireAdmin(req);
    const card = AdminCardUpsertReq.parse(req.body);
    const existing = (await app.repos.cards.all()).find((c) => c.id === card.id);
    await app.repos.cards.upsert({ line: null, story: null, ...existing, ...card });
    await app.repos.audit.add({ id: newId('aud'), actorId: actor.id, action: 'card.upsert', target: card.id, meta: { rarity: card.rarity, source: card.source }, createdAt: new Date().toISOString() });
    return { ok: true };
  });

  /**
   * Issue a small batch of lucky-card codes (events, partner samples) with the same key as the print runs.
   * The plaintext codes are returned exactly once — they are stored hashed and cannot be recovered.
   * Print runs are generated offline with tools/luckcards and imported into D1, not through this endpoint.
   */
  app.post('/serial-batches', async (req) => {
    const actor = requireAdmin(req);
    const batch = AdminSerialBatchReq.parse(req.body);
    const id = newId('bat');
    const codes = new Set<string>();
    while (codes.size < batch.quantity) codes.add(generateCode());
    const rows = [...codes].map((code, i) => ({ id: `${id}-${String(i + 1).padStart(5, '0')}`, codeHash: hashSerial(code, env.SERIAL_HMAC_KEY) }));
    const added = await app.repos.serials.createBatch(
      { id, label: batch.label, quantity: batch.quantity, trialDays: batch.trialDays, draws: batch.draws, createdAt: new Date().toISOString() }, rows
    );
    // A collision with an existing code (1 in ~10^8 per code) is skipped by the store; never hand out a code that was not stored.
    if (added !== rows.length) throw httpError('code_collision_retry', 409);
    await app.repos.audit.add({ id: newId('aud'), actorId: actor.id, action: 'serial.batch', target: id, meta: { quantity: batch.quantity, trialDays: batch.trialDays, draws: batch.draws }, createdAt: new Date().toISOString() });
    return { batchId: id, codes: [...codes] };
  });

  /**
   * 指標 (#52): the v1.1 success metrics (#47) as raw counts per JST day or week, zero-filled, plus the whole range.
   * The queries live in the stores (db/sql.ts, and its twin in db/memory.ts) so both backends answer the same test.
   */
  app.get('/metrics', async (req): Promise<AdminMetricsResT> => {
    requireAdmin(req);
    const { grain, days } = AdminMetricsQuery.parse(req.query);
    const to = jstDay();
    const start = addDays(to, -(days - 1));
    // Whole weeks only, so the first week is not a partial one that reads as a drop.
    const from = grain === 'week' ? weekStart(start) : start;
    const [periods, [whole]] = await Promise.all([app.repos.events.metrics(from, to, grain), app.repos.events.metrics(from, to, 'all')]);
    const found = new Map(periods.map((p) => [p.period, p]));
    const filled = [];
    for (let p = from; p <= to; p = addDays(p, grain === 'week' ? 7 : 1)) filled.push(found.get(p) ?? { period: p, ...zeroCounts() });
    let total: MetricsCountsT = zeroCounts();
    if (whole) { const { period: _period, ...counts } = whole; total = counts; }
    return { asOf: to, grain, from, to, total, periods: filled };
  });

  /** Pickups (#78), every one ever scheduled (the draws name them), with the odds they publish. */
  app.get('/pickups', async (req): Promise<AdminPickupsResT> => {
    requireAdmin(req);
    const [rows, all] = await Promise.all([app.repos.pickups.all(), app.repos.cards.all()]);
    return { pickups: rows.map((p) => pickupRates(p, all)) };
  });

  /**
   * Schedules a Pickup, or moves its end (#78). The odds come from PICKUP_RULES when it is created and are then fixed;
   * the window is published on 提供割合 as soon as it is saved, so a change of odds is announced before it starts
   * (docs/compliance-jp.md §3). Audited like every change that touches a rate.
   */
  app.put('/pickups', async (req) => {
    const actor = requireAdmin(req);
    const body = AdminPickupReq.parse(req.body);
    const plan = await planPickup(app.repos, body, actor.id);
    if (!plan.ok) throw httpError(plan.error, 409);
    await app.repos.pickups.upsert(plan.row);
    await app.repos.audit.add({
      id: newId('aud'), actorId: actor.id, action: plan.created ? 'pickup.create' : 'pickup.update', target: plan.row.id,
      meta: { cardId: plan.row.cardId, share: plan.row.share, startsAt: plan.row.startsAt, endsAt: plan.row.endsAt }, createdAt: new Date().toISOString()
    });
    return { pickup: pickupRates(plan.row, await app.repos.cards.all()) };
  });

  app.get('/audit', async (req) => { requireAdmin(req); return { entries: await app.repos.audit.recent(200) }; });

  /** Moderation queue: the latest hard-blocked chat messages (an 80-character excerpt each), newest first. */
  app.get('/moderation', async (req) => {
    requireAdmin(req);
    return { entries: await app.repos.audit.byAction('chat.blocked', 200) };
  });

  /** Support: one account by e-mail (or id) — wallet, cards held, codes redeemed and the latest draws. */
  app.get('/users', async (req) => {
    requireAdmin(req);
    const { email, id } = req.query as { email?: string; id?: string };
    const user = id ? await app.repos.users.byId(id) : email ? await app.repos.users.byEmail(email.trim().toLowerCase()) : null;
    if (!user) throw httpError('user_not_found', 404);
    const [owned, codes, draws] = await Promise.all([app.repos.owned.forUser(user.id), app.repos.draws.codesForOwner(user.id), app.repos.draws.forOwner(user.id, 20)]);
    return {
      user: {
        id: user.id, email: user.email, nickname: user.nickname, via: user.via, createdAt: user.createdAt, banned: user.banned,
        points: user.points, freePulls: user.freePulls, pity: user.pity, shards: user.shards, passUntil: user.passUntil, birthdayConfirmed: !!user.birthday
      },
      owned: owned.map((o) => ({ cardId: o.cardId, copies: o.copies, viaSerial: o.viaSerial })),
      codes: codes.map((d) => ({ serialId: d.serialId, drawId: d.id, cards: d.cardIds, createdAt: d.createdAt })),
      draws: draws.reverse().map((d) => ({ id: d.id, pool: d.poolId, cost: d.cost, cards: d.cardIds, createdAt: d.createdAt }))
    };
  });

  /** Compensation (補填) after an incident: points and/or free pulls, always with a reason in the audit log. */
  app.post('/users/:id/grant', async (req) => {
    const actor = requireAdmin(req);
    const { id } = req.params as { id: string };
    const grant = AdminGrantReq.parse(req.body);
    const user = await app.repos.users.adjustWallet(id, { points: grant.points, freePulls: grant.freePulls });
    if (!user) throw httpError('user_not_found', 404);
    await app.repos.audit.add({ id: newId('aud'), actorId: actor.id, action: 'user.grant', target: id, meta: grant, createdAt: new Date().toISOString() });
    return { points: user.points, freePulls: user.freePulls };
  });

  /** A code's state, looked up by the code a customer reads out, or by the serial number printed next to it. */
  app.get('/serials', async (req) => {
    requireAdmin(req);
    const { code, id } = req.query as { code?: string; id?: string };
    let row: SerialRow | null = null;
    if (code) {
      const c = normalizeSerial(code);
      if (!isValidSerialFormat(c)) throw httpError('invalid_serial_format', 400);
      row = await app.repos.serials.byHash(hashSerial(c, env.SERIAL_HMAC_KEY));
    } else if (id) row = await app.repos.serials.byId(id.trim());
    if (!row) throw httpError('serial_not_found', 404);
    const status = !row.redeemedAt ? 'unused' : row.redeemedByDevice === VOID ? 'void' : 'redeemed';
    return {
      id: row.id, batchId: row.batchId, status, redeemedAt: row.redeemedAt,
      redeemedByUserId: row.redeemedByUserId, pendingOnDevice: !!row.redeemedByDevice && row.redeemedByDevice !== VOID && !row.redeemedByUserId
    };
  });

  /** Voids an unredeemed code (lost, leaked or misprinted card). A redeemed code is never taken back here. */
  app.post('/serials/:id/void', async (req) => {
    const actor = requireAdmin(req);
    const { id } = req.params as { id: string };
    const { reason } = AdminVoidReq.parse(req.body);
    if (!(await app.repos.serials.byId(id))) throw httpError('serial_not_found', 404);
    if (!(await app.repos.serials.void(id, new Date().toISOString()))) throw httpError('serial_already_used', 409);
    await app.repos.audit.add({ id: newId('aud'), actorId: actor.id, action: 'serial.void', target: id, meta: { reason }, createdAt: new Date().toISOString() });
    return { ok: true };
  });
}

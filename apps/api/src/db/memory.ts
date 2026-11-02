import { RULES, addDays, countDay, freshConfession, freshRelationship, variantLevelOf, weekStart, type CardDef, type EventName, type StarId, type TriggerSource, type VariantGain } from '@jstar/shared';
import { OTP_MAX_ATTEMPTS, VOID, zeroCounts, type AuditRow, type CardAffectionRow, type EventRow, type MetricsGrouping, type MetricsPeriodRow, type BatchRow, type ChatMemoryRow, type DeviceRow, type DrawRow, type InboxRow, type JobRunRow, type MemoryRow, type MessageRow, type OwnedRow, type PlannedCard, type PoolRow, type PickupRow, type Repos, type SerialRow, type UserRow, type PushSubscriptionRow, type RelationshipRow, type SceneGrant, type SceneRunRow, type SceneOfferRow } from './types';
import type { ConfessionRow, ConfessionVoiceRow, FirstSnowRow, UserCityRow, WeatherRow } from './types';
import { promiseInboxId, type PromiseRow } from './types';
import type { AlarmRow } from './types';
import type { HerMessageKey, HerMessageRow, HerPlanCandidate } from './types';
import type { HerMessageMode } from '@jstar/shared/herMessages';
import type { GiftPlan, GiftRow, SceneExtension, VoiceDayRow, VoiceLedgerRow } from './types';
import type { CallNameState } from '@jstar/shared/bond';
import type { CalendarCandidate } from './types';

/**
 * In-memory storage: used by tests and by `npm run dev` before Postgres is wired up.
 * Each conditional method does its check and write without an `await` in between, which makes it
 * atomic on Node's single thread — the SQL versions must be single conditional UPDATEs for the same reason.
 */
export function createMemoryRepos(seed?: { cards?: CardDef[]; pools?: PoolRow[] }): Repos {
  const users = new Map<string, UserRow>();
  const devices = new Map<string, DeviceRow>();
  const otps = new Map<string, { code: string; expiresAt: number; attempts: number }>();
  const signupBlocks = new Map<string, string>();
  /** Stored without the batch fields; `serialRow` joins them in, as the SQL version does. */
  const serials = new Map<string, Omit<SerialRow, 'trialDays' | 'draws'>>();
  const batches = new Map<string, BatchRow>();
  const cards = new Map<string, CardDef>((seed?.cards ?? []).map((c) => [c.id, c]));
  const pools = new Map<string, PoolRow>((seed?.pools ?? []).map((p) => [p.id, p]));
  const pickups = new Map<string, PickupRow>();
  const owned: OwnedRow[] = [];
  const cardAffection = new Map<string, CardAffectionRow>();
  const memories: MemoryRow[] = [];
  let messages: MessageRow[] = [];
  const affinity = new Map<string, number>();
  const draws: DrawRow[] = [];
  const audit: AuditRow[] = [];
  const chatMemory = new Map<string, ChatMemoryRow>();
  /** Insertion order is kept, like SQL rowid, to break ties between rows delivered at the same instant. */
  let inbox: InboxRow[] = [];
  const jobRuns = new Map<string, JobRunRow>();
  const copyInbox = (r: InboxRow): InboxRow => ({ ...r, payload: structuredClone(r.payload) });
  const events: EventRow[] = [];
  const pushSubs = new Map<string, PushSubscriptionRow>();
  const sceneRuns = new Map<string, SceneRunRow>();
  const relationships = new Map<string, RelationshipRow>();
  /** Runs are copied in and out so a caller holding a row can never change what is stored. */
  const copyRun = (r: SceneRunRow): SceneRunRow => JSON.parse(JSON.stringify(r)) as SceneRunRow;
  const sceneOffers = new Map<string, SceneOfferRow>();
  const weather = new Map<string, WeatherRow>();
  const copyWeather = (r: WeatherRow): WeatherRow => ({ ...r, data: r.data ? structuredClone(r.data) : null });
  const firstSnows: FirstSnowRow[] = [];
  const userCities = new Map<string, UserCityRow>();
  let promises: PromiseRow[] = [];
  let herMsgs: HerMessageRow[] = [];
  const herPrefs = new Map<string, { mode: HerMessageMode; updatedAt: string }>();
  const sameHer = (a: HerMessageKey, b: HerMessageKey) => a.userId === b.userId && a.day === b.day && a.kind === b.kind;
  let gifts: GiftRow[] = [];
  let voiceRows: VoiceLedgerRow[] = [];
  /** An extension (#74): the row and the points, for a new request id under today's cap with the points; else null. */
  /** Why a gift cannot be bought now (#77), or null. */
  const giftRefusal = ({ row, perDay }: GiftPlan): 'limit' | 'insufficient' | null => {
    if (gifts.filter((g) => g.userId === row.userId && g.day === row.day).length >= perDay) return 'limit';
    return mustUser(row.userId).points < row.price ? 'insufficient' : null;
  };
  const canGive = (plan: GiftPlan) => !giftRefusal(plan);
  /** Buys a gift that `canGive`: points, the row, her XP and a variant's share. */
  const give = ({ row, variant }: GiftPlan): { next: UserRow; affinityXp: number } => {
    const user = mustUser(row.userId);
    const next = { ...user, points: user.points - row.price };
    users.set(user.id, next);
    gifts.push({ ...row });
    const affinityXp = addXp(row.userId, row.star, row.xp);
    if (variant) addVariant(row.userId, variant.cardId, row.star, variant.gain);
    return { next, affinityXp };
  };
  const buyExtension = ({ row, perDay }: SceneExtension): UserRow | null => {
    const user = mustUser(row.userId);
    if (voiceRows.some((v) => v.userId === row.userId && v.requestId === row.requestId)) return null;
    if (voiceDay(row.userId, row.day).extensions >= perDay || user.points < row.points) return null;
    const next = { ...user, points: user.points - row.points };
    users.set(user.id, next);
    voiceRows.push({ ...row });
    return next;
  };
  const voiceDay = (userId: string, day: string): VoiceDayRow => {
    const rows = voiceRows.filter((v) => v.userId === userId && v.day === day);
    return { day, usedSeconds: rows.filter((v) => v.kind !== 'extend').reduce((n, v) => n + v.seconds, 0), extensions: rows.filter((v) => v.kind === 'extend').length };
  };
  const copyPromise = (r: PromiseRow): PromiseRow => ({ ...r });
  const openWith = (userId: string, star: StarId) => promises.some((p) => p.userId === userId && p.star === star && p.status === 'open');
  /** Reads a promise's inbox line (if it has one): she keeps or gives up on it, the badge goes. */
  const readPromiseLine = (promiseId: string, at: string) => {
    const line = inbox.find((r) => r.id === promiseInboxId(promiseId));
    if (line) line.readAt ??= at;
  };
  const alarms = new Map<string, AlarmRow>();
  const copyAlarm = (a: AlarmRow): AlarmRow => ({ ...a, days: [...a.days] });
  const confessions = new Map<string, ConfessionRow>();
  /** The recording is kept apart from the row, like the SQL version's lists that never select it. */
  const voices = new Map<string, ConfessionVoiceRow & { audio: string | null }>();
  const callNames = new Map<string, CallNameState>();
  const praise = new Map<string, Record<string, number>>();
  const callNamePrefs = new Map<string, string>();
  /** #51: a memory card as the SQL version reads it back, `kind` defaulting to chat. */
  const memoryOf = (m: MemoryRow): MemoryRow => ({ ...m, kind: m.kind ?? 'chat', sceneId: m.sceneId ?? null, still: m.still ?? null });
  const memoryExports = new Map<string, string>();
  const memoryPurges = new Map<string, { requestedAt: string; triedAt: string | null }>();
  const confessionOf = (userId: string, star: StarId): ConfessionRow => confessions.get(key(userId, star)) ?? { ...freshConfession(), userId, star };
  const now = () => new Date().toISOString();
  const key = (u: string, s: StarId) => `${u}:${s}`;
  const device = (id: string) => {
    let row = devices.get(id);
    if (!row) { row = { id, trialUsed: 0, redemptions: [] }; devices.set(id, row); }
    return row;
  };
  const mustUser = (id: string) => {
    const row = users.get(id);
    if (!row) throw new Error('user_not_found');
    return row;
  };
  const serialRow = (row: Omit<SerialRow, 'trialDays' | 'draws'>): SerialRow => {
    const batch = batches.get(row.batchId)!;
    return { ...row, trialDays: batch.trialDays, draws: batch.draws };
  };
  /** Adds one copy; true when it is the first. */
  const grant = (userId: string, cardId: string, viaSerial: boolean) => {
    const row = owned.find((o) => o.userId === userId && o.cardId === cardId);
    if (row) { row.copies += 1; return false; }
    owned.push({ userId, cardId, copies: 1, firstOwnedAt: now(), viaSerial });
    return true;
  };
  const grantScene = (userId: string, star: StarId, g: SceneGrant) => {
    if (g.affinity > 0) addXp(userId, star, g.affinity);
    memories.push(...g.memories.map(memoryOf));
    if (g.variant) addVariant(userId, g.variant.cardId, star, g.variant.gain);
    for (const p of g.promises ?? []) if (!openWith(p.userId, p.star)) promises.push(copyPromise(p));
  };
  /** Variant XP and 心意 on the card, its main share on her affinity (#75). */
  const addVariant = (userId: string, cardId: string, star: StarId, g: VariantGain): CardAffectionRow => {
    const k = `${userId}:${cardId}`;
    const prev = cardAffection.get(k);
    const xp = (prev?.xp ?? 0) + g.xp;
    const row = { userId, cardId, xp, level: variantLevelOf(xp, prev?.level ?? 1), kokoro: (prev?.kokoro ?? 0) + g.kokoro, homePinned: prev?.homePinned ?? false, updatedAt: now() };
    cardAffection.set(k, row);
    if (g.mainXp > 0) addXp(userId, star, g.mainXp);
    return { ...row };
  };
  /** Adds a copy; a duplicate of a variant card also brings its 心意. True when it is the first. */
  const grantPlanned = (userId: string, c: PlannedCard, viaSerial: boolean) => {
    const first = grant(userId, c.cardId, viaSerial);
    if (!first && c.variant) addVariant(userId, c.cardId, c.star, c.variant);
    return first;
  };
  const addXp = (userId: string, star: StarId, xp: number) => {
    const next = (affinity.get(key(userId, star)) ?? 0) + xp;
    affinity.set(key(userId, star), next);
    return next;
  };

  return {
    users: {
      async byId(id) { return users.get(id) ?? null; },
      async byEmail(email) { return [...users.values()].find((u) => u.email === email) ?? null; },
      async create(u) { const row = { ...u, createdAt: now() }; users.set(row.id, row); return row; },
      async update(id, patch) {
        const next = { ...mustUser(id), ...patch };
        users.set(id, next);
        return next;
      },
      async adjustWallet(id, { points = 0, freePulls = 0 }) {
        const row = mustUser(id);
        if (row.points + points < 0 || row.freePulls + freePulls < 0) return null;
        const next = { ...row, points: row.points + points, freePulls: row.freePulls + freePulls };
        users.set(id, next);
        return next;
      },
      async reserveChat(id, day, limit) {
        const row = mustUser(id);
        const used = row.chatDay === day ? row.chatUsedToday : 0;
        if (used >= limit) return null;
        const next = { ...row, chatDay: day, chatUsedToday: used + 1 };
        users.set(id, next);
        return next;
      },
      async releaseChat(id, day) {
        const row = mustUser(id);
        if (row.chatDay === day && row.chatUsedToday > 0) users.set(id, { ...row, chatUsedToday: row.chatUsedToday - 1 });
      },
      async dailyLogin(id, day, month, points) {
        const row = mustUser(id);
        if (row.loginDay === day) return null;
        const sameMonth = row.checkMonth === month;
        const next = { ...row, loginDay: day, points: row.points + points, checkMonth: month, checkDays: sameMonth ? row.checkDays + 1 : 1, checkClaimed: sameMonth ? row.checkClaimed : [] };
        users.set(id, next);
        return next;
      },
      async claimCheckIn(id, expected, next, { points = 0, freePulls = 0 }) {
        const row = mustUser(id);
        if (JSON.stringify(row.checkClaimed) !== JSON.stringify(expected)) return null;
        const updated = { ...row, checkClaimed: next, points: row.points + points, freePulls: row.freePulls + freePulls };
        users.set(id, updated);
        return updated;
      },
      async setBirthday(id, birthday) { const next = { ...mustUser(id), birthday }; users.set(id, next); return next; },
      async anonymise(id, at) {
        const row = mustUser(id);
        if (!memoryPurges.has(id)) memoryPurges.set(id, { requestedAt: at, triedAt: null });
        for (const k of [...memoryExports.keys()]) if (k.startsWith(`${id}:`)) memoryExports.delete(k);
        users.set(id, { ...row, email: null, lineSub: null, nickname: 'deleted', banned: true, birthday: null, tz: null });
        for (const [k, p] of pushSubs) if (p.userId === id) pushSubs.delete(k);
        messages = messages.filter((m) => m.ownerId !== id);
        for (let i = memories.length - 1; i >= 0; i--) if (memories[i].userId === id) memories.splice(i, 1);
        for (const k of [...chatMemory.keys()]) if (k.startsWith(`${id}:`)) chatMemory.delete(k);
        inbox = inbox.filter((r) => r.userId !== id);
        for (const e of events) if (e.userId === id) e.userId = null;
        for (const [k, r] of sceneRuns) if (r.userId === id) sceneRuns.delete(k);
        for (const [k, r] of sceneOffers) if (r.userId === id) sceneOffers.delete(k);
        for (const [k, r] of cardAffection) if (r.userId === id) cardAffection.delete(k);
        userCities.delete(id);
        for (const [k, r] of relationships) if (r.userId === id) relationships.delete(k);
        promises = promises.filter((p) => p.userId !== id);
        alarms.delete(id);
        for (const [k, r] of confessions) if (r.userId === id) confessions.delete(k);
        for (const [k, r] of voices) if (r.userId === id) voices.delete(k);
        herMsgs = herMsgs.filter((h) => h.userId !== id);
        herPrefs.delete(id);
        gifts = gifts.filter((g) => g.userId !== id);
        voiceRows = voiceRows.filter((v) => v.userId !== id);
        for (const k of [...callNames.keys()]) if (k.startsWith(`${id}:`)) callNames.delete(k);
        for (const k of [...praise.keys()]) if (k.startsWith(`${id}:`)) praise.delete(k);
        callNamePrefs.delete(id);
      }
    },
    devices: {
      async get(id) { const row = device(id); return { ...row, redemptions: row.redemptions.map((r) => ({ ...r, cardIds: [...r.cardIds] })) }; },
      async reserveTrial(id, limit) {
        const row = device(id);
        if (row.trialUsed >= limit) return null;
        row.trialUsed += 1;
        return limit - row.trialUsed;
      },
      async releaseTrial(id) { const row = device(id); row.trialUsed = Math.max(0, row.trialUsed - 1); }
    },
    otp: {
      async put(email, code, expiresAt) { otps.set(email, { code, expiresAt, attempts: 0 }); },
      async take(email, code) {
        const row = otps.get(email);
        if (!row) return 'expired';
        row.attempts += 1;
        if (row.attempts > OTP_MAX_ATTEMPTS) return 'attempts'; // B-N6: spent until a new code is put
        if (row.expiresAt < Date.now()) { otps.delete(email); return 'expired'; }
        if (row.code !== code) return 'invalid';
        otps.delete(email);
        return 'ok';
      }
    },
    signupBlocks: {
      async put(hash, until) { const cur = signupBlocks.get(hash); if (!cur || cur < until) signupBlocks.set(hash, until); },
      async until(hash, now) { const u = signupBlocks.get(hash); return u && u > now ? u : null; }
    },
    serials: {
      async byHash(hash) { const row = [...serials.values()].find((s) => s.codeHash === hash); return row ? serialRow(row) : null; },
      async createBatch(batch, rows) {
        if (!batches.has(batch.id)) batches.set(batch.id, batch);
        const hashes = new Set([...serials.values()].map((s) => s.codeHash));
        let added = 0;
        for (const { id, codeHash } of rows) {
          if (serials.has(id) || hashes.has(codeHash)) continue;
          serials.set(id, { id, codeHash, batchId: batch.id, redeemedByUserId: null, redeemedByDevice: null, redeemedAt: null });
          hashes.add(codeHash);
          added++;
        }
        return added;
      },
      async countByUser(userId) { return [...serials.values()].filter((s) => s.redeemedByUserId === userId).length; },
      async byId(id) { const row = serials.get(id); return row ? serialRow(row) : null; },
      async void(id, at) {
        const row = serials.get(id);
        if (!row || row.redeemedAt) return false;
        serials.set(id, { ...row, redeemedByDevice: VOID, redeemedAt: at });
        return true;
      }
    },
    gacha: {
      async draw(plan) {
        const row = mustUser(plan.userId);
        if (row.pity !== plan.expectPity) return { ok: false, reason: 'conflict' };
        if (row.points < plan.cost.points || row.freePulls < plan.cost.freePulls || row.shards + plan.shardsDelta < 0) return { ok: false, reason: 'insufficient' };
        const isNew = plan.cards.map((c) => grantPlanned(plan.userId, c, false));
        const duplicateShards = plan.cards.reduce((sum, c, i) => sum + (isNew[i] ? 0 : c.duplicateShards ?? 0), 0);
        const user = { ...row, points: row.points - plan.cost.points, freePulls: row.freePulls - plan.cost.freePulls, pity: plan.newPity, shards: row.shards + plan.shardsDelta + duplicateShards };
        users.set(user.id, user);
        draws.push(plan.draw);
        return { ok: true, user, isNew };
      }
    },
    lucky: {
      async redeem(plan) {
        const row = serials.get(plan.serialId);
        if (!row || row.redeemedAt) return { ok: false };
        const byUser = 'userId' in plan.owner ? plan.owner.userId : null;
        serials.set(row.id, { ...row, redeemedByUserId: byUser, redeemedByDevice: 'device' in plan.owner ? plan.owner.device : null, redeemedAt: plan.at });
        draws.push(plan.draw);
        if (!byUser) {
          device((plan.owner as { device: string }).device).redemptions.push({ serialId: row.id, cardIds: plan.cards.map((c) => c.cardId), trialDays: plan.trialDays });
          return { ok: true, isNew: plan.cards.map(() => false) };
        }
        const isNew = plan.cards.map((c) => {
          const first = grantPlanned(byUser, c, true);
          if (!first) {
            addXp(byUser, c.star, plan.bondXp);
            const current = mustUser(byUser);
            users.set(byUser, { ...current, shards: current.shards + (c.duplicateShards ?? 0) });
          }
          return first;
        });
        if (plan.passUntil) users.set(byUser, { ...mustUser(byUser), passUntil: plan.passUntil });
        return { ok: true, isNew };
      },
      async claim(user, deviceId, bondXp, passUntil, variantDup) {
        const row = device(deviceId);
        const taken = row.redemptions;
        if (!taken.length) return null;
        row.redemptions = [];
        const cardIds = taken.flatMap((r) => r.cardIds);
        for (const id of cardIds) {
          const star = cards.get(id)?.star;
          const variant = variantDup?.(id) ?? undefined;
          if (!star) { grant(user.id, id, true); continue; }
          const duplicateShards = cards.get(id)?.rarity ? RULES.duplicateShards[cards.get(id)!.rarity] : 0;
          if (!grantPlanned(user.id, { cardId: id, star, variant, duplicateShards }, true)) {
            addXp(user.id, star, bondXp);
            const current = mustUser(user.id);
            users.set(user.id, { ...current, shards: current.shards + duplicateShards });
          }
        }
        for (const r of taken) {
          const s = serials.get(r.serialId);
          if (s) serials.set(s.id, { ...s, redeemedByUserId: user.id });
        }
        for (const d of draws) if (d.ownerId === `device:${deviceId}`) d.ownerId = user.id;
        const trialDays = taken.reduce((n, r) => n + r.trialDays, 0);
        users.set(user.id, { ...mustUser(user.id), passUntil: passUntil(trialDays) });
        return { cardIds, trialDays, serials: taken.map((r) => r.serialId) };
      }
    },
    cards: { async all() { return [...cards.values()]; }, async upsert(c) { cards.set(c.id, c); } },
    pools: { async byId(id) { return pools.get(id) ?? null; }, async upsert(p) { pools.set(p.id, p); }, async all() { return [...pools.values()]; } },
    pickups: {
      async all() { return [...pickups.values()].sort((a, b) => a.startsAt.localeCompare(b.startsAt) || a.id.localeCompare(b.id)).map((p) => structuredClone(p)); },
      async byId(id) { const p = pickups.get(id); return p ? structuredClone(p) : null; },
      async upsert(p) { pickups.set(p.id, structuredClone(p)); }
    },
    owned: {
      async forUser(userId) { return owned.filter((o) => o.userId === userId); },
      async grant(userId, cardId, viaSerial) { return grant(userId, cardId, viaSerial); },
      async uninvited(cardIds, since, invitePrefix, limit) {
        const invited = new Set(inbox.filter((r) => r.id.startsWith(invitePrefix)).map((r) => `${r.userId}|${String(r.payload.cardId)}`));
        return owned.flatMap((o) => {
          const u = users.get(o.userId);
          return cardIds.includes(o.cardId) && o.firstOwnedAt >= since && u && !u.banned && !invited.has(`${o.userId}|${o.cardId}`)
            ? [{ ...o, lang: u.lang }] : [];
        }).sort((a, b) => a.firstOwnedAt.localeCompare(b.firstOwnedAt)).slice(0, limit);
      }
    },
    cardAffection: {
      async get(userId, cardId) { const r = cardAffection.get(`${userId}:${cardId}`); return r ? { ...r } : null; },
      async forUser(userId) { return [...cardAffection.values()].filter((r) => r.userId === userId).map((r) => ({ ...r })); },
      async add(userId, cardId, star, gain) { return addVariant(userId, cardId, star, gain); },
      async setPinned(userId, cardId, pinned) {
        const k = `${userId}:${cardId}`;
        const prev = cardAffection.get(k);
        const row: CardAffectionRow = { userId, cardId, xp: prev?.xp ?? 0, level: prev?.level ?? 1, kokoro: prev?.kokoro ?? 0, homePinned: pinned, updatedAt: now() };
        cardAffection.set(k, row);
        return { ...row };
      }
    },
    memories: { async forUser(userId) { return memories.filter((m) => m.userId === userId).map(memoryOf); }, async add(m) { memories.push(memoryOf(m)); } },
    messages: {
      async recent(ownerId, star, limit) { return messages.filter((m) => m.ownerId === ownerId && m.star === star).slice(-limit); },
      async add(m) { messages.push(m); },
      async countUser(ownerId, star) { return messages.filter((m) => m.ownerId === ownerId && m.star === star && m.role === 'user').length; },
      async reassign(fromOwner, toOwner) { messages = messages.map((m) => (m.ownerId === fromOwner ? { ...m, ownerId: toOwner } : m)); }
    },
    affinity: {
      async get(userId, star) { return affinity.get(key(userId, star)) ?? 0; },
      async all(userId) {
        const out: Partial<Record<StarId, number>> = {};
        for (const [k, xp] of affinity) if (k.startsWith(`${userId}:`)) out[k.slice(userId.length + 1) as StarId] = xp;
        return out;
      },
      async add(userId, star, xp) { return addXp(userId, star, xp); }
    },
    draws: { async add(d) { draws.push(d); }, async forOwner(ownerId, limit) { return draws.filter((d) => d.ownerId === ownerId).slice(-limit); },
      async codesForOwner(ownerId) { return draws.filter((d) => d.ownerId === ownerId && d.serialId).reverse(); } },
    audit: { async add(a) { audit.push(a); }, async recent(limit) { return audit.slice(-limit); }, async byAction(action, limit) { return audit.filter((a) => a.action === action).slice(-limit).reverse(); } },
    events: {
      async add(e) { events.push({ ...e, props: { ...e.props } }); },
      async purgeOldestDay(cutoff) {
        const oldest = events.reduce<string | null>((m, e) => (m === null || e.day < m ? e.day : m), null);
        if (!oldest || oldest >= cutoff) return 0;
        const before = events.length;
        for (let i = events.length - 1; i >= 0; i--) if (events[i].day === oldest) events.splice(i, 1);
        return before - events.length;
      },
      async metrics(from, to, grouping) { return memoryMetrics(events, from, to, grouping); },
      async activeRooms(sinceDay) {
        const last = new Map<string, { userId: string; star: StarId; lastDay: string }>();
        for (const e of events) {
          if (e.name !== 'room.entered' || !e.userId || e.day < sinceDay) continue;
          const star = e.props.star as StarId;
          const k = key(e.userId, star);
          const prev = last.get(k);
          if (!prev || e.day > prev.lastDay) last.set(k, { userId: e.userId, star, lastDay: e.day });
        }
        return [...last.values()];
      },
      async ofUser(userId, name, sinceDay) {
        return events.filter((e) => e.userId === userId && e.name === name && e.day >= sinceDay).map((e) => ({ createdAt: e.createdAt, props: { ...e.props } }));
      }
    },
    chatMemory: {
      async get(ownerId, star) {
        const row = chatMemory.get(key(ownerId, star));
        return row ? { ...row, facts: { ...row.facts }, greeting: row.greeting ? { ...row.greeting } : null, pending: row.pending.map((t) => ({ ...t })) } : null;
      },
      async save(ownerId, star, facts, summary) {
        const prev = chatMemory.get(key(ownerId, star));
        chatMemory.set(key(ownerId, star), { ownerId, star, facts: { ...facts }, summary, updatedAt: now(), greeting: prev?.greeting ?? null,
          pending: prev?.pending ?? [], pendingAt: prev?.pendingAt ?? null });
      },
      async setGreeting(ownerId, star, greeting) {
        const prev = chatMemory.get(key(ownerId, star));
        chatMemory.set(key(ownerId, star), prev ? { ...prev, greeting: { ...greeting } }
          : { ownerId, star, facts: {}, summary: null, updatedAt: now(), greeting: { ...greeting }, pending: [], pendingAt: null });
      },
      async addPending(ownerId, star, turns, at, max) {
        if (!turns.length) return;
        const prev = chatMemory.get(key(ownerId, star)) ?? { ownerId, star, facts: {}, summary: null, updatedAt: at, greeting: null, pending: [], pendingAt: null };
        chatMemory.set(key(ownerId, star), { ...prev, pending: [...prev.pending, ...turns.map((t) => ({ ...t }))].slice(-max), pendingAt: at });
      },
      async dropPending(ownerId, star, ids) {
        const prev = chatMemory.get(key(ownerId, star));
        if (!prev || !ids.length) return;
        const pending = prev.pending.filter((t) => !ids.includes(t.id));
        chatMemory.set(key(ownerId, star), { ...prev, pending, pendingAt: pending.length ? prev.pendingAt : null });
      },
      async quiet(before, limit) {
        return [...chatMemory.values()].filter((r) => r.pending.length && r.pendingAt && r.pendingAt < before)
          .sort((a, b) => (a.pendingAt! < b.pendingAt! ? -1 : 1)).slice(0, limit).map((r) => ({ ownerId: r.ownerId, star: r.star }));
      }
    },
    inbox: {
      async add(row) {
        if (inbox.some((r) => r.id === row.id)) throw new Error('inbox_id_taken');
        inbox.push(copyInbox(row));
      },
      async deliverDue(at, limit) {
        const due = inbox.filter((r) => !r.deliveredAt && r.dueAt <= at).sort((a, b) => (a.dueAt < b.dueAt ? -1 : a.dueAt > b.dueAt ? 1 : 0)).slice(0, limit);
        for (const r of due) r.deliveredAt = at;
        return due.map(copyInbox);
      },
      async forUser(userId, limit) {
        const mine = inbox.map((r, n) => ({ r, n })).filter(({ r }) => r.userId === userId && r.deliveredAt);
        mine.sort((a, b) => (a.r.readAt ? 1 : 0) - (b.r.readAt ? 1 : 0) || (a.r.deliveredAt! < b.r.deliveredAt! ? 1 : a.r.deliveredAt! > b.r.deliveredAt! ? -1 : b.n - a.n));
        return mine.slice(0, limit).map(({ r }) => copyInbox(r));
      },
      async deliveredSince(userId, star, prefix, since) {
        return inbox.filter((r) => r.userId === userId && r.star === star && r.id.startsWith(prefix) && !!r.deliveredAt && r.deliveredAt >= since).map(copyInbox);
      },
      async mine(userId, id) {
        const row = inbox.find((r) => r.id === id && r.userId === userId && r.deliveredAt);
        return row ? copyInbox(row) : null;
      },
      async unread(userId) { return inbox.filter((r) => r.userId === userId && r.deliveredAt && !r.readAt).length; },
      async deliverMine(userId, id, at, dueBy) {
        const row = inbox.find((r) => r.id === id && r.userId === userId && !r.deliveredAt && r.dueAt <= dueBy);
        if (!row) return null;
        row.deliveredAt = at;
        return copyInbox(row);
      },
      async addTexts(userId, id, texts) {
        const row = inbox.find((r) => r.id === id && r.userId === userId);
        if (!row) return;
        const kept = row.payload.texts && typeof row.payload.texts === 'object' ? row.payload.texts as Record<string, string> : {};
        row.payload = { ...row.payload, texts: { ...kept, ...texts } };
      },
      async markRead(userId, id, at) {
        const row = inbox.find((r) => r.id === id && r.userId === userId && r.deliveredAt);
        if (!row) return null;
        row.readAt ??= at;
        return copyInbox(row);
      },
      async addOnce(row) {
        if (inbox.some((r) => r.id === row.id)) return false;
        inbox.push(copyInbox(row));
        return true;
      },
      async withPrefix(prefix, since) { return inbox.filter((r) => r.id.startsWith(prefix) && r.createdAt >= since).map(copyInbox); },
      async readNaming(userId, star, sceneId, at) {
        let n = 0;
        for (const r of inbox) {
          if (r.userId !== userId || r.star !== star || r.readAt || !r.deliveredAt) continue;
          if (r.payload.scene === sceneId || r.payload.sceneId === sceneId) { r.readAt = at; n++; }
        }
        return n;
      }
    },
    promises: {
      async create(row) {
        if (openWith(row.userId, row.star)) return false;
        promises.push(copyPromise(row));
        return true;
      },
      async byId(id) { const r = promises.find((p) => p.id === id); return r ? copyPromise(r) : null; },
      async open(userId, star) {
        return promises.filter((p) => p.userId === userId && p.status === 'open' && (!star || p.star === star))
          .sort((a, b) => a.dueAt.localeCompare(b.dueAt)).map(copyPromise);
      },
      async latest(userId, star) {
        const mine = promises.filter((p) => p.userId === userId && p.star === star);
        const r = mine.reduce<PromiseRow | null>((m, p) => (!m || p.madeAt >= m.madeAt ? p : m), null);
        return r ? copyPromise(r) : null;
      },
      async forUser(userId) {
        return promises.filter((p) => p.userId === userId).sort((a, b) => a.madeAt.localeCompare(b.madeAt)).map(copyPromise);
      },
      async dueUnnotified(at, limit) {
        return promises.filter((p) => p.status === 'open' && !p.notifiedAt && p.dueAt <= at)
          .sort((a, b) => a.dueAt.localeCompare(b.dueAt)).slice(0, limit).map(copyPromise);
      },
      async notify(id, at, line) {
        const r = promises.find((p) => p.id === id);
        if (!r || r.status !== 'open' || r.notifiedAt) return false;
        if (line && inbox.some((x) => x.id === line.id)) return false;
        r.notifiedAt = at;
        if (line) inbox.push(copyInbox(line));
        return true;
      },
      async keep(id, at, dueFrom, dueTo, memory) {
        const r = promises.find((p) => p.id === id);
        if (!r || r.status !== 'open' || r.dueAt < dueFrom || r.dueAt > dueTo) return null;
        Object.assign(r, { status: 'kept', keptAt: at, notifiedAt: r.notifiedAt ?? at });
        readPromiseLine(id, at);
        if (memory) memories.push(memoryOf(memory));
        return copyPromise(r);
      },
      async expire(dueBefore, at, limit) {
        const gone = promises.filter((p) => p.status === 'open' && p.dueAt < dueBefore).sort((a, b) => a.dueAt.localeCompare(b.dueAt)).slice(0, limit);
        for (const r of gone) { Object.assign(r, { status: 'missed', missedAt: at }); readPromiseLine(r.id, at); }
        return gone.map(copyPromise);
      },
      async toMention(userId, star) {
        const r = promises.filter((p) => p.userId === userId && p.star === star && p.status === 'missed' && !p.mentionedAt)
          .sort((a, b) => b.dueAt.localeCompare(a.dueAt))[0];
        return r ? copyPromise(r) : null;
      },
      async mention(id, at) {
        const r = promises.find((p) => p.id === id);
        if (!r || r.status !== 'missed' || r.mentionedAt) return false;
        r.mentionedAt = at;
        return true;
      }
    },
    jobs: {
      async claim(job, at, dueBefore, staleBefore) {
        const prev = jobRuns.get(job);
        if (prev && !(prev.finishedAt ? prev.startedAt <= dueBefore : prev.startedAt <= staleBefore)) return false;
        jobRuns.set(job, { job, startedAt: at, finishedAt: null, ok: prev?.ok ?? null, error: prev?.error ?? null, result: prev?.result ?? null, lastOkAt: prev?.lastOkAt ?? null, runs: (prev?.runs ?? 0) + 1 });
        return true;
      },
      async finish(job, at, outcome) {
        const prev = jobRuns.get(job);
        if (!prev) return;
        jobRuns.set(job, { ...prev, finishedAt: at, ok: outcome.ok, error: outcome.error, result: outcome.result ? structuredClone(outcome.result) : null, lastOkAt: outcome.ok ? at : prev.lastOkAt });
      },
      async get(job) { const r = jobRuns.get(job); return r ? { ...r, result: r.result ? structuredClone(r.result) : null } : null; }
    },
    push: {
      async subscribe(p) {
        const prev = pushSubs.get(p.endpoint);
        pushSubs.set(p.endpoint, { ...p, keys: { ...p.keys }, createdAt: prev?.createdAt ?? p.createdAt, failedAt: null });
        if (p.tz && users.has(p.userId)) users.set(p.userId, { ...mustUser(p.userId), tz: p.tz });
      },
      async unsubscribe(userId, endpoint) {
        let n = 0;
        for (const [k, p] of pushSubs) if (p.userId === userId && (endpoint === undefined || k === endpoint)) { pushSubs.delete(k); n++; }
        return n;
      },
      async forUser(userId) { return [...pushSubs.values()].filter((p) => p.userId === userId).map((p) => ({ ...p, keys: { ...p.keys } })); },
      async remove(endpoint) { pushSubs.delete(endpoint); },
      async setFailed(endpoint, at) { const p = pushSubs.get(endpoint); if (p) pushSubs.set(endpoint, { ...p, failedAt: at }); }
    },
    relationship: {
      async get(userId, star) { const r = relationships.get(key(userId, star)); return r ? { ...r } : null; },
      async forUser(userId) { return [...relationships.values()].filter((r) => r.userId === userId).map((r) => ({ ...r })); },
      async touch(userId, star, day, at) {
        const k = key(userId, star);
        const cur = relationships.get(k) ?? { ...freshRelationship(at), userId, star, rev: null };
        const next = { ...cur, ...countDay(cur, day) };
        relationships.set(k, next);
        return { ...next };
      },
      async change(expect, next, pulls) {
        if (!next.rev || next.rev === expect.rev) throw new Error('relationship_rev_must_change');
        const k = key(expect.userId, expect.star);
        const cur = relationships.get(k);
        if (!cur || cur.rev !== expect.rev) return null;
        const row: RelationshipRow = { ...next, daysTogether: cur.daysTogether, lastDay: cur.lastDay, userId: cur.userId, star: cur.star };
        relationships.set(k, row);
        if (pulls > 0) { const u = mustUser(cur.userId); users.set(u.id, { ...u, freePulls: u.freePulls + pulls }); }
        return { ...row };
      }
    },
    sceneRuns: {
      async start(row, grant) {
        if ([...sceneRuns.values()].some((r) => r.userId === row.userId && !r.endedAt)) return false;
        sceneRuns.set(row.id, copyRun(row));
        grantScene(row.userId, row.star, grant);
        return true;
      },
      async byId(id) { const r = sceneRuns.get(id); return r ? copyRun(r) : null; },
      async active(userId) {
        const r = [...sceneRuns.values()].filter((x) => x.userId === userId && !x.endedAt).pop();
        return r ? copyRun(r) : null;
      },
      async advance(row, expectSeq, grant, extension, gift) {
        if (row.seq <= expectSeq) throw new Error('scene_seq_must_grow');
        const cur = sceneRuns.get(row.id);
        if (!cur || cur.seq !== expectSeq || cur.endedAt) return false;
        // Both checked before either is paid, so a refusal pays nothing (the D1 store's one batch does the same).
        if (gift && !canGive(gift)) return false;
        if (extension && !buyExtension(extension)) return false;
        if (gift) give(gift);
        sceneRuns.set(row.id, copyRun(row));
        grantScene(row.userId, row.star, grant);
        return true;
      },
      async rewardedSince(userId, sceneId, since) {
        return [...sceneRuns.values()].filter((r) => r.userId === userId && r.sceneId === sceneId && r.rewarded && r.startedAt >= since).length;
      },
      async endedSince(userId, since) {
        return [...sceneRuns.values()].filter((r) => r.userId === userId && r.startedAt >= since && r.endedAt)
          .sort((a, b) => b.endedAt!.localeCompare(a.endedAt!))
          .map((r) => ({ sceneId: r.sceneId, endedAt: r.endedAt!, outcome: r.outcome }));
      }
    },
    sceneOffers: {
      async add(row) { sceneOffers.set(row.id, { ...row }); },
      async since(userId, since) {
        return [...sceneOffers.values()].filter((r) => r.userId === userId && r.createdAt >= since).map((r) => ({ ...r }));
      },
      async answer(id, userId, sceneId, status, at) {
        const r = sceneOffers.get(id);
        if (!r || r.userId !== userId || r.status !== 'open' || (status === 'accepted' && r.expiresAt <= at) || (sceneId !== null && r.sceneId !== sceneId)) return null;
        const next: SceneOfferRow = { ...r, status, answeredAt: at };
        sceneOffers.set(id, next);
        return { ...next };
      }
    },
    gifts: {
      async send(plan) {
        const { row } = plan;
        const today = gifts.filter((g) => g.userId === row.userId && g.day === row.day).length;
        const refused = giftRefusal(plan);
        if (refused) return { ok: false, reason: refused };
        const { next, affinityXp } = give(plan);
        return { ok: true, user: next, affinityXp: affinity.get(key(row.userId, row.star)) ?? affinityXp, sentToday: today + 1 };
      },
      async countOn(userId, day) { return gifts.filter((g) => g.userId === userId && g.day === day).length; }
    },
    voice: {
      async day(userId, day) { return voiceDay(userId, day); },
      async use(row) {
        if (voiceRows.some((v) => v.userId === row.userId && v.requestId === row.requestId)) return { recorded: false, day: voiceDay(row.userId, row.day) };
        voiceRows.push({ ...row, points: 0 });
        return { recorded: true, day: voiceDay(row.userId, row.day) };
      },
      async settle(userId, requestId, nonce, day, seconds) {
        const mine = (v: VoiceLedgerRow) => v.userId === userId && v.requestId === requestId && v.nonce === nonce;
        if (seconds === null) voiceRows = voiceRows.filter((v) => !mine(v));
        else voiceRows = voiceRows.map((v) => (mine(v) ? { ...v, seconds } : v));
        return voiceDay(userId, day);
      },
      async extend(row, perDay) {
        const user = mustUser(row.userId);
        const seen = voiceRows.find((v) => v.userId === row.userId && v.requestId === row.requestId);
        if (seen) return seen.kind === 'extend' ? { ok: true, replayed: true, user: { ...user }, day: voiceDay(row.userId, row.day) } : { ok: false, reason: 'conflict' };
        if (voiceDay(row.userId, row.day).extensions >= perDay) return { ok: false, reason: 'limit' };
        if (user.points < row.points) return { ok: false, reason: 'insufficient' };
        const next = buyExtension({ row, perDay })!;
        return { ok: true, replayed: false, user: { ...next }, day: voiceDay(row.userId, row.day) };
      }
    },
    weather: {
      async all() { return [...weather.values()].map(copyWeather); },
      async get(keys) { return keys.flatMap((k) => { const r = weather.get(k); return r ? [copyWeather(r)] : []; }); },
      async saved(cityKey, lat, lon, at, data) {
        weather.set(cityKey, { cityKey, lat, lon, fetchedAt: at, triedAt: at, error: null, data: structuredClone(data) });
      },
      async failed(cityKey, lat, lon, at, error) {
        const prev = weather.get(cityKey);
        weather.set(cityKey, { cityKey, lat, lon, fetchedAt: prev?.fetchedAt ?? null, triedAt: at, error, data: prev?.data ?? null });
      },
      async prune(herKeys) {
        let n = 0;
        const chosen = (r: WeatherRow) => [...userCities.values()].some((u) => u.lat === r.lat && u.lon === r.lon);
        for (const [k, r] of weather) {
          if (k.startsWith('ll:') ? !chosen(r) : !herKeys.includes(k)) { weather.delete(k); n++; }
        }
        return n;
      },
      async markFirstSnow(cityKey, winter, day) {
        if (firstSnows.some((s) => s.cityKey === cityKey && s.winter === winter)) return false;
        firstSnows.push({ cityKey, winter, day });
        return true;
      },
      async firstSnow(keys) { return firstSnows.filter((s) => keys.includes(s.cityKey)).map((s) => ({ ...s })); },
      async forgetFirstSnow(cityKey, winter) {
        const i = firstSnows.findIndex((s) => s.cityKey === cityKey && s.winter === winter);
        if (i >= 0) firstSnows.splice(i, 1);
      }
    },
    confessions: {
      async get(userId, star) { const r = confessions.get(key(userId, star)); return r ? { ...r } : null; },
      async uninvited(limit, { retryDays, maxAsks, today }) {
        const out = [];
        for (const r of relationships.values()) {
          if (r.stage !== 'confession_ready') continue;
          const c = confessionOf(r.userId, r.star);
          const u = users.get(r.userId);
          if (!u || u.banned || c.invitedRound >= c.tries || c.tries >= maxAsks || c.answeredOn === today) continue;
          if (c.answeredDays !== null && r.daysTogether < c.answeredDays + retryDays) continue;
          out.push({ userId: r.userId, star: r.star, lang: u.lang, daysTogether: r.daysTogether, confession: { ...c } });
          if (out.length >= limit) break;
        }
        return out;
      },
      async invite(userId, star, round, row) {
        const c = confessionOf(userId, star);
        if (c.invitedRound >= round) return false;
        confessions.set(key(userId, star), { ...c, invitedRound: round });
        inbox.push(copyInbox(row));
        return true;
      },
      async reach(userId, star, round, day) {
        const c = confessionOf(userId, star);
        if (c.reachedRound >= round) return false;
        confessions.set(key(userId, star), { ...c, reachedRound: round, reachedOn: day });
        return true;
      },
      async answer(userId, star, expectTries, next) {
        const c = confessionOf(userId, star);
        if (c.tries !== expectTries || c.lastAnswer === 'accept') return false;
        confessions.set(key(userId, star), { ...next, userId, star });
        return true;
      },
      async reset(userId, star) { confessions.delete(key(userId, star)); },
      async addVoice(row) {
        if (voices.has(row.memoryId)) throw new Error('confession_voice_exists');
        voices.set(row.memoryId, { ...row, audioKey: null, audio: null });
      },
      async voices(userId) {
        return [...voices.values()].filter((v) => v.userId === userId)
          .sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0))
          .map(({ audio: _audio, ...v }) => ({ ...v }));
      },
      async voice(userId, memoryId) {
        const v = voices.get(memoryId);
        if (!v || v.userId !== userId) return null;
        const { audio: _audio, ...row } = v;
        return { ...row };
      },
      async setAudio(userId, memoryId, audioType, audio, consentedAt) {
        const v = voices.get(memoryId);
        if (!v || v.userId !== userId || v.audio !== null || v.audioKey) return false;
        voices.set(memoryId, { ...v, audioType, audio, consentedAt });
        return true;
      },
      async audio(userId, memoryId) {
        const v = voices.get(memoryId);
        return v && v.userId === userId && v.audio !== null && v.audioType ? { audioType: v.audioType, audio: v.audio } : null;
      },
      async clearAudio(userId, memoryId, expectKey) {
        const v = voices.get(memoryId);
        if (!v || v.userId !== userId || (v.audio === null && !v.audioKey)) return false;
        if (expectKey !== undefined && (v.audioKey ?? null) !== expectKey) return false;
        voices.set(memoryId, { ...v, audio: null, audioKey: null, audioType: null, consentedAt: null });
        return true;
      },
      async setAudioKey(userId, memoryId, audioType, audioKey, consentedAt) {
        const v = voices.get(memoryId);
        if (!v || v.userId !== userId || v.audio !== null || v.audioKey) return false;
        voices.set(memoryId, { ...v, audioType, audioKey, consentedAt });
        return true;
      },
      async moveAudio(userId, memoryId, audioKey) {
        const v = voices.get(memoryId);
        if (!v || v.userId !== userId || v.audio === null || v.audioKey) return false;
        voices.set(memoryId, { ...v, audio: null, audioKey });
        return true;
      },
      async legacyAudio(limit) {
        return [...voices.values()].filter((v) => v.audio !== null).sort((a, b) => a.createdAt.localeCompare(b.createdAt))
          .slice(0, limit).map((v) => ({ userId: v.userId, memoryId: v.memoryId }));
      },
      async keptBefore(before, limit) {
        return [...voices.values()].filter((v) => v.audioType !== null && v.consentedAt !== null && v.consentedAt < before)
          .sort((a, b) => a.consentedAt!.localeCompare(b.consentedAt!)).slice(0, limit).map(({ audio: _audio, ...v }) => ({ ...v }));
      }
    },
    memoryAssets: {
      async claimExport(userId, day, at) {
        if (memoryExports.has(`${userId}:${day}`)) return false;
        memoryExports.set(`${userId}:${day}`, at);
        return true;
      },
      async releaseExport(userId, day) { memoryExports.delete(`${userId}:${day}`); },
      async pruneExports(day) {
        let n = 0;
        for (const k of [...memoryExports.keys()]) if (k.slice(k.lastIndexOf(':') + 1) < day) { memoryExports.delete(k); n++; }
        return n;
      },
      async purgesPending(limit) {
        return [...memoryPurges.entries()].sort((a, b) => a[1].requestedAt.localeCompare(b[1].requestedAt)).slice(0, limit).map(([id]) => id);
      },
      async purgeTried(userId, at) { const p = memoryPurges.get(userId); if (p) p.triedAt = at; },
      async purgeDone(userId) { memoryPurges.delete(userId); }
    },
    userCities: {
      async get(userId) { const r = userCities.get(userId); return r ? { ...r } : null; },
      async set(row) { userCities.set(row.userId, { ...row }); },
      async clear(userId) { return userCities.delete(userId); },
      async points() {
        const seen = new Map<string, { lat: number; lon: number }>();
        for (const u of userCities.values()) seen.set(`${u.lat},${u.lon}`, { lat: u.lat, lon: u.lon });
        return [...seen.values()];
      }
    },
    alarms: {
      async get(userId) { const a = alarms.get(userId); return a ? copyAlarm(a) : null; },
      async set(row, setUserTz) {
        const prev = alarms.get(row.userId);
        const next: AlarmRow = { ...row, days: [...row.days], snoozes: prev?.snoozes ?? 0, createdAt: prev?.createdAt ?? row.createdAt };
        alarms.set(row.userId, next);
        if (setUserTz && users.has(row.userId)) users.set(row.userId, { ...mustUser(row.userId), tz: row.tz });
        return copyAlarm(next);
      },
      async enabled() {
        return [...alarms.values()].flatMap((a) => {
          const u = users.get(a.userId);
          return a.enabled && u && !u.banned ? [{ ...copyAlarm(a), userTz: u.tz, lang: u.lang }] : [];
        });
      },
      async ring(userId, day, row) {
        const a = alarms.get(userId);
        if (!a || !a.enabled || (a.lastDay !== null && a.lastDay >= day)) return false;
        alarms.set(userId, { ...a, lastDay: day, snoozes: 0 });
        inbox.push(copyInbox(row));
        return true;
      },
      async snooze(userId, day, max, row) {
        const a = alarms.get(userId);
        if (!a || a.lastDay !== day || a.snoozes >= max) return false;
        alarms.set(userId, { ...a, snoozes: a.snoozes + 1 });
        inbox.push(copyInbox(row));
        return true;
      },
      async answered(userId, day, at) {
        const ofDay = (r: InboxRow) => r.userId === userId && r.kind === 'wakeup' && r.payload.day === day;
        const before = inbox.length;
        inbox = inbox.filter((r) => !(ofDay(r) && !r.deliveredAt));
        let read = 0;
        for (const r of inbox) if (ofDay(r) && r.deliveredAt && !r.readAt) { r.readAt = at; read++; }
        return { dropped: before - inbox.length, read };
      }
    },
    herMessages: {
      async zones() { return [...new Set([...users.values()].map((u) => u.tz))]; },
      async toPlan(zones, day, since, after, limit) {
        const out: HerPlanCandidate[] = [];
        for (const u of [...users.values()].sort((a, b) => a.id.localeCompare(b.id))) {
          if (out.length >= limit) break;
          const mode = herPrefs.get(u.id)?.mode ?? 'normal';
          if (u.id <= after || u.banned || mode === 'off' || !zones.includes(u.tz)) continue;
          if (herMsgs.some((h) => h.userId === u.id && h.day === day)) continue;
          const stars = [...relationships.values()].filter((r) => r.userId === u.id && r.lastDay && r.lastDay >= since)
            .map((r) => ({ star: r.star, lastDay: r.lastDay!, daysTogether: r.daysTogether }));
          if (stars.length) out.push({ userId: u.id, tz: u.tz, mode, stars });
        }
        return out;
      },
      async lastNightWith(userId, from, to) {
        const times = [
          ...messages.filter((m) => m.ownerId === userId && m.role === 'user').map((m) => ({ star: m.star, at: m.createdAt })),
          ...[...sceneRuns.values()].filter((r) => r.userId === userId).map((r) => ({ star: r.star, at: r.startedAt }))
        ].filter((x) => x.at >= from && x.at < to).sort((a, b) => b.at.localeCompare(a.at));
        return times[0]?.star ?? null;
      },
      async plan(rows) {
        let n = 0;
        for (const r of rows) if (!herMsgs.some((h) => sameHer(h, r))) { herMsgs.push({ ...r }); n++; }
        return n;
      },
      async due(at, staleBefore, limit) {
        return herMsgs.filter((h) => (h.status === 'planned' && h.dueAt <= at) || (h.status === 'writing' && h.triedAt! <= staleBefore))
          .sort((a, b) => a.dueAt.localeCompare(b.dueAt)).slice(0, limit)
          .flatMap((h) => {
            const u = users.get(h.userId);
            return u ? [{ ...h, user: { lang: u.lang, nickname: u.nickname, tz: u.tz, passUntil: u.passUntil, active: !u.banned, mode: herPrefs.get(u.id)?.mode ?? 'normal' } }] : [];
          });
      },
      async take(key, at, staleBefore) {
        const h = herMsgs.find((x) => sameHer(x, key));
        if (!h || !(h.status === 'planned' || (h.status === 'writing' && h.triedAt! <= staleBefore))) return false;
        Object.assign(h, { status: 'writing', triedAt: at });
        return true;
      },
      async send(key, triedAt, at, source, line) {
        const h = herMsgs.find((x) => sameHer(x, key));
        if (!h || h.status !== 'writing' || h.triedAt !== triedAt) return false;
        Object.assign(h, { status: 'sent', sentAt: at, source });
        if (!inbox.some((r) => r.id === line.id)) inbox.push(copyInbox(line));
        return true;
      },
      async skip(key, reason) {
        const h = herMsgs.find((x) => sameHer(x, key));
        if (h && (h.status === 'planned' || h.status === 'writing')) Object.assign(h, { status: 'skipped', reason });
      },
      async sentSince(since) { return herMsgs.filter((h) => h.status === 'sent' && h.sentAt! >= since).length; },
      async sentOn(userId, day) { return herMsgs.filter((h) => h.userId === userId && h.day === day && h.status === 'sent').length; },
      async purge(day, limit) {
        const old = herMsgs.filter((h) => h.day < day).slice(0, limit);
        herMsgs = herMsgs.filter((h) => !old.includes(h));
        return old.length;
      },
      async mode(userId) { return herPrefs.get(userId)?.mode ?? 'normal'; },
      async setMode(userId, mode, at) { herPrefs.set(userId, { mode, updatedAt: at }); },
      async replan(row) {
        herMsgs = herMsgs.filter((h) => !sameHer(h, row));
        herMsgs.push({ ...row });
      }
    },
    bond: {
      async get(userId, star) { const r = callNames.get(key(userId, star)); return r ? { ...r } : null; },
      async answer(userId, star, expectAsked, next) {
        if ((callNames.get(key(userId, star))?.asked ?? 'new') !== expectAsked) return false;
        callNames.set(key(userId, star), { ...next });
        return true;
      },
      async set(userId, star, s) { callNames.set(key(userId, star), { ...s }); },
      async praise(userId, star) { return { ...(praise.get(key(userId, star)) ?? {}) }; },
      async addPraise(userId, star, looks, _at, max) {
        const counts = praise.get(key(userId, star)) ?? {};
        for (const look of new Set(looks)) counts[look] = Math.min(max, (counts[look] ?? 0) + 1);
        praise.set(key(userId, star), counts);
      },
      async name(userId) { return callNamePrefs.get(userId) ?? null; },
      async setName(userId, name) { if (name === null) callNamePrefs.delete(userId); else callNamePrefs.set(userId, name); }
    },
    calendar: {
      async candidates(since, after, limit) {
        const out: CalendarCandidate[] = [];
        for (const u of [...users.values()].sort((a, b) => a.id.localeCompare(b.id))) {
          if (out.length >= limit) break;
          const mode = herPrefs.get(u.id)?.mode ?? 'normal';
          if (u.id <= after || u.banned || mode === 'off') continue;
          const stars = [...relationships.values()].filter((r) => r.userId === u.id && r.lastDay && r.lastDay >= since)
            .map((r) => ({ star: r.star, lastDay: r.lastDay!, stage: r.stage, anniversary: r.anniversary }));
          if (stars.length) out.push({ userId: u.id, lang: u.lang, tz: u.tz, birthday: u.birthday, mode, stars });
        }
        return out;
      }
    }
  };
}

/** The in-memory twin of the metrics SQL in sql.ts (definitions: MetricsCounts in @jstar/shared); tests/events.test.ts holds both to the same numbers. */
function memoryMetrics(events: EventRow[], from: string, to: string, grouping: MetricsGrouping): MetricsPeriodRow[] {
  const periodOf = (day: string) => (grouping === 'all' ? from : grouping === 'week' ? weekStart(day) : day);
  const inRange = (day: string) => day >= from && day <= to;
  const rows = new Map<string, MetricsPeriodRow>();
  const row = (period: string) => {
    let r = rows.get(period);
    if (!r) { r = { period, ...zeroCounts() }; rows.set(period, r); }
    return r;
  };
  const byUser = new Map<string, EventRow[]>();
  for (const e of events) {
    if (!e.userId) continue;
    const list = byUser.get(e.userId);
    if (list) list.push(e); else byUser.set(e.userId, [e]);
  }

  // Cohorts: users whose first event falls in the range.
  for (const evs of byUser.values()) {
    const d0 = evs.reduce((m, e) => (e.day < m ? e.day : m), evs[0].day);
    if (!inRange(d0)) continue;
    const has = (name: EventName, hi = '9999-12-31') => evs.some((e) => e.name === name && e.day <= hi);
    const r = row(periodOf(d0));
    r.newUsers++;
    if (has('confession.reached')) r.confessed++;
    const retained = evs.some((e) => e.day >= addDays(d0, 7) && e.day <= addDays(d0, 13));
    if (has('scene.trigger', addDays(d0, 6))) { r.sceneUsers++; if (retained) r.sceneRetained++; }
    else { r.chatOnlyUsers++; if (retained) r.chatOnlyRetained++; }
  }

  // Active users: anyone with an event in the period; of them, who had set an alarm by the period's last day (#57).
  const periodEnd = (period: string) => {
    const end = grouping === 'day' ? period : grouping === 'week' ? addDays(period, 6) : to;
    return end < to ? end : to;
  };
  const active = new Map<string, Set<string>>();
  for (const e of events) {
    if (!e.userId || !inRange(e.day)) continue;
    const period = periodOf(e.day);
    active.set(period, (active.get(period) ?? new Set()).add(e.userId));
  }
  for (const [period, users] of active) {
    const r = row(period);
    const end = periodEnd(period);
    r.activeUsers = users.size;
    r.alarmSet = [...users].filter((u) => byUser.get(u)!.some((e) => e.name === 'alarm.set' && e.day <= end)).length;
  }

  // What happened in the range.
  const kept = new Set(events.filter((e) => e.name === 'promise.kept').map((e) => String(e.props.promiseId)));
  const due = new Map<string, Set<string>>();
  for (const e of events) {
    if (!inRange(e.day)) continue;
    const period = periodOf(e.day);
    if (e.name === 'room.entered') row(period).roomEntries++;
    else if (e.name === 'scene.trigger') {
      const r = row(period);
      r.sceneTriggers++;
      const source = e.props.source as TriggerSource;
      if (source in r.triggerSources) r.triggerSources[source]++;
    } else if (e.name === 'promise.due') {
      row(period);
      due.set(period, (due.get(period) ?? new Set()).add(String(e.props.promiseId)));
    }
  }
  for (const [period, ids] of due) {
    const r = row(period);
    r.promisesDue = ids.size;
    r.promisesKept = [...ids].filter((id) => kept.has(id)).length;
  }

  // Variant funnel: per user and period, from the first prompt.
  const prompts = new Map<string, { userId: string; period: string; d0: string }>();
  for (const e of events) {
    if (e.name !== 'variant.prompted' || !e.userId || !inRange(e.day)) continue;
    const period = periodOf(e.day);
    const k = `${e.userId}|${period}`;
    const cur = prompts.get(k);
    if (!cur || e.day < cur.d0) prompts.set(k, { userId: e.userId, period, d0: e.day });
  }
  for (const { userId, period, d0 } of prompts.values()) {
    const r = row(period);
    const evs = byUser.get(userId) ?? [];
    const draws = evs.filter((e) => e.name === 'variant.drawn' && e.day >= d0 && e.day <= to && periodOf(e.day) === period);
    r.variantPrompted++;
    if (draws.length) r.variantDrawn++;
    if (draws.some((d) => evs.some((e) => e.name === 'variant.scene_opened' && e.day === d.day))) r.variantSceneOpened++;
  }
  return [...rows.values()].sort((a, b) => a.period.localeCompare(b.period));
}

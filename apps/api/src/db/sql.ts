import { RULES, VARIANT_RULES, freshConfession, variantLevel, type CardDef, type StarId, type VariantGain } from '@jstar/shared';
import { OTP_MAX_ATTEMPTS, VOID, zeroCounts, type AuditRow, type CardAffectionRow, type MetricsGrouping, type MetricsPeriodRow, type ChatMemoryRow, type DeviceRedemption, type DrawRow, type InboxRow, type JobRunRow, type MessageRow, type OwnedRow, type PoolRow, type PickupRow, type Repos, type SerialRow, type UserRow, type PushSubscriptionRow, type RelationshipRow, type SceneGrant, type SceneRunRow } from './types';
import type { SceneOfferRow, WeatherRow } from './types';
import { promiseInboxId, type MemoryRow, type PromiseRow } from './types';
import type { AlarmRow, RingCandidate } from './types';
import type { ConfessionRow, ConfessionVoiceRow } from './types';
import type { HerMessageRow, HerPlanCandidate } from './types';
import type { CalendarCandidate } from './types';
import type { GiftPlan, SceneExtension, VoiceDayRow } from './types';
import type { Lang } from '@jstar/shared';
import type { HerMessageMode } from '@jstar/shared/herMessages';
import type { CallAnswer } from '@jstar/shared/bond';
import type { CallStage } from '@jstar/shared/world';
import type { MemoryKind } from '@jstar/shared/memories';

const toHerMessage = (r: Record<string, unknown>): HerMessageRow => ({
  userId: String(r.user_id), day: String(r.day), kind: r.kind as HerMessageRow['kind'], star: r.star as StarId, inboxId: String(r.inbox_id),
  dueAt: String(r.due_at), status: r.status as HerMessageRow['status'], triedAt: str(r.tried_at), sentAt: str(r.sent_at),
  source: str(r.source) as HerMessageRow['source'], reason: str(r.reason), createdAt: String(r.created_at)
});

/**
 * SQL storage (schema: migrations/). Production runs it on Cloudflare D1 through the Worker (d1.ts); the test
 * suite runs the same statements on SQLite (tests/sqlite.ts), so both backends are held to one contract.
 *
 * Rules that keep it correct under concurrency, as memory.ts does on one thread:
 * - a conditional change is one statement (`UPDATE … WHERE <condition> RETURNING`), never read-then-write;
 * - a change that spans rows is one `batch`, which the client runs as a single transaction;
 * - inside a batch, later statements are guarded by a token the first statement wrote, so a batch that lost
 *   the race (its first statement matched nothing) writes nothing at all.
 */
export type SqlValue = string | number | null;
export interface Stmt { sql: string; params: SqlValue[] }
export interface SqlResult { rows: Record<string, unknown>[]; changes: number }
/** Runs the statements in order inside one transaction; if any fails, none of them applies. */
export interface SqlClient { batch(stmts: Stmt[]): Promise<SqlResult[]> }

const q = (sql: string, ...params: (SqlValue | boolean | undefined)[]): Stmt =>
  ({ sql, params: params.map((p) => (p === undefined ? null : typeof p === 'boolean' ? (p ? 1 : 0) : p)) });

/** D1 accepts at most 100 bound parameters per statement. */
const MAX_PARAMS = 99;

type Row = Record<string, unknown>;
const str = (v: unknown) => (v === null || v === undefined ? null : String(v));
const num = (v: unknown) => Number(v ?? 0);

const toUser = (r: Row): UserRow => ({
  id: String(r.id), email: str(r.email), lineSub: str(r.line_sub), nickname: String(r.nickname), via: r.via as UserRow['via'],
  lang: r.lang as UserRow['lang'], ageConfirmedAt: String(r.age_confirmed_at), createdAt: String(r.created_at),
  points: num(r.points), freePulls: num(r.free_pulls), role: r.role as UserRow['role'], banned: num(r.banned) === 1,
  passUntil: str(r.pass_until), chatDay: String(r.chat_day ?? ''), chatUsedToday: num(r.chat_used_today), bonusDay: str(r.bonus_day),
  pity: num(r.pity), shards: num(r.shards), loginDay: str(r.login_day), checkMonth: str(r.check_month), checkDays: num(r.check_days),
  checkClaimed: JSON.parse(String(r.check_claimed ?? '[]')) as number[], birthday: str(r.birthday), tz: str(r.tz)
});
const toSerial = (r: Row): SerialRow => ({
  id: String(r.id), codeHash: String(r.code_hash), batchId: String(r.batch_id), trialDays: num(r.trial_days), draws: num(r.draws),
  redeemedByUserId: str(r.redeemed_by_user), redeemedByDevice: str(r.redeemed_by_device), redeemedAt: str(r.redeemed_at)
});
const toRedemption = (r: Row): DeviceRedemption => ({ serialId: String(r.serial_id), cardIds: JSON.parse(String(r.card_ids)) as string[], trialDays: num(r.trial_days) });
const toOwned = (r: Row): OwnedRow => ({ userId: String(r.user_id), cardId: String(r.card_id), copies: num(r.copies), firstOwnedAt: String(r.first_owned_at), viaSerial: num(r.via_serial) === 1 });
const toMessage = (r: Row): MessageRow => ({ id: String(r.id), ownerId: String(r.owner_id), star: r.star as StarId, role: r.role as MessageRow['role'], text: String(r.text), createdAt: String(r.created_at) });
const toDraw = (r: Row): DrawRow => ({
  id: String(r.id), ownerId: String(r.owner_id), poolId: String(r.pool_id), serialId: str(r.serial_id),
  cardIds: JSON.parse(String(r.card_ids)) as string[], tiers: r.tiers ? (JSON.parse(String(r.tiers)) as string[]) : null,
  cost: num(r.cost), seed: String(r.seed), createdAt: String(r.created_at)
});
const toAudit = (r: Row): AuditRow => ({ id: String(r.id), actorId: String(r.actor_id), action: String(r.action), target: String(r.target), meta: JSON.parse(String(r.meta)) as AuditRow['meta'], createdAt: String(r.created_at) });

const toChatMemory = (r: Row): ChatMemoryRow => ({
  ownerId: String(r.owner_id), star: r.star as StarId, facts: JSON.parse(String(r.facts ?? '{}')) as Record<string, string>,
  summary: str(r.summary), updatedAt: String(r.updated_at),
  greeting: r.greeting_day && r.greeting_text ? { day: String(r.greeting_day), lang: String(r.greeting_lang ?? ''), text: String(r.greeting_text) } : null,
  pending: JSON.parse(String(r.pending ?? '[]')) as ChatMemoryRow['pending'], pendingAt: str(r.pending_at)
});

const toInbox = (r: Row): InboxRow => ({
  id: String(r.id), userId: String(r.user_id), star: r.star as StarId, kind: r.kind as InboxRow['kind'],
  payload: JSON.parse(String(r.payload ?? '{}')) as Record<string, unknown>,
  dueAt: String(r.due_at), deliveredAt: str(r.delivered_at), readAt: str(r.read_at), createdAt: String(r.created_at)
});
const toJobRun = (r: Row): JobRunRow => ({
  job: String(r.job), startedAt: String(r.started_at), finishedAt: str(r.finished_at), ok: r.ok === null || r.ok === undefined ? null : num(r.ok) === 1,
  error: str(r.error), result: r.result ? (JSON.parse(String(r.result)) as Record<string, unknown>) : null, lastOkAt: str(r.last_ok_at), runs: num(r.runs)
});
const toPush = (r: Row): PushSubscriptionRow => ({
  endpoint: String(r.endpoint), userId: String(r.user_id), keys: JSON.parse(String(r.keys)) as PushSubscriptionRow['keys'],
  tz: str(r.tz), createdAt: String(r.created_at), failedAt: str(r.failed_at)
});
const toSceneOffer = (r: Row): SceneOfferRow => ({
  id: String(r.id), userId: String(r.user_id), star: r.star as StarId, sceneId: String(r.scene_id),
  source: r.source as SceneOfferRow['source'], status: r.status as SceneOfferRow['status'],
  createdAt: String(r.created_at), expiresAt: String(r.expires_at), answeredAt: r.answered_at == null ? null : String(r.answered_at)
});
const toSceneRun = (r: Row): SceneRunRow => ({
  id: String(r.id), userId: String(r.user_id), star: r.star as StarId, sceneId: String(r.scene_id), step: String(r.step), seq: num(r.seq),
  state: JSON.parse(String(r.state)) as SceneRunRow['state'], rewarded: num(r.rewarded) === 1,
  startedAt: String(r.started_at), updatedAt: String(r.updated_at), endedAt: str(r.ended_at), outcome: str(r.outcome)
});
const toConfession = (r: Row): ConfessionRow => ({
  userId: String(r.user_id), star: r.star as StarId, tries: num(r.tries), lastAnswer: (str(r.last_answer) as ConfessionRow['lastAnswer']),
  answeredDays: r.answered_days === null || r.answered_days === undefined ? null : num(r.answered_days), answeredOn: str(r.answered_on),
  invitedRound: r.invited_round === null || r.invited_round === undefined ? -1 : num(r.invited_round),
  reachedRound: r.reached_round === null || r.reached_round === undefined ? -1 : num(r.reached_round), reachedOn: str(r.reached_on)
});
/** Lists never select the recording itself. */
const VOICE_COLUMNS = 'memory_id, user_id, star, transcript, audio_type, audio_key, consented_at, created_at';
const toVoice = (r: Row): ConfessionVoiceRow => ({
  memoryId: String(r.memory_id), userId: String(r.user_id), star: r.star as StarId, transcript: String(r.transcript),
  audioType: str(r.audio_type), consentedAt: str(r.consented_at), createdAt: String(r.created_at), audioKey: str(r.audio_key)
});
/** His voice time on a JST day (#74): seconds used (tts + input) and extensions bought. */
const voiceDayStmt = (userId: string, day: string): Stmt =>
  q(`SELECT coalesce(sum(CASE WHEN kind = 'extend' THEN 0 ELSE seconds END), 0) AS used, coalesce(sum(CASE WHEN kind = 'extend' THEN 1 ELSE 0 END), 0) AS ext
     FROM voice_ledger WHERE user_id = ? AND day = ?`, userId, day);
const toVoiceDay = (day: string, r: Row | null | undefined): VoiceDayRow => ({ day, usedSeconds: num(r?.used), extensions: num(r?.ext) });
/**
 * An extension's two writes (#74): the ledger row, only for a new request id, under today's cap, with the points there
 * (and while `when` holds, if given); and the points, taken only when the row is this attempt's own (its nonce), so a
 * replay or a refusal takes nothing. `mine` is that condition, for other writes that must go with it.
 */
const extensionStmts = ({ row, perDay }: SceneExtension, when?: Stmt): { insert: Stmt; take: Stmt; mine: Stmt } => {
  const mine = q('EXISTS (SELECT 1 FROM voice_ledger WHERE user_id = ? AND request_id = ? AND nonce = ?)', row.userId, row.requestId, row.nonce);
  return {
    insert: q(`INSERT INTO voice_ledger (user_id, request_id, day, kind, seconds, points, nonce, created_at)
       SELECT ?, ?, ?, 'extend', ?, ?, ?, ?
       WHERE NOT EXISTS (SELECT 1 FROM voice_ledger WHERE user_id = ? AND request_id = ?)
         AND (SELECT count(*) FROM voice_ledger WHERE user_id = ? AND day = ? AND kind = 'extend') < ?
         AND EXISTS (SELECT 1 FROM users WHERE id = ? AND points >= ?)${when ? ` AND ${when.sql}` : ''}`,
      row.userId, row.requestId, row.day, row.seconds, row.points, row.nonce, row.createdAt,
      row.userId, row.requestId, row.userId, row.day, perDay, row.userId, row.points, ...(when?.params ?? [])),
    take: q(`UPDATE users SET points = points - ? WHERE id = ? AND ${mine.sql} RETURNING *`, row.points, row.userId, ...mine.params),
    mine
  };
};
/**
 * A gift's writes (#77): the row, only while today's gifts are under the cap and he has the points (and while `when`
 * holds, if given: #68, the scene run is still at the step he answered); then everything it pays — points, her XP, a
 * variant's share — guarded by the row's own id (`mine`), so a refused gift writes nothing at all.
 */
const giftStmts = ({ row, perDay, variant }: GiftPlan, when?: Stmt): { insert: Stmt; pay: Stmt[]; mine: Stmt } => {
  const mine = q('EXISTS (SELECT 1 FROM gifts WHERE id = ?)', row.id);
  return {
    insert: q(`INSERT INTO gifts (id, user_id, star, gift_id, card_id, price, xp, taste, day, created_at)
       SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ? WHERE (SELECT count(*) FROM gifts WHERE user_id = ? AND day = ?) < ?
         AND EXISTS (SELECT 1 FROM users WHERE id = ? AND points >= ?)${when ? ` AND ${when.sql}` : ''}`,
      row.id, row.userId, row.star, row.giftId, row.cardId, row.price, row.xp, row.taste, row.day, row.createdAt,
      row.userId, row.day, perDay, row.userId, row.price, ...(when?.params ?? [])),
    pay: [
      q(`UPDATE users SET points = points - ? WHERE id = ? AND ${mine.sql} RETURNING *`, row.price, row.userId, ...mine.params),
      q(`INSERT INTO affinity (user_id, star, xp) SELECT ?, ?, ? WHERE ${mine.sql}
         ON CONFLICT (user_id, star) DO UPDATE SET xp = xp + excluded.xp`, row.userId, row.star, row.xp, ...mine.params),
      ...(variant ? variantStmts(mine, row.userId, variant.cardId, row.star, variant.gain, row.createdAt) : [])
    ],
    mine
  };
};
/** A memory card (#51: with its kind, scene and still), written only when `guard` holds when one is given. */
const memoryInsert = (m: MemoryRow, guard?: Stmt): Stmt =>
  q(`INSERT INTO memories (id, user_id, star, title, created_at, kind, scene_id, still) SELECT ?, ?, ?, ?, ?, ?, ?, ?${guard ? ` WHERE ${guard.sql}` : ''}`,
    m.id, m.userId, m.star, m.title, m.createdAt, m.kind ?? 'chat', m.sceneId ?? null, m.still ?? null, ...(guard?.params ?? []));
const toWeather = (r: Row): WeatherRow => ({
  cityKey: String(r.city_key), lat: num(r.lat), lon: num(r.lon), fetchedAt: str(r.fetched_at), triedAt: String(r.tried_at),
  error: str(r.error), data: r.data ? (JSON.parse(String(r.data)) as WeatherRow['data']) : null
});
const toRelationship = (r: Row): RelationshipRow => ({
  userId: String(r.user_id), star: r.star as StarId, stage: r.stage as RelationshipRow['stage'], stageSince: String(r.stage_since),
  stageDay: num(r.stage_day), daysTogether: num(r.days_together), lastDay: str(r.last_day), confessedAt: str(r.confessed_at),
  anniversary: str(r.anniversary), loverXp: r.lover_xp === null || r.lover_xp === undefined ? null : num(r.lover_xp),
  rewardRank: num(r.reward_rank), rev: str(r.rev)
});
const toPromise = (r: Row): PromiseRow => ({
  id: String(r.id), userId: String(r.user_id), star: r.star as StarId, text: String(r.text), dueAt: String(r.due_at),
  kind: r.kind as PromiseRow['kind'], status: r.status as PromiseRow['status'], source: r.source as PromiseRow['source'],
  madeAt: String(r.made_at), keptAt: str(r.kept_at), sourceMsgId: str(r.source_msg_id), sceneId: str(r.scene_id), lang: r.lang as PromiseRow['lang'],
  notifiedAt: str(r.notified_at), missedAt: str(r.missed_at), mentionedAt: str(r.mentioned_at)
});
/**
 * Makes a promise only while `cond` holds and no promise with her is open (one at a time). The unique partial index
 * idx_promises_open is the backstop; the NOT EXISTS keeps a refused promise from failing the rest of its batch.
 */
const promiseStmt = (cond: Stmt, p: PromiseRow): Stmt =>
  q(`INSERT INTO promises (id, user_id, star, text, due_at, kind, status, made_at, kept_at, source_msg_id, source, scene_id, lang, notified_at, missed_at, mentioned_at)
     SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ? WHERE ${cond.sql}
       AND NOT EXISTS (SELECT 1 FROM promises WHERE user_id = ? AND star = ? AND status = 'open')`,
    p.id, p.userId, p.star, p.text, p.dueAt, p.kind, p.status, p.madeAt, p.keptAt, p.sourceMsgId, p.source, p.sceneId, p.lang,
    p.notifiedAt, p.missedAt, p.mentionedAt, ...cond.params, p.userId, p.star);
const always = q('1');

/** Alarm weekdays are one INTEGER: bit n = weekday n (0 = Sunday). */
const daysMask = (days: number[]) => days.reduce((m, d) => m | (1 << d), 0);
const daysOf = (mask: number) => [0, 1, 2, 3, 4, 5, 6].filter((d) => mask & (1 << d));
const toAlarm = (r: Row): AlarmRow => ({
  userId: String(r.user_id), star: r.star as StarId, time: String(r.time_local), days: daysOf(num(r.days)), enabled: num(r.enabled) === 1,
  tz: String(r.tz), lastDay: str(r.last_day), snoozes: num(r.snoozes), createdAt: String(r.created_at), updatedAt: String(r.updated_at)
});
/** A wake-up inbox row, inserted only under the ring token its alarm UPDATE wrote (the row's own id). */
const wakeInsert = (row: InboxRow): Stmt =>
  q(`INSERT INTO inbox (id, user_id, star, kind, payload, due_at, delivered_at, read_at, created_at) SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?
     WHERE EXISTS (SELECT 1 FROM alarms WHERE user_id = ? AND ring_token = ?)`,
    row.id, row.userId, row.star, row.kind, JSON.stringify(row.payload), row.dueAt, row.deliveredAt, row.readAt, row.createdAt, row.userId, row.id);
/** A scene's affinity and memory cards, applied only when `guard` (the run change it belongs to) holds. */
const sceneGrantStmts = (guard: Stmt, row: SceneRunRow, g: SceneGrant): Stmt[] => [
  ...(g.affinity > 0 ? [q(`INSERT INTO affinity (user_id, star, xp) SELECT ?, ?, ? WHERE ${guard.sql}
     ON CONFLICT (user_id, star) DO UPDATE SET xp = xp + excluded.xp`, row.userId, row.star, g.affinity, ...guard.params)] : []),
  ...g.memories.map((m) => memoryInsert(m, guard)),
  ...(g.variant ? variantStmts(guard, row.userId, g.variant.cardId, row.star, g.variant.gain, row.updatedAt) : []),
  ...(g.promises ?? []).map((p) => promiseStmt(guard, p))
];

const toCardAffection = (r: Row): CardAffectionRow => ({
  userId: String(r.user_id), cardId: String(r.card_id), xp: num(r.xp), level: num(r.level), kokoro: num(r.kokoro),
  homePinned: num(r.home_pinned) === 1, updatedAt: String(r.updated_at)
});
/** The level (VARIANT_RULES.levelXp) an SQL expression's XP reaches, as a CASE: the thresholds are constants, never input. */
const levelCase = (xp: string) =>
  `CASE ${VARIANT_RULES.levelXp.map((min, i) => `WHEN ${xp} >= ${min} THEN ${i + 1}`).reverse().join(' ')} ELSE 1 END`;
/**
 * Variant XP and 心意 on a card (#75), and the main share on her affinity, applied only while `cond` holds (the guard
 * of the step they belong to). The level is the highest reached: it follows the XP up and never comes down.
 */
const variantStmts = (cond: Stmt, userId: string, cardId: string, star: string, g: VariantGain, at: string): Stmt[] => [
  q(`INSERT INTO card_affection (user_id, card_id, xp, level, kokoro, updated_at) SELECT ?, ?, ?, ?, ?, ? WHERE ${cond.sql}
     ON CONFLICT (user_id, card_id) DO UPDATE SET xp = card_affection.xp + excluded.xp, kokoro = card_affection.kokoro + excluded.kokoro,
       level = max(card_affection.level, ${levelCase('card_affection.xp + excluded.xp')}), updated_at = excluded.updated_at`,
    userId, cardId, g.xp, variantLevel(g.xp), g.kokoro, at, ...cond.params),
  ...(g.mainXp > 0 ? [q(`INSERT INTO affinity (user_id, star, xp) SELECT ?, ?, ? WHERE ${cond.sql}
     ON CONFLICT (user_id, star) DO UPDATE SET xp = xp + excluded.xp`, userId, star, g.mainXp, ...cond.params)] : [])
];
/** A duplicate's 心意: runs right after grantStmt, so `copies > 1` means this copy was not the first (as bondStmt). */
const duplicateStmts = (guard: Stmt, userId: string, cardId: string, star: string, g: VariantGain | undefined | null, at: string): Stmt[] =>
  g ? variantStmts(q(`${guard.sql} AND (SELECT copies FROM owned WHERE user_id = ? AND card_id = ?) > 1`, ...guard.params, userId, cardId), userId, cardId, star, g, at) : [];

const USER_COLUMNS: Record<string, string> = { nickname: 'nickname', lang: 'lang', banned: 'banned', role: 'role', passUntil: 'pass_until', bonusDay: 'bonus_day' };

/** Adds a copy of a card; RETURNING copies tells whether it was the first. Guarded like the rest of its batch. */
const grantStmt = (guard: Stmt, userId: string, cardId: string, at: string, viaSerial = true): Stmt =>
  q(`INSERT INTO owned (user_id, card_id, copies, first_owned_at, via_serial) SELECT ?, ?, 1, ?, ? WHERE ${guard.sql}
     ON CONFLICT (user_id, card_id) DO UPDATE SET copies = copies + 1 RETURNING copies`, userId, cardId, at, viaSerial, ...guard.params);
/** Bond XP for a duplicate: runs right after grantStmt, so `copies > 1` means this copy was not the first. */
const bondStmt = (guard: Stmt, userId: string, cardId: string, star: string, xp: number): Stmt =>
  q(`INSERT INTO affinity (user_id, star, xp) SELECT ?, ?, ? WHERE ${guard.sql}
       AND (SELECT copies FROM owned WHERE user_id = ? AND card_id = ?) > 1
     ON CONFLICT (user_id, star) DO UPDATE SET xp = xp + excluded.xp`, userId, star, xp, ...guard.params, userId, cardId);
/** Converts one duplicate copy into Star Shards, immediately after its grant statement raised copies above one. */
const duplicateShardStmt = (guard: Stmt, userId: string, cardId: string, amount = 0): Stmt =>
  q(`UPDATE users SET shards = shards + ? WHERE id = ? AND ${guard.sql}
       AND (SELECT copies FROM owned WHERE user_id = ? AND card_id = ?) > 1`, amount, userId, ...guard.params, userId, cardId);

export function createSqlRepos(db: SqlClient): Repos {
  const all = async (s: Stmt) => (await db.batch([s]))[0].rows;
  const one = async (s: Stmt) => (await all(s))[0] ?? null;
  const run = async (s: Stmt) => (await db.batch([s]))[0].changes;
  const userById = async (id: string) => { const r = await one(q('SELECT * FROM users WHERE id = ?', id)); return r ? toUser(r) : null; };
  const allCards = async () => (await all(q('SELECT data FROM cards ORDER BY rowid'))).map((r) => JSON.parse(String(r.data)) as CardDef);

  const repos: Repos = {
    users: {
      byId: userById,
      async byEmail(email) { const r = await one(q('SELECT * FROM users WHERE email = ?', email)); return r ? toUser(r) : null; },
      async create(u) {
        const r = await one(q(`INSERT INTO users (id, email, line_sub, nickname, via, lang, age_confirmed_at, created_at, points, free_pulls, role, banned, pass_until, chat_day, chat_used_today, bonus_day, pity, shards, login_day, check_month, check_days, check_claimed, birthday, tz)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING *`,
          u.id, u.email, u.lineSub, u.nickname, u.via, u.lang, u.ageConfirmedAt, new Date().toISOString(), u.points, u.freePulls, u.role, u.banned, u.passUntil, u.chatDay, u.chatUsedToday, u.bonusDay,
          u.pity, u.shards, u.loginDay, u.checkMonth, u.checkDays, JSON.stringify(u.checkClaimed), u.birthday, u.tz));
        return toUser(r!);
      },
      async update(id, patch) {
        const keys = Object.keys(patch).filter((k) => k in USER_COLUMNS) as (keyof typeof patch)[];
        const r = keys.length
          ? await one(q(`UPDATE users SET ${keys.map((k) => `${USER_COLUMNS[k]} = ?`).join(', ')} WHERE id = ? RETURNING *`, ...keys.map((k) => patch[k]), id))
          : await one(q('SELECT * FROM users WHERE id = ?', id));
        if (!r) throw new Error('user_not_found');
        return toUser(r);
      },
      async adjustWallet(id, { points = 0, freePulls = 0 }) {
        const r = await one(q(`UPDATE users SET points = points + ?, free_pulls = free_pulls + ?
          WHERE id = ? AND points + ? >= 0 AND free_pulls + ? >= 0 RETURNING *`, points, freePulls, id, points, freePulls));
        return r ? toUser(r) : null;
      },
      async reserveChat(id, day, limit) {
        const r = await one(q(`UPDATE users SET chat_used_today = CASE WHEN chat_day = ? THEN chat_used_today + 1 ELSE 1 END, chat_day = ?
          WHERE id = ? AND (CASE WHEN chat_day = ? THEN chat_used_today ELSE 0 END) < ? RETURNING *`, day, day, id, day, limit));
        return r ? toUser(r) : null;
      },
      async releaseChat(id, day) {
        await run(q('UPDATE users SET chat_used_today = chat_used_today - 1 WHERE id = ? AND chat_day = ? AND chat_used_today > 0', id, day));
      },
      async dailyLogin(id, day, month, points) {
        const r = await one(q(`UPDATE users SET login_day = ?, points = points + ?,
            check_days = CASE WHEN check_month = ? THEN check_days + 1 ELSE 1 END,
            check_claimed = CASE WHEN check_month = ? THEN check_claimed ELSE '[]' END,
            check_month = ?
          WHERE id = ? AND (login_day IS NULL OR login_day <> ?) RETURNING *`, day, points, month, month, month, id, day));
        return r ? toUser(r) : null;
      },
      async claimCheckIn(id, expected, next, { points = 0, freePulls = 0 }) {
        const r = await one(q(`UPDATE users SET check_claimed = ?, points = points + ?, free_pulls = free_pulls + ?
          WHERE id = ? AND check_claimed = ? RETURNING *`, JSON.stringify(next), points, freePulls, id, JSON.stringify(expected)));
        return r ? toUser(r) : null;
      },
      async setBirthday(id, birthday) {
        const r = await one(q('UPDATE users SET birthday = ? WHERE id = ? RETURNING *', birthday, id));
        if (!r) throw new Error('user_not_found');
        return toUser(r);
      },
      async anonymise(id, at) {
        await db.batch([
          q(`UPDATE users SET email = NULL, line_sub = NULL, nickname = 'deleted', banned = 1, birthday = NULL, tz = NULL, deleted_at = ? WHERE id = ?`, at, id),
          q('DELETE FROM messages WHERE owner_id = ?', id),
          q('DELETE FROM push_subscriptions WHERE user_id = ?', id),
          q('DELETE FROM memories WHERE user_id = ?', id),
          q('DELETE FROM chat_memory WHERE owner_id = ?', id),
          q('DELETE FROM inbox WHERE user_id = ?', id),
          q('UPDATE events SET user_id = NULL WHERE user_id = ?', id),
          q('DELETE FROM scene_runs WHERE user_id = ?', id),
          q('DELETE FROM scene_offers WHERE user_id = ?', id),
          q('DELETE FROM card_affection WHERE user_id = ?', id),
          q('DELETE FROM user_cities WHERE user_id = ?', id),
          q('DELETE FROM relationship WHERE user_id = ?', id),
          q('DELETE FROM promises WHERE user_id = ?', id),
          q('DELETE FROM alarms WHERE user_id = ?', id),
          q('DELETE FROM confessions WHERE user_id = ?', id),
          q('DELETE FROM confession_voice WHERE user_id = ?', id),
          q('DELETE FROM her_messages WHERE user_id = ?', id),
          q('DELETE FROM her_message_prefs WHERE user_id = ?', id),
          q('DELETE FROM gifts WHERE user_id = ?', id),
          q('DELETE FROM voice_ledger WHERE user_id = ?', id),
          q('DELETE FROM call_names WHERE user_id = ?', id),
          q('DELETE FROM look_praise WHERE user_id = ?', id),
          q('DELETE FROM call_name_prefs WHERE user_id = ?', id),
          // #51: his exports go; his memory-store files are queued for erasure in this same step.
          q('DELETE FROM memory_exports WHERE user_id = ?', id),
          q('INSERT INTO memory_purges (user_id, requested_at) VALUES (?, ?) ON CONFLICT (user_id) DO NOTHING', id, at)
        ]);
      }
    },
    devices: {
      async get(id) {
        const [dev, reds] = await db.batch([
          q('SELECT trial_used FROM devices WHERE id = ?', id),
          q('SELECT * FROM device_redemptions WHERE device_id = ? ORDER BY created_at, rowid', id)
        ]);
        return { id, trialUsed: num(dev.rows[0]?.trial_used), redemptions: reds.rows.map(toRedemption) };
      },
      async reserveTrial(id, limit) {
        const [, r] = await db.batch([
          q('INSERT OR IGNORE INTO devices (id) VALUES (?)', id),
          q('UPDATE devices SET trial_used = trial_used + 1 WHERE id = ? AND trial_used < ? RETURNING trial_used', id, limit)
        ]);
        return r.rows[0] ? limit - num(r.rows[0].trial_used) : null;
      },
      async releaseTrial(id) { await run(q('UPDATE devices SET trial_used = max(trial_used - 1, 0) WHERE id = ?', id)); }
    },
    otp: {
      async put(email, code, expiresAt) {
        await run(q(`INSERT INTO otps (email, code, expires_at, attempts) VALUES (?, ?, ?, 0)
          ON CONFLICT (email) DO UPDATE SET code = excluded.code, expires_at = excluded.expires_at, attempts = 0`, email, code, expiresAt));
      },
      async take(email, code) {
        const row = await one(q('UPDATE otps SET attempts = attempts + 1 WHERE email = ? RETURNING code, expires_at, attempts', email));
        if (!row) return 'expired';
        // B-N6: a code spent by wrong tries stays spent (the row is kept; only a new code resets it), so every later try,
        // the right code included, says so instead of 「expired」.
        if (num(row.attempts) > OTP_MAX_ATTEMPTS) return 'attempts';
        if (num(row.expires_at) < Date.now()) { await run(q('DELETE FROM otps WHERE email = ?', email)); return 'expired'; }
        if (String(row.code) !== code) return 'invalid';
        // Single use: of two parallel correct submissions only one deletes the row.
        return (await run(q('DELETE FROM otps WHERE email = ? AND code = ?', email, code))) === 1 ? 'ok' : 'expired';
      }
    },
    signupBlocks: {
      async put(hash, until) {
        await run(q(`INSERT INTO signup_blocks (email_hash, until) VALUES (?, ?)
          ON CONFLICT (email_hash) DO UPDATE SET until = max(until, excluded.until)`, hash, until));
      },
      async until(hash, now) {
        const r = await one(q('SELECT until FROM signup_blocks WHERE email_hash = ? AND until > ?', hash, now));
        return r ? String(r.until) : null;
      }
    },
    serials: {
      async byHash(hash) {
        const r = await one(q(`SELECT s.*, b.trial_days, b.draws FROM serials s JOIN serial_batches b ON b.id = s.batch_id WHERE s.code_hash = ?`, hash));
        return r ? toSerial(r) : null;
      },
      async createBatch(batch, rows) {
        const per = Math.floor(MAX_PARAMS / 3);
        const stmts = [q(`INSERT OR IGNORE INTO serial_batches (id, label, quantity, trial_days, draws, created_at) VALUES (?, ?, ?, ?, ?, ?)`,
          batch.id, batch.label, batch.quantity, batch.trialDays, batch.draws, batch.createdAt)];
        for (let i = 0; i < rows.length; i += per) {
          const chunk = rows.slice(i, i + per);
          stmts.push(q(`INSERT OR IGNORE INTO serials (id, code_hash, batch_id) VALUES ${chunk.map(() => '(?, ?, ?)').join(', ')}`,
            ...chunk.flatMap((r) => [r.id, r.codeHash, batch.id])));
        }
        const results = await db.batch(stmts);
        return results.slice(1).reduce((n, r) => n + r.changes, 0);
      },
      async countByUser(userId) { return num((await one(q('SELECT count(*) AS n FROM serials WHERE redeemed_by_user = ?', userId)))?.n); },
      async byId(id) {
        const r = await one(q(`SELECT s.*, b.trial_days, b.draws FROM serials s JOIN serial_batches b ON b.id = s.batch_id WHERE s.id = ?`, id));
        return r ? toSerial(r) : null;
      },
      async void(id, at) {
        return (await run(q(`UPDATE serials SET redeemed_at = ?, redeemed_by_device = '${VOID}' WHERE id = ? AND redeemed_at IS NULL`, at, id))) === 1;
      }
    },
    gacha: {
      async draw(plan) {
        const d = plan.draw;
        const guard = q('EXISTS (SELECT 1 FROM users WHERE id = ? AND last_draw_id = ?)', plan.userId, d.id);
        const stmts: Stmt[] = [
          q(`UPDATE users SET points = points - ?, free_pulls = free_pulls - ?, pity = ?, shards = shards + ?, last_draw_id = ?
             WHERE id = ? AND points >= ? AND free_pulls >= ? AND pity = ? AND shards + ? >= 0 RETURNING *`,
            plan.cost.points, plan.cost.freePulls, plan.newPity, plan.shardsDelta, d.id, plan.userId, plan.cost.points, plan.cost.freePulls, plan.expectPity, plan.shardsDelta),
          q(`INSERT INTO draws (id, owner_id, pool_id, serial_id, card_ids, tiers, cost, seed, created_at) SELECT ?, ?, ?, ?, ?, ?, ?, ?, ? WHERE ${guard.sql}`,
            d.id, d.ownerId, d.poolId, d.serialId, JSON.stringify(d.cardIds), d.tiers ? JSON.stringify(d.tiers) : null, d.cost, d.seed, d.createdAt, ...guard.params)
        ];
        const grantAt = plan.cards.map((c) => {
          const at = stmts.push(grantStmt(guard, plan.userId, c.cardId, plan.at, false)) - 1;
          stmts.push(...duplicateStmts(guard, plan.userId, c.cardId, c.star, c.variant, plan.at));
          stmts.push(duplicateShardStmt(guard, plan.userId, c.cardId, c.duplicateShards));
          return at;
        });
        const walletAt = stmts.push(q(`SELECT * FROM users WHERE id = ? AND ${guard.sql}`, plan.userId, ...guard.params)) - 1;
        const results = await db.batch(stmts);
        const row = results[0].rows[0];
        if (!row) {
          const now = await userById(plan.userId);
          return { ok: false, reason: now && now.pity !== plan.expectPity ? 'conflict' : 'insufficient' };
        }
        return { ok: true, user: toUser(results[walletAt].rows[0] ?? row), isNew: grantAt.map((i) => num(results[i].rows[0]?.copies) === 1) };
      }
    },
    lucky: {
      async redeem(plan) {
        const d = plan.draw;
        const userId = 'userId' in plan.owner ? plan.owner.userId : null;
        const device = 'device' in plan.owner ? plan.owner.device : null;
        // Everything after the first statement applies only if that statement claimed the code for this draw.
        const guard = q('EXISTS (SELECT 1 FROM serials WHERE id = ? AND draw_id = ?)', plan.serialId, d.id);
        const stmts: Stmt[] = [
          q('UPDATE serials SET redeemed_at = ?, redeemed_by_user = ?, redeemed_by_device = ?, draw_id = ? WHERE id = ? AND redeemed_at IS NULL',
            plan.at, userId, device, d.id, plan.serialId),
          q(`INSERT INTO draws (id, owner_id, pool_id, serial_id, card_ids, tiers, cost, seed, created_at) SELECT ?, ?, ?, ?, ?, ?, ?, ?, ? WHERE ${guard.sql}`,
            d.id, d.ownerId, d.poolId, d.serialId, JSON.stringify(d.cardIds), d.tiers ? JSON.stringify(d.tiers) : null, d.cost, d.seed, d.createdAt, ...guard.params)
        ];
        const grantAt: number[] = [];
        if (userId) {
          for (const c of plan.cards) {
            grantAt.push(stmts.length);
            stmts.push(grantStmt(guard, userId, c.cardId, plan.at), bondStmt(guard, userId, c.cardId, c.star, plan.bondXp),
              ...duplicateStmts(guard, userId, c.cardId, c.star, c.variant, plan.at), duplicateShardStmt(guard, userId, c.cardId, c.duplicateShards));
          }
          if (plan.passUntil) stmts.push(q(`UPDATE users SET pass_until = ? WHERE id = ? AND ${guard.sql}`, plan.passUntil, userId, ...guard.params));
        } else {
          stmts.push(
            q('INSERT OR IGNORE INTO devices (id) VALUES (?)', device),
            q(`INSERT INTO device_redemptions (serial_id, device_id, card_ids, trial_days, created_at) SELECT ?, ?, ?, ?, ? WHERE ${guard.sql}`,
              plan.serialId, device, JSON.stringify(plan.cards.map((c) => c.cardId)), plan.trialDays, plan.at, ...guard.params)
          );
        }
        const results = await db.batch(stmts);
        if (results[0].changes !== 1) return { ok: false };
        return { ok: true, isNew: userId ? grantAt.map((i) => num(results[i].rows[0]?.copies) === 1) : plan.cards.map(() => false) };
      },
      async claim(user, device, bondXp, passUntil, variantDup) {
        const taken = (await all(q('SELECT * FROM device_redemptions WHERE device_id = ? ORDER BY created_at, rowid', device))).map(toRedemption);
        if (!taken.length) return null;
        const cardDefs = new Map((await allCards()).map((c) => [c.id, c]));
        const at = new Date().toISOString();
        const trialDays = taken.reduce((n, r) => n + r.trialDays, 0);
        const stmts: Stmt[] = [];
        for (const r of taken) {
          // Per code: applies only while the code is still waiting on this device, so a parallel claim cannot double it.
          const guard = q('EXISTS (SELECT 1 FROM device_redemptions WHERE serial_id = ? AND device_id = ?)', r.serialId, device);
          for (const cardId of r.cardIds) {
            const card = cardDefs.get(cardId);
            const star = card?.star ?? '';
            stmts.push(grantStmt(guard, user.id, cardId, at), bondStmt(guard, user.id, cardId, star, bondXp),
              ...(star ? duplicateStmts(guard, user.id, cardId, star, variantDup?.(cardId), at) : []),
              duplicateShardStmt(guard, user.id, cardId, card ? RULES.duplicateShards[card.rarity] : 0));
          }
          stmts.push(
            q(`UPDATE serials SET redeemed_by_user = ? WHERE id = ? AND ${guard.sql}`, user.id, r.serialId, ...guard.params),
            q(`UPDATE draws SET owner_id = ? WHERE serial_id = ? AND ${guard.sql}`, user.id, r.serialId, ...guard.params)
          );
        }
        const ids = taken.map((r) => r.serialId);
        const marks = ids.map(() => '?').join(', ');
        stmts.push(
          q(`UPDATE users SET pass_until = ? WHERE id = ? AND EXISTS (SELECT 1 FROM device_redemptions WHERE device_id = ? AND serial_id IN (${marks}))`,
            passUntil(trialDays), user.id, device, ...ids),
          q(`DELETE FROM device_redemptions WHERE device_id = ? AND serial_id IN (${marks})`, device, ...ids)
        );
        const results = await db.batch(stmts);
        if (results[results.length - 1].changes === 0) return null;
        return { cardIds: taken.flatMap((r) => r.cardIds), trialDays, serials: ids };
      }
    },
    cards: {
      all: allCards,
      async upsert(c) { await run(q('INSERT INTO cards (id, data) VALUES (?, ?) ON CONFLICT (id) DO UPDATE SET data = excluded.data', c.id, JSON.stringify(c))); }
    },
    pools: {
      async byId(id) { const r = await one(q('SELECT data FROM pools WHERE id = ?', id)); return r ? (JSON.parse(String(r.data)) as PoolRow) : null; },
      async upsert(p) { await run(q('INSERT INTO pools (id, data) VALUES (?, ?) ON CONFLICT (id) DO UPDATE SET data = excluded.data', p.id, JSON.stringify(p))); },
      async all() { return (await all(q('SELECT data FROM pools ORDER BY rowid'))).map((r) => JSON.parse(String(r.data)) as PoolRow); }
    },
    // Pickups (#78) share the JSON `pools` table under ids `pickup:…`; the legacy pool rows never use that prefix.
    pickups: {
      async all() {
        return (await all(q("SELECT data FROM pools WHERE id LIKE 'pickup:%'"))).map((r) => JSON.parse(String(r.data)) as PickupRow)
          .sort((a, b) => a.startsAt.localeCompare(b.startsAt) || a.id.localeCompare(b.id));
      },
      async byId(id) {
        if (!id.startsWith('pickup:')) return null;
        const r = await one(q('SELECT data FROM pools WHERE id = ?', id));
        return r ? (JSON.parse(String(r.data)) as PickupRow) : null;
      },
      async upsert(p) { await run(q('INSERT INTO pools (id, data) VALUES (?, ?) ON CONFLICT (id) DO UPDATE SET data = excluded.data', p.id, JSON.stringify(p))); }
    },
    owned: {
      async forUser(userId) { return (await all(q('SELECT * FROM owned WHERE user_id = ? ORDER BY first_owned_at, rowid', userId))).map(toOwned); },
      async grant(userId, cardId, viaSerial) {
        const r = await one(q(`INSERT INTO owned (user_id, card_id, copies, first_owned_at, via_serial) VALUES (?, ?, 1, ?, ?)
          ON CONFLICT (user_id, card_id) DO UPDATE SET copies = copies + 1 RETURNING copies`, userId, cardId, new Date().toISOString(), viaSerial));
        return num(r?.copies) === 1;
      },
      async uninvited(cardIds, since, invitePrefix, limit) {
        if (!cardIds.length) return [];
        // Invited rows are left out here rather than skipped by the caller, so the batch always moves on to the next
        // owners. The invite's id is a hash of user and card, so the match is on the owner's rows with the prefix (a
        // range on the primary key, as inbox.withPrefix) and the card in their payload.
        return (await all(q(`SELECT o.*, u.lang AS user_lang FROM owned o JOIN users u ON u.id = o.user_id AND u.banned = 0
          WHERE o.card_id IN (${cardIds.map(() => '?').join(', ')}) AND o.first_owned_at >= ?
            AND NOT EXISTS (SELECT 1 FROM inbox i WHERE i.user_id = o.user_id AND i.id >= ? AND i.id < ?
              AND json_extract(i.payload, '$.cardId') = o.card_id)
          ORDER BY o.first_owned_at, o.rowid LIMIT ?`, ...cardIds, since, invitePrefix, `${invitePrefix}\uFFFF`, limit)))
          .map((r) => ({ ...toOwned(r), lang: String(r.user_lang) as Lang }));
      }
    },
    cardAffection: {
      async get(userId, cardId) {
        const r = await one(q('SELECT * FROM card_affection WHERE user_id = ? AND card_id = ?', userId, cardId));
        return r ? toCardAffection(r) : null;
      },
      async forUser(userId) { return (await all(q('SELECT * FROM card_affection WHERE user_id = ? ORDER BY card_id', userId))).map(toCardAffection); },
      async add(userId, cardId, star, gain) {
        const results = await db.batch([
          ...variantStmts(q('1'), userId, cardId, star, gain, new Date().toISOString()),
          q('SELECT * FROM card_affection WHERE user_id = ? AND card_id = ?', userId, cardId)
        ]);
        return toCardAffection(results[results.length - 1].rows[0]);
      },
      async setPinned(userId, cardId, pinned) {
        const r = await one(q(`INSERT INTO card_affection (user_id, card_id, home_pinned, updated_at) VALUES (?, ?, ?, ?)
          ON CONFLICT (user_id, card_id) DO UPDATE SET home_pinned = excluded.home_pinned, updated_at = excluded.updated_at RETURNING *`,
          userId, cardId, pinned ? 1 : 0, new Date().toISOString()));
        return toCardAffection(r!);
      }
    },
    memories: {
      async forUser(userId) {
        return (await all(q('SELECT * FROM memories WHERE user_id = ? ORDER BY rowid', userId)))
          .map((r) => ({
            id: String(r.id), userId: String(r.user_id), star: r.star as StarId, title: String(r.title), createdAt: String(r.created_at),
            kind: (str(r.kind) ?? 'chat') as MemoryKind, sceneId: str(r.scene_id), still: str(r.still)
          }));
      },
      async add(m) { await run(memoryInsert(m)); }
    },
    messages: {
      async recent(ownerId, star, limit) {
        return (await all(q('SELECT * FROM (SELECT * FROM messages WHERE owner_id = ? AND star = ? ORDER BY n DESC LIMIT ?) ORDER BY n', ownerId, star, limit))).map(toMessage);
      },
      async add(m) { await run(q('INSERT INTO messages (id, owner_id, star, role, text, created_at) VALUES (?, ?, ?, ?, ?, ?)', m.id, m.ownerId, m.star, m.role, m.text, m.createdAt)); },
      async countUser(ownerId, star) { return num((await one(q(`SELECT count(*) AS n FROM messages WHERE owner_id = ? AND star = ? AND role = 'user'`, ownerId, star)))?.n); },
      async reassign(fromOwner, toOwner) { await run(q('UPDATE messages SET owner_id = ? WHERE owner_id = ?', toOwner, fromOwner)); }
    },
    affinity: {
      async get(userId, star) { return num((await one(q('SELECT xp FROM affinity WHERE user_id = ? AND star = ?', userId, star)))?.xp); },
      async all(userId) {
        const out: Partial<Record<StarId, number>> = {};
        for (const r of await all(q('SELECT star, xp FROM affinity WHERE user_id = ?', userId))) out[r.star as StarId] = num(r.xp);
        return out;
      },
      async add(userId, star, xp) {
        return num((await one(q(`INSERT INTO affinity (user_id, star, xp) VALUES (?, ?, ?)
          ON CONFLICT (user_id, star) DO UPDATE SET xp = xp + excluded.xp RETURNING xp`, userId, star, xp)))?.xp);
      }
    },
    draws: {
      async add(d) {
        await run(q('INSERT INTO draws (id, owner_id, pool_id, serial_id, card_ids, tiers, cost, seed, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
          d.id, d.ownerId, d.poolId, d.serialId, JSON.stringify(d.cardIds), d.tiers ? JSON.stringify(d.tiers) : null, d.cost, d.seed, d.createdAt));
      },
      async forOwner(ownerId, limit) {
        return (await all(q('SELECT * FROM (SELECT * FROM draws WHERE owner_id = ? ORDER BY n DESC LIMIT ?) ORDER BY n', ownerId, limit))).map(toDraw);
      },
      async codesForOwner(ownerId) {
        return (await all(q('SELECT * FROM draws WHERE owner_id = ? AND serial_id IS NOT NULL ORDER BY n DESC', ownerId))).map(toDraw);
      }
    },
    audit: {
      async add(a) { await run(q('INSERT INTO audit (id, actor_id, action, target, meta, created_at) VALUES (?, ?, ?, ?, ?, ?)', a.id, a.actorId, a.action, a.target, JSON.stringify(a.meta), a.createdAt)); },
      async recent(limit) { return (await all(q('SELECT * FROM (SELECT * FROM audit ORDER BY n DESC LIMIT ?) ORDER BY n', limit))).map(toAudit); },
      async byAction(action, limit) { return (await all(q('SELECT * FROM audit WHERE action = ? ORDER BY n DESC LIMIT ?', action, limit))).map(toAudit); }
    },
    events: {
      async add(e) {
        await run(q('INSERT INTO events (user_id, name, props, day, created_at) VALUES (?, ?, ?, ?, ?)', e.userId, e.name, JSON.stringify(e.props), e.day, e.createdAt));
      },
      async purgeOldestDay(cutoff) {
        return run(q('DELETE FROM events WHERE day = (SELECT min(day) FROM events) AND day < ?', cutoff));
      },
      async metrics(from, to, grouping) { return sqlMetrics(db, from, to, grouping); },
      async activeRooms(sinceDay) {
        const rows = await all(q(`SELECT user_id, json_extract(props, '$.star') AS star, max(day) AS last_day FROM events
          WHERE name = 'room.entered' AND day >= ? AND user_id IS NOT NULL GROUP BY user_id, star`, sinceDay));
        return rows.filter((r) => r.star).map((r) => ({ userId: String(r.user_id), star: r.star as StarId, lastDay: String(r.last_day) }));
      },
      async ofUser(userId, name, sinceDay) {
        const rows = await all(q('SELECT props, created_at FROM events WHERE user_id = ? AND day >= ? AND name = ? ORDER BY n', userId, sinceDay, name));
        return rows.map((r) => ({ createdAt: String(r.created_at), props: JSON.parse(String(r.props)) as Record<string, unknown> }));
      }
    },
    chatMemory: {
      async get(ownerId, star) {
        const r = await one(q('SELECT * FROM chat_memory WHERE owner_id = ? AND star = ?', ownerId, star));
        return r ? toChatMemory(r) : null;
      },
      async save(ownerId, star, facts, summary) {
        await run(q(`INSERT INTO chat_memory (owner_id, star, facts, summary, updated_at) VALUES (?, ?, ?, ?, ?)
          ON CONFLICT (owner_id, star) DO UPDATE SET facts = excluded.facts, summary = excluded.summary, updated_at = excluded.updated_at`,
          ownerId, star, JSON.stringify(facts), summary, new Date().toISOString()));
      },
      async setGreeting(ownerId, star, g) {
        await run(q(`INSERT INTO chat_memory (owner_id, star, updated_at, greeting_day, greeting_lang, greeting_text) VALUES (?, ?, ?, ?, ?, ?)
          ON CONFLICT (owner_id, star) DO UPDATE SET greeting_day = excluded.greeting_day, greeting_lang = excluded.greeting_lang, greeting_text = excluded.greeting_text`,
          ownerId, star, new Date().toISOString(), g.day, g.lang, g.text));
      },
      async addPending(ownerId, star, turns, at, max) {
        if (!turns.length) return;
        // One transaction: the row if there is none, then the turns appended ('$[#]') and only the newest `max` kept.
        // json_each walks the array in order, so json_group_array keeps it.
        const appended = `json_insert(chat_memory.pending${", '$[#]', json(?)".repeat(turns.length)})`;
        await db.batch([
          q(`INSERT INTO chat_memory (owner_id, star, updated_at) VALUES (?, ?, ?) ON CONFLICT (owner_id, star) DO NOTHING`, ownerId, star, at),
          q(`UPDATE chat_memory SET pending_at = ?, pending = (SELECT json_group_array(json(value)) FROM json_each(${appended})
               WHERE key >= json_array_length(chat_memory.pending) + ? - ?)
             WHERE owner_id = ? AND star = ?`, at, ...turns.map((t) => JSON.stringify(t)), turns.length, max, ownerId, star)
        ]);
      },
      async dropPending(ownerId, star, ids) {
        if (!ids.length) return;
        const kept = `FROM json_each(chat_memory.pending) WHERE json_extract(value, '$.id') NOT IN (SELECT value FROM json_each(?))`;
        await run(q(`UPDATE chat_memory SET pending = (SELECT json_group_array(json(value)) ${kept}),
          pending_at = CASE WHEN EXISTS (SELECT 1 ${kept}) THEN pending_at ELSE NULL END
          WHERE owner_id = ? AND star = ?`, JSON.stringify(ids), JSON.stringify(ids), ownerId, star));
      },
      async quiet(before, limit) {
        const rows = await all(q(`SELECT owner_id, star FROM chat_memory WHERE pending_at IS NOT NULL AND pending_at < ? AND pending <> '[]' ORDER BY pending_at LIMIT ?`, before, limit));
        return rows.map((r) => ({ ownerId: String(r.owner_id), star: r.star as StarId }));
      }
    },
    inbox: {
      async add(r) {
        await run(q('INSERT INTO inbox (id, user_id, star, kind, payload, due_at, delivered_at, read_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
          r.id, r.userId, r.star, r.kind, JSON.stringify(r.payload), r.dueAt, r.deliveredAt, r.readAt, r.createdAt));
      },
      async deliverDue(at, limit) {
        // D1 has no UPDATE … LIMIT; the subquery picks the batch and `delivered_at IS NULL` in the outer WHERE
        // keeps a row that an overlapping tick delivered first from being delivered again.
        const rows = await all(q(`UPDATE inbox SET delivered_at = ? WHERE delivered_at IS NULL AND id IN
          (SELECT id FROM inbox WHERE delivered_at IS NULL AND due_at <= ? ORDER BY due_at LIMIT ?) RETURNING *`, at, at, limit));
        return rows.map(toInbox).sort((a, b) => (a.dueAt < b.dueAt ? -1 : a.dueAt > b.dueAt ? 1 : 0));
      },
      async forUser(userId, limit) {
        return (await all(q(`SELECT * FROM inbox WHERE user_id = ? AND delivered_at IS NOT NULL
          ORDER BY read_at IS NOT NULL, delivered_at DESC, rowid DESC LIMIT ?`, userId, limit))).map(toInbox);
      },
      async deliveredSince(userId, star, prefix, since) {
        return (await all(q(`SELECT * FROM inbox WHERE user_id = ? AND star = ? AND id >= ? AND id < ? AND delivered_at IS NOT NULL AND delivered_at >= ?`,
          userId, star, prefix, `${prefix}\uFFFF`, since))).map(toInbox);
      },
      async mine(userId, id) {
        const r = await one(q('SELECT * FROM inbox WHERE id = ? AND user_id = ? AND delivered_at IS NOT NULL', id, userId));
        return r ? toInbox(r) : null;
      },
      async unread(userId) {
        return num((await one(q('SELECT count(*) AS n FROM inbox WHERE user_id = ? AND delivered_at IS NOT NULL AND read_at IS NULL', userId)))?.n);
      },
      async deliverMine(userId, id, at, dueBy) {
        const r = await one(q('UPDATE inbox SET delivered_at = ? WHERE id = ? AND user_id = ? AND delivered_at IS NULL AND due_at <= ? RETURNING *', at, id, userId, dueBy));
        return r ? toInbox(r) : null;
      },
      async markRead(userId, id, at) {
        const r = await one(q(`UPDATE inbox SET read_at = coalesce(read_at, ?) WHERE id = ? AND user_id = ? AND delivered_at IS NOT NULL RETURNING *`, at, id, userId));
        return r ? toInbox(r) : null;
      },
      async addOnce(r) {
        return (await run(q('INSERT OR IGNORE INTO inbox (id, user_id, star, kind, payload, due_at, delivered_at, read_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
          r.id, r.userId, r.star, r.kind, JSON.stringify(r.payload), r.dueAt, r.deliveredAt, r.readAt, r.createdAt))) === 1;
      },
      async withPrefix(prefix, since) {
        // A range on the primary key rather than LIKE, so the index is used: every id with the prefix sorts before prefix + U+FFFF.
        return (await all(q('SELECT * FROM inbox WHERE id >= ? AND id < ? AND created_at >= ?', prefix, `${prefix}￿`, since))).map(toInbox);
      },
      async addTexts(userId, id, texts) {
        // json_patch merges the new languages into what is there (or into nothing, for a row without texts yet).
        await run(q(`UPDATE inbox SET payload = json_set(payload, '$.texts', json_patch(coalesce(json_extract(payload, '$.texts'), '{}'), json(?)))
          WHERE id = ? AND user_id = ?`, JSON.stringify(texts), id, userId));
      },
      async readNaming(userId, star, sceneId, at) {
        return run(q(`UPDATE inbox SET read_at = ? WHERE user_id = ? AND star = ? AND read_at IS NULL AND delivered_at IS NOT NULL
          AND (json_extract(payload, '$.scene') = ? OR json_extract(payload, '$.sceneId') = ?)`, at, userId, star, sceneId, sceneId));
      }
    },
    promises: {
      async create(p) { return (await run(promiseStmt(always, p))) === 1; },
      async byId(id) { const r = await one(q('SELECT * FROM promises WHERE id = ?', id)); return r ? toPromise(r) : null; },
      async open(userId, star) {
        return (await all(star
          ? q(`SELECT * FROM promises WHERE user_id = ? AND star = ? AND status = 'open' ORDER BY due_at`, userId, star)
          : q(`SELECT * FROM promises WHERE user_id = ? AND status = 'open' ORDER BY due_at`, userId))).map(toPromise);
      },
      async latest(userId, star) {
        const r = await one(q('SELECT * FROM promises WHERE user_id = ? AND star = ? ORDER BY made_at DESC, rowid DESC LIMIT 1', userId, star));
        return r ? toPromise(r) : null;
      },
      async forUser(userId) {
        return (await all(q('SELECT * FROM promises WHERE user_id = ? ORDER BY made_at, rowid', userId))).map(toPromise);
      },
      async dueUnnotified(at, limit) {
        return (await all(q(`SELECT * FROM promises WHERE status = 'open' AND notified_at IS NULL AND due_at <= ? ORDER BY due_at LIMIT ?`, at, limit))).map(toPromise);
      },
      async notify(id, at, line) {
        // Her line is written only by the batch whose first statement marked the promise: guarded by that mark.
        const results = await db.batch([
          q(`UPDATE promises SET notified_at = ? WHERE id = ? AND status = 'open' AND notified_at IS NULL`, at, id),
          ...(line ? [q(`INSERT INTO inbox (id, user_id, star, kind, payload, due_at, delivered_at, read_at, created_at)
             SELECT ?, ?, ?, ?, ?, ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM promises WHERE id = ? AND notified_at = ?)
               AND NOT EXISTS (SELECT 1 FROM inbox WHERE id = ?)`,
            line.id, line.userId, line.star, line.kind, JSON.stringify(line.payload), line.dueAt, line.deliveredAt, line.readAt, line.createdAt, id, at, line.id)] : [])
        ]);
        return results[0].changes === 1;
      },
      async keep(id, at, dueFrom, dueTo, memory: MemoryRow | null) {
        const kept = q(`EXISTS (SELECT 1 FROM promises WHERE id = ? AND status = 'kept' AND kept_at = ?)`, id, at);
        const [r] = await db.batch([
          q(`UPDATE promises SET status = 'kept', kept_at = ?, notified_at = coalesce(notified_at, ?)
             WHERE id = ? AND status = 'open' AND due_at >= ? AND due_at <= ? RETURNING *`, at, at, id, dueFrom, dueTo),
          q(`UPDATE inbox SET read_at = coalesce(read_at, ?) WHERE id = ? AND ${kept.sql}`, at, promiseInboxId(id), ...kept.params),
          ...(memory ? [memoryInsert(memory, kept)] : [])
        ]);
        return r.rows[0] ? toPromise(r.rows[0]) : null;
      },
      async expire(dueBefore, at, limit) {
        // The lines first, while their promises are still open: the same rows the second statement then marks.
        const pick = `SELECT id FROM promises WHERE status = 'open' AND due_at < ? ORDER BY due_at LIMIT ?`;
        const [, r] = await db.batch([
          q(`UPDATE inbox SET read_at = coalesce(read_at, ?) WHERE id IN (SELECT '${promiseInboxId('')}' || id FROM (${pick}))`, at, dueBefore, limit),
          q(`UPDATE promises SET status = 'missed', missed_at = ? WHERE status = 'open' AND id IN (${pick}) RETURNING *`, at, dueBefore, limit)
        ]);
        return r.rows.map(toPromise).sort((a, b) => a.dueAt.localeCompare(b.dueAt));
      },
      async toMention(userId, star) {
        const r = await one(q(`SELECT * FROM promises WHERE user_id = ? AND star = ? AND status = 'missed' AND mentioned_at IS NULL ORDER BY due_at DESC LIMIT 1`, userId, star));
        return r ? toPromise(r) : null;
      },
      async mention(id, at) {
        return (await run(q(`UPDATE promises SET mentioned_at = ? WHERE id = ? AND status = 'missed' AND mentioned_at IS NULL`, at, id))) === 1;
      }
    },
    jobs: {
      async claim(job, at, dueBefore, staleBefore) {
        // One conditional upsert: of two overlapping ticks, only the one whose statement changes the row runs the job.
        const r = await one(q(`INSERT INTO job_runs (job, started_at, runs) VALUES (?, ?, 1)
          ON CONFLICT (job) DO UPDATE SET started_at = excluded.started_at, finished_at = NULL, runs = job_runs.runs + 1
          WHERE (job_runs.finished_at IS NOT NULL AND job_runs.started_at <= ?) OR (job_runs.finished_at IS NULL AND job_runs.started_at <= ?)
          RETURNING runs`, job, at, dueBefore, staleBefore));
        return !!r;
      },
      async finish(job, at, o) {
        await run(q(`UPDATE job_runs SET finished_at = ?, ok = ?, error = ?, result = ?, last_ok_at = CASE WHEN ? THEN ? ELSE last_ok_at END WHERE job = ?`,
          at, o.ok, o.error, o.result ? JSON.stringify(o.result) : null, o.ok, at, job));
      },
      async get(job) { const r = await one(q('SELECT * FROM job_runs WHERE job = ?', job)); return r ? toJobRun(r) : null; }
    },
    push: {
      async subscribe(p) {
        await db.batch([
          // A new owner or new keys start clean: an old failure mark belonged to the previous state.
          q(`INSERT INTO push_subscriptions (endpoint, user_id, keys, tz, created_at) VALUES (?, ?, ?, ?, ?)
             ON CONFLICT (endpoint) DO UPDATE SET user_id = excluded.user_id, keys = excluded.keys, tz = excluded.tz, failed_at = NULL`,
            p.endpoint, p.userId, JSON.stringify(p.keys), p.tz, p.createdAt),
          ...(p.tz ? [q('UPDATE users SET tz = ? WHERE id = ?', p.tz, p.userId)] : [])
        ]);
      },
      async unsubscribe(userId, endpoint) {
        return endpoint === undefined
          ? run(q('DELETE FROM push_subscriptions WHERE user_id = ?', userId))
          : run(q('DELETE FROM push_subscriptions WHERE user_id = ? AND endpoint = ?', userId, endpoint));
      },
      async forUser(userId) { return (await all(q('SELECT * FROM push_subscriptions WHERE user_id = ? ORDER BY created_at, rowid', userId))).map(toPush); },
      async remove(endpoint) { await run(q('DELETE FROM push_subscriptions WHERE endpoint = ?', endpoint)); },
      async setFailed(endpoint, at) { await run(q('UPDATE push_subscriptions SET failed_at = ? WHERE endpoint = ?', at, endpoint)); }
    },
    relationship: {
      async get(userId, star) { const r = await one(q('SELECT * FROM relationship WHERE user_id = ? AND star = ?', userId, star)); return r ? toRelationship(r) : null; },
      async forUser(userId) { return (await all(q('SELECT * FROM relationship WHERE user_id = ?', userId))).map(toRelationship); },
      async touch(userId, star, day, at) {
        // Insert-or-count in one statement: of two first messages the same day, only one adds the day.
        const [, read] = await db.batch([
          q(`INSERT INTO relationship (user_id, star, stage, stage_since, stage_day, days_together, last_day, reward_rank) VALUES (?, ?, 'new', ?, 0, 1, ?, 0)
             ON CONFLICT (user_id, star) DO UPDATE SET days_together = days_together + 1, last_day = excluded.last_day
             WHERE relationship.last_day IS NULL OR relationship.last_day < excluded.last_day`, userId, star, at, day),
          q('SELECT * FROM relationship WHERE user_id = ? AND star = ?', userId, star)
        ]);
        return toRelationship(read.rows[0]);
      },
      async change(expect, next, pulls) {
        if (!next.rev || next.rev === expect.rev) throw new Error('relationship_rev_must_change');
        // The free pull and the read-back are guarded by the new rev, which only this change can have written.
        const guard = q('EXISTS (SELECT 1 FROM relationship WHERE user_id = ? AND star = ? AND rev = ?)', expect.userId, expect.star, next.rev);
        const results = await db.batch([
          q(`UPDATE relationship SET stage = ?, stage_since = ?, stage_day = ?, confessed_at = ?, anniversary = ?, lover_xp = ?, reward_rank = ?, rev = ?
             WHERE user_id = ? AND star = ? AND rev IS ?`,
            next.stage, next.stageSince, next.stageDay, next.confessedAt, next.anniversary, next.loverXp, next.rewardRank, next.rev, expect.userId, expect.star, expect.rev),
          ...(pulls > 0 ? [q(`UPDATE users SET free_pulls = free_pulls + ? WHERE id = ? AND ${guard.sql}`, pulls, expect.userId, ...guard.params)] : []),
          q('SELECT * FROM relationship WHERE user_id = ? AND star = ? AND rev = ?', expect.userId, expect.star, next.rev)
        ]);
        const row = results[results.length - 1].rows[0];
        return row ? toRelationship(row) : null;
      }
    },
    sceneRuns: {
      async start(row, grant) {
        const guard = q('EXISTS (SELECT 1 FROM scene_runs WHERE id = ?)', row.id);
        const results = await db.batch([
          q(`INSERT INTO scene_runs (id, user_id, star, scene_id, step, seq, state, rewarded, started_at, updated_at, ended_at, outcome)
             SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ? WHERE NOT EXISTS (SELECT 1 FROM scene_runs WHERE user_id = ? AND ended_at IS NULL)`,
            row.id, row.userId, row.star, row.sceneId, row.step, row.seq, JSON.stringify(row.state), row.rewarded, row.startedAt, row.updatedAt, row.endedAt, row.outcome, row.userId),
          ...sceneGrantStmts(guard, row, grant)
        ]);
        return results[0].changes === 1;
      },
      async byId(id) { const r = await one(q('SELECT * FROM scene_runs WHERE id = ?', id)); return r ? toSceneRun(r) : null; },
      async active(userId) {
        const r = await one(q('SELECT * FROM scene_runs WHERE user_id = ? AND ended_at IS NULL ORDER BY started_at DESC LIMIT 1', userId));
        return r ? toSceneRun(r) : null;
      },
      async advance(row, expectSeq, grant, extension, gift) {
        if (row.seq <= expectSeq) throw new Error('scene_seq_must_grow');
        // The grant is guarded by the new seq, which only this change can have written.
        const guard = q('EXISTS (SELECT 1 FROM scene_runs WHERE id = ? AND seq = ?)', row.id, row.seq);
        // A paid extension (#74) or a gift (#68) goes in only while the run is at the step being answered, and the run
        // moves only with it (its row is this attempt's own): he never pays for a step another request moved first,
        // nor moves unpaid.
        const atStep = q('EXISTS (SELECT 1 FROM scene_runs WHERE id = ? AND seq = ? AND ended_at IS NULL)', row.id, expectSeq);
        const paid = extension && extensionStmts(extension, atStep);
        const given = gift && giftStmts(gift, atStep);
        const conds = [paid?.mine, given?.mine].filter((c): c is Stmt => !!c);
        const inserts = [...(paid ? [paid.insert] : []), ...(given ? [given.insert] : [])];
        const results = await db.batch([
          ...inserts,
          q(`UPDATE scene_runs SET step = ?, seq = ?, state = ?, rewarded = ?, updated_at = ?, ended_at = ?, outcome = ?
             WHERE id = ? AND seq = ? AND ended_at IS NULL${conds.map((c) => ` AND ${c.sql}`).join('')}`,
            row.step, row.seq, JSON.stringify(row.state), row.rewarded, row.updatedAt, row.endedAt, row.outcome, row.id, expectSeq, ...conds.flatMap((c) => c.params)),
          ...(paid ? [paid.take] : []),
          ...(given ? given.pay : []),
          ...sceneGrantStmts(guard, row, grant)
        ]);
        return results[inserts.length].changes === 1;
      },
      async rewardedSince(userId, sceneId, since) {
        return num((await one(q('SELECT count(*) AS n FROM scene_runs WHERE user_id = ? AND scene_id = ? AND rewarded = 1 AND started_at >= ?', userId, sceneId, since)))?.n);
      },
      async endedSince(userId, since) {
        const rows = await all(q(`SELECT scene_id, ended_at, outcome FROM scene_runs
          WHERE user_id = ? AND started_at >= ? AND ended_at IS NOT NULL ORDER BY ended_at DESC LIMIT 50`, userId, since));
        return rows.map((r) => ({ sceneId: String(r.scene_id), endedAt: String(r.ended_at), outcome: r.outcome === null ? null : String(r.outcome) }));
      }
    },
    sceneOffers: {
      async add(row) {
        await run(q(`INSERT INTO scene_offers (id, user_id, star, scene_id, source, status, created_at, expires_at, answered_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`, row.id, row.userId, row.star, row.sceneId, row.source, row.status, row.createdAt, row.expiresAt, row.answeredAt));
      },
      async since(userId, since) {
        return (await all(q('SELECT * FROM scene_offers WHERE user_id = ? AND created_at >= ? ORDER BY created_at, rowid', userId, since))).map(toSceneOffer);
      },
      async answer(id, userId, sceneId, status, at) {
        const r = await one(q(`UPDATE scene_offers SET status = ?, answered_at = ?
          WHERE id = ? AND user_id = ? AND status = 'open' AND (? = 'declined' OR expires_at > ?) AND (? IS NULL OR scene_id = ?) RETURNING *`,
          status, at, id, userId, status, at, sceneId, sceneId));
        return r ? toSceneOffer(r) : null;
      }
    },
    gifts: {
      async send(plan) {
        const { row, perDay } = plan;
        // The row goes in only while today's gifts are under the cap and he has the points; everything after it is
        // guarded by the row's own id, so a refused gift writes nothing at all.
        const { insert, pay } = giftStmts(plan);
        const stmts: Stmt[] = [
          insert,
          ...pay,
          q('SELECT xp FROM affinity WHERE user_id = ? AND star = ?', row.userId, row.star),
          q('SELECT count(*) AS n FROM gifts WHERE user_id = ? AND day = ?', row.userId, row.day)
        ];
        const results = await db.batch(stmts);
        const sentToday = num(results[results.length - 1].rows[0]?.n);
        const user = results[1].rows[0];
        if (!user) return { ok: false, reason: sentToday >= perDay ? 'limit' : 'insufficient' };
        return { ok: true, user: toUser(user), affinityXp: num(results[results.length - 2].rows[0]?.xp), sentToday };
      },
      async countOn(userId, day) { return num((await one(q('SELECT count(*) AS n FROM gifts WHERE user_id = ? AND day = ?', userId, day)))?.n); }
    },
    voice: {
      async day(userId, day) { return toVoiceDay(day, await one(voiceDayStmt(userId, day))); },
      async use(row) {
        const [ins, sum] = await db.batch([
          q(`INSERT INTO voice_ledger (user_id, request_id, day, kind, seconds, points, nonce, created_at) VALUES (?, ?, ?, ?, ?, 0, ?, ?)
             ON CONFLICT (user_id, request_id) DO NOTHING`, row.userId, row.requestId, row.day, row.kind, row.seconds, row.nonce, row.createdAt),
          voiceDayStmt(row.userId, row.day)
        ]);
        return { recorded: ins.changes > 0, day: toVoiceDay(row.day, sum.rows[0]) };
      },
      async settle(userId, requestId, nonce, day, seconds) {
        const [, sum] = await db.batch([
          seconds === null
            ? q('DELETE FROM voice_ledger WHERE user_id = ? AND request_id = ? AND nonce = ?', userId, requestId, nonce)
            : q('UPDATE voice_ledger SET seconds = ? WHERE user_id = ? AND request_id = ? AND nonce = ?', seconds, userId, requestId, nonce),
          voiceDayStmt(userId, day)
        ]);
        return toVoiceDay(day, sum.rows[0]);
      },
      async extend(row, perDay) {
        const { insert, take } = extensionStmts({ row, perDay });
        const results = await db.batch([
          insert,
          take,
          q('SELECT kind, nonce FROM voice_ledger WHERE user_id = ? AND request_id = ?', row.userId, row.requestId),
          voiceDayStmt(row.userId, row.day),
          q('SELECT * FROM users WHERE id = ?', row.userId)
        ]);
        const [, paid, seen, sum, user] = results;
        const day = toVoiceDay(row.day, sum.rows[0]);
        if (paid.rows[0]) return { ok: true, replayed: false, user: toUser(paid.rows[0]), day };
        const prior = seen.rows[0];
        if (prior) return prior.kind === 'extend' ? { ok: true, replayed: true, user: toUser(user.rows[0]), day } : { ok: false, reason: 'conflict' };
        return { ok: false, reason: day.extensions >= perDay ? 'limit' : 'insufficient' };
      }
    },
    weather: {
      async all() { return (await all(q('SELECT * FROM weather ORDER BY city_key'))).map(toWeather); },
      async get(keys) {
        if (!keys.length) return [];
        return (await all(q(`SELECT * FROM weather WHERE city_key IN (${keys.map(() => '?').join(', ')})`, ...keys))).map(toWeather);
      },
      async saved(cityKey, lat, lon, at, data) {
        await run(q(`INSERT INTO weather (city_key, lat, lon, fetched_at, tried_at, error, data) VALUES (?, ?, ?, ?, ?, NULL, ?)
           ON CONFLICT (city_key) DO UPDATE SET lat = excluded.lat, lon = excluded.lon, fetched_at = excluded.fetched_at,
             tried_at = excluded.tried_at, error = NULL, data = excluded.data`, cityKey, lat, lon, at, at, JSON.stringify(data)));
      },
      async failed(cityKey, lat, lon, at, error) {
        // The last good data and its time stay: readers show it until it is stale.
        await run(q(`INSERT INTO weather (city_key, lat, lon, tried_at, error) VALUES (?, ?, ?, ?, ?)
           ON CONFLICT (city_key) DO UPDATE SET tried_at = excluded.tried_at, error = excluded.error`, cityKey, lat, lon, at, error.slice(0, 500)));
      },
      async prune(herKeys) {
        const her = herKeys.length ? `city_key NOT IN (${herKeys.map(() => '?').join(', ')})` : '1';
        return run(q(`DELETE FROM weather WHERE
           (city_key NOT LIKE 'll:%' AND ${her})
           OR (city_key LIKE 'll:%' AND NOT EXISTS (SELECT 1 FROM user_cities u WHERE u.lat = weather.lat AND u.lon = weather.lon))`, ...herKeys));
      },
      async markFirstSnow(cityKey, winter, day) {
        return (await run(q('INSERT OR IGNORE INTO weather_first_snow (city_key, winter, day) VALUES (?, ?, ?)', cityKey, winter, day))) === 1;
      },
      async firstSnow(keys) {
        if (!keys.length) return [];
        return (await all(q(`SELECT * FROM weather_first_snow WHERE city_key IN (${keys.map(() => '?').join(', ')})`, ...keys)))
          .map((r) => ({ cityKey: String(r.city_key), winter: num(r.winter), day: String(r.day) }));
      },
      async forgetFirstSnow(cityKey, winter) {
        await run(q('DELETE FROM weather_first_snow WHERE city_key = ? AND winter = ?', cityKey, winter));
      }
    },
    confessions: {
      async get(userId, star) { const r = await one(q('SELECT * FROM confessions WHERE user_id = ? AND star = ?', userId, star)); return r ? toConfession(r) : null; },
      async uninvited(limit, { retryDays, maxAsks, today }) {
        const rows = await all(q(`SELECT r.user_id, r.star, r.days_together, u.lang, c.tries, c.last_answer, c.answered_days, c.answered_on,
            c.invited_round, c.reached_round, c.reached_on
          FROM relationship r JOIN users u ON u.id = r.user_id
          LEFT JOIN confessions c ON c.user_id = r.user_id AND c.star = r.star
          WHERE r.stage = 'confession_ready' AND u.banned = 0 AND coalesce(c.invited_round, -1) < coalesce(c.tries, 0)
            AND coalesce(c.tries, 0) < ? AND (c.answered_on IS NULL OR c.answered_on <> ?)
            AND (c.answered_days IS NULL OR r.days_together >= c.answered_days + ?)
          LIMIT ?`, maxAsks, today, retryDays, limit));
        return rows.map((r) => ({
          userId: String(r.user_id), star: r.star as StarId, lang: r.lang as UserRow['lang'], daysTogether: num(r.days_together),
          confession: r.tries === null || r.tries === undefined ? freshConfession() : (({ userId: _u, star: _s, ...c }) => c)(toConfession(r))
        }));
      },
      async invite(userId, star, round, row) {
        // Her message is inserted only by the statement that moved the round on (it wrote this row's id).
        const guard = q('EXISTS (SELECT 1 FROM confessions WHERE user_id = ? AND star = ? AND invited_inbox = ?)', userId, star, row.id);
        const [mark] = await db.batch([
          q(`INSERT INTO confessions (user_id, star, invited_round, invited_inbox) VALUES (?, ?, ?, ?)
             ON CONFLICT (user_id, star) DO UPDATE SET invited_round = excluded.invited_round, invited_inbox = excluded.invited_inbox
             WHERE confessions.invited_round < excluded.invited_round`, userId, star, round, row.id),
          q(`INSERT INTO inbox (id, user_id, star, kind, payload, due_at, delivered_at, read_at, created_at) SELECT ?, ?, ?, ?, ?, ?, ?, ?, ? WHERE ${guard.sql}`,
            row.id, row.userId, row.star, row.kind, JSON.stringify(row.payload), row.dueAt, row.deliveredAt, row.readAt, row.createdAt, ...guard.params)
        ]);
        return mark.changes === 1;
      },
      async reach(userId, star, round, day) {
        return !!(await one(q(`INSERT INTO confessions (user_id, star, reached_round, reached_on) VALUES (?, ?, ?, ?)
          ON CONFLICT (user_id, star) DO UPDATE SET reached_round = excluded.reached_round, reached_on = excluded.reached_on
          WHERE confessions.reached_round < excluded.reached_round RETURNING reached_round`, userId, star, round, day)));
      },
      async answer(userId, star, expectTries, next) {
        return !!(await one(q(`INSERT INTO confessions (user_id, star, tries, last_answer, answered_days, answered_on) VALUES (?, ?, ?, ?, ?, ?)
          ON CONFLICT (user_id, star) DO UPDATE SET tries = excluded.tries, last_answer = excluded.last_answer,
            answered_days = excluded.answered_days, answered_on = excluded.answered_on
          WHERE confessions.tries = ? AND coalesce(confessions.last_answer, '') <> 'accept' RETURNING tries`,
          userId, star, next.tries, next.lastAnswer, next.answeredDays, next.answeredOn, expectTries)));
      },
      async reset(userId, star) { await run(q('DELETE FROM confessions WHERE user_id = ? AND star = ?', userId, star)); },
      async addVoice(v) {
        await run(q(`INSERT INTO confession_voice (memory_id, user_id, star, transcript, audio_type, audio, consented_at, created_at) VALUES (?, ?, ?, ?, NULL, NULL, NULL, ?)`,
          v.memoryId, v.userId, v.star, v.transcript, v.createdAt));
      },
      async voices(userId) {
        return (await all(q(`SELECT ${VOICE_COLUMNS} FROM confession_voice WHERE user_id = ? ORDER BY created_at DESC, rowid DESC`, userId))).map(toVoice);
      },
      async voice(userId, memoryId) {
        const r = await one(q(`SELECT ${VOICE_COLUMNS} FROM confession_voice WHERE user_id = ? AND memory_id = ?`, userId, memoryId));
        return r ? toVoice(r) : null;
      },
      async setAudio(userId, memoryId, audioType, audio, consentedAt) {
        return (await run(q(`UPDATE confession_voice SET audio_type = ?, audio = ?, consented_at = ? WHERE memory_id = ? AND user_id = ? AND audio IS NULL AND audio_key IS NULL`,
          audioType, audio, consentedAt, memoryId, userId))) === 1;
      },
      async setAudioKey(userId, memoryId, audioType, key, consentedAt) {
        return (await run(q(`UPDATE confession_voice SET audio_type = ?, audio_key = ?, consented_at = ? WHERE memory_id = ? AND user_id = ? AND audio IS NULL AND audio_key IS NULL`,
          audioType, key, consentedAt, memoryId, userId))) === 1;
      },
      async moveAudio(userId, memoryId, key) {
        return (await run(q(`UPDATE confession_voice SET audio_key = ?, audio = NULL WHERE memory_id = ? AND user_id = ? AND audio IS NOT NULL AND audio_key IS NULL`,
          key, memoryId, userId))) === 1;
      },
      async legacyAudio(limit) {
        return (await all(q('SELECT user_id, memory_id FROM confession_voice WHERE audio IS NOT NULL ORDER BY created_at LIMIT ?', limit)))
          .map((r) => ({ userId: String(r.user_id), memoryId: String(r.memory_id) }));
      },
      async keptBefore(before, limit) {
        return (await all(q(`SELECT ${VOICE_COLUMNS} FROM confession_voice WHERE audio_type IS NOT NULL AND consented_at < ? ORDER BY consented_at LIMIT ?`, before, limit))).map(toVoice);
      },
      async audio(userId, memoryId) {
        const r = await one(q('SELECT audio_type, audio FROM confession_voice WHERE memory_id = ? AND user_id = ? AND audio IS NOT NULL', memoryId, userId));
        return r ? { audioType: String(r.audio_type), audio: String(r.audio) } : null;
      },
      async clearAudio(userId, memoryId, expectKey) {
        const same = expectKey === undefined ? q('1') : q('audio_key IS ?', expectKey);
        return (await run(q(`UPDATE confession_voice SET audio = NULL, audio_key = NULL, audio_type = NULL, consented_at = NULL
          WHERE memory_id = ? AND user_id = ? AND (audio IS NOT NULL OR audio_key IS NOT NULL) AND ${same.sql}`, memoryId, userId, ...same.params))) === 1;
      }
    },
    memoryAssets: {
      async claimExport(userId, day, at) {
        return (await run(q('INSERT INTO memory_exports (user_id, day, created_at) VALUES (?, ?, ?) ON CONFLICT (user_id, day) DO NOTHING', userId, day, at))) === 1;
      },
      async releaseExport(userId, day) { await run(q('DELETE FROM memory_exports WHERE user_id = ? AND day = ?', userId, day)); },
      async pruneExports(day) { return run(q('DELETE FROM memory_exports WHERE day < ?', day)); },
      async purgesPending(limit) {
        return (await all(q('SELECT user_id FROM memory_purges ORDER BY requested_at, user_id LIMIT ?', limit))).map((r) => String(r.user_id));
      },
      async purgeTried(userId, at) { await run(q('UPDATE memory_purges SET tried_at = ? WHERE user_id = ?', at, userId)); },
      async purgeDone(userId) { await run(q('DELETE FROM memory_purges WHERE user_id = ?', userId)); }
    },
    userCities: {
      async get(userId) {
        const r = await one(q('SELECT * FROM user_cities WHERE user_id = ?', userId));
        return r ? { userId: String(r.user_id), name: String(r.name), lat: num(r.lat), lon: num(r.lon), updatedAt: String(r.updated_at) } : null;
      },
      async set(row) {
        await run(q(`INSERT INTO user_cities (user_id, name, lat, lon, updated_at) VALUES (?, ?, ?, ?, ?)
           ON CONFLICT (user_id) DO UPDATE SET name = excluded.name, lat = excluded.lat, lon = excluded.lon, updated_at = excluded.updated_at`,
          row.userId, row.name, row.lat, row.lon, row.updatedAt));
      },
      async clear(userId) { return (await run(q('DELETE FROM user_cities WHERE user_id = ?', userId))) > 0; },
      async points() { return (await all(q('SELECT DISTINCT lat, lon FROM user_cities ORDER BY lat, lon'))).map((r) => ({ lat: num(r.lat), lon: num(r.lon) })); }
    },
    alarms: {
      async get(userId) { const r = await one(q('SELECT * FROM alarms WHERE user_id = ?', userId)); return r ? toAlarm(r) : null; },
      async set(a, setUserTz) {
        const [res] = await db.batch([
          q(`INSERT INTO alarms (user_id, star, time_local, days, enabled, tz, last_day, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
             ON CONFLICT (user_id) DO UPDATE SET star = excluded.star, time_local = excluded.time_local, days = excluded.days, enabled = excluded.enabled,
               tz = excluded.tz, last_day = excluded.last_day, updated_at = excluded.updated_at
             RETURNING *`, a.userId, a.star, a.time, daysMask(a.days), a.enabled, a.tz, a.lastDay, a.createdAt, a.updatedAt),
          ...(setUserTz ? [q('UPDATE users SET tz = ? WHERE id = ?', a.tz, a.userId)] : [])
        ]);
        return toAlarm(res.rows[0]);
      },
      async enabled() {
        const rows = await all(q(`SELECT a.*, u.tz AS user_tz, u.lang AS user_lang FROM alarms a JOIN users u ON u.id = a.user_id
          WHERE a.enabled = 1 AND u.banned = 0 ORDER BY a.user_id`));
        return rows.map((r): RingCandidate => ({ ...toAlarm(r), userTz: str(r.user_tz), lang: r.user_lang as RingCandidate['lang'] }));
      },
      async ring(userId, day, row) {
        // The claim and the wake-up in one transaction: the INSERT runs only under the token this UPDATE wrote, so a
        // tick that lost the claim (or a repeated tick) adds nothing.
        const [claim] = await db.batch([
          q(`UPDATE alarms SET last_day = ?, snoozes = 0, ring_token = ? WHERE user_id = ? AND enabled = 1 AND (last_day IS NULL OR last_day < ?)`,
            day, row.id, userId, day),
          wakeInsert(row)
        ]);
        return claim.changes === 1;
      },
      async snooze(userId, day, max, row) {
        const [claim] = await db.batch([
          q('UPDATE alarms SET snoozes = snoozes + 1, ring_token = ? WHERE user_id = ? AND last_day = ? AND snoozes < ?', row.id, userId, day, max),
          wakeInsert(row)
        ]);
        return claim.changes === 1;
      },
      async answered(userId, day, at) {
        const [dropped, read] = await db.batch([
          q(`DELETE FROM inbox WHERE user_id = ? AND kind = 'wakeup' AND delivered_at IS NULL AND json_extract(payload, '$.day') = ?`, userId, day),
          q(`UPDATE inbox SET read_at = ? WHERE user_id = ? AND kind = 'wakeup' AND delivered_at IS NOT NULL AND read_at IS NULL
             AND json_extract(payload, '$.day') = ?`, at, userId, day)
        ]);
        return { dropped: dropped.changes, read: read.changes };
      }
    },
    herMessages: {
      async zones() { return (await all(q('SELECT DISTINCT tz FROM users'))).map((r) => str(r.tz)); },
      async toPlan(zones, day, since, after, limit) {
        const named = zones.filter((z): z is string => z !== null).slice(0, MAX_PARAMS - 8);
        const zoneSql = [named.length ? `u.tz IN (${named.map(() => '?').join(', ')})` : '', zones.includes(null) ? 'u.tz IS NULL' : ''].filter(Boolean).join(' OR ') || '0';
        // Users first (a page is whole users), then each one's recent talents.
        const rows = await all(q(`WITH picked AS (
            SELECT u.id, u.tz, coalesce(p.mode, 'normal') AS mode FROM users u LEFT JOIN her_message_prefs p ON p.user_id = u.id
            WHERE u.id > ? AND u.banned = 0 AND u.deleted_at IS NULL AND coalesce(p.mode, 'normal') <> 'off' AND (${zoneSql})
              AND EXISTS (SELECT 1 FROM relationship r WHERE r.user_id = u.id AND r.last_day >= ?)
              AND NOT EXISTS (SELECT 1 FROM her_messages h WHERE h.user_id = u.id AND h.day = ?)
            ORDER BY u.id LIMIT ?
          )
          SELECT picked.id, picked.tz, picked.mode, r.star, r.last_day, r.days_together FROM picked
          JOIN relationship r ON r.user_id = picked.id AND r.last_day >= ? ORDER BY picked.id`, after, ...named, since, day, limit, since));
        const out = new Map<string, HerPlanCandidate>();
        for (const r of rows) {
          const id = String(r.id);
          const c = out.get(id) ?? { userId: id, tz: str(r.tz), mode: r.mode as HerPlanCandidate['mode'], stars: [] };
          c.stars.push({ star: r.star as StarId, lastDay: String(r.last_day), daysTogether: num(r.days_together) });
          out.set(id, c);
        }
        return [...out.values()];
      },
      async lastNightWith(userId, from, to) {
        const r = await one(q(`SELECT star FROM (
            SELECT star, created_at AS at FROM messages WHERE owner_id = ? AND role = 'user' AND created_at >= ? AND created_at < ?
            UNION ALL SELECT star, started_at AS at FROM scene_runs WHERE user_id = ? AND started_at >= ? AND started_at < ?
          ) ORDER BY at DESC LIMIT 1`, userId, from, to, userId, from, to));
        return r ? (r.star as StarId) : null;
      },
      async plan(rows) {
        if (!rows.length) return 0;
        const res = await db.batch(rows.map((h) => q(`INSERT OR IGNORE INTO her_messages (user_id, day, kind, star, inbox_id, due_at, status, tried_at, sent_at, source, reason, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, h.userId, h.day, h.kind, h.star, h.inboxId, h.dueAt, h.status, h.triedAt, h.sentAt, h.source, h.reason, h.createdAt)));
        return res.reduce((n, r) => n + r.changes, 0);
      },
      async due(at, staleBefore, limit) {
        return (await all(q(`SELECT h.*, u.lang, u.nickname, u.tz, u.pass_until, u.banned, u.deleted_at, coalesce(p.mode, 'normal') AS mode
          FROM her_messages h JOIN users u ON u.id = h.user_id LEFT JOIN her_message_prefs p ON p.user_id = h.user_id
          WHERE (h.status = 'planned' AND h.due_at <= ?) OR (h.status = 'writing' AND h.tried_at <= ?)
          ORDER BY h.due_at LIMIT ?`, at, staleBefore, limit))).map((r) => ({
          ...toHerMessage(r),
          user: { lang: r.lang as Lang, nickname: String(r.nickname), tz: str(r.tz), passUntil: str(r.pass_until), active: num(r.banned) === 0 && !r.deleted_at, mode: r.mode as HerMessageMode }
        }));
      },
      async take(key, at, staleBefore) {
        return (await run(q(`UPDATE her_messages SET status = 'writing', tried_at = ?
          WHERE user_id = ? AND day = ? AND kind = ? AND (status = 'planned' OR (status = 'writing' AND tried_at <= ?))`, at, key.userId, key.day, key.kind, staleBefore))) === 1;
      },
      async send(key, triedAt, at, source, line) {
        // Her line is written only by the batch whose first statement marked the row sent: guarded by that mark.
        const [r] = await db.batch([
          q(`UPDATE her_messages SET status = 'sent', sent_at = ?, source = ? WHERE user_id = ? AND day = ? AND kind = ? AND status = 'writing' AND tried_at = ?`,
            at, source, key.userId, key.day, key.kind, triedAt),
          q(`INSERT INTO inbox (id, user_id, star, kind, payload, due_at, delivered_at, read_at, created_at)
             SELECT ?, ?, ?, ?, ?, ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM her_messages WHERE user_id = ? AND day = ? AND kind = ? AND status = 'sent' AND sent_at = ? AND tried_at = ?)
               AND NOT EXISTS (SELECT 1 FROM inbox WHERE id = ?)`,
            line.id, line.userId, line.star, line.kind, JSON.stringify(line.payload), line.dueAt, line.deliveredAt, line.readAt, line.createdAt,
            key.userId, key.day, key.kind, at, triedAt, line.id)
        ]);
        return r.changes === 1;
      },
      async skip(key, reason) {
        await run(q(`UPDATE her_messages SET status = 'skipped', reason = ? WHERE user_id = ? AND day = ? AND kind = ? AND status IN ('planned', 'writing')`, reason, key.userId, key.day, key.kind));
      },
      async sentSince(since) { return num((await one(q(`SELECT count(*) AS n FROM her_messages WHERE status = 'sent' AND sent_at >= ?`, since)))?.n); },
      async sentOn(userId, day) { return num((await one(q(`SELECT count(*) AS n FROM her_messages WHERE user_id = ? AND day = ? AND status = 'sent'`, userId, day)))?.n); },
      async purge(day, limit) {
        return run(q(`DELETE FROM her_messages WHERE rowid IN (SELECT rowid FROM her_messages WHERE day < ? LIMIT ?)`, day, limit));
      },
      async mode(userId) { return ((await one(q('SELECT mode FROM her_message_prefs WHERE user_id = ?', userId)))?.mode as HerMessageMode | undefined) ?? 'normal'; },
      async setMode(userId, mode, at) {
        await run(q(`INSERT INTO her_message_prefs (user_id, mode, updated_at) VALUES (?, ?, ?)
          ON CONFLICT (user_id) DO UPDATE SET mode = excluded.mode, updated_at = excluded.updated_at`, userId, mode, at));
      },
      async replan(h) {
        await run(q(`INSERT INTO her_messages (user_id, day, kind, star, inbox_id, due_at, status, tried_at, sent_at, source, reason, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT (user_id, day, kind) DO UPDATE SET star = excluded.star, inbox_id = excluded.inbox_id, due_at = excluded.due_at, status = excluded.status,
            tried_at = excluded.tried_at, sent_at = excluded.sent_at, source = excluded.source, reason = excluded.reason, created_at = excluded.created_at`,
          h.userId, h.day, h.kind, h.star, h.inboxId, h.dueAt, h.status, h.triedAt, h.sentAt, h.source, h.reason, h.createdAt));
      }
    },
    bond: {
      async get(userId, star) {
        const r = await one(q('SELECT stage, asked, last_answer, answered_at FROM call_names WHERE user_id = ? AND star = ?', userId, star));
        return r ? { stage: r.stage as CallStage, asked: r.asked as CallStage, lastAnswer: (r.last_answer ?? null) as CallAnswer | null, answeredAt: (r.answered_at ?? null) as string | null } : null;
      },
      async answer(userId, star, expectAsked, next) {
        // No row reads as `new`: the insert only happens when she was asking her first question.
        const params = [userId, star, next.stage, next.asked, next.lastAnswer, next.answeredAt];
        if (expectAsked === 'new') {
          return !!(await one(q(`INSERT INTO call_names (user_id, star, stage, asked, last_answer, answered_at) VALUES (?, ?, ?, ?, ?, ?)
            ON CONFLICT (user_id, star) DO UPDATE SET stage = excluded.stage, asked = excluded.asked, last_answer = excluded.last_answer, answered_at = excluded.answered_at
            WHERE call_names.asked = 'new' RETURNING asked`, ...params)));
        }
        return (await run(q(`UPDATE call_names SET stage = ?, asked = ?, last_answer = ?, answered_at = ? WHERE user_id = ? AND star = ? AND asked = ?`,
          next.stage, next.asked, next.lastAnswer, next.answeredAt, userId, star, expectAsked))) === 1;
      },
      async set(userId, star, st) {
        await run(q(`INSERT INTO call_names (user_id, star, stage, asked, last_answer, answered_at) VALUES (?, ?, ?, ?, ?, ?)
          ON CONFLICT (user_id, star) DO UPDATE SET stage = excluded.stage, asked = excluded.asked, last_answer = excluded.last_answer, answered_at = excluded.answered_at`,
          userId, star, st.stage, st.asked, st.lastAnswer, st.answeredAt));
      },
      async praise(userId, star) {
        const rows = await all(q('SELECT look, count FROM look_praise WHERE user_id = ? AND star = ?', userId, star));
        return Object.fromEntries(rows.map((r) => [String(r.look), num(r.count)]));
      },
      async addPraise(userId, star, looks, at, max) {
        const unique = [...new Set(looks)];
        if (!unique.length) return;
        await db.batch(unique.map((look) => q(`INSERT INTO look_praise (user_id, star, look, count, last_at) VALUES (?, ?, ?, 1, ?)
          ON CONFLICT (user_id, star, look) DO UPDATE SET count = min(look_praise.count + 1, ?), last_at = excluded.last_at`, userId, star, look, at, max)));
      },
      async name(userId) { const r = await one(q('SELECT name FROM call_name_prefs WHERE user_id = ?', userId)); return r ? String(r.name) : null; },
      async setName(userId, name, at) {
        if (name === null) { await run(q('DELETE FROM call_name_prefs WHERE user_id = ?', userId)); return; }
        await run(q(`INSERT INTO call_name_prefs (user_id, name, updated_at) VALUES (?, ?, ?)
          ON CONFLICT (user_id) DO UPDATE SET name = excluded.name, updated_at = excluded.updated_at`, userId, name, at));
      }
    },
    calendar: {
      async candidates(since, after, limit) {
        // Users first (a page is whole users), then each one's recent talents — as herMessages.toPlan.
        const rows = await all(q(`WITH picked AS (
            SELECT u.id, u.lang, u.tz, u.birthday, coalesce(p.mode, 'normal') AS mode FROM users u LEFT JOIN her_message_prefs p ON p.user_id = u.id
            WHERE u.id > ? AND u.banned = 0 AND u.deleted_at IS NULL AND coalesce(p.mode, 'normal') <> 'off'
              AND EXISTS (SELECT 1 FROM relationship r WHERE r.user_id = u.id AND r.last_day >= ?)
            ORDER BY u.id LIMIT ?
          )
          SELECT picked.*, r.star, r.last_day, r.stage, r.anniversary FROM picked
          JOIN relationship r ON r.user_id = picked.id AND r.last_day >= ? ORDER BY picked.id, r.star`, after, since, limit, since));
        const out = new Map<string, CalendarCandidate>();
        for (const r of rows) {
          const id = String(r.id);
          const c = out.get(id) ?? { userId: id, lang: r.lang as Lang, tz: str(r.tz), birthday: str(r.birthday), mode: r.mode as CalendarCandidate['mode'], stars: [] };
          c.stars.push({ star: r.star as StarId, lastDay: String(r.last_day), stage: r.stage as CalendarCandidate['stars'][number]['stage'], anniversary: str(r.anniversary) });
          out.set(id, c);
        }
        return [...out.values()];
      }
    }
  };
  return repos;
}

/**
 * The admin metrics as three read-only aggregates, so only counts leave the database, not 180 days of rows
 * (definitions: MetricsCounts in @jstar/shared). memory.ts has the same logic in TypeScript; tests/events.test.ts
 * holds both to the same numbers. SQLite date math: `date(d, 'weekday 0', '-6 days')` is the Monday of d's week.
 */
async function sqlMetrics(db: SqlClient, from: string, to: string, grouping: MetricsGrouping): Promise<MetricsPeriodRow[]> {
  const period = (col: string) => (grouping === 'all' ? `'all'` : grouping === 'week' ? `date(${col}, 'weekday 0', '-6 days')` : col);
  // The last day of a period (day / week / all), never past the range's end.
  const periodEnd = (col: string) => `min(${grouping === 'day' ? col : grouping === 'week' ? `date(${col}, '+6 days')` : `'9999-12-31'`}, ?)`;
  const [cohorts, happened, variants, active] = await db.batch([
    // Cohorts: each user's first day over all retained events; the users first seen in the range.
    q(`WITH first AS (SELECT user_id, min(day) AS d0 FROM events WHERE user_id IS NOT NULL GROUP BY user_id),
       c AS (
         SELECT ${period('f.d0')} AS period,
           EXISTS (SELECT 1 FROM events e WHERE e.user_id = f.user_id AND e.name = 'confession.reached') AS confessed,
           EXISTS (SELECT 1 FROM events e WHERE e.user_id = f.user_id AND e.name = 'scene.trigger' AND e.day <= date(f.d0, '+6 days')) AS scene,
           EXISTS (SELECT 1 FROM events e WHERE e.user_id = f.user_id AND e.day BETWEEN date(f.d0, '+7 days') AND date(f.d0, '+13 days')) AS retained
         FROM first f WHERE f.d0 BETWEEN ? AND ?
       )
       SELECT period, count(*) AS new_users, sum(confessed) AS confessed,
         sum(scene) AS scene_users, sum(scene AND retained) AS scene_retained,
         sum(NOT scene) AS chat_users, sum(NOT scene AND retained) AS chat_retained
       FROM c GROUP BY period`, from, to),
    // What happened in the range. A due promise counts as kept whenever its promise.kept arrives.
    q(`SELECT ${period('ev.day')} AS period,
         sum(ev.name = 'room.entered') AS room_entries,
         sum(ev.name = 'scene.trigger') AS scene_triggers,
         sum(ev.name = 'scene.trigger' AND json_extract(ev.props, '$.source') = 'request') AS src_request,
         sum(ev.name = 'scene.trigger' AND json_extract(ev.props, '$.source') = 'proposed') AS src_proposed,
         sum(ev.name = 'scene.trigger' AND json_extract(ev.props, '$.source') = 'time') AS src_time,
         count(DISTINCT CASE WHEN ev.name = 'promise.due' THEN json_extract(ev.props, '$.promiseId') END) AS promises_due,
         count(DISTINCT CASE WHEN ev.name = 'promise.due' AND EXISTS (
             SELECT 1 FROM events k WHERE k.name = 'promise.kept' AND json_extract(k.props, '$.promiseId') = json_extract(ev.props, '$.promiseId')
           ) THEN json_extract(ev.props, '$.promiseId') END) AS promises_kept
       FROM events ev WHERE ev.day BETWEEN ? AND ? AND ev.name IN ('room.entered', 'scene.trigger', 'promise.due')
       GROUP BY period`, from, to),
    // Variant funnel: per user and period, from the first prompt; the scene must open the day the variant was drawn.
    q(`WITH p AS (
         SELECT user_id, ${period('day')} AS period, min(day) AS d0 FROM events
         WHERE name = 'variant.prompted' AND user_id IS NOT NULL AND day BETWEEN ? AND ? GROUP BY user_id, period
       ),
       f AS (
         SELECT p.period,
           EXISTS (SELECT 1 FROM events d WHERE d.user_id = p.user_id AND d.name = 'variant.drawn'
             AND d.day BETWEEN p.d0 AND ? AND ${period('d.day')} = p.period) AS drawn,
           EXISTS (SELECT 1 FROM events d JOIN events s ON s.user_id = d.user_id AND s.day = d.day AND s.name = 'variant.scene_opened'
             WHERE d.user_id = p.user_id AND d.name = 'variant.drawn' AND d.day BETWEEN p.d0 AND ? AND ${period('d.day')} = p.period) AS opened
         FROM p
       )
       SELECT period, count(*) AS prompted, sum(drawn) AS drawn, sum(opened) AS opened FROM f GROUP BY period`, from, to, to, to),
    // Active users: anyone with an event in the period; of them, who had set an alarm by the period's last day (#57).
    q(`WITH a AS (
         SELECT user_id, ${period('day')} AS period FROM events WHERE user_id IS NOT NULL AND day BETWEEN ? AND ? GROUP BY user_id, period
       )
       SELECT period, count(*) AS active_users,
         sum(EXISTS (SELECT 1 FROM events e WHERE e.user_id = a.user_id AND e.name = 'alarm.set' AND e.day <= ${periodEnd('a.period')})) AS alarm_set
       FROM a GROUP BY period`, from, to, to)
  ]);
  const rows = new Map<string, MetricsPeriodRow>();
  const row = (r: Row) => {
    const key = grouping === 'all' ? from : String(r.period);
    let out = rows.get(key);
    if (!out) { out = { period: key, ...zeroCounts() }; rows.set(key, out); }
    return out;
  };
  for (const r of cohorts.rows) {
    Object.assign(row(r), {
      newUsers: num(r.new_users), confessed: num(r.confessed),
      sceneUsers: num(r.scene_users), sceneRetained: num(r.scene_retained), chatOnlyUsers: num(r.chat_users), chatOnlyRetained: num(r.chat_retained)
    });
  }
  for (const r of happened.rows) {
    Object.assign(row(r), {
      roomEntries: num(r.room_entries), sceneTriggers: num(r.scene_triggers),
      triggerSources: { request: num(r.src_request), proposed: num(r.src_proposed), time: num(r.src_time) },
      promisesDue: num(r.promises_due), promisesKept: num(r.promises_kept)
    });
  }
  for (const r of variants.rows) Object.assign(row(r), { variantPrompted: num(r.prompted), variantDrawn: num(r.drawn), variantSceneOpened: num(r.opened) });
  for (const r of active.rows) Object.assign(row(r), { activeUsers: num(r.active_users), alarmSet: num(r.alarm_set) });
  return [...rows.values()].sort((a, b) => a.period.localeCompare(b.period));
}

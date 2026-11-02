import type { CardDef, ConfessionState, PickupDef, EventName, InboxKind, Lang, MetricsCountsT, PromiseKind, PromiseSource, PromiseStatus, RelationshipState, StarId, VariantGain, WeatherData } from '@jstar/shared';
import type { MemoryKind } from '@jstar/shared/memories';
import type { HerMessageKind, HerMessageMode } from '@jstar/shared/herMessages';
import type { GiftId, GiftTaste } from '@jstar/shared/gifts';
import type { RunState } from '@jstar/shared/scenes';
import type { CallNameState } from '@jstar/shared/bond';

export interface UserRow {
  id: string; email: string | null; lineSub: string | null; nickname: string;
  via: 'line' | 'email'; lang: Lang; ageConfirmedAt: string; createdAt: string;
  points: number; freePulls: number; role: 'user' | 'admin' | 'moderator';
  banned: boolean;
  /** Monthly pass expiry (ISO), null when never bought. */
  passUntil: string | null;
  /** Daily chat allowance: the JST day it counts for and how many messages were used that day. */
  chatDay: string; chatUsedToday: number;
  /** JST day the pass daily points were last granted. */
  bonusDay: string | null;
  /** Pulls since the last SSR or better (hard pity at RULES.pityPulls) and exchange shards. */
  pity: number; shards: number;
  /** Daily login and monthly check-in (JST): last login day, the month counted, login days in it, reward days paid. */
  loginDay: string | null; checkMonth: string | null; checkDays: number; checkClaimed: number[];
  /** Self-declared date of birth (YYYY-MM-DD), confirmed 18+ at sign-up. */
  birthday: string | null;
  /** IANA time zone the user's browser reported when turning on notifications; null = JST (the business calendar). */
  tz: string | null;
}
/** A printed lucky-card code. `id` is the printer's serial ("2026A-00001"), used for reconciliation; the code itself is never stored. */
export interface SerialRow {
  id: string; codeHash: string; batchId: string;
  /** From the batch: pass days and number of draws the code is worth. */
  trialDays: number; draws: number;
  /** Set once redeemed: by an account, or by a visitor's device (then the account that claims it). */
  redeemedByUserId: string | null; redeemedByDevice: string | null; redeemedAt: string | null;
}
/** `redeemedByDevice` of a code an admin voided: marked used, by nobody. */
export const VOID = 'void';
/** Wrong codes allowed per issued sign-in code; the next attempt spends it (a fresh code must be sent). */
export const OTP_MAX_ATTEMPTS = 5;
export interface BatchRow { id: string; label: string; quantity: number; trialDays: number; draws: number; createdAt: string }
export interface OwnedRow { userId: string; cardId: string; copies: number; firstOwnedAt: string; viaSerial: boolean }
/** A variant card first owned tonight and not yet invited (owned.uninvited, #76), with its owner's language. */
export type UninvitedRow = OwnedRow & { lang: Lang };
/**
 * A variant card's own affinity (#75). `level` is the highest level reached (1–10), kept when a threshold is raised.
 * `homePinned`: her home keeps this look (#76), set by him from VARIANT_RULES.homePinLevel.
 */
export interface CardAffectionRow { userId: string; cardId: string; xp: number; level: number; kokoro: number; homePinned: boolean; updatedAt: string }
/**
 * A card handed out by a draw, a code or an exchange. `variant`: what a duplicate of a variant card adds (心意 as
 * variant XP, and its share of main XP) — applied only when this copy turns out not to be the first, in the same step.
 */
export interface PlannedCard {
  cardId: string;
  star: StarId;
  /** Added to the wallet only when this copy is a duplicate. */
  duplicateShards?: number;
  variant?: VariantGain;
}
/**
 * A memory card. `kind` (#51): where it came from, `chat` when not given; `sceneId`: the scene it was made in; `still`:
 * the memory-store key of that scene's still, once stills exist (#64/#80). Reads always fill all three.
 */
export interface MemoryRow { id: string; userId: string; star: StarId; title: string; createdAt: string; kind?: MemoryKind; sceneId?: string | null; still?: string | null }
/** `ownerId` is a user id, or `device:<id>` for visitor trial messages that move to the account on sign-up. */
export interface MessageRow { id: string; ownerId: string; star: StarId; role: 'user' | 'assistant'; text: string; createdAt: string }
/** Every draw is kept with its seed so a disputed result can be replayed. `ownerId` is a user id or `device:<id>`. */
export interface DrawRow {
  id: string; ownerId: string; poolId: string; cardIds: string[];
  /** Lucky-code draws only: the code's serial and the print tier behind each card. */
  serialId: string | null; tiers: string[] | null;
  cost: number; seed: string; createdAt: string;
}
export interface AuditRow { id: string; actorId: string; action: string; target: string; meta: Record<string, unknown>; createdAt: string }
/** Long-term chat memory per (user, talent), maintained by the persona service; plus the day's cached greeting. */
export interface ChatMemoryRow {
  ownerId: string; star: StarId;
  facts: Record<string, string>; summary: string | null; updatedAt: string;
  greeting: { day: string; lang: string; text: string } | null;
  /** Turns the persona service has not taken into memory yet, oldest first (migration 0028); `pendingAt`: the latest added. */
  pending: PendingTurn[]; pendingAt: string | null;
}
/** One side of a chat turn waiting to go into memory; `id` is his message's id, the same for both sides of a turn. */
export interface PendingTurn { id: string; role: 'user' | 'assistant'; text: string }
/** A product event (#52). `userId` is null once the account is deleted; `day` is the JST day it happened. */
export interface EventRow { userId: string | null; name: EventName; props: Record<string, unknown>; day: string; createdAt: string }
/** `day` and `week` group by JST day / by week starting Monday; `all` is the whole range as one period. */
export type MetricsGrouping = 'day' | 'week' | 'all';
export type MetricsPeriodRow = MetricsCountsT & { period: string };
export const zeroCounts = (): MetricsCountsT => ({
  newUsers: 0, confessed: 0, activeUsers: 0, alarmSet: 0, promisesDue: 0, promisesKept: 0, roomEntries: 0, sceneTriggers: 0,
  triggerSources: { request: 0, proposed: 0, time: 0 }, variantPrompted: 0, variantDrawn: 0, variantSceneOpened: 0,
  sceneUsers: 0, sceneRetained: 0, chatOnlyUsers: 0, chatOnlyRetained: 0
});

/** One browser that allowed notifications (Web Push). `endpoint` identifies it; `keys` encrypt what is sent to it. */
export interface PushSubscriptionRow {
  endpoint: string; userId: string; keys: { p256dh: string; auth: string };
  tz: string | null; createdAt: string; failedAt: string | null;
}
export interface PoolRow { id: string; label: string; cardIds: string[]; rates: { SSR: number; SR: number; R: number }; startsAt: string; endsAt: string }
/**
 * A Pickup (#78): her pool with her variant boosted for an announced window. The odds (`share`, `rates`) are copied in
 * when it is created and never change, so every draw made in it replays from its seed. Kept for good, like the draws
 * that name it. Stored as JSON in the `pools` table (id `pickup:…`), so no migration.
 */
export interface PickupRow extends PickupDef { createdAt: string; createdBy: string }
/** A code a visitor redeemed: its cards and pass days wait on the device until an account claims them. */
export interface DeviceRedemption { serialId: string; cardIds: string[]; trialDays: number }
export interface DeviceRow { id: string; trialUsed: number; redemptions: DeviceRedemption[] }

/**
 * Everything one code redemption writes, applied all-or-nothing: the code is marked used only together with
 * the cards, the pass days and the draw log, so a failure half-way can never burn a code for nothing.
 */
export interface RedeemPlan {
  serialId: string;
  owner: { userId: string } | { device: string };
  cards: PlannedCard[];
  /** Accounts: the new pass expiry. Visitors: null, the days wait on the device (`trialDays`). */
  passUntil: string | null;
  trialDays: number;
  /** Bond XP a duplicate card adds to its talent. */
  bondXp: number;
  draw: DrawRow;
  at: string;
}
/** A paid pull (or an exchange), applied all-or-nothing like a code redemption. */
export interface GachaPlan {
  userId: string;
  /** Points and free pulls spent. */
  cost: { points: number; freePulls: number };
  /** The pity counter the plan was computed from; a parallel draw that moved it makes this one fail. */
  expectPity: number;
  newPity: number;
  shardsDelta: number;
  cards: PlannedCard[];
  draw: DrawRow;
  at: string;
}
export type GachaOutcome = { ok: true; user: UserRow; isNew: boolean[] } | { ok: false; reason: 'insufficient' | 'conflict' };

/** `isNew` per planned card, for accounts; visitors get it from the module. */
export type RedeemOutcome = { ok: true; isNew: boolean[] } | { ok: false };

export interface ClaimOutcome { cardIds: string[]; trialDays: number; serials: string[] }

export type WalletDelta = { points?: number; freePulls?: number };

/**
 * Something she sends on her own (#49): written ahead with `dueAt`, shown once the tick has delivered it.
 * Times are `toISOString()` (UTC): delivery compares them as text.
 */
export interface InboxRow {
  id: string; userId: string; star: StarId; kind: InboxKind;
  payload: Record<string, unknown>;
  dueAt: string; deliveredAt: string | null; readAt: string | null; createdAt: string;
}
/** The last run of one tick job (src/lib/tick.ts). `finishedAt` is null while it runs. */
export interface JobRunRow {
  job: string; startedAt: string; finishedAt: string | null; ok: boolean | null; error: string | null;
  result: Record<string, unknown> | null; lastOkAt: string | null; runs: number;
}
/** One play of a scene (#64). `state` is the engine's RunState; `seq` counts accepted answers and changes. */
export interface SceneRunRow {
  id: string; userId: string; star: StarId; sceneId: string;
  step: string; seq: number; state: RunState; rewarded: boolean;
  startedAt: string; updatedAt: string; endedAt: string | null; outcome: string | null;
}
/**
 * His relationship with one talent (#54): the shared RelationshipState plus `rev`, the id of the last stage change,
 * which every change is conditional on (and which guards the free pull written with it).
 */
export interface RelationshipRow extends RelationshipState { userId: string; star: StarId; rev: string | null }
/**
 * What a scene change grants, stored together with the run so it is paid exactly once. `variant`: XP for the variant card the scene belongs to (#75).
 * `promises` (#59): written only while no promise with her is open (one at a time), so a second one is simply not made.
 */
export interface SceneGrant { affinity: number; memories: MemoryRow[]; variant?: { cardId: string; gain: VariantGain }; promises?: PromiseRow[] }

/**
 * A promise (#59, docs/requirements.md §11.4). Times are `toISOString()` (UTC) and compared as text. `notifiedAt`: the
 * tick turned it into her `promise_due` inbox line (or he kept it before the tick came); `mentionedAt`: a missed
 * promise she has brought up once.
 */
export interface PromiseRow {
  id: string; userId: string; star: StarId; text: string; dueAt: string;
  kind: PromiseKind; status: PromiseStatus; source: PromiseSource;
  madeAt: string; keptAt: string | null; sourceMsgId: string | null; sceneId: string | null; lang: Lang;
  notifiedAt: string | null; missedAt: string | null; mentionedAt: string | null;
}
/** The inbox row a promise falling due becomes: one per promise, so writing it twice is impossible. */
export const promiseInboxId = (promiseId: string) => `inb_${promiseId}`;
/**
 * A scene offered to him (#65): she proposed it, or the moment did. `open` until he accepts it (a start that names
 * it) or declines it; an unanswered offer simply lapses at `expiresAt`.
 */
export interface SceneOfferRow {
  id: string; userId: string; star: StarId; sceneId: string; source: 'proposed' | 'time';
  status: 'open' | 'accepted' | 'declined'; createdAt: string; expiresAt: string; answeredAt: string | null;
}
/** Her confession with him (#55): the shared ConfessionState per (user, talent). */
export interface ConfessionRow extends ConfessionState { userId: string; star: StarId }
/**
 * A relationship at `confession_ready` whose round has no inbox message yet, with what the invitation needs: his
 * language and where the round stands (the tick decides whether she is due, packages/shared/src/confession.ts).
 */
export interface ConfessionCandidate { userId: string; star: StarId; lang: Lang; daysTogether: number; confession: ConfessionState }
/**
 * The memory his yes became (docs/compliance-jp.md §7.3): his words and, only with his consent, the recording (base64
 * until #51 moves files to R2). `audio` is omitted from lists; it is read one memory at a time.
 */
export interface ConfessionVoiceRow {
  memoryId: string; userId: string; star: StarId; transcript: string;
  audioType: string | null; consentedAt: string | null; createdAt: string;
  /** #51: the recording's key in the memory store; null with `audioType` set = still base64 in the row. Reads always fill it. */
  audioKey?: string | null;
}

/** What a scene change grants, stored together with the run so it is paid exactly once. `variant`: XP for the variant card the scene belongs to (#75). */
export interface SceneGrant { affinity: number; memories: MemoryRow[]; variant?: { cardId: string; gain: VariantGain } }

/** A gift he gave her (#77): what it cost, the XP it added and how it landed. `day` is the JST day, for the daily cap. */
export interface GiftRow {
  id: string; userId: string; star: StarId; giftId: GiftId; cardId: string | null;
  price: number; xp: number; taste: GiftTaste; day: string; createdAt: string;
}
/**
 * Everything one gift writes, all or nothing: the row (only while today's gifts are under `perDay` and he has the
 * points), the points, her affinity XP, and — while she wears a variant card — that card's XP (#75).
 */
export interface GiftPlan { row: GiftRow; perDay: number; variant?: { cardId: string; gain: VariantGain } }
export type GiftOutcome = { ok: true; user: UserRow; affinityXp: number; sentToday: number } | { ok: false; reason: 'insufficient' | 'limit' };

/**
 * One charge against his voice time (#74, migrations/0026_voice.sql): seconds of her runtime voice (`tts`, #73), of his
 * voice input in a scene (`input`, #72), or an extension he bought (`extend`: `seconds` added, `points` spent).
 * Unique per (userId, requestId), so a retried request is charged once.
 */
export type VoiceKind = 'tts' | 'input' | 'extend';
export interface VoiceLedgerRow {
  userId: string; requestId: string; day: string; kind: VoiceKind; seconds: number; points: number; nonce: string; createdAt: string;
}
/** A JST day of his voice time: seconds used (tts + input) and extensions bought. */
export interface VoiceDayRow { day: string; usedSeconds: number; extensions: number }
/**
 * An extension, all or nothing (#74): the row goes in only while today's extensions are under `perDay`, he has the
 * points and the request id is new; the points are taken in the same step. A request id already used for an extension
 * is a replay: nothing is written, `replayed: true`. One used for something else is a `conflict`.
 */
export type VoiceExtendOutcome =
  | { ok: true; replayed: boolean; user: UserRow; day: VoiceDayRow }
  | { ok: false; reason: 'insufficient' | 'limit' | 'conflict' };
/**
 * An extension bought with a scene step (アリス's 「30分延長する」, #69, #74): the ledger row goes in on the same terms as
 * voice.extend, and only while the run is still at the step being answered; the run moves only with it.
 */
export interface SceneExtension { row: VoiceLedgerRow & { kind: 'extend' }; perDay: number }

/** One weather point (#62): her city ('nagano') or a user city's 0.1° square ('ll:25.1,121.5'). */
export interface WeatherRow {
  cityKey: string; lat: number; lon: number;
  /** Last successful fetch; null until the first. */
  fetchedAt: string | null;
  triedAt: string;
  /** Why the last attempt failed; null after a success. */
  error: string | null;
  data: WeatherData | null;
}
export interface FirstSnowRow { cityKey: string; winter: number; day: string }
/** His own city (#62), city level: a place name and a position rounded to 0.1°. */
export interface UserCityRow { userId: string; name: string; lat: number; lon: number; updatedAt: string }

/**
 * His wake-up alarm (#57). `time` is 'HH:MM' in his clock; `days` the weekdays it rings (0 = Sunday). `lastDay` is
 * the local day it last rang (the per-morning claim) and `snoozes` the 「あと5分」 used that morning.
 */
export interface AlarmRow {
  userId: string; star: StarId; time: string; days: number[]; enabled: boolean; tz: string;
  lastDay: string | null; snoozes: number; createdAt: string; updatedAt: string;
}
/** An enabled alarm as the ring job needs it: with his clock (`users.tz`, null = never reported) and language. */
export type RingCandidate = AlarmRow & { userTz: string | null; lang: Lang };
/**
 * One message she will write to him on her own (#58, docs/requirements.md §11.3), keyed by (user, his local day, kind).
 * planned → writing (the send job took it; `triedAt`) → sent (with her inbox line) or skipped (`reason`).
 */
export interface HerMessageRow {
  userId: string; day: string; kind: HerMessageKind; star: StarId; inboxId: string; dueAt: string;
  status: 'planned' | 'writing' | 'sent' | 'skipped'; triedAt: string | null; sentAt: string | null;
  source: 'model' | 'fallback' | null; reason: string | null; createdAt: string;
}
export type HerMessageKey = Pick<HerMessageRow, 'userId' | 'day' | 'kind'>;
/** A user to plan his day for: his zone, his setting, and each talent he has been with and when last. */
export interface HerPlanCandidate {
  userId: string; tz: string | null; mode: Exclude<HerMessageMode, 'off'>;
  stars: { star: StarId; lastDay: string; daysTogether: number }[];
}
/** A message due to be written, with what the send job needs to know about him now. */
export interface HerMessageDue extends HerMessageRow {
  user: { lang: Lang; nickname: string; tz: string | null; passUntil: string | null; active: boolean; mode: HerMessageMode };
}

/**
 * A user her day's messages may go to (#61): his clock, language, birthday (the calendar reads only its month and day)
 * and her-messages setting, and each talent he spent a day with recently, with where they stand.
 */
export interface CalendarCandidate {
  userId: string; lang: Lang; tz: string | null; birthday: string | null; mode: Exclude<HerMessageMode, 'off'>;
  stars: { star: StarId; lastDay: string; stage: RelationshipState['stage']; anniversary: string | null }[];
}

/** Everything the API needs from storage. The in-memory implementation backs `npm run dev` and fast tests;
 *  the SQL implementation (sql.ts, schema in migrations/) backs production on Cloudflare D1 and runs the same tests on SQLite.
 *  Methods that move money or allowances are conditional single operations — never read-then-write in a handler. */
export type OtpTake = 'ok' | 'invalid' | 'expired' | 'attempts';

export interface Repos {
  users: {
    byId(id: string): Promise<UserRow | null>;
    byEmail(email: string): Promise<UserRow | null>;
    create(u: Omit<UserRow, 'createdAt'>): Promise<UserRow>;
    update(id: string, patch: Partial<Pick<UserRow, 'nickname' | 'lang' | 'banned' | 'role' | 'passUntil' | 'bonusDay'>>): Promise<UserRow>;
    /** Adds (or, with negative numbers, removes) points/free pulls only if no balance goes below zero. Null = insufficient. */
    adjustWallet(id: string, delta: WalletDelta): Promise<UserRow | null>;
    /** Reserves one chat message against `limit` for `day`; resets the counter on a new day. Null = limit reached. */
    reserveChat(id: string, day: string, limit: number): Promise<UserRow | null>;
    /** Gives a reserved message back (the agent failed or the message was hard-blocked). */
    releaseChat(id: string, day: string): Promise<void>;
    /** First visit of a JST day: login points and a check-in day. Null when today was already counted. */
    dailyLogin(id: string, day: string, month: string, points: number): Promise<UserRow | null>;
    /** Pays check-in rewards once: succeeds only if `claimed` is still what the caller read. */
    claimCheckIn(id: string, expected: number[], next: number[], reward: WalletDelta): Promise<UserRow | null>;
    setBirthday(id: string, birthday: string): Promise<UserRow>;
    /** Account deletion: personal data removed (chats, memories, inbox, promises, variant affinity, gifts…), the row kept anonymised so codes and draws stay auditable; the user's events lose their user id. His memory-store files are queued for erasure in the same step (memoryAssets.purgesPending, #51). */
    anonymise(id: string, at: string): Promise<void>;
  };
  devices: {
    get(id: string): Promise<DeviceRow>;
    /** Reserves one trial message; null when the allowance is used up. */
    reserveTrial(id: string, limit: number): Promise<number | null>;
    releaseTrial(id: string): Promise<void>;
  };
  /**
   * One-time sign-in codes. `take` spends an attempt and says why a code was refused (M1): `expired` once its time is up
   * or no code is pending (used, replaced, never sent), `attempts` from the attempt after the limit: the code is spent, and
   * every later try says `attempts` too (B-N6) until a new code is put.
   */
  otp: { put(email: string, code: string, expiresAt: number): Promise<void>; take(email: string, code: string): Promise<OtpTake> };
  /**
   * Under-18 closures (M7): a keyed hash of the address (never the address) and until when it may not sign up again.
   * `put` keeps the later of two dates; `until` answers the date while it is still in the future, else null.
   */
  signupBlocks: { put(hash: string, until: string): Promise<void>; until(hash: string, now: string): Promise<string | null> };
  serials: {
    byHash(hash: string): Promise<SerialRow | null>;
    /** Idempotent: rows whose id or hash already exists are skipped. Returns how many were added. */
    createBatch(batch: BatchRow, rows: { id: string; codeHash: string }[]): Promise<number>;
    countByUser(userId: string): Promise<number>;
    byId(id: string): Promise<SerialRow | null>;
    /** Marks an unredeemed code as used by nobody ('void'), so it can never be redeemed. False when already used. */
    void(id: string, at: string): Promise<boolean>;
  };
  gacha: {
    draw(plan: GachaPlan): Promise<GachaOutcome>;
  };
  lucky: {
    /** Single use is decided here: exactly one caller gets `ok`, and only then is anything written. */
    redeem(plan: RedeemPlan): Promise<RedeemOutcome>;
    /**
     * Sign-up claim: moves the device's redeemed codes into the account (cards, bond XP for duplicates, pass
     * days, the codes and their draw logs) in one step. Null when the device had nothing to claim.
     */
    claim(user: UserRow, device: string, bondXp: number, passUntil: (days: number) => string | null, variantDup?: (cardId: string) => VariantGain | null): Promise<ClaimOutcome | null>;
  };
  cards: { all(): Promise<CardDef[]>; upsert(c: CardDef): Promise<void> };
  pools: { byId(id: string): Promise<PoolRow | null>; upsert(p: PoolRow): Promise<void>; all(): Promise<PoolRow[]> };
  /** Pickups (#78), oldest start first. Never deleted: a draw log names its Pickup, and a replay needs its odds. */
  pickups: { all(): Promise<PickupRow[]>; byId(id: string): Promise<PickupRow | null>; upsert(p: PickupRow): Promise<void> };
  owned: {
    forUser(userId: string): Promise<OwnedRow[]>;
    grant(userId: string, cardId: string, viaSerial: boolean): Promise<boolean>;
    /**
     * The draw-night invite's candidates (#76): rows of these cards first owned at or after `since` whose owner is in
     * good standing (not banned, not deleted) and has no inbox row with `invitePrefix` for that card yet
     * (`payload.cardId`), oldest first, at most `limit`, each with the owner's language. Invited rows drop out of
     * the next call, so a night with more new owners than `limit` is worked through tick by tick.
     */
    uninvited(cardIds: readonly string[], since: string, invitePrefix: string, limit: number): Promise<UninvitedRow[]>;
  };
  /**
   * Variant affinity (#75). Draws, codes, exchanges and scenes write it inside their own all-or-nothing step (see
   * PlannedCard and SceneGrant); `add` is for gains outside those (chat while she wears it, gifts). Rows of a deleted
   * account go with it (users.anonymise).
   */
  cardAffection: {
    get(userId: string, cardId: string): Promise<CardAffectionRow | null>;
    forUser(userId: string): Promise<CardAffectionRow[]>;
    /** Adds the gain to the card (its level follows VARIANT_RULES.levelXp, never going down) and its main share to her affinity. */
    add(userId: string, cardId: string, star: StarId, gain: VariantGain): Promise<CardAffectionRow>;
    /** Pins her variant look to her home, or unpins it (#76); writes the row if he had none yet. The caller checks the level. */
    setPinned(userId: string, cardId: string, pinned: boolean): Promise<CardAffectionRow>;
  };
  memories: { forUser(userId: string): Promise<MemoryRow[]>; add(m: MemoryRow): Promise<void> };
  messages: {
    recent(ownerId: string, star: StarId, limit: number): Promise<MessageRow[]>;
    add(m: MessageRow): Promise<void>;
    countUser(ownerId: string, star: StarId): Promise<number>;
    /** Moves a visitor's trial messages to the account created from that device. */
    reassign(fromOwner: string, toOwner: string): Promise<void>;
  };
  affinity: { get(userId: string, star: StarId): Promise<number>; all(userId: string): Promise<Partial<Record<StarId, number>>>; add(userId: string, star: StarId, xp: number): Promise<number> };
  draws: { add(d: DrawRow): Promise<void>; forOwner(ownerId: string, limit: number): Promise<DrawRow[]>; codesForOwner(ownerId: string): Promise<DrawRow[]> };
  audit: { add(a: AuditRow): Promise<void>; recent(limit: number): Promise<AuditRow[]>; byAction(action: string, limit: number): Promise<AuditRow[]> };
  /** Product events for the admin metrics (#52). Written through lib/events.ts, which validates props. */
  events: {
    add(e: EventRow): Promise<void>;
    /** Retention: deletes the oldest day's events if that day is before `cutoff`. Returns the rows deleted (0 = nothing left to delete). */
    purgeOldestDay(cutoff: string): Promise<number>;
    /**
     * Counts behind the metrics (definitions: MetricsCounts in packages/shared/src/contracts.ts) for the JST days
     * `from`–`to`, one row per period that has data, oldest first. `period` is the period's first day ('all' → `from`).
     */
    metrics(from: string, to: string, grouping: MetricsGrouping): Promise<MetricsPeriodRow[]>;
    /**
     * Who opened whose room (`room.entered`) on JST day `sinceDay` or later: one row per (user, talent) with the
     * last such day. Deleted accounts are not in it. The weather events' "recently active" (#63).
     */
    activeRooms(sinceDay: string): Promise<{ userId: string; star: StarId; lastDay: string }[]>;
    /** One user's events of one name on JST day `sinceDay` or later, oldest first: limits such as how often she brings up a Pickup (#78). */
    ofUser(userId: string, name: string, sinceDay: string): Promise<{ createdAt: string; props: Record<string, unknown> }[]>;
  };
  /** AI chat: long-term memory the persona service reads and updates every turn, and the companion-home greeting. */
  chatMemory: {
    get(ownerId: string, star: StarId): Promise<ChatMemoryRow | null>;
    /** Replaces facts and summary (upsert); the cached greeting is kept. */
    save(ownerId: string, star: StarId, facts: Record<string, string>, summary: string | null): Promise<void>;
    /** Caches the greeting for one JST day and language (upsert); memory is kept. */
    setGreeting(ownerId: string, star: StarId, greeting: { day: string; lang: string; text: string }): Promise<void>;
    /**
     * Appends turns memory has not taken in yet (upsert), keeping the newest `max`; `pendingAt` becomes `at`. One
     * statement, so a turn and a flush racing each other never lose a turn.
     */
    addPending(ownerId: string, star: StarId, turns: PendingTurn[], at: string, max: number): Promise<void>;
    /** Drops the pending turns of these ids — the ones an update just took in; turns added since stay. Idempotent. */
    dropPending(ownerId: string, star: StarId, ids: string[]): Promise<void>;
    /** Up to `limit` rows with pending turns whose latest turn is older than `before`, oldest first. */
    quiet(before: string, limit: number): Promise<{ ownerId: string; star: StarId }[]>;
  };
  /** Her inbox (#49). Rows of a deleted account go with it (users.anonymise). */
  inbox: {
    add(row: InboxRow): Promise<void>;
    /**
     * Marks up to `limit` rows whose `dueAt` has passed as delivered at `at`, oldest due first, and returns them.
     * One conditional statement: a row is delivered exactly once, however many ticks overlap.
     */
    deliverDue(at: string, limit: number): Promise<InboxRow[]>;
    /** Delivered rows only: unread first, then newest delivered first. */
    forUser(userId: string, limit: number): Promise<InboxRow[]>;
    /** One of his delivered rows by id (N-37: however many are newer); null when it is not his or not delivered. */
    mine(userId: string, id: string): Promise<InboxRow | null>;
    /** His rows with her whose id starts with `prefix`, delivered at or after `since` (N-56: not only the newest 50). */
    deliveredSince(userId: string, star: StarId, prefix: string, since: string): Promise<InboxRow[]>;
    unread(userId: string): Promise<number>;
    /**
     * F-04: one of his rows not delivered yet, due by `dueBy`, delivered now at `at` (an open room rang it): the tick
     * never delivers or pushes it again. Null when it is not his, already delivered, or not due by then.
     */
    deliverMine(userId: string, id: string, at: string, dueBy: string): Promise<InboxRow | null>;
    /** Sets `readAt` once (the first read time is kept). Null when the row is not this user's or not delivered yet. */
    markRead(userId: string, id: string, at: string): Promise<InboxRow | null>;
    /**
     * Inserts a row whose id is derived from what it is about (the weather events, #63); false when that id is
     * already there, so a message meant once is written once however many ticks overlap.
     */
    addOnce(row: InboxRow): Promise<boolean>;
    /** Rows (delivered or not) whose id starts with `prefix`, created at or after `since`. */
    withPrefix(prefix: string, since: string): Promise<InboxRow[]>;
    /**
     * U-29 / #8: her delivered, unread items with her that name `sceneId` (`payload.scene` or `payload.sceneId`) are
     * read at `at` — the scene they invite to has been played to its end. Returns how many.
     */
    readNaming(userId: string, star: StarId, sceneId: string, at: string): Promise<number>;
    /**
     * M18: her line in more languages, kept on his row (`payload.texts`, merged with what is there): her words the model
     * wrote in one language, re-rendered into his when he reads them. Nothing for a row that is not his.
     */
    addTexts(userId: string, id: string, texts: Partial<Record<Lang, string>>): Promise<void>;
  };
  /**
   * Promises (#59). One open promise per (user, talent): `create` and a scene's grant both refuse a second. Every
   * change of status is one conditional statement, so the tick and his visit can race without keeping or missing
   * a promise twice. Rows of a deleted account go with it (users.anonymise).
   */
  promises: {
    /** False when a promise with her is already open (nothing is written). */
    create(row: PromiseRow): Promise<boolean>;
    byId(id: string): Promise<PromiseRow | null>;
    /** His open promises, with one talent or all of them, soonest first. */
    open(userId: string, star?: StarId): Promise<PromiseRow[]>;
    /** His newest promise with her, whatever its status: the persona service's view of it (#59 "written to memory"). */
    latest(userId: string, star: StarId): Promise<PromiseRow | null>;
    /** All his promises, every status, oldest first: his export (#51). */
    forUser(userId: string): Promise<PromiseRow[]>;
    /** Open promises due by `at` that have no inbox line yet, soonest first. */
    dueUnnotified(at: string, limit: number): Promise<PromiseRow[]>;
    /**
     * Marks an open, not yet notified promise as notified at `at` and writes `inbox` (her line) with it, all or
     * nothing. False when it was already notified or is no longer open: the line is written exactly once.
     */
    notify(id: string, at: string, inbox: InboxRow | null): Promise<boolean>;
    /**
     * Keeps an open promise at `at` if its time lies within [`dueFrom`, `dueTo`] (the window around `at`): status
     * kept, its inbox line read, and `memory` (a memory card of it) added, together. Null when it was not open or
     * not in the window.
     */
    keep(id: string, at: string, dueFrom: string, dueTo: string, memory: MemoryRow | null): Promise<PromiseRow | null>;
    /** Marks up to `limit` open promises due before `dueBefore` as missed at `at` (their unread inbox line is read), and returns them. */
    expire(dueBefore: string, at: string, limit: number): Promise<PromiseRow[]>;
    /** His newest missed promise with her that she has not brought up yet. */
    toMention(userId: string, star: StarId): Promise<PromiseRow | null>;
    /** Records that she brought a missed promise up; false when she already had (it is said once). */
    mention(id: string, at: string): Promise<boolean>;
  };
  /** Bookkeeping of the scheduled tick's jobs (src/lib/tick.ts). */
  jobs: {
    /**
     * Starts `job` at `at` if it may run: its last run finished and started no later than `dueBefore`, or it
     * started no later than `staleBefore` and never finished (a crash). False = not due or still running.
     */
    claim(job: string, at: string, dueBefore: string, staleBefore: string): Promise<boolean>;
    finish(job: string, at: string, outcome: { ok: boolean; error: string | null; result: Record<string, unknown> | null }): Promise<void>;
    get(job: string): Promise<JobRunRow | null>;
  };
  /** Web Push subscriptions (#50). */
  push: {
    /** Upsert by endpoint: a browser re-subscribing, or one now signed in to another account, keeps a single row. Sets the user's tz when given. */
    subscribe(row: Omit<PushSubscriptionRow, 'failedAt'>): Promise<void>;
    /** One endpoint of this user's, or all of them when `endpoint` is omitted. Returns how many were removed. */
    unsubscribe(userId: string, endpoint?: string): Promise<number>;
    forUser(userId: string): Promise<PushSubscriptionRow[]>;
    /** The push service said the subscription is gone (404/410): forget it, whoever it belongs to. */
    remove(endpoint: string): Promise<void>;
    /** Records a failed delivery (at) or clears the mark after a successful one (null). */
    setFailed(endpoint: string, at: string | null): Promise<void>;
  };
  /** Relationship stages (#54): one row per (user, talent), created by his first message or scene with her. */
  relationship: {
    get(userId: string, star: StarId): Promise<RelationshipRow | null>;
    forUser(userId: string): Promise<RelationshipRow[]>;
    /**
     * A message or scene with her on JST `day`: creates the row at `new` if there is none, and counts the day as a
     * day together once (a later call the same day changes nothing). One conditional statement.
     */
    touch(userId: string, star: StarId, day: string, at: string): Promise<RelationshipRow>;
    /**
     * Moves the row to `next` (stage fields, reward rank and a fresh `rev`; the day count is `touch`'s) only if its
     * `rev` is still `expect.rev`, and adds `pulls` free pulls with it, all or nothing. Null when another change got
     * there first — so a stage's free pull is paid exactly once however many requests race.
     */
    change(expect: RelationshipRow, next: RelationshipRow, pulls: number): Promise<RelationshipRow | null>;
  };
  /** Scene runs (#64). Every change is conditional on `seq`, and a run's grant is written with it or not at all. */
  sceneRuns: {
    /** Inserts a new run with what its opening grants; false when he already has an active run (one at a time). */
    start(row: SceneRunRow, grant: SceneGrant): Promise<boolean>;
    byId(id: string): Promise<SceneRunRow | null>;
    active(userId: string): Promise<SceneRunRow | null>;
    /**
     * Replaces a run that is still active at `expectSeq` (row.seq must be higher) and applies the grant, all or
     * nothing; false when another change got there first. With `extension`, the extension is bought in the same step:
     * the run moves only if the extension goes in (and its points are taken), and nothing is paid if the run does not
     * move — also false, with the run still at `expectSeq`, when the extension itself was refused. With `gift` (#68: a gift
     * given inside the scene), the same: the gift is bought (points, her XP, exactly as `gifts.send`) only with the move.
     */
    advance(row: SceneRunRow, expectSeq: number, grant: SceneGrant, extension?: SceneExtension, gift?: GiftPlan): Promise<boolean>;
    /** Rewarded runs of a scene started since `since` (ISO): rewards are paid once per scene per JST day. */
    rewardedSince(userId: string, sceneId: string, since: string): Promise<number>;
    /** His runs started at or after `since` (ISO) that have ended, newest end first: the pause after a scene (M2). */
    endedSince(userId: string, since: string): Promise<{ sceneId: string; endedAt: string; outcome: string | null }[]>;
  };
  /** Scene offers (#65). Rows of a deleted account go with it (users.anonymise). */
  sceneOffers: {
    add(row: SceneOfferRow): Promise<void>;
    /** His offers created at or after `since` (ISO), oldest first: the proposal limits read these. */
    since(userId: string, since: string): Promise<SceneOfferRow[]>;
    /**
     * Answers his open offer (of that scene, unless `sceneId` is null) in one conditional write. Accepting needs it
     * unexpired; "not now" is kept even after it lapsed. Null when there is none to answer.
     */
    answer(id: string, userId: string, sceneId: string | null, status: 'accepted' | 'declined', at: string): Promise<SceneOfferRow | null>;
  };
  /** Gifts (#77). Rows of a deleted account go with it (users.anonymise). */
  gifts: {
    /** The daily cap and the points are checked in the same step that spends them; nothing is written on a refusal. */
    send(plan: GiftPlan): Promise<GiftOutcome>;
    /** Gifts he gave on a JST day, all talents together. */
    countOn(userId: string, day: string): Promise<number>;
  };
  /** His voice time (#74). Rows of a deleted account go with it (users.anonymise). */
  voice: {
    /** His voice time on a JST day. */
    day(userId: string, day: string): Promise<VoiceDayRow>;
    /** Charges seconds used (tts / input), once per request id. `recorded`: false for a repeat. */
    use(row: Omit<VoiceLedgerRow, 'points'> & { kind: 'tts' | 'input' }): Promise<{ recorded: boolean; day: VoiceDayRow }>;
    /**
     * Settles a row `use` wrote as a claim (her runtime voice, #73: claimed before the vendor is asked, so a request id
     * is synthesized once): its seconds, or null to take the claim back when nothing was synthesized. Only the row with
     * this `nonce` is touched.
     */
    settle(userId: string, requestId: string, nonce: string, day: string, seconds: number | null): Promise<VoiceDayRow>;
    /** Buys an extension (VoiceExtendOutcome); `row.points` is the price. */
    extend(row: VoiceLedgerRow & { kind: 'extend' }, perDay: number): Promise<VoiceExtendOutcome>;
  };
  /** Weather points (#62), written by the tick's weather job. */
  weather: {
    all(): Promise<WeatherRow[]>;
    get(cityKeys: string[]): Promise<WeatherRow[]>;
    /** A successful fetch: replaces the data and clears the error. */
    saved(cityKey: string, lat: number, lon: number, at: string, data: WeatherData): Promise<void>;
    /** A failed fetch: records the error and keeps the last good data and its time. */
    failed(cityKey: string, lat: number, lon: number, at: string, error: string): Promise<void>;
    /**
     * Deletes points nobody needs: her-city rows not in `herKeys`, and user squares no user_cities row is in.
     * Returns how many were deleted.
     */
    prune(herKeys: string[]): Promise<number>;
    /** Records the season's first snow at a point; true only for the first call per (point, winter). */
    markFirstSnow(cityKey: string, winter: number, day: string): Promise<boolean>;
    firstSnow(cityKeys: string[]): Promise<FirstSnowRow[]>;
    /** Test site only (`PUT /v1/world/demo`): forgets a season's first snow so it can be shown again. */
    forgetFirstSnow(cityKey: string, winter: number): Promise<void>;
  };
  /**
   * Her confession (#55). Every change is one conditional statement on the round it expects, so two tabs (or two
   * ticks) never count an answer, send her message or record the moment twice. Deleted with the account.
   */
  confessions: {
    get(userId: string, star: StarId): Promise<ConfessionRow | null>;
    /**
     * Relationships at `confession_ready` whose current round has no inbox message yet and whose wait is over: fewer
     * than `maxAsks` answers that were not yes, none of them on `today`, and `retryDays` days together since the last
     * (at most `limit`, so no one waiting starves the rest).
     */
    uninvited(limit: number, rules: { retryDays: number; maxAsks: number; today: string }): Promise<ConfessionCandidate[]>;
    /** Marks `round` as invited and writes her inbox row with it, only if no earlier call did. True = this call sent it. */
    invite(userId: string, star: StarId, round: number, row: InboxRow): Promise<boolean>;
    /** Marks `round` as reached on JST `day`. True only the first time for that round. */
    reach(userId: string, star: StarId, round: number, day: string): Promise<boolean>;
    /**
     * Stores his answer (tries, last answer, when) if the round is still `expectTries` and he has not said yes: a
     * repeated or parallel answer changes nothing.
     */
    answer(userId: string, star: StarId, expectTries: number, next: ConfessionState): Promise<boolean>;
    /** Demo mode: starts over (the relationship was put back at confession_ready by hand). */
    reset(userId: string, star: StarId): Promise<void>;
    /** The memory of his yes; one per memory card, never replaced. */
    addVoice(row: ConfessionVoiceRow): Promise<void>;
    voices(userId: string): Promise<ConfessionVoiceRow[]>;
    voice(userId: string, memoryId: string): Promise<ConfessionVoiceRow | null>;
    /** Keeps the recording (base64) with the time he consented, only if none is kept yet. False = not his, or already kept. */
    setAudio(userId: string, memoryId: string, audioType: string, audio: string, consentedAt: string): Promise<boolean>;
    audio(userId: string, memoryId: string): Promise<{ audioType: string; audio: string } | null>;
    /**
     * Deletes the recording and keeps his words. False when there was none, or (#51) when `expectKey` is given and the
     * row's store key is no longer that (it moved meanwhile: read it again).
     */
    clearAudio(userId: string, memoryId: string, expectKey?: string | null): Promise<boolean>;
    /**
     * #51: keeps the recording as a file in the memory store (`key`) with the time he consented, only if none is kept
     * yet (neither in the row nor in the store). False = not his, or already kept.
     */
    setAudioKey(userId: string, memoryId: string, audioType: string, key: string, consentedAt: string): Promise<boolean>;
    /** A recording still base64 in the row now lives in the store at `key`: only while the row still holds it. */
    moveAudio(userId: string, memoryId: string, key: string): Promise<boolean>;
    /** Up to `limit` recordings still base64 in their row, oldest first, for the tick to move into the store. */
    legacyAudio(limit: number): Promise<{ userId: string; memoryId: string }[]>;
    /** Up to `limit` recordings he chose to keep before `before`, oldest first: the retention job (MEMORY_RULES.retentionDays). */
    keptBefore(before: string, limit: number): Promise<ConfessionVoiceRow[]>;
  };
  /**
   * His memories as assets (#51, docs/compliance-jp.md §7.6): his exports (one per JST day) and the memory-store files
   * of deleted accounts still to be erased. The files themselves are in the memory store (src/lib/memoryAssets.ts).
   */
  memoryAssets: {
    /** Takes today's export: false when he already had one on JST `day`. */
    claimExport(userId: string, day: string, at: string): Promise<boolean>;
    /** Gives the day back after an export that failed. */
    releaseExport(userId: string, day: string): Promise<void>;
    /** Forgets exports of JST days before `day`; returns how many. */
    pruneExports(day: string): Promise<number>;
    /** Deleted accounts whose files may still be in the store, oldest first (users.anonymise writes them). */
    purgesPending(limit: number): Promise<string[]>;
    /** An attempt that left files behind: the tick tries again. */
    purgeTried(userId: string, at: string): Promise<void>;
    /** Everything under `<userId>/` is gone. */
    purgeDone(userId: string): Promise<void>;
  };
  /** His own city (#62). Deleted with the account (users.anonymise). */
  userCities: {
    get(userId: string): Promise<UserCityRow | null>;
    /** Upsert: one city per user. */
    set(row: UserCityRow): Promise<void>;
    /** False when he had none. */
    clear(userId: string): Promise<boolean>;
    /** The distinct squares users chose, for the weather job. */
    points(): Promise<{ lat: number; lon: number }[]>;
  };
  /** His wake-up alarm (#57), one per user. Deleted with the account (users.anonymise). */
  alarms: {
    get(userId: string): Promise<AlarmRow | null>;
    /**
     * Upsert (settings, `enabled`, `tz`, `lastDay`); `snoozes` is kept. Also makes `row.tz` his clock (`users.tz`),
     * like a push subscription does, when `setUserTz` is true.
     */
    set(row: Omit<AlarmRow, 'snoozes'>, setUserTz: boolean): Promise<AlarmRow>;
    /** Every enabled alarm of an account in good standing, for the ring job. */
    enabled(): Promise<RingCandidate[]>;
    /**
     * Rings `day`: only if the alarm is enabled and has not rung on `day` or later, sets `lastDay`, resets the
     * snoozes and adds `row` (the wake-up) — together, or nothing. False = already rung (another tick got there).
     */
    ring(userId: string, day: string, row: InboxRow): Promise<boolean>;
    /** One 「あと5分」 on `day`: only while `lastDay` is `day` and fewer than `max` were used; adds `row` with it. */
    snooze(userId: string, day: string, max: number, row: InboxRow): Promise<boolean>;
    /**
     * U-41: he is up — `day`'s wake-up is answered. Her call that is still to come that morning (the snooze row, not
     * delivered yet) is dropped, and her wake-ups of `day` already delivered are read, so none of them rings again or
     * turns into one of her messages later. Returns how many were dropped and read.
     */
    answered(userId: string, day: string, at: string): Promise<{ dropped: number; read: number }>;
  };
  /**
   * Her messages (#58). Each (user, his local day, kind) exists once (the key), and every change of status is one
   * conditional statement, so overlapping ticks never write a message twice or ask the model twice. Rows and his
   * setting go with a deleted account (users.anonymise).
   */
  herMessages: {
    /** The distinct `users.tz` values of accounts (null = none reported): the plan job groups users by local day. */
    zones(): Promise<(string | null)[]>;
    /**
     * Up to `limit` users, by id after `after`, to plan local `day` for: tz in `zones` (a null in it = users without
     * one), not banned or deleted, setting not `off`, with her relationship touched on or after JST day `since`, and
     * no row for `day` yet.
     */
    toPlan(zones: (string | null)[], day: string, since: string, after: string, limit: number): Promise<HerPlanCandidate[]>;
    /** The talent he last spent time with (a message of his, or a scene he started) in [from, to); null = none. */
    lastNightWith(userId: string, from: string, to: string): Promise<StarId | null>;
    /** Inserts the rows whose key is new; returns how many were. */
    plan(rows: HerMessageRow[]): Promise<number>;
    /** Up to `limit` rows due by `at`, soonest first: planned ones, and ones left writing since `staleBefore` or earlier (a run that died). */
    due(at: string, staleBefore: string, limit: number): Promise<HerMessageDue[]>;
    /** Takes a due row for writing at `at` (planned, or writing since `staleBefore` or earlier); false when another run has it. */
    take(key: HerMessageKey, at: string, staleBefore: string): Promise<boolean>;
    /** Marks the row taken at `triedAt` sent and writes her inbox line with it, all or nothing; false when it is no longer that run's. */
    send(key: HerMessageKey, triedAt: string, at: string, source: 'model' | 'fallback', line: InboxRow): Promise<boolean>;
    /** Gives a planned or writing row up, with why. */
    skip(key: HerMessageKey, reason: string): Promise<void>;
    /** Messages sent at or after `since`, all users: the global daily cap. */
    sentSince(since: string): Promise<number>;
    /** Messages sent to him for his local `day`. */
    sentOn(userId: string, day: string): Promise<number>;
    /** Deletes up to `limit` rows of local days before `day`; returns how many. */
    purge(day: string, limit: number): Promise<number>;
    mode(userId: string): Promise<HerMessageMode>;
    setMode(userId: string, mode: HerMessageMode, at: string): Promise<void>;
    /** Demo mode: (re)plans the row for its key as given, whatever was there. */
    replan(row: HerMessageRow): Promise<void>;
  };
  /**
   * What she calls him and how she changes for him (#56). Only states and counts are kept — never his words. All of it
   * goes with a deleted account (users.anonymise).
   */
  bond: {
    get(userId: string, star: StarId): Promise<CallNameState | null>;
    /**
     * Stores his answer (`next`) only if what she had asked about is still `expectAsked` (no row = `new`): a repeated or
     * parallel answer to the same question changes nothing. True = this call stored it.
     */
    answer(userId: string, star: StarId, expectAsked: CallNameState['asked'], next: CallNameState): Promise<boolean>;
    /** Demo mode: puts the state as given. */
    set(userId: string, star: StarId, s: CallNameState): Promise<void>;
    /** How often he praised each of her looks. */
    praise(userId: string, star: StarId): Promise<Record<string, number>>;
    /** One more praise for each look (once per call), capped at `max`. */
    addPraise(userId: string, star: StarId, looks: string[], at: string, max: number): Promise<void>;
    /** The name he asked all five to use; null = none. */
    name(userId: string): Promise<string | null>;
    /** Sets (or, with null, clears) that name. */
    setName(userId: string, name: string | null, at: string): Promise<void>;
  };
  /** Her year with him (#61): who her messages for the day may go to. Her lines themselves are inbox rows (`addOnce`). */
  calendar: {
    /**
     * Up to `limit` users, by id after `after`: not banned or deleted, her-messages setting not `off`, with each
     * relationship touched on JST day `since` or later.
     */
    candidates(since: string, after: string, limit: number): Promise<CalendarCandidate[]>;
  };
}

import { z } from 'zod';
import { LANGS, POOL_IDS, RARITIES, STAR_IDS } from './domain';
import { RULES } from './rules';
import { SERIAL_RE, isValidSerialFormat } from './serial';
import { ASR_LANGS, VOICE_INPUT } from './voice';
import { RPS_HANDS, zSceneId, zSceneStep, zSceneText, zStepId } from './scenes/schema';
import { BARGAIN_MOVES, DANMAKU_LABELS, PRAISE_REASONS, PRAISE_TIERS } from './scenes/minigames';
import { WEATHER_ALERTS, WEATHER_CONDITIONS } from './weather';
import { CALL_STAGES, CITY_IDS } from './world';
import { RELATIONSHIP_HINTS, RELATIONSHIP_STAGES } from './relationship';
import { PROMISE_KINDS, PROMISE_SOURCES, PROMISE_STATUSES } from './promises';
import { ALARM_TIME_RE } from './alarm';
import { HER_MESSAGE_KINDS, HER_MESSAGE_MODES } from './herMessages';
import { GIFT_IDS, GIFT_TASTES } from './gifts';
import { PICKUP_ID_RE } from './gacha';
import { CALENDAR_EVENT_KINDS } from './calendar';
import { SEASON_IDS } from './world';
import { MEMORY_KINDS } from './memories';

/** Single source of truth for every HTTP payload. The API validates with these; web/admin infer types from them. */
export const zStarId = z.enum(STAR_IDS);
export const zLang = z.enum(LANGS);
export const zRarity = z.enum(RARITIES);
export const zSerial = z.string().regex(SERIAL_RE, 'invalid_serial_format').refine(isValidSerialFormat, 'invalid_serial_format');
export const zEmail = z.string().email().max(120);

export const AgeConfirmReq = z.object({ confirmed: z.literal(true) });
export const OtpStartReq = z.object({ email: zEmail, lang: zLang.default('ja') });
/** `lang`: the language he uses the app in. A new account starts in it; signing in again keeps the account in step (#176). */
export const OtpVerifyReq = z.object({ email: zEmail, code: z.string().regex(/^\d{6}$/), lang: zLang.optional() });
/** `PUT /v1/auth/me/lang`: the server writes her texts (wake-up, her messages, the day's words, pushes) in this (#176). */
export const LangReq = z.object({ lang: zLang });
export const SessionRes = z.object({
  token: z.string(),
  /**
   * `named` (M4): he chose his nickname (PUT /v1/auth/me/nickname). False while it is still the stand-in made from his
   * e-mail address at sign-up, which the app never shows as his name.
   */
  user: z.object({ id: z.string(), nickname: z.string(), via: z.enum(['line', 'email']), lang: zLang, ageConfirmedAt: z.string(), named: z.boolean().optional() })
});
/** `PUT /v1/auth/me/nickname` (M4): his name on My page, and the name the five use for him unless he set 「呼び方」. */
export const NicknameReq = z.object({ nickname: z.string().max(200) });
/** `POST /v1/auth/otp/start`: how long the code is good for (M1: the form says so). */
export const OtpStartRes = z.object({ ok: z.literal(true), ttlMinutes: z.number().int().positive() });

/** A card handed out by a draw; `isNew` is false for a duplicate (it adds a copy and bond XP instead). */
export const DrawnCard = z.object({ id: z.string(), star: zStarId, rarity: zRarity, isNew: z.boolean() });

export const SerialRedeemReq = z.object({ code: zSerial });
/**
 * One printed code = RULES.lucky.drawsPerCode cards (the first SR or better) plus pass days.
 * `claimed` is false for a visitor: cards and days wait on the device until sign-up (docs/requirements.md §5).
 */
export const SerialRedeemRes = z.object({
  cards: z.array(DrawnCard), trialDays: z.number().int().min(0), claimed: z.boolean(), passUntil: z.string().nullable(), drawId: z.string()
});

export const ChatSendReq = z.object({
  star: zStarId,
  text: z.string().min(1).max(500),
  lang: zLang.default('ja'),
  clientMessageId: z.string().max(64).optional(),
  /** Round 12: his browser's time zone (IANA), so a time he names in chat is his — not Tokyo's. */
  tz: z.string().max(64).optional(),
  /** QA #4: her room asks for his next words as choices (`replies` in the result); her chat does not. */
  suggest: z.boolean().optional()
});
/**
 * A promise between him and one talent (#59, docs/requirements.md §11.4). `text` is as it was made, in the language of
 * that moment. `sceneId`: the scene it came from, played again to keep it (null for promises made in chat).
 */
export const PromiseItem = z.object({
  id: z.string(),
  star: zStarId,
  text: z.string(),
  kind: z.enum(PROMISE_KINDS),
  status: z.enum(PROMISE_STATUSES),
  source: z.enum(PROMISE_SOURCES),
  dueAt: z.string(),
  madeAt: z.string(),
  keptAt: z.string().nullable(),
  sceneId: z.string().nullable()
});
export type PromiseItemT = z.infer<typeof PromiseItem>;

export const ChatSendRes = z.object({
  reply: z.string(),
  affinityXp: z.number().int(),
  level: z.number().int(),
  memoryCard: z.object({ id: z.string(), title: z.string(), createdAt: z.string() }).nullable(),
  trialMessagesLeft: z.number().int().nullable(),
  /** Registered users: messages left today, null while a monthly pass is active. */
  chatLeft: z.number().int().nullable(),
  freePulls: z.number().int(),
  /** Registered users: the relationship with her after this turn (#54), so the home panel follows without a refetch. */
  relationship: z.lazy(() => RelationshipView).optional(),
  /** A promise this turn made (#59): both said yes to a time, and the memory model heard it. */
  promise: PromiseItem.nullable().optional(),
  /**
   * He asked for a scene and she agreed (`start`: the web opens it after her line), or she turned it down and offered
   * another (`offer`: a button, never forced) — #65. Checked by the API against the scenes it may offer; absent otherwise.
   */
  scene: z.object({ sceneId: zSceneId, action: z.enum(['start', 'offer']), title: zSceneText }).nullable().optional(),
  /**
   * #78: she mentioned her variant card he does not have — he asked about it (`ask`) or she brought it up (`invite`) —
   * and a Pickup of it is live: the web shows a small link to that Pickup under her line. Never a pop-up, never a
   * countdown. Absent otherwise.
   */
  pickup: z.lazy(() => ChatPickup).nullable().optional(),
  /** QA #4: up to 3 things he might say next, written with her reply (asked for with `suggest`); absent otherwise. */
  replies: z.array(z.string().min(1).max(40)).max(3).optional(),
  /** Her reply may be spoken in her voice (#73): its signature for `POST /v1/tts`, only while she has one for him. */
  voiceSig: z.string().optional()
});

export const ChatMessage = z.object({ id: z.string(), role: z.enum(['user', 'assistant']), text: z.string(), createdAt: z.string() });
export const ChatHistoryRes = z.object({ messages: z.array(ChatMessage) });

export const zPoolId = z.enum(POOL_IDS as [string, ...string[]]);
/** A Pickup (#78): `pickup:<cardId>:<YYYYMMDD>`; drawable only while it is live. */
export const zPickupPoolId = z.string().regex(PICKUP_ID_RE);
export const DrawReq = z.object({ pool: z.union([zPoolId, zPickupPoolId]).default('all'), count: z.union([z.literal(1), z.literal(6), z.literal(10)]), useFreePull: z.boolean().default(false) });
/** Wallet plus the gacha counters: pulls since the last SSR or better (pity) and exchange shards. */
export const GachaState = z.object({ points: z.number().int(), freePulls: z.number().int(), pity: z.number().int(), shards: z.number().int() });
export const DrawRes = z.object({
  cards: z.array(DrawnCard),
  wallet: GachaState,
  drawId: z.string()
});
export const ExchangeReq = z.object({ cardId: z.string().max(64) });
export const ExchangeRes = z.object({ card: DrawnCard, wallet: GachaState });
export const DrawHistoryRes = z.object({
  draws: z.array(z.object({ id: z.string(), pool: z.string(), cards: z.array(z.object({ id: z.string(), rarity: zRarity })), cost: z.number().int(), createdAt: z.string() }))
});

/** One tier of a pool's 提供割合: its rate, each card's rate (the other cards, in a Pickup) and how many cards. */
export const RateRowSchema = z.object({ tier: zRarity, rate: z.number(), perCard: z.number(), cards: z.number().int() });
const zPoolDisclosure = {
  rows: z.array(RateRowSchema), pity: z.number().int(), effectiveTopRate: z.number(),
  firstCodeDraw: z.object(Object.fromEntries(RARITIES.map((r) => [r, z.number()])) as Record<(typeof RARITIES)[number], z.ZodNumber>)
};
/**
 * A Pickup's published odds (#78, docs/compliance-jp.md §3), computed from its config by `pickupDisclosure`: every
 * tier and card, and the picked-up card's rate beside its rate in her regular pool. `live`: drawable now; a Pickup
 * is listed from the moment it is scheduled, so a change of odds is announced before it starts.
 */
export const PickupRates = z.object({
  id: zPickupPoolId, star: zStarId, cardId: z.string(), startsAt: z.string(), endsAt: z.string(), live: z.boolean(),
  ...zPoolDisclosure,
  pickup: z.object({ cardId: z.string(), tier: zRarity, rate: z.number(), baseRate: z.number(), share: z.number(), effectiveRate: z.number() })
});
/** `GET /v1/gacha/rates` (public): the regular pools, then the Pickups that are live or scheduled. */
export const GachaRatesRes = z.object({
  pools: z.array(z.object({ id: zPoolId, ...zPoolDisclosure })),
  pickups: z.array(PickupRates),
  shardsForExchange: z.number().int(),
  duplicateShards: z.object({ N: z.number().int(), R: z.number().int(), SR: z.number().int(), SSR: z.number().int(), UR: z.number().int() }),
  exchangeShards: z.object({ N: z.number().int(), R: z.number().int(), SR: z.number().int(), SSR: z.number().int(), UR: z.number().int() })
});
/** Under her line in chat (#78): the Pickup of the card she mentioned. */
export const ChatPickup = z.object({ poolId: zPickupPoolId, cardId: z.string(), star: zStarId, via: z.enum(['ask', 'invite']) });
export type PickupRatesT = z.infer<typeof PickupRates>;
export type GachaRatesResT = z.infer<typeof GachaRatesRes>;
export type ChatPickupT = z.infer<typeof ChatPickup>;

/** Date of birth, asked once after sign-up (18+ service). `YYYY-MM-DD`. */
export const BirthdayReq = z.object({ birthday: z.string().regex(/^\d{4}-\d{2}-\d{2}$/) });
/** Account deletion needs the word typed back, so it never happens by a stray tap. */
export const DeleteAccountReq = z.object({ confirm: z.literal('DELETE') });
/** Printed codes this account redeemed (or claimed from its device), newest first. */
export const RedemptionHistoryRes = z.object({
  redemptions: z.array(z.object({ serialId: z.string(), drawId: z.string(), cards: z.array(z.object({ id: z.string(), rarity: zRarity })), createdAt: z.string() }))
});

export const TopUpReq = z.object({ points: z.number().int().positive() });
export const TopUpRes = z.object({ checkoutUrl: z.string().url().nullable(), points: z.number().int() });
export const PassRes = z.object({ checkoutUrl: z.string().url().nullable(), passUntil: z.string() });

/** `vapidPublicKey`: Web Push application server key (base64url), null while push is off (no VAPID keys configured). */
export const PublicConfigRes = z.object({
  demo: z.boolean(), turnstile: z.string().nullable(), vapidPublicKey: z.string().nullable(),
  /** Server speech-to-text (`POST /v1/asr`) is on: browsers without their own speech recognition may record and send audio. */
  asr: z.boolean().optional(),
  /**
   * Her runtime voice (#73) exists on this server: a TTS vendor is configured and these talents have a cloned voice
   * (`voiceStars`). Whether HE hears it is `voice.tts` on his account (every member since 2026-10-02).
   */
  voice: z.boolean().optional(),
  voiceStars: z.array(zStarId).optional()
});

// ---------------------------------------------------------------- Voice input (#72)

export const zAsrLang = z.enum(ASR_LANGS);
/**
 * `POST /v1/asr?lang=ja`, body = the recording (audio/webm, audio/mp4, audio/ogg or audio/wav, at most
 * VOICE_INPUT.maxBytes). The audio is transcribed in memory and dropped: never stored or logged. `text` is empty
 * when nothing was said.
 */
export const AsrQuery = z.object({ lang: zAsrLang.optional() });
export const AsrRes = z.object({ text: z.string(), lang: z.string().nullable() });

// ---------------------------------------------------------------- Voice minutes (#74) and her runtime voice (#73)

/**
 * His voice time today (VOICE_RULES, reset at 0:00 JST): `GET /v1/voice`, and `voice` on `/v1/auth/me`. Seconds, so
 * the ledger and the display agree to the second; the web app shows minutes. `tts`: her runtime voice is on for this
 * account (a provider is configured and a talent has a cloned voice; every member, owner 2026-10-02) — false hides every entry.
 */
export const VoiceState = z.object({
  day: z.string(),
  leftSeconds: z.number().int().min(0),
  usedSeconds: z.number().int().min(0),
  allowanceSeconds: z.number().int().min(0),
  extensions: z.number().int().min(0),
  extensionsLeft: z.number().int().min(0),
  extendCost: z.number().int().min(0),
  extendMinutes: z.number().int().min(0),
  tts: z.boolean(),
  /** With `tts`: the talents who have a runtime voice (the others stay in subtitles, and are never asked for). */
  ttsStars: z.array(zStarId).optional()
});
/** A request id the client makes up once per action (a UUID) and repeats on retry: the same id is charged once. */
export const zRequestId = z.string().regex(/^[A-Za-z0-9_:.-]{8,80}$/, 'invalid_request_id');
/**
 * `POST /v1/voice/extend`: +VOICE_RULES.extendMinutes voice minutes for today, for VOICE_RULES.extendCostPoints points.
 * Idempotent per `requestId`: a repeat returns the first answer (`replayed: true`) and charges nothing. 402
 * `insufficient_points`; 409 `extend_limit` after VOICE_RULES.extendsPerDay today; 409 `request_conflict` when the id
 * was already used for something else.
 */
export const VoiceExtendReq = z.object({ requestId: zRequestId });
export const VoiceExtendRes = z.object({ voice: VoiceState, points: z.number().int(), replayed: z.boolean() });
/**
 * `POST /v1/tts` (#73): her voice for one sentence of a line of hers, while `voice.tts` is true. `requestId` makes the
 * charge idempotent (a request id is synthesized once). 403 `not_her_line` when the signature does not match the line
 * (or another account's). The answer is her audio (`voice`), or `subtitle` with the reason — the web app then shows
 * the line as subtitles only, which is never an error: `off` (no provider), `no_minutes` (today's voice time is used up), `failed` (the provider did
 * not answer), `no_voice` (no cloned voice of hers is configured: a generic voice never stands in for hers).
 */
export const TtsReq = z.object({
  star: zStarId,
  /**
   * Her line exactly as the server gave it, with its signature (`voiceSig` of a chat reply, `voiceSigs` of a scene
   * line): only her own words are ever spoken in her voice, never text of his (docs/requirements.md §13.6). A scene
   * line may hold `{name}`; the server fills in what she calls him.
   */
  line: z.string().trim().min(1).max(2000),
  sig: z.string().regex(/^[A-Za-z0-9_-]{16,64}$/, 'invalid_sig'),
  /** Which sentence of the line (splitSentences in @jstar/shared/voice): the web app asks for them one by one. */
  index: z.number().int().min(0).max(40),
  lang: zLang.optional(),
  requestId: zRequestId
});
export const TtsRes = z.discriminatedUnion('mode', [
  z.object({ mode: z.literal('voice'), audio: z.string(), mime: z.string(), seconds: z.number().min(0), leftSeconds: z.number().int().min(0) }),
  z.object({ mode: z.literal('subtitle'), reason: z.enum(['off', 'no_minutes', 'failed', 'no_voice']), leftSeconds: z.number().int().min(0) })
]);
export type VoiceStateT = z.infer<typeof VoiceState>;
export type VoiceExtendResT = z.infer<typeof VoiceExtendRes>;
export type TtsReqT = z.infer<typeof TtsReq>;
/**
 * `POST /v1/tts/ticket` (#73, first sound): the same request as `POST /v1/tts`, checked the same way (signature, voice,
 * minutes, limits), answered with a one-use URL the page's <audio> plays as it is synthesized: `GET {url}` streams her
 * sentence (MP3) and is charged the seconds that reached him. `subtitle` as for /v1/tts. 404 `no_stream`: this vendor
 * cannot stream — use `POST /v1/tts`.
 */
export const TtsTicketRes = z.union([
  z.object({ mode: z.literal('stream'), url: z.string(), leftSeconds: z.number().int().min(0) }),
  z.object({ mode: z.literal('subtitle'), reason: z.enum(['off', 'no_minutes', 'failed', 'no_voice']), leftSeconds: z.number().int().min(0) })
]);
export type TtsTicketResT = z.infer<typeof TtsTicketRes>;
export type TtsResT = z.infer<typeof TtsRes>;

/**
 * A variant card's own affinity with him (#75, docs/requirements.md §14.1): level 1–10, the layers of her variant scenes
 * it opened (by level) and the next one, and 心意 (kokoro) from duplicates. `progress` is the share of the way to the
 * next level: the card detail shows a bar, never the XP thresholds (#76).
 */
export const VariantState = z.object({
  level: z.number().int().min(1).max(10),
  xp: z.number().int().min(0),
  kokoro: z.number().int().min(0),
  progress: z.number().min(0).max(1),
  layers: z.array(z.number().int()),
  nextLayer: z.number().int().nullable(),
  /** Her home keeps this look instead of rotating (#76); only from VARIANT_RULES.homePinLevel. */
  pinned: z.boolean()
});
/** `GET /v1/cards/:id/affection` (signed in). 404 `card_not_found`, or `not_a_variant` for the cards that are not variants. */
export const CardAffectionRes = z.object({ cardId: z.string(), star: zStarId, owned: z.boolean(), variant: VariantState });
/**
 * `PUT /v1/cards/:id/home-pin` (signed in, #76): pin her variant look to her home, or unpin it. Answers CardAffectionRes.
 * 404 `card_not_found` / `not_a_variant`, 403 `not_owned`, 403 `variant_level` below VARIANT_RULES.homePinLevel.
 */
export const CardHomePinReq = z.object({ pinned: z.boolean() }).strict();
export type CardHomePinReqT = z.infer<typeof CardHomePinReq>;
export type VariantStateT = z.infer<typeof VariantState>;
export type CardAffectionResT = z.infer<typeof CardAffectionRes>;

/** Everything the web app shows about the signed-in user; the browser cache is replaced by this on every load. */
export const MeRes = z.object({
  user: SessionRes.shape.user,
  wallet: GachaState,
  /** `variant`: set on variant cards only (#75). */
  owned: z.array(z.object({ cardId: z.string(), copies: z.number().int(), viaSerial: z.boolean(), variant: VariantState.optional() })),
  /** `still` (#51): a scene's card carries the clip on screen when it was made (a media id or family), for its picture. */
  memories: z.array(z.object({ id: z.string(), star: zStarId, title: z.string(), createdAt: z.string(), still: z.string().nullable().optional(), sceneId: z.string().nullable().optional(),
    /** N-25: what made the card, so its title can be read in the language of the moment. */
    kind: z.enum(['chat', 'scene', 'promise', 'confession']).nullable().optional() })),
  affinity: z.record(zStarId, z.number().int()),
  chat: z.object({ left: z.number().int().nullable(), passUntil: z.string().nullable() }),
  serialsRedeemed: z.number().int(),
  /** Points granted by this call (daily login + pass bonus + check-in), so the UI can say so once. */
  dailyBonus: z.number().int(),
  /** Monthly check-in: login days this JST month and the reward days already paid. */
  checkIn: z.object({ month: z.string(), days: z.number().int(), claimed: z.array(z.number().int()) }),
  birthdayConfirmed: z.boolean(),
  /** Delivered inbox items not yet opened (her messages, promises, wake-ups, events): the companion-home badge. */
  inboxUnread: z.number().int().min(0),
  /** Voice seconds left today (#74; the same number as `voice.leftSeconds`, named as #73 asks for it). */
  voiceLeft: z.number().int().min(0),
  /** His voice time today and whether her runtime voice is on for him (#73, #74). */
  voice: VoiceState
});

/** A visitor's server-side state, keyed by device id: cards from redeemed codes and the pass days they carry. */
export const DeviceRes = z.object({
  trialLeft: z.number().int(),
  cards: z.array(z.object({ cardId: z.string(), copies: z.number().int() })),
  pendingPassDays: z.number().int()
});

/** Admin */
export const AdminCardUpsertReq = z.object({
  id: z.string().max(64), star: zStarId, rarity: zRarity,
  title: z.object({ ja: z.string().max(80), 'zh-Hant': z.string().max(80), en: z.string().max(80) }),
  source: z.enum(['photo', 'ai']), art: z.string().max(300).nullable(), voice: z.string().max(300).nullable()
});
/** Compensation (補填): points and/or free pulls with a reason for the audit log. */
export const AdminGrantReq = z.object({
  points: z.number().int().min(0).max(100_000).default(0),
  freePulls: z.number().int().min(0).max(100).default(0),
  reason: z.string().trim().min(2).max(200)
}).refine((g) => g.points > 0 || g.freePulls > 0, 'nothing_to_grant');
/** Voids an unredeemed code (lost, leaked or misprinted card). */
export const AdminVoidReq = z.object({ reason: z.string().trim().min(2).max(200) });

export const AdminSerialBatchReq = z.object({
  label: z.string().min(1).max(80), quantity: z.number().int().min(1).max(10_000),
  trialDays: z.number().int().min(0).max(90).default(RULES.serialDefaultTrialDays),
  draws: z.number().int().min(1).max(10).default(RULES.lucky.drawsPerCode)
});
export const AdminPoolReq = z.object({
  id: z.string().max(64), label: z.string().max(80), cardIds: z.array(z.string().max(64)).min(1),
  rates: z.object(Object.fromEntries(RARITIES.map((r) => [r, z.number().min(0).max(1)])) as Record<(typeof RARITIES)[number], z.ZodNumber>),
  startsAt: z.string(), endsAt: z.string()
});

/**
 * Schedules a Pickup of a variant card (#78): her pool, with the card at PICKUP_RULES.share of SSR or better, from
 * `startsAt` until `endsAt`. Once it has started, only `endsAt` may change (ending it early or extending it); the
 * odds are fixed when it is created. Audited.
 */
export const AdminPickupReq = z.object({ cardId: z.string().max(64), startsAt: z.string().datetime({ offset: true }), endsAt: z.string().datetime({ offset: true }) });
export const AdminPickupsRes = z.object({ pickups: z.array(PickupRates) });
export type AdminPickupsResT = z.infer<typeof AdminPickupsRes>;

export type SessionResT = z.infer<typeof SessionRes>;
export type NicknameReqT = z.infer<typeof NicknameReq>;
export type OtpStartResT = z.infer<typeof OtpStartRes>;
export type ChatSendReqT = z.infer<typeof ChatSendReq>;
export type ChatSendResT = z.infer<typeof ChatSendRes>;
export type DrawResT = z.infer<typeof DrawRes>;
export type GachaStateT = z.infer<typeof GachaState>;
export type ExchangeResT = z.infer<typeof ExchangeRes>;
export type DrawHistoryResT = z.infer<typeof DrawHistoryRes>;
export type DrawnCardT = z.infer<typeof DrawnCard>;
export type MeResT = z.infer<typeof MeRes>;
export type RedemptionHistoryResT = z.infer<typeof RedemptionHistoryRes>;
export type DeviceResT = z.infer<typeof DeviceRes>;
export type SerialRedeemResT = z.infer<typeof SerialRedeemRes>;
export type ChatHistoryResT = z.infer<typeof ChatHistoryRes>;

// ---------------------------------------------------------------- AI chat: streaming and greeting

/**
 * `POST /v1/chat/send/stream` and `/v1/chat/trial/stream`: the same turn as the non-streaming routes, answered as
 * NDJSON (one event per line). Errors found before the reply starts (limit, blocked, agent down) are plain HTTP
 * errors, exactly as on the non-streaming routes; once the stream has started, a failure is an `error` event.
 */
export const ChatStreamEvent = z.discriminatedUnion('type', [
  /** Append to her reply. */
  z.object({ type: z.literal('delta'), text: z.string() }),
  /** The content check replaced what was shown so far with this text. */
  z.object({ type: z.literal('replace'), text: z.string() }),
  /** The turn is complete and stored; `result.reply` is the final text. */
  z.object({ type: z.literal('done'), result: ChatSendRes }),
  z.object({ type: z.literal('error'), error: z.string() })
]);

/** M4 (C-room): `tz`, his time zone (IANA), so her greeting fits his time of day; the account's zone, else JST, without it. */
export const ChatGreetingQuery = z.object({ star: zStarId, lang: zLang.optional(), tz: z.string().max(64).optional() });
/**
 * `GET /v1/chat/greeting?star=`: her first line on the companion home, from time of day (JST), days since the last visit and affinity. Cached per user, talent and JST day.
 * `promise` (#59): the promise this line keeps (he came within its window) or, once, the missed one it mentions; such a
 * line replaces the greeting for that visit and is never cached.
 */
export const ChatGreetingRes = z.object({ text: z.string(), cached: z.boolean(), promise: PromiseItem.nullable().optional() });

export type ChatStreamEventT = z.infer<typeof ChatStreamEvent>;
export type ChatGreetingResT = z.infer<typeof ChatGreetingRes>;

// ---------------------------------------------------------------- her inbox and the scheduled tick (#49)

/**
 * What she sends on her own, at a time she chose: a message, a promise falling due, a wake-up call, a calendar
 * event. Rows wait with a `dueAt` and are delivered by the tick (`POST /v1/ops/tick`); only delivered rows are
 * ever shown. `payload` belongs to the job that wrote the row; a `text` string in it is her opening line.
 */
export const INBOX_KINDS = ['message', 'promise_due', 'wakeup', 'event'] as const;
export const zInboxKind = z.enum(INBOX_KINDS);
export const InboxItem = z.object({
  id: z.string(),
  star: zStarId,
  kind: zInboxKind,
  payload: z.record(z.unknown()),
  deliveredAt: z.string(),
  readAt: z.string().nullable(),
  createdAt: z.string()
});
/** `GET /v1/inbox`: unread first, newest first, at most 50; `unread` counts every unread item, beyond the 50 too. */
export const InboxRes = z.object({ items: z.array(InboxItem), unread: z.number().int().min(0) });
/**
 * `POST /v1/inbox/:id/read`: idempotent; the item keeps its first read time. Opening a `promise_due` item within the
 * promise's window keeps the promise (#59): `promise` is then that promise, now `kept`.
 */
export const InboxReadRes = z.object({ item: InboxItem, unread: z.number().int().min(0), promise: PromiseItem.nullable().optional() });
/**
 * `POST /v1/inbox/:id/voice` (#13): her message as a voice note, asked for when he plays it — her line exactly as
 * signed for him (`POST /v1/tts` speaks it, each second charged to his voice minutes, §13.6), or `subtitle` when her
 * runtime voice is not his to hear. Nothing is synthesized until he plays it.
 */
export const InboxVoiceRes = z.discriminatedUnion('mode', [
  z.object({ mode: z.literal('voice'), line: z.string(), sig: z.string() }),
  z.object({ mode: z.literal('subtitle') })
]);
export type InboxVoiceResT = z.infer<typeof InboxVoiceRes>;

/**
 * `POST /v1/inbox/demo`, demo mode only (local and the test site; 404 in production): puts a message from her in
 * the caller's own inbox, due in `inMinutes`, so the tick and the badge can be tried before the real jobs exist.
 */
export const InboxDemoReq = z.object({ star: zStarId, text: z.string().trim().min(1).max(300), inMinutes: z.number().int().min(0).max(24 * 60).default(0) });

/**
 * `POST /v1/ops/tick` (Cron Trigger → Worker → API container; never reachable from the internet). Each job runs
 * at most once per tick, in order, within one time budget; a failing job is reported and the others still run.
 */
export const TickJobStatus = z.enum(['ok', 'failed', 'timeout', 'not_due', 'busy', 'skipped']);
export const TickRes = z.object({
  startedAt: z.string(),
  tookMs: z.number().int(),
  jobs: z.array(z.object({ name: z.string(), status: TickJobStatus, ms: z.number().int(), result: z.record(z.unknown()).nullable(), error: z.string().nullable() }))
});

export type InboxKind = z.infer<typeof zInboxKind>;
export type InboxItemT = z.infer<typeof InboxItem>;
export type InboxResT = z.infer<typeof InboxRes>;
export type InboxReadResT = z.infer<typeof InboxReadRes>;
export type TickResT = z.infer<typeof TickRes>;

// ---------------------------------------------------------------- Product events and the admin metrics (#52)

/**
 * Event props carry ids and enums only. The id pattern has no spaces, so a sentence (a chat line, a nickname) can
 * never ride along in an event — the events table is kept 180 days and read by admins; chat text never goes there.
 */
const zEventId = z.string().regex(/^[A-Za-z0-9_.:-]{1,64}$/);

/** How a scene started: he asked for it, she proposed it, or a time event (wake-up, bedtime, weather…) did. */
export const TRIGGER_SOURCES = ['request', 'proposed', 'time'] as const;
export type TriggerSource = (typeof TRIGGER_SOURCES)[number];
/** The mix the plan aims for (plan v2 核心指标, #47): mostly on request, but she and the clock start a good share. */
export const TRIGGER_SOURCE_TARGET: Record<TriggerSource, number> = { request: 0.4, proposed: 0.3, time: 0.3 };

/** Events are deleted a JST day at a time once they are older than this (#52). */
export const EVENT_RETENTION_DAYS = 180;

/**
 * Every server-side product event and its props. Only the API writes events (the browser is never trusted to
 * report them); each feature issue adds the `recordEvent` call to its own flow. Objects are strict: an unknown
 * key is a bug, not extra data.
 */
export const EVENT_PROPS = {
  /** Relationship stage machine (#54); stage names are its ids. */
  'stage.changed': z.object({ star: zStarId, from: zEventId, to: zEventId }).strict(),
  /** She confessed (#55): the numerator of the confession reach rate. */
  'confession.reached': z.object({ star: zStarId }).strict(),
  'confession.answered': z.object({ star: zStarId, answer: zEventId }).strict(),
  /** What she calls him (#56): his answer to her asking to call him differently (`to`: familiar / lover; `answer`: accepted / declined). */
  'call_name.answered': z.object({ star: zStarId, to: zEventId, answer: zEventId }).strict(),
  /** Wake-up alarm (#57): set, and the morning call opened. */
  'alarm.set': z.object({ star: zStarId }).strict(),
  'wakeup.opened': z.object({ star: zStarId }).strict(),
  /** Promises (#59). `promiseId` is the promise's own globally unique id: due and kept are paired by it. */
  'promise.due': z.object({ star: zStarId, promiseId: zEventId }).strict(),
  'promise.kept': z.object({ star: zStarId, promiseId: zEventId }).strict(),
  /**
   * He opened her room (the companion home). Not in #52's list; added because two metrics need it: it is the
   * denominator of scene triggers per room entry, and the visit signal of the 7-day retention.
   */
  'room.entered': z.object({ star: zStarId }).strict(),
  /** Scene engine (#64, #65): one trigger per scene started, with where it came from. */
  'scene.trigger': z.object({ star: zStarId, sceneId: zEventId, source: z.enum(TRIGGER_SOURCES) }).strict(),
  'scene.start': z.object({ star: zStarId, sceneId: zEventId }).strict(),
  'scene.end': z.object({ star: zStarId, sceneId: zEventId, seconds: z.number().int().min(0).max(86_400) }).strict(),
  /** Variant cards (#75–#78): she brought it up, he drew it, he opened its scene. */
  /** #78 `via`: he asked about it, or she brought it up; either way the link to its Pickup was shown. */
  'variant.prompted': z.object({ star: zStarId, cardId: zEventId, via: z.enum(['ask', 'invite']).optional() }).strict(),
  /** #78 `pickup`: drawn in a Pickup (absent for the regular pools and codes). */
  'variant.drawn': z.object({ star: zStarId, cardId: zEventId, pickup: z.literal(true).optional() }).strict(),
  /** #76 `layer`: which of her four variant scenes (1 / 3 / 6 / 10) he entered. */
  'variant.scene_opened': z.object({ star: zStarId, cardId: zEventId, layer: z.number().int().min(1).max(10).optional() }).strict(),
  /** `sceneId`: given inside a scene (#68 うんぱい's stream). */
  'gift.sent': z.object({ star: zStarId, giftId: zEventId, sceneId: zEventId.optional() }).strict()
} as const;
export type EventName = keyof typeof EVENT_PROPS;
export const EVENT_NAMES = Object.keys(EVENT_PROPS) as EventName[];
export type EventProps<N extends EventName> = z.infer<(typeof EVENT_PROPS)[N]>;

export const MetricsGrain = z.enum(['day', 'week']);
/** `GET /v1/admin/metrics?grain=&days=`: the last `days` JST days up to today; weeks start on Monday. */
export const AdminMetricsQuery = z.object({
  grain: MetricsGrain.default('day'),
  days: z.coerce.number().int().min(1).max(EVENT_RETENTION_DAYS).default(28)
});
const zCount = z.number().int().min(0);
/**
 * Raw counts of one period; the admin page turns them into rates, so an empty period reads as "—", never NaN.
 * Cohort fields count the users first seen (their first event) in the period, whatever they did later; the other
 * fields count what happened in the period.
 */
export const MetricsCounts = z.object({
  /** Cohort: users first seen; of them, who reached the confession. */
  newUsers: zCount, confessed: zCount,
  /**
   * Active users: everyone with at least one event in the period (new or returning); of them, who had set a wake-up
   * alarm (`alarm.set`) by the period's last day. The alarm set rate is alarmSet ÷ activeUsers (#57).
   */
  activeUsers: zCount, alarmSet: zCount,
  /** Promises due in the period and, of those, kept (paired by promiseId). */
  promisesDue: zCount, promisesKept: zCount,
  roomEntries: zCount, sceneTriggers: zCount,
  triggerSources: z.object({ request: zCount, proposed: zCount, time: zCount }),
  /** Users prompted in the period; of them, who drew a variant after the prompt in the same period, and who opened its scene the day they drew. */
  variantPrompted: zCount, variantDrawn: zCount, variantSceneOpened: zCount,
  /**
   * Cohort, split by whether they triggered a scene in their first 7 days (day 0–6); retained = came back on
   * day 7–13. Chat-only = the rest of the cohort.
   */
  sceneUsers: zCount, sceneRetained: zCount, chatOnlyUsers: zCount, chatOnlyRetained: zCount
});
export const AdminMetricsRes = z.object({
  asOf: z.string(), grain: MetricsGrain, from: z.string(), to: z.string(),
  /** The whole range as one period. */
  total: MetricsCounts,
  /** Every period of the range, oldest first, zero-filled. `period` is its first JST day. */
  periods: z.array(MetricsCounts.extend({ period: z.string() }))
});
export type MetricsGrainT = z.infer<typeof MetricsGrain>;
export type MetricsCountsT = z.infer<typeof MetricsCounts>;
export type AdminMetricsResT = z.infer<typeof AdminMetricsRes>;
// ---------------------------------------------------------------- Web Push (#50)

/**
 * `POST /v1/push/subscribe`: the browser's PushSubscription (`subscription.toJSON()`) plus the device's IANA time
 * zone, which becomes the user's clock for wake-ups. Sizes are generous caps, not the real lengths: a p256dh key is
 * 87 characters and auth 22 in base64url.
 */
export const PushSubscribeReq = z.object({
  endpoint: z.string().url().startsWith('https://').max(1024),
  keys: z.object({ p256dh: z.string().regex(/^[A-Za-z0-9_-]+={0,2}$/).max(200), auth: z.string().regex(/^[A-Za-z0-9_-]+={0,2}$/).max(64) }),
  tz: z.string().max(64).optional()
});
/** `DELETE /v1/push/subscribe`: this browser's endpoint, or no endpoint to turn push off on every device. */
export const PushUnsubscribeReq = z.object({ endpoint: z.string().max(1024).optional() });
export const PushSubscribeRes = z.object({ ok: z.literal(true) });
export const PushUnsubscribeRes = z.object({ ok: z.literal(true), removed: z.number().int() });
/** `POST /v1/push/test` (demo / test site only): one notification from her to the caller's devices. */
export const PushTestReq = z.object({ star: zStarId.default('mahiro') });
export const PushTestRes = z.object({ sent: z.number().int(), removed: z.number().int(), failed: z.number().int() });

/**
 * What the service worker receives in a push. Her name and one line of hers, nothing else: never the user's own
 * words or anything personal, because it is shown on the lock screen (#50 acceptance criteria). `url` is an in-app
 * hash route; the worker refuses anything else.
 */
export const PushPayload = z.object({
  title: z.string().min(1).max(40),
  body: z.string().min(1).max(160),
  url: z.string().regex(/^\/#\/[A-Za-z0-9/_?=&.-]*$/).max(200),
  star: zStarId.optional(),
  /** Same tag = the newer notification replaces the older one instead of stacking. */
  tag: z.string().max(64).optional()
});

export type PublicConfigResT = z.infer<typeof PublicConfigRes>;
export type AsrResT = z.infer<typeof AsrRes>;
export type PushSubscribeReqT = z.infer<typeof PushSubscribeReq>;
export type PushTestResT = z.infer<typeof PushTestRes>;
export type PushPayloadT = z.infer<typeof PushPayload>;
// ---------------------------------------------------------------- Scenes (#64)

/** `POST /v1/scene/start`: starts a scene, or resumes it when it is already his active run. */
export const SceneStartReq = z.object({
  sceneId: zSceneId, lang: zLang.optional(),
  /** The offer he accepted (#65): she proposed it or the moment did; without one the start is his own request. */
  offerId: z.string().min(1).max(64).optional(),
  /**
   * Demo mode only (the test site): start a draft scene (#66–#70) as a preview, its pending clips played by stand-ins
   * (`GET /v1/scene/previews`). Its trigger conditions are waived; elsewhere 404 `scene_not_found`.
   */
  preview: z.boolean().optional()
});
/**
 * `POST /v1/scene/step`: his answer to the waiting step, exactly one of choice / input / minigame / timeout.
 * `seq` is the run's `seq` he answered; a repeated submission of an answered step returns the run unchanged.
 * `step` (D-N2): the id of the step he answered. An answer naming a step the run is no longer waiting on (it took
 * that step already — a countdown left over from it) changes nothing either, and returns the run as it is.
 */
export const SceneStepReq = z.object({
  runId: z.string().min(1).max(64),
  seq: z.number().int().min(0).max(10_000),
  step: z.string().min(1).max(80).optional(),
  choice: zStepId.optional(),
  /** With `choice` only: the gift he picked in the sheet for an option that lets him pick one (#68, `gift: "pick"`). */
  gift: z.enum(GIFT_IDS).optional(),
  input: z.string().trim().min(1).max(500).optional(),
  minigame: z.object({ hand: z.enum(RPS_HANDS).optional(), text: z.string().trim().min(1).max(500).optional() }).strict().optional(),
  timeout: z.literal(true).optional(),
  lang: zLang.optional(),
  /**
   * #74: how long he talked into the mic for this answer (from the moment he started to when he stopped), in ms.
   * Charged to his voice time once per answer (the step's `seq` is the idempotency key); capped at VOICE_INPUT.maxMs.
   */
  voiceMs: z.number().int().min(0).max(VOICE_INPUT.maxMs).optional()
}).refine((b) => [b.choice, b.input, b.minigame, b.timeout].filter((v) => v !== undefined).length === 1, 'one_answer')
  .refine((b) => b.gift === undefined || b.choice !== undefined, 'gift_needs_choice');
/** `POST /v1/scene/end`: he left (`left`) or went quiet for five minutes (`idle`); either way without a penalty. */
export const SceneEndReq = z.object({ runId: z.string().min(1).max(64), reason: z.enum(['left', 'idle']).default('left') });
export const SceneCurrentQuery = z.object({ star: zStarId.optional() });

const zGameOutcome = z.enum(['win', 'lose', 'draw']);
export const SceneGameResult = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('rps'), mine: z.enum(RPS_HANDS), hers: z.enum(RPS_HANDS), result: zGameOutcome }),
  z.object({ kind: z.literal('praise'), tier: z.enum(PRAISE_TIERS), reason: z.enum(PRAISE_REASONS), score: z.number().int(), attempt: z.number().int(), result: zGameOutcome }),
  z.object({ kind: z.literal('ogiri'), score: z.number().int(), of: z.number().int(), pass: z.number().int().nullable(), result: zGameOutcome }),
  z.object({ kind: z.literal('bargain'), move: z.enum(BARGAIN_MOVES), result: zGameOutcome }),
  z.object({ kind: z.literal('danmaku'), label: z.enum(DANMAKU_LABELS).nullable(), read: z.boolean(), result: zGameOutcome }),
  /** A gift he gave inside the scene (#68, #77): its XP went to her like any gift's. */
  z.object({ kind: z.literal('gift'), giftId: z.enum(GIFT_IDS), taste: z.enum(GIFT_TASTES), xp: z.number().int(), result: z.literal('win') })
]);

/**
 * A run as the player needs it. `beats` is what the last change plays (script steps, plus the server's own beats:
 * a chosen option's reward `<step>~<option>` and her free-talk reply `<step>~reply`), ending with `waiting`.
 * `upcoming` names the clips each answer leads to, for preloading. Rewards are what the server has granted.
 */
export const SceneRunView = z.object({
  id: z.string(), sceneId: z.string(), star: zStarId,
  seq: z.number().int(),
  status: z.enum(['active', 'ended']),
  /** 'complete' (or the end step's outcome), 'left', 'idle', 'timeout', 'replaced'. */
  outcome: z.string().nullable(),
  startedAt: z.string(), endsAt: z.string(), endedAt: z.string().nullable(),
  beats: z.array(zSceneStep),
  waiting: zSceneStep.nullable(),
  waitingSince: z.string(),
  upcoming: z.array(z.string()),
  timerEndsAt: z.string().nullable(),
  /** False on a replay the same JST day: the scene plays, nothing is granted. */
  rewardable: z.boolean(),
  rewards: z.object({
    affinity: z.number().int(), variantXp: z.number().int(),
    /** `still` (#51): the clip on screen when the card was made (a media id or family); its poster is the card's picture. */
    memories: z.array(z.object({ id: z.string(), title: z.string(), createdAt: z.string(), still: z.string().optional() })),
    /** `kind` wakeup: her 「明日の朝、起こしてあげる」 — the ending (and the home) offers to set the alarm (#57, #66). */
    promises: z.array(z.object({ text: z.string(), dueAt: z.string(), kind: z.enum(['scene', 'wakeup']).optional(), scene: z.string().optional() }))
  }),
  /** The live-stream overlay is up (#68 うんぱい's stream); false or missing once she is off air. */
  live: z.boolean().optional(),
  /**
   * Her lines in `beats` that her runtime voice may speak (#73: a `tts` line, her free-talk reply, a line with his
   * name), by beat id and language: the signature `POST /v1/tts` wants with that language's text. Only while she
   * has a runtime voice for him.
   */
  voiceSigs: z.record(z.string(), z.record(z.string(), z.string())).optional(),
  /**
   * The last decided mini-game (#66–#70; packages/shared/src/scenes/minigames.ts): rock-paper-scissors drawn on the
   * server, or his answer as judged there — praise tier, ōgiri score, bargaining move, whether his comment was read out.
   */
  result: SceneGameResult.nullable(),
  /** Her affinity XP with him after this change. */
  affinityXp: z.number().int()
});
export const SceneRunRes = z.object({ run: SceneRunView, replayed: z.boolean() });
export const SceneCurrentRes = z.object({ run: SceneRunView.nullable() });

/**
 * `POST /v1/scene/room` (#65): he entered her room, has sat there quietly for TRIGGER_RULES.idleProposeMs, or opened
 * an inbox item whose payload names a scene (`inboxId`: wake-up, goodnight, a promise due, first snow, a birthday).
 * The server decides whether she offers a scene now; `offer` is null otherwise.
 */
export const SceneRoomReq = z.object({
  star: zStarId,
  inboxId: z.string().min(1).max(64).optional()
});
export const SceneOfferView = z.object({
  id: z.string(), sceneId: zSceneId, star: zStarId,
  /** `proposed`: her idea; `time`: the moment's (a time window, the weather, a stage reached, an inbox event). */
  source: z.enum(['proposed', 'time']),
  expiresAt: z.string(),
  title: zSceneText,
  /** Every clip the scene plays: the web shows the offer only when it has them all (the scene chunk stays unloaded). */
  media: z.array(z.string())
});
/**
 * C-room N1: with `inboxId`, the scene her invitation names — `ready`: it can start now (✦ into it); otherwise
 * `dueAt`, when it can (her evening scene, invited in the morning): she offers 「今晚見」 (`tonight`: that is tonight on
 * her clock), a promise for then (`POST /v1/promises/tonight`) — never a link to a locked scene. Absent when no time can
 * be promised for it (his stage, a card, her weather): her invitation is then only her words.
 */
export const SceneInvite = z.object({ sceneId: zSceneId, title: zSceneText, ready: z.boolean(), dueAt: z.string().nullable(), tonight: z.boolean() });
export const SceneRoomRes = z.object({ offer: SceneOfferView.nullable(), invite: SceneInvite.optional() });
/** `POST /v1/scene/offer/decline`: "not now" — she lets it go, and does not bring that scene up again for a while. */
export const SceneOfferDeclineReq = z.object({ offerId: z.string().min(1).max(64) });

/**
 * Draft scene previews (#66–#70), demo mode only (404 in production). `GET /v1/scene/previews` lists the drafts;
 * `GET /v1/scene/preview/:id` returns one as the player plays it — the pending clips (#80) replaced by her existing
 * ones (`standIns`: pending id → stand-in). Start it with `POST /v1/scene/start { sceneId, preview: true }`.
 */
export const ScenePreviewItem = z.object({
  id: zSceneId, star: zStarId, title: zSceneText,
  /** #80 clips the draft still waits for, each played by a stand-in in the preview. */
  pending: z.array(z.string()),
  /** The mini-games it plays (#66–#70). */
  games: z.array(z.string())
});
export const ScenePreviewListRes = z.object({ scenes: z.array(ScenePreviewItem) });
/** The script is a draft (packages/shared/src/scenes/schema.ts zSceneScript), not validated again on the wire. */
export const ScenePreviewRes = z.object({ script: z.unknown(), standIns: z.record(z.string()) });

export type SceneRoomReqT = z.infer<typeof SceneRoomReq>;
export type SceneOfferViewT = z.infer<typeof SceneOfferView>;
export type SceneRoomResT = z.infer<typeof SceneRoomRes>;
export type SceneInviteT = z.infer<typeof SceneInvite>;
export type SceneStepReqT = z.infer<typeof SceneStepReq>;
export type SceneRunViewT = z.infer<typeof SceneRunView>;
export type SceneRunResT = z.infer<typeof SceneRunRes>;
export type SceneCurrentResT = z.infer<typeof SceneCurrentRes>;
export type SceneGameResultT = z.infer<typeof SceneGameResult>;
export type ScenePreviewItemT = z.infer<typeof ScenePreviewItem>;
export type ScenePreviewListResT = z.infer<typeof ScenePreviewListRes>;
export type ScenePreviewResT = z.infer<typeof ScenePreviewRes>;
// ---------------------------------------------------------------- Her world: weather (#62)

export const zWeatherCondition = z.enum(WEATHER_CONDITIONS);
export const zWeatherAlert = z.enum(WEATHER_ALERTS);
const zLocalText = z.object({ ja: z.string(), 'zh-Hant': z.string(), en: z.string() });

/**
 * The weather at one point now (packages/shared/src/weather.ts). `sunrise` / `sunset` are today's, local to the
 * point, as ISO UTC; `isDay` is computed for the moment of the request. `stale` = not refreshed for
 * WEATHER_STALE_MS (the provider is down): the last data is kept and sent, but readers must treat it as absent —
 * the web shows no weather and her prompt gets none (#62 降级).
 */
export const WeatherNow = z.object({
  weather: zWeatherCondition,
  /** WMO code, for readers that need finer detail than `weather`. */
  code: z.number().int(),
  tempC: z.number(),
  precipMm: z.number(),
  windMs: z.number(),
  sunrise: z.string(),
  sunset: z.string(),
  isDay: z.boolean(),
  alert: zWeatherAlert.nullable(),
  next6h: z.array(z.object({ at: z.string(), weather: zWeatherCondition, tempC: z.number(), precipMm: z.number() })),
  updatedAt: z.string(),
  stale: z.boolean(),
  /** This snow season's first snow (JMA 寒候年, August–July) at the point, its local day; null until it snows. */
  firstSnow: z.string().nullable()
});
/**
 * One talent's city and its weather. The city is her confirmed hometown, or Tokyo while it is unconfirmed
 * (world.ts `weatherPoint`), so an unconfirmed hometown never shows. `weather` is null until the first fetch.
 */
export const WorldTalent = z.object({ star: zStarId, cityId: z.enum(CITY_IDS), city: zLocalText, weather: WeatherNow.nullable() });
/** The signed-in user's own city (optional, city level only), with its weather. */
export const WorldUser = z.object({ name: z.string(), weather: WeatherNow.nullable() });
/** `GET /v1/world`: public; `user` is set only for a signed-in user who chose a city. */
export const WorldRes = z.object({ asOf: z.string(), talents: z.array(WorldTalent), user: WorldUser.nullable() });

/** `GET /v1/world/cities?q=&lang=` (signed in): cities matching a name, for choosing one's own. */
export const CitySearchQuery = z.object({ q: z.string().trim().min(1).max(60), lang: zLang.optional() });
/** A city-level place (GeoNames id); position rounded to 0.1°. `region` / `country` tell namesakes apart. */
export const CityCandidate = z.object({
  id: z.number().int().positive(), name: z.string(), region: z.string().nullable(), country: z.string().nullable(), lat: z.number(), lon: z.number()
});
export const CitySearchRes = z.object({ results: z.array(CityCandidate) });
/**
 * `PUT /v1/world/city`: his city, by a search result's id. The server looks the place up again, so only a real
 * place name is ever stored (it will reach her prompt, #63), never free text. `DELETE /v1/world/city` clears it.
 */
export const SetCityReq = z.object({ id: z.number().int().positive().max(2_000_000_000), lang: zLang.optional() });
export const SetCityRes = z.object({ user: WorldUser });
/** `removed` is false when he had no city; clearing works even while the weather is off. */
export const ClearCityRes = z.object({ ok: z.literal(true), removed: z.boolean() });
/**
 * `PUT /v1/world/demo` (demo mode only: the test site's acceptance, #63): made-up weather at her point until the next
 * hourly refresh. Her point is shared (Tokyo while hometowns are unconfirmed), so it changes every talent there.
 * `firstSnow` records today as this season's first snow at the point (forgetting an earlier one).
 */
export const WorldDemoReq = z.object({
  star: zStarId,
  weather: zWeatherCondition,
  alert: zWeatherAlert.nullable().optional(),
  tempC: z.number().min(-30).max(45).optional(),
  firstSnow: z.boolean().optional()
});
export const WorldDemoRes = z.object({ talent: WorldTalent });

export type WeatherNowT = z.infer<typeof WeatherNow>;
export type WorldTalentT = z.infer<typeof WorldTalent>;
export type WorldUserT = z.infer<typeof WorldUser>;
export type WorldResT = z.infer<typeof WorldRes>;
export type CityCandidateT = z.infer<typeof CityCandidate>;
export type CitySearchResT = z.infer<typeof CitySearchRes>;
export type SetCityResT = z.infer<typeof SetCityRes>;

// ---------------------------------------------------------------- Relationship stages (#54)

export const zRelationshipStage = z.enum(RELATIONSHIP_STAGES);
/**
 * One talent's relationship (packages/shared/src/relationship.ts). `hint` is a key the web says in her words
 * (「もう少し一緒に過ごしたら…」): the thresholds themselves are never shown. `progress` (0–1, by XP) is the bar
 * under her name. `confession_ready` is shown as ambiguous until she has confessed (#55).
 */
export const RelationshipView = z.object({
  star: zStarId,
  stage: zRelationshipStage,
  daysTogether: z.number().int().min(0),
  /** JST day they became lovers (YYYY-MM-DD). */
  anniversary: z.string().nullable(),
  loverLevel: z.number().int().min(1).nullable(),
  hint: z.enum(RELATIONSHIP_HINTS),
  progress: z.number().min(0).max(1),
  /**
   * Her confession (#55), only while the stage is `confession_ready` and the confession is offered (her lines are
   * drafts until #84: test site and demos only). `due`: tonight (`tonight`) the room opens on it, in daytime she
   * hints; `waiting`: he said not yet or no; `open`: she stopped asking, he can bring it up (`sceneId`).
   */
  confession: z.object({
    phase: z.enum(['due', 'waiting', 'open']),
    sceneId: zSceneId,
    tonight: z.boolean(),
    reachedToday: z.boolean()
  }).nullable().optional()
});
/** `GET /v1/relationship`: all five talents, in STAR_IDS order; each line is independent of the others. */
export const RelationshipRes = z.object({ talents: z.array(RelationshipView) });
/**
 * `POST /v1/relationship/demo`, demo mode only (local and the test site; 404 in production): puts his relationship
 * with her at a stage so the panel and the confession (#55) can be tried without waiting a week. Pays no free pull.
 */
export const RelationshipDemoReq = z.object({ star: zStarId, stage: zRelationshipStage });

export type RelationshipViewT = z.infer<typeof RelationshipView>;
export type RelationshipResT = z.infer<typeof RelationshipRes>;

// ---------------------------------------------------------------- Promises (#59)

/**
 * What she says to propose the next time (#82 lines): `propose` is her line, `text` the promise as the home card will
 * show it, `dueAt` when it would fall if he said yes now. Offered only while no promise with her is open.
 */
export const PromiseProposal = z.object({
  star: zStarId, lineId: z.string(), kind: z.enum(PROMISE_KINDS), propose: z.string(), text: z.string(), dueAt: z.string()
});
export const PromisesQuery = z.object({ star: zStarId.optional(), lang: zLang.optional() });
/**
 * `GET /v1/promises?star=&lang=` (signed in): his open promises, soonest first (at most one per talent), and — with
 * `star` — her proposal for the next time when none with her is open (null otherwise, or while her lines are drafts
 * outside demo mode).
 */
export const PromisesRes = z.object({ promises: z.array(PromiseItem), proposal: PromiseProposal.nullable() });
/** `POST /v1/promises`: he said 「約束する」 to her proposal. 409 `promise_open` while one with her is open. */
export const PromiseCreateReq = z.object({ star: zStarId, lineId: z.string().min(1).max(40), lang: zLang.optional() });
export const PromiseCreateRes = z.object({ promise: PromiseItem });
/**
 * C-room N1: 「今晚見」 — his yes to her invitation for a scene that cannot start now: a promise of that scene for when it
 * can (the API works the time out again; `inboxId`, her invitation, is read). 409 `promise_open` while another with her
 * is open; 409 `not_promisable` when no time can be promised.
 */
export const PromiseTonightReq = z.object({ star: zStarId, sceneId: zSceneId, inboxId: z.string().min(1).max(64).optional(), lang: zLang.optional() });
/**
 * `POST /v1/promises/demo`, demo mode only (local and the test site; 404 in production): a promise with her due in
 * `inMinutes` (negative = already past, to try the missed path without waiting three hours). Same one-open rule.
 */
export const PromiseDemoReq = z.object({
  star: zStarId, inMinutes: z.number().int().min(-24 * 60).max(24 * 60).default(5), lang: zLang.optional()
});

export type PromiseProposalT = z.infer<typeof PromiseProposal>;
export type PromisesResT = z.infer<typeof PromisesRes>;
export type PromiseCreateResT = z.infer<typeof PromiseCreateRes>;

// ---------------------------------------------------------------- Wake-up alarm (#57)

export const zAlarmTime = z.string().regex(ALARM_TIME_RE, 'invalid_time');
/** 0 = Sunday … 6 = Saturday (JavaScript's `getDay`). */
const zWeekday = z.number().int().min(0).max(6);

/**
 * `PUT /v1/alarm` (signed in): sets or changes his one alarm and who wakes him; `enabled: false` turns it off and
 * keeps the settings. `tz` is the device's IANA zone: it becomes his clock (`users.tz`), as turning push on does, so
 * after a move the next save rings by the new zone. Omitted or unknown = the clock already on file.
 */
export const AlarmSetReq = z.object({
  star: zStarId,
  time: zAlarmTime,
  days: z.array(zWeekday).min(1).max(7).refine((d) => new Set(d).size === d.length, 'duplicate_days'),
  enabled: z.boolean().default(true),
  tz: z.string().max(64).optional()
});
export const AlarmView = z.object({
  star: zStarId,
  time: zAlarmTime,
  days: z.array(zWeekday),
  enabled: z.boolean(),
  /** The zone it rings in: his clock (`users.tz`), else the zone it was set in. */
  tz: z.string(),
  /** When it rings next (ISO); null while it is off. */
  nextAt: z.string().nullable(),
  updatedAt: z.string()
});
/** `GET /v1/alarm` and `PUT /v1/alarm`: `alarm` is null until he sets one. */
export const AlarmRes = z.object({ alarm: AlarmView.nullable() });

/**
 * The payload of a `wakeup` inbox row, written by the tick's ring job (and by 「あと5分」). `text` is her line in his
 * language when it was written (the push body); `lineId` names it in her line set (`@jstar/shared/lines`), or
 * `greet-morning` for her recorded morning greeting; `day` is the morning it belongs to, in his clock.
 */
/** `voice` (#12): her recording of the line, her ringtone while the call rings (older rows have none). */
export const WakePayload = z.object({ text: z.string(), lineId: z.string(), day: z.string(), snooze: z.boolean().optional(), voice: z.string().optional() });

/** `POST /v1/alarm/wake/open`: he opened a wake-up (the push, her face's badge, or her room before 11:00). Marks it read. */
export const WakeOpenReq = z.object({ id: z.string().min(1).max(64), lang: zLang.optional() });
export const WakeOpenRes = z.object({
  id: z.string(),
  star: zStarId,
  day: z.string(),
  /** Her wake-up line in his language, and its id (see WakePayload). */
  line: z.string(),
  lineId: z.string(),
  /** Her recording of the line (#83; she speaks Japanese whatever the subtitles), or null: subtitle only. */
  voice: z.string().nullable().optional(),
  /** What she says to 「起きた」 and 「あと5分」; null while her lines await native review in production (#84). */
  replies: z.object({ awake: z.string(), snooze: z.string() }).nullable(),
  /** Her recordings of those two answers (#83), when made. */
  replyVoices: z.object({ awake: z.string().nullable(), snooze: z.string().nullable() }).nullable().optional(),
  /** Her wake-up promise (#57, #66: 「明日の朝、起こしてあげる」) this wake-up just kept, quoted. */
  keptPromise: z.string().nullable().optional(),
  /** 「あと5分」 left this morning; 0 = only 「起きた」 is offered. */
  snoozeLeft: z.number().int().min(0),
  snoozeMinutes: z.number().int().positive(),
  /** The item as read and the unread count, as `POST /v1/inbox/:id/read` answers. */
  item: InboxItem,
  unread: z.number().int().min(0)
});
/**
 * `POST /v1/alarm/wake/snooze` (「あと5分」): she calls again in WAKEUP_RULES.snoozeMinutes. 409 `snooze_used` when
 * this morning's snoozes are used up, `wake_over` when the wake-up is not this morning's (or the alarm was changed).
 */
export const WakeSnoozeReq = z.object({ id: z.string().min(1).max(64) });
/**
 * `next` (F-04): her second call as it will ring — the open room rings it itself at `dueAt` (POST /wake/ring), the tick
 * and his phone only if no room did.
 */
export const WakeSnoozeRes = z.object({ dueAt: z.string(), snoozeLeft: z.number().int().min(0), next: InboxItem.optional() });
/** `POST /v1/alarm/wake/ring`: an open room rings her snoozed call at its time — delivered now, so no push follows. */
export const WakeRingReq = z.object({ id: z.string().min(1).max(64) });

export type AlarmSetReqT = z.infer<typeof AlarmSetReq>;
export type AlarmViewT = z.infer<typeof AlarmView>;
export type AlarmResT = z.infer<typeof AlarmRes>;
export type WakePayloadT = z.infer<typeof WakePayload>;
export type WakeOpenResT = z.infer<typeof WakeOpenRes>;
export type WakeSnoozeResT = z.infer<typeof WakeSnoozeRes>;
export type WorldDemoReqT = z.infer<typeof WorldDemoReq>;
export type WorldDemoResT = z.infer<typeof WorldDemoRes>;
// ---------------------------------------------------------------- Her confession (#55)

/**
 * The memory his yes became: the words he answered with (as heard or typed) and, only if he chose to keep it, the
 * recording of his voice (docs/compliance-jp.md §7.3). Deleted with the account; the recording can be deleted alone.
 */
export const ConfessionMemory = z.object({
  memoryId: z.string(),
  star: zStarId,
  transcript: z.string(),
  audio: z.boolean(),
  createdAt: z.string()
});
/** `GET /v1/confession/memories`: his confession memories, newest first. */
export const ConfessionMemoriesRes = z.object({ memories: z.array(ConfessionMemory) });
/**
 * `PUT /v1/confession/memories/:id/audio?consent=yes`, body = the recording (audio/*, at most
 * CONFESSION_RULES.voiceMaxBytes). `consent=yes` is his explicit choice to keep it, recorded with the time; without it
 * nothing is stored. Once per memory: a recording is never replaced, only deleted (`DELETE …/audio`).
 * `GET …/audio` returns it to him alone.
 */
export const ConfessionAudioQuery = z.object({ consent: z.literal('yes') });
export const ConfessionAudioRes = z.object({ memory: ConfessionMemory });

export type ConfessionMemoryT = z.infer<typeof ConfessionMemory>;
export type ConfessionMemoriesResT = z.infer<typeof ConfessionMemoriesRes>;
export type ConfessionAudioResT = z.infer<typeof ConfessionAudioRes>;
// ---------------------------------------------------------------- His memories: storage and export (#51)

export const zMemoryKind = z.enum(MEMORY_KINDS);
/**
 * A link to one of his files. The recording of his yes is signed: it opens without a session, so it works as a plain
 * download, and stops working at `expiresAt` (MEMORY_RULES.linkTtlMs), when the file is deleted, or when he leaves.
 * Never cached (`private, no-store`). A scene card's still (#51) is the poster of her clip on screen when the card was
 * made — public like the clip itself — so its link never expires (`expiresAt` null).
 */
export const MemoryFileLink = z.object({ type: z.string(), url: z.string(), expiresAt: z.string().nullable() });
/**
 * `GET /v1/me/export` (signed in): everything he has with them, as one JSON file (`content-disposition` names it
 * exportFileName(JST day)). Once per JST day (MEMORY_RULES.exportsPerDay): a second request that day answers 429
 * `export_limit`. Files are links, not bytes. `memories` is the same list the 思い出 page shows.
 */
export const MemoryExport = z.object({
  format: z.literal('jstar-memories'),
  version: z.literal(1),
  exportedAt: z.string(),
  account: z.object({ id: z.string(), nickname: z.string(), email: z.string().nullable(), lang: zLang, createdAt: z.string() }),
  memories: z.array(z.object({
    id: z.string(), star: zStarId, kind: zMemoryKind, title: z.string(), sceneId: z.string().nullable(),
    still: MemoryFileLink.nullable(), createdAt: z.string()
  })),
  /** His answers to her confession (#55): his words, and the recording only if he chose to keep it (`keptAt`). */
  confessions: z.array(z.object({
    memoryId: z.string(), star: zStarId, transcript: z.string(), createdAt: z.string(), keptAt: z.string().nullable(), audio: MemoryFileLink.nullable()
  })),
  /** Every promise with her (#59): open, kept or missed. */
  promises: z.array(z.object({
    id: z.string(), star: zStarId, text: z.string(), kind: z.enum(PROMISE_KINDS), status: z.enum(PROMISE_STATUSES),
    madeAt: z.string(), dueAt: z.string(), keptAt: z.string().nullable()
  })),
  /** His chats, oldest first: the newest MEMORY_RULES.exportChatPerTalent messages per talent. */
  chats: z.array(z.object({ star: zStarId, messages: z.array(z.object({ role: z.enum(['user', 'assistant']), text: z.string(), createdAt: z.string() })) }))
});
/**
 * `GET /v1/memories/file?u=&kind=&id=&exp=&sig=`: one of his files, through a link from his export (no session: the
 * signature is the permission). 404 once it expired, was altered, or the file is gone.
 */
export const MemoryFileQuery = z.object({
  u: z.string().min(1).max(64),
  kind: z.enum(['confession']),
  id: z.string().min(1).max(64),
  exp: z.coerce.number().int().positive(),
  sig: z.string().min(1).max(128)
});

export type MemoryFileLinkT = z.infer<typeof MemoryFileLink>;
export type MemoryExportT = z.infer<typeof MemoryExport>;
export type MemoryFileQueryT = z.infer<typeof MemoryFileQuery>;
// ---------------------------------------------------------------- Her messages (#58)

export const zHerMessageMode = z.enum(HER_MESSAGE_MODES);
export const zHerMessageKind = z.enum(HER_MESSAGE_KINDS);
/**
 * `GET /v1/her-messages/settings` and `PUT` with the same body (signed in): how often she writes to him on her own —
 * `normal` (HER_MESSAGE_RULES.perDay a day), `less` (lessPerDay) or `off`. Push stays a separate, per-browser switch.
 */
export const HerMessageSettings = z.object({ mode: zHerMessageMode });
/**
 * `POST /v1/her-messages/demo`, demo mode only (local and the test site; 404 in production): plans her message of
 * `kind` for the caller, due now and outside the windows and caps, so the next tick writes and delivers it.
 */
export const HerMessageDemoReq = z.object({ kind: zHerMessageKind.default('note'), star: zStarId.optional() });
/**
 * What her message's inbox item (kind `message`) carries in `payload`: her line, which kind of message it is, and for
 * an invitation the scene she invites him to (only a scene that can be started in this mode).
 */
export const HerMessagePayload = z.object({ text: z.string(), herMessage: zHerMessageKind, sceneId: z.string().optional() });

export type HerMessageSettingsT = z.infer<typeof HerMessageSettings>;
export type HerMessagePayloadT = z.infer<typeof HerMessagePayload>;
// ---------------------------------------------------------------- Gifts (#77)

export const zGiftId = z.enum(GIFT_IDS);
export const GiftsQuery = z.object({ star: zStarId });
/**
 * `GET /v1/gift?star=` (signed in): the catalogue with her prices, and which gifts he has learned she likes (`known`:
 * she mentioned them in conversation, or loved one he gave her). What she likes and has not told him stays hidden.
 * `sentToday` / `perDay`: gifts today, all talents together (GIFT_RULES.perDay).
 */
export const GiftsRes = z.object({
  star: zStarId,
  gifts: z.array(z.object({ id: zGiftId, price: z.number().int().positive(), known: z.boolean() })),
  sentToday: z.number().int().min(0),
  perDay: z.number().int().min(0),
  points: z.number().int()
});
/**
 * `POST /v1/gift`: gives her a gift. The points, today's count, her affinity XP (and, with `cardId`, the XP of the
 * variant card she is wearing, #75) are one all-or-nothing step. 402 `insufficient_points`; 409 `gift_limit` once
 * GIFT_RULES.perDay gifts were given today; 400 `invalid_card` for a `cardId` that is not a variant of hers he owns.
 */
export const GiftSendReq = z.object({ star: zStarId, giftId: zGiftId, cardId: z.string().min(1).max(64).optional(), lang: zLang.optional() });
export const GiftSendRes = z.object({
  star: zStarId,
  giftId: zGiftId,
  /** How it landed. Her reaction says it too; the XP behind it is never shown as a number. */
  taste: z.enum(GIFT_TASTES),
  /** She had mentioned wanting it: her reaction remembers that she did. */
  wished: z.boolean(),
  /** Her line, in her voice (the persona service, or her written line when it cannot answer). */
  reaction: z.string(),
  affinityXp: z.number().int(),
  level: z.number().int(),
  relationship: RelationshipView,
  /** Wallet after the gift (a stage entered pays a free pull, #54). */
  points: z.number().int(),
  freePulls: z.number().int(),
  sentToday: z.number().int().min(0),
  perDay: z.number().int().min(0),
  /** Gifts he now knows she likes. */
  known: z.array(zGiftId),
  variant: z.object({ cardId: z.string(), state: VariantState }).nullable()
});

export type GiftsResT = z.infer<typeof GiftsRes>;
export type GiftSendReqT = z.infer<typeof GiftSendReq>;
export type GiftSendResT = z.infer<typeof GiftSendRes>;

// ---------------------------------------------------------------- What she calls him, and how she changes for him (#56)

export const zCallStage = z.enum(CALL_STAGES);
export const zCallChange = z.enum(['familiar', 'lover']);
export const BondQuery = z.object({ star: zStarId, lang: zLang.optional() });
/**
 * `GET /v1/bond?star=&lang=` (signed in), packages/shared/src/bond.ts. `callName`: what she calls him now (null when
 * he has no name she can use). `ask`: her question when the relationship reached a call stage she has not asked about
 * (her #82 line with his name in it) — null once asked, and while her lines are drafts outside demo mode. `praise`:
 * how often he praised each of her looks (a count per look id, never his words), for the look her room shows.
 */
export const BondRes = z.object({
  star: zStarId,
  callName: z.string().nullable(),
  callStage: zCallStage,
  ask: z.object({ to: zCallChange, text: z.string() }).nullable(),
  praise: z.record(z.string(), z.number().int().min(0))
});
/**
 * `POST /v1/bond/call-name` (signed in): his answer to her question. Yes: she calls him the new way from now on; no:
 * she keeps the old way. Either is kept, and she never asks about that change again (409 `not_asking` otherwise).
 * `reply` is her answer line; both her lines go into the conversation.
 */
export const CallAnswerReq = z.object({ star: zStarId, to: zCallChange, accept: z.boolean(), lang: zLang.optional() });
export const CallAnswerRes = z.object({ reply: z.string(), bond: BondRes });
/**
 * `GET /v1/bond/name` and `PUT` (signed in): the name he asks all five to use (「呼び方」 on My page), in place of his
 * nickname; null = none set. At most BOND_RULES.nameMax characters, no contact details (400 `invalid_name`).
 */
export const CallNameSettings = z.object({ name: z.string().nullable() });
export const CallNameSetReq = z.object({ name: z.string().max(200).nullable() });

export type BondResT = z.infer<typeof BondRes>;
export type CallAnswerReqT = z.infer<typeof CallAnswerReq>;
export type CallAnswerResT = z.infer<typeof CallAnswerRes>;
export type CallNameSettingsT = z.infer<typeof CallNameSettings>;

// ---------------------------------------------------------------- Her year with him (#61)

/** One thing today is (packages/shared/src/calendar.ts): no dates and no keys, and never his age or birth year. */
export const CalendarEventView = z.object({
  kind: z.enum(CALENDAR_EVENT_KINDS),
  /** Years or months together (anniversary, monthiversary), days until her birthday (herBirthdaySoon). */
  count: z.number().int().min(0).optional(),
  season: z.enum(SEASON_IDS).optional()
});
/**
 * `GET /v1/calendar` (signed in): what today is with each of the five, most important first — her home shows the
 * first. Her birthday only once the agency confirmed it (#84; the test site shows all). Private to him (his birthday
 * is in it): never cached.
 */
export const CalendarRes = z.object({
  talents: z.array(z.object({ star: zStarId, events: z.array(CalendarEventView) }))
});
/**
 * `POST /v1/calendar/demo`, demo mode only (the test site; 404 in production): for the next two hours his calendar,
 * her greeting and the prompt read `day` as today (null = back to the real day), and her messages for that day are
 * put in his inbox at once, so a birthday or an anniversary can be tried on any date.
 */
export const CalendarDemoReq = z.object({ day: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable() });
export const CalendarDemoRes = CalendarRes.extend({ day: z.string().nullable(), sent: z.number().int().min(0) });

export type CalendarEventViewT = z.infer<typeof CalendarEventView>;
export type CalendarResT = z.infer<typeof CalendarRes>;
export type CalendarDemoResT = z.infer<typeof CalendarDemoRes>;

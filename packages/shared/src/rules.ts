/**
 * Business rules (v1.0 + the v1.1 baseline). Every number here is written down in docs/requirements.md;
 * change both together. Values marked 待确认 there are placeholders until the business side decides.
 */
import { TTS_MAX_CHARS } from './voice';
export const RULES = {
  /** Visitor trial: messages per device, never reset. */
  trialMessages: 3,
  /** One text/picture chat turn costs one credit. */
  textMessageCostPoints: 1,
  /** Video calls are billed per started minute. */
  videoMinuteCostPoints: 60,
  /** Every successfully redeemed code grants this many chat credits. */
  serialPoints: 100,
  /** Legacy allowance fields remain readable for old accounts, but no longer price chat. */
  dailyFreeMessages: 0,
  /** Monthly pass: unlimited in the UI, capped server-side against scripted abuse. */
  passFairUseMessages: 300,
  passDays: 30,
  passPriceYen: 980,
  passDailyPoints: 0,
  xpPerMessage: 8,
  xpPerLevel: 40,
  memoryCardEvery: 3,
  awakenCopies: 3,
  signupFreePulls: 0,
  pullCost: 100,
  tenPullCost: 1000,
  /** Star Genesis tier rates, shared by paid draws and printed codes (docs/catalog-spec.md). */
  rates: { N: 0.55, R: 0.28, SR: 0.12, SSR: 0.045, UR: 0.005 },
  /** SSR or better is guaranteed by this pull; the counter is visible and carries across pools. */
  pityPulls: 80,
  /** A duplicate card turns into this many Star Shards; higher rarity always yields more. */
  duplicateShards: { N: 1, R: 3, SR: 8, SSR: 25, UR: 80 },
  /** Star Shards required to choose a card of each rarity from the exchange. */
  exchangeShards: { N: 15, R: 45, SR: 120, SSR: 360, UR: 1000 },
  /** Compatibility value exposed by the rates endpoint: the SSR exchange cost. */
  shardsForExchange: 360,
  /** Shows the configurable credit top-up demo; no real payment is processed yet. */
  shopOpen: true,
  /** Minimum age, checked against the birthday asked once after sign-up. */
  minAge: 18,
  /** M7: days an address closed under minAge may not sign up again (only a keyed hash of it is kept). */
  underageCooldownDays: 30,
  dailyLoginPoints: 0,
  /** Chat credits are obtained from redemption codes or top-up, not account creation. */
  welcomePoints: 0,
  /** Monthly check-in rewards by number of login days in the JST month. */
  checkIn: [
    { day: 7, freePulls: 0, points: 0 },
    { day: 14, freePulls: 0, points: 0 },
    { day: 21, freePulls: 0, points: 0 },
    { day: 28, freePulls: 0, points: 0 }
  ],
  pointPacks: [
    { points: 1000, usd: 9.99 }
  ],
  pointExpiryDays: 180,
  serialDefaultTrialDays: 7,
  /**
   * Lucky cards (tools/luckcards/config/pool.S1.json): one printed code = six draws plus the pass days above;
   * the first draw is SR or better, at the same tier rates as paid draws. A duplicate adds a copy and bond XP.
   */
  lucky: {
    drawsPerCode: 6,
    tierRates: { N: 0.55, R: 0.28, SR: 0.12, SSR: 0.045, UR: 0.005 },
    duplicateBondXp: 20
  },
  serialMaxFailures: 5,
  serialLockMs: 10 * 60 * 1000
} as const;

/**
 * Scene engine (#64, docs/requirements.md §13.1). A run never outlives maxRunMs; when he stops answering the stage
 * falls back to her idle loop, then she asks whether he is still there, then the run ends without any penalty.
 * Rewards (affinity, memory card, promise) are paid for one run per scene per JST day, so replaying is free but
 * cannot be farmed for free pulls.
 */
export const SCENE_RULES = {
  maxRunMs: 30 * 60 * 1000,
  idleLoopMs: 30 * 1000,
  idlePromptMs: 60 * 1000,
  idleEndMs: 5 * 60 * 1000,
  rewardedRunsPerDay: 1,
  /** A timeout answer is accepted this much before the countdown ends (clock skew, rendering). */
  timeoutGraceMs: 2000,
  /**
   * M4 (D-scenes 47b0fcb: her model-written replies ran 5–7 subtitle lines): the longest reply the model writes inside
   * a scene — free talk and her ōgiri remark — so it fits 3 subtitle lines at the player's ~23em width: about 23
   * full-width characters a line for Japanese and Chinese, fewer Hangul with the spaces between words, and about 46
   * Latin letters a line for English, each with a little room. Cut at a sentence end (`fitSceneReply`).
   */
  replyMaxChars: { ja: 60, 'zh-Hant': 60, en: 140, ko: 66 }
} as const;

/**
 * Voice minutes (#74, docs/requirements.md §13.6). ALL 待确认 (#84): the minutes, the price and the cap are placeholders
 * until the owner decides; change only the numbers here. v1.1 charges no money (#47): an extension costs points.
 *
 * What counts as voice time: her runtime voice (#73, the seconds synthesized for him) and his voice input inside a
 * scene (#72, from the moment he starts talking until he stops). Her pre-recorded lines (`voice` on a line step) cost
 * nothing to play and do not count. Seconds are summed per JST day and reset at 0:00 JST. When they run out nothing
 * stops: the scene goes on in subtitles, and the mic gives way to the text box, until tomorrow or an extension.
 */
export const VOICE_RULES = {
  /** 待确认: voice minutes per JST day for every signed-in user. */
  freeMinutesPerDay: 10,
  /** 待确认: voice minutes per JST day while the monthly pass is active (instead of the free minutes). */
  passMinutesPerDay: 60,
  /** 待确认: one extension adds this many minutes, for today only (also アリス's date, DATE_RULES.extendMinutes). */
  extendMinutes: 30,
  /** 待确认: points per extension (no real money in v1.1). */
  extendCostPoints: 150,
  /** 待确认: extensions per user per JST day. */
  extendsPerDay: 3,
  /** She mentions it, in her own words, when this many minutes are left (once per day). */
  lowMinutes: 5,
  /**
   * Who hears her runtime voice (#73): every signed-in member (owner, 2026-10-02), now that /v1/tts only speaks lines
   * the server itself gave her (a signed reply or scene line, never his text). Nobody while no TTS vendor is configured.
   */
  ttsRoles: ['user', 'admin', 'moderator'] as readonly string[],
  /** Longest text one TTS request may carry (one or two sentences: the web app sends her line sentence by sentence). */
  ttsMaxChars: TTS_MAX_CHARS
} as const;

/**
 * A date with a countdown at the top of the scene (#69 アリス's greenhouse; the date's length and its paid extension
 * come from #74). 待确认 (#84): the minutes are placeholders until the owner decides them with #74. A run with a
 * date lasts as long as the date (plus her plea when it runs out), not SCENE_RULES.maxRunMs, within `maxRunMs` here.
 */
export const DATE_RULES = {
  /** 待确认: the date's length (#69: 演示默认 40 分钟) — night-greenhouse.json's `clock` timer. */
  minutes: 40,
  /**
   * One extension (#69 「延长 30 分钟」) — the `extend` option's timer. It is the voice extension of #74: the option is
   * marked `pay: "extend"`, costs VOICE_RULES.extendCostPoints once, and adds the same minutes to his voice time.
   */
  extendMinutes: VOICE_RULES.extendMinutes,
  /** Longest countdown one script effect may set (the script schema's cap). */
  maxTimerSeconds: 60 * 60,
  /** After the countdown runs out the run stays open this long, for her plea and his answer. */
  afterTimerMs: 5 * 60 * 1000,
  /** However it is extended, a run with a date ends by then. */
  maxRunMs: 2 * 60 * 60 * 1000
} as const;

/**
 * The five scenes' mini-games (#66–#70; packages/shared/src/scenes/minigames.ts). 待确认 (#84): every number is a
 * placeholder until the owner decides. Rock-paper-scissors has no numbers: her hand is uniformly random, on the server.
 */
export const MINIGAME_RULES = {
  /** #70 大喜利: the judge scores 1–`ogiriScale` (the script's `config.scale` wins). */
  ogiriScale: 10,
  /** 待确认 #70: affinity + score × 0.7, rounded, for every answer she scores. */
  ogiriAffinityPerPoint: 0.7,
  /**
   * #70: the score when the judge cannot answer (down, slow, malformed): the middle of the scale, below any pass line,
   * so a failure never hands out the reward — she just says "so close" and asks for a rematch tomorrow.
   */
  ogiriFallbackShare: 0.5,
  /** #67 夸奖分级: affinity per tier when the script names none (`config.scores`). */
  praiseScores: { generic: 1, specific: 18 },
  /** #68: the longest part of his comment she reads back; the rest is cut with an ellipsis. */
  danmakuQuoteChars: 40
} as const;

/**
 * How scenes begin (#65, docs/requirements.md §13.2). 待确认: every number is a placeholder until the owner decides.
 * The plan aims for 40% of scene starts on his request, 30% proposed by her and 30% from time and events
 * (TRIGGER_SOURCE_TARGET); these limits keep her proposals a pleasant surprise rather than a nag.
 */
export const TRIGGER_RULES = {
  /** Chance she proposes a scene when he enters her room (or has sat there quietly for idleProposeMs). */
  proposeRate: 0.3,
  /** Her proposals per user per JST day, all talents together. */
  maxProposalsPerDay: 5,
  /** Minimum time between two proposals: leaving and re-entering the room does not re-roll at once. */
  minProposalGapMs: 60_000,
  /** After he says "not now" to a scene, it is not proposed or offered again for this long. */
  declineCooldownMs: 6 * 3_600_000,
  /** Time and event offers per user per JST day (each scene at most once a day). */
  maxTimeOffersPerDay: 3,
  /** An offer he does not answer lapses: accepting it later still starts the scene, counted as his request. */
  offerTtlMs: 10 * 60_000,
  /** Quiet time on the companion home before she gets one more chance to propose (once per visit). */
  idleProposeMs: 90_000,
  /**
   * M2 (D-scenes 47b0fcb): after any scene run ends she offers nothing — no moment, no proposal, not in chat — for this
   * long. 20 minutes: the end card, his reply to her afterwards and a re-entry or an idle re-roll (idleProposeMs) all
   * fall inside it, so a scene is never chased by another; an evening visit still has room for a second one later.
   * A message of hers he opens that names a scene is his own asking, and is not held back.
   */
  afterSceneCooldownMs: 20 * 60_000,
  /**
   * M2: after goodnight (or her whisper) played to its end, she offers nothing more that night: not until this hour on
   * his clock (users.tz, JST when unknown) — the hour goodnight closes (SYSTEM_SCENE_RULES.goodnightHours.to) and his
   * morning begins.
   */
  afterGoodnightUntilHour: 5
} as const;

/**
 * The system scenes (#71, packages/shared/src/scenes/system.ts): moments every talent shares — goodnight, the
 * weather events, the two birthdays, a promise kept. 待确认 (#84): every number is a placeholder.
 */
export const SYSTEM_SCENE_RULES = {
  /** Goodnight is offered from `from` until `to` o'clock on his own clock (users.tz, JST when unknown). */
  goodnightHours: { from: 22, to: 5 },
  /** Her weather message (#63) opens its scene for this long after it reached him. */
  weatherSceneMs: 24 * 3_600_000,
  /** Affinity for each moment (never negative: leaving early costs nothing). */
  affinity: { goodnight: 2, whisper: 3, weather: 3, birthday: 10, promiseKept: 5 }
} as const;

/**
 * Variant cards (#75, docs/requirements.md §14.1). 待确认 (#84): every number here is a placeholder until the owner
 * decides; changing one changes the model, never a draw (variants are drawn exactly like the other cards of their tier).
 */
export const VARIANT_RULES = {
  /**
   * Variant XP at which each level 1–10 starts. Levels 1 / 3 / 6 / 10 = 0 / 100 / 400 / 1000 come from #75; the
   * levels between are straight-line fills.
   */
  levelXp: [0, 50, 100, 200, 300, 400, 550, 700, 850, 1000],
  /** Levels that open a layer of her variant scenes (#76): the entrance, then three more. */
  layerLevels: [1, 3, 6, 10],
  /** 心意 (kokoro) per duplicate of a variant card; each point of 心意 is also a point of her variant XP. */
  kokoroPerDuplicate: 100,
  /** Variant XP from playing (#76, #77): a variant scene's end (scripts grant it), each message while she wears it, gifts. */
  sceneEndXp: 30,
  chatXp: 8,
  giftMultiplier: { min: 1, max: 3 },
  /**
   * Share of variant XP that also counts for her main relationship XP (affinity). It only ever adds XP, like a chat
   * message: the stage machine (#54) still needs its minimum days, so a variant can speed a stage up, never skip one.
   */
  mainLinkRatio: 0.5,
  /** Variant cards remain available in the same rarity-priced Star Shard exchange as the full catalogue. */
  exchangeable: true,
  /**
   * The draw-night invite (#76): the night she asks him to come and see her new outfit. A night runs in JST from
   * `fromHour` until `nightEndsHour` the next morning; a variant first owned since that day's `nightEndsHour` is
   * invited on it (at `fromHour`, or at once when it came in the evening). Once per card, never the next night.
   */
  invite: { fromHour: 18, nightEndsHour: 5 },
  /**
   * Her home (#76): among the looks her room rotates (bond.ts), an owned variant weighs 1 at level 1 and
   * `homeWeightPerLevel` more per level above it (level 10 = 3.25×); from `homePinLevel` he may pin it.
   */
  homeWeightPerLevel: 0.25,
  homePinLevel: 10
} as const;

/**
 * Which cards are variants: one per talent (#47). PROVISIONAL — the owner picks the five (#84). Until then each
 * talent's only UR (the catalogue has exactly one per talent, see catalogProblems), which also matches the plan's
 * example for eimi (the rose satin gown). Anything a user sees of variants must work with any selection, including none.
 * This list is the only place the pick lives: the variant scenes (scenes/variantScenes.ts) name no card, they take
 * their talent's from here, so the owner's final pick is a one-line change.
 */
export const VARIANT_CARDS: readonly string[] = ['s1-mahiro-30', 's1-nana-30', 's1-unpai-30', 's1-alice-30', 's1-eimi-29'];

/**
 * Pickup pools (#78, docs/requirements.md §14.2). A Pickup is her own pool (`star:<id>`, her 30 cards) for a time the
 * admin sets, in which her variant card takes `share` of every SSR-or-better draw. The chance of SSR or better, the
 * lower tiers and the pity stay exactly as in her regular pool; only who is drawn inside the top band changes. Every
 * rate is published on the pool itself and on 提供割合 (docs/compliance-jp.md §3.1), and the regular pools never change.
 *
 * 待确认 (#84): every number here is the owner's to decide. The share is copied into a Pickup when the admin creates
 * it, so a later change here never alters a Pickup already announced, nor the replay of a draw made in one.
 */
export const PICKUP_RULES = {
  /** Pickup ratio 待确认: the variant card's share of SSR-or-better draws in its Pickup (#78: 50%). */
  share: 0.5,
  /** Longest window one Pickup may run (an announced period, never an open-ended "limited" pool). */
  maxDays: 31,
  /**
   * She brings up her variant on her own (#78) — a line in her voice, never a pop-up or a countdown. All 待确认.
   * Only while a Pickup of it is live and he does not have the card, never while he is upset, tired or curt, and
   * only with reviewed lines (drafts on the test site only, #82).
   */
  invite: {
    /** Chance on a turn where she may bring it up. */
    rate: 0.2,
    /** At least this long since he was last shown a Pickup in her chat (his asking included). */
    gapMs: 3 * 86_400_000,
    /** Times she brings up one Pickup on her own, per user, over its whole window. */
    perPickup: 2
  }
} as const;

/**
 * Relationship stages (#54, docs/requirements.md §10.1). ALL 待确认 — the owner decides the numbers (#84); change only
 * the values here. A stage is left for the next one when he has spent at least `minDays` days together with her in
 * it (JST days with a message or a scene) AND her affinity XP (cumulative, the same `affinity.xp` as before) has
 * reached `xp`. XP alone never skips the days: at the minimums the confession is ready on the 7th day together
 * (2 + 2 + 3). After the confession (#55), every `loverXpPerLevel` XP is a lover level, up to `loverMaxLevel`;
 * v1.1 writes content for levels 1–`loverContentLevel` only, higher levels just show the number.
 * One free pull is paid per stage entered (familiar, ambiguous, lover) and per lover level after the first — at
 * most 12 per talent, instead of one per 40 XP without end.
 */
export const STAGE_RULES = {
  stages: {
    new: { minDays: 2, xp: 80 },
    familiar: { minDays: 2, xp: 200 },
    ambiguous: { minDays: 3, xp: 400 }
  },
  loverXpPerLevel: 300,
  loverMaxLevel: 10,
  loverContentLevel: 3,
  /** Card detail: story episode 2 opens at this stage (it was affinity Lv.3, the same 80 XP). */
  storyTwoStage: 'familiar'
} as const;

/**
 * Promises (#59, docs/requirements.md §11.4). She keeps a promise when he comes within `windowMs` either side of its
 * time; past the window it is missed, and she brings it up once, gently. One open promise per talent at a time.
 */
export const PROMISE_RULES = {
  windowMs: 3 * 3600 * 1000,
  /** A promise the model heard in chat must fall this far ahead, at least and at most (a wrong year is not a promise). */
  chatMinAheadMs: 10 * 60 * 1000,
  chatMaxAheadMs: 14 * 86_400_000,
  /** After this long without a message in her chat, she brings up the next time (web). */
  idleProposeMs: 10 * 60 * 1000,
  /** Longest promise text kept: it is shown on the home card and quoted back to him. */
  textMax: 60,
  /**
   * Her wake-up keeps her wake-up promise (#57, #66: 「明日の朝、起こしてあげる」) when it is due within this long of
   * the morning she wakes him — the alarm is his, set to his own morning, which a script's "+12h" only approximates.
   */
  wakeKeepMs: 18 * 3600 * 1000
} as const;

/**
 * Her confession (#55, docs/requirements.md §10.2). All 待确认 (#84): the days she waits after "not yet" or "no",
 * how many times she asks on her own before leaving it to him (the relationship panel then offers it), and the
 * largest recording kept as the memory of his answer (docs/compliance-jp.md §7.3).
 */
export const CONFESSION_RULES = {
  /** Days together after an answer that was not yes before she asks again; the same day never counts. */
  retryDays: 2,
  /** Answers that were not yes before she stops asking herself (the stage stays; he can bring it up). */
  maxAsks: 3,
  /** She confesses from 17:00 JST (evening and night); in daytime she only hints. */
  slots: ['evening', 'night'],
  /** The kept recording of his answer: 30 s of Opus is ~120 KB, AAC on iOS ~500 KB. */
  voiceMaxBytes: 768 * 1024,
  /** Affinity for the moment itself (accept only), on top of becoming lovers. */
  acceptAffinity: 20
} as const;

/**
 * Her messages (#58, docs/requirements.md §11.3): she writes to him on her own — an everyday note in the day, tonight's
 * invitation in the late afternoon, and, the morning after an evening together, that she dreamed of him.
 * 待确认 (#84): `perDay` (herMessagesPerDay) and `dailyCap` (herMessagesDailyCap) are the owner's to decide; every
 * number here is a placeholder. Hours are his local clock (users.tz, JST when unknown).
 */
export const HER_MESSAGE_RULES = {
  /** herMessagesPerDay 待确认: most messages one user gets in one of his days; 「少なめ」 in his settings is `lessPerDay`. */
  perDay: 2,
  lessPerDay: 1,
  /**
   * herMessagesDailyCap 待确认: messages written per JST day across all users — the bound on what the model costs a
   * day. Once it is reached, only monthly-pass holders still get theirs that day.
   */
  dailyCap: 10_000,
  /** Only users who talked with her (a message or a scene) within this many JST days; after that she stops writing. */
  activeDays: 7,
  /** His night: nothing is sent in [from, to) of his local hours, whatever the windows say. */
  quietHours: { from: 22, to: 7 },
  /** His local hours [from, to) in which each kind goes out, each user at a time of his own inside the window. */
  windows: { dream: [7, 11], note: [11, 16], invite: [16, 20] },
  /** "Last night" for the dream: from `from` o'clock the day before to `to` o'clock on the day, his local time. */
  lastNight: { from: 18, to: 5 },
  /** The strict length her message must fit (it is also the push on his lock screen), in characters. */
  maxChars: { ja: 70, 'zh-Hant': 60, en: 160, ko: 80 }
} as const;

/**
 * Gifts (#77, docs/requirements.md §14.3). ALL 待确认 (#84): prices, the daily cap and the XP are placeholders until the
 * owner decides; change only the numbers here. A gift costs points (bought or earned, docs/compliance-jp.md §4) and
 * is a fixed digital item: nothing random, nothing physical, nothing that can be cashed out or passed on.
 */
export const GIFT_RULES = {
  /** Points per gift (plan: 50–300 pt). The five everyday gifts first, then the fifteen from the talents' tastes. */
  prices: {
    bouquet: 100, macarons: 80, candle: 120, teddy: 150, alarm: 50,
    melonpan: 50, cocoa: 80, 'cat-plush': 200,
    yakiniku: 200, 'karaoke-mic': 150, 'fes-towel': 100,
    'new-game': 300, 'konbini-sweets': 50, blanket: 150,
    'tea-leaves': 120, paperback: 100, 'letter-set': 80,
    lipstick: 200, 'travel-guide': 100, 'night-view': 300
  },
  /** Gifts per user per JST day, all talents together (plan: `giftsPerDay: 5`). */
  perDay: 5,
  /** Her affinity XP per point spent, before her taste (100 pt = 20 XP; a chat message is RULES.xpPerMessage). */
  xpPerPoint: 0.2,
  /**
   * Her taste multiplies the XP (#77 acceptance: what she likes counts double). Like every XP, it moves her stage
   * only within the stage machine's minimum days (#54): a gift can speed a stage up, never skip one.
   */
  taste: { liked: 2, plain: 1, disliked: 0.5 },
  /**
   * While she wears a variant card (#75, `cardId`), the gift's XP also counts for that variant, times this — within
   * VARIANT_RULES.giftMultiplier. `wished`: a liked gift she had mentioned to him in conversation.
   */
  variantMultiplier: { disliked: 1, plain: 1, liked: 2, wished: 3 },
  /**
   * Her tastes come up in everyday conversation: on his `hintAtTurn`-th message with her and every `hintEveryTurns`
   * after it, the persona may mention one thing she has been wanting (at most once per 20 turns, #77).
   */
  hintEveryTurns: 20,
  hintAtTurn: 5
} as const;

/**
 * What she calls him, and how she changes for him (#56, docs/requirements.md §10.3). 待确认 (#84): the owner decides the
 * numbers. A look he has praised `praisedAt` times or more counts `praisedWeight` times as much when her room picks
 * which of her looks to show (a look is only ever picked among clips that exist).
 */
export const BOND_RULES = {
  praisedAt: 3,
  praisedWeight: 2,
  /** Praise counted per look is capped: the weight only needs to know "often". */
  praiseMax: 999,
  /** The name he asks her to use (My page), in characters. */
  nameMax: 20
} as const;

const JST_OFFSET_MS = 9 * 3600 * 1000;

/** The JST calendar day ("2026-09-24") a moment falls on; the daily chat allowance resets at 0:00 JST. */
export function jstDay(at: number | Date = Date.now()): string {
  const ms = typeof at === 'number' ? at : at.getTime();
  return new Date(ms + JST_OFFSET_MS).toISOString().slice(0, 10);
}

/** A JST day `n` days later (or earlier, negative) — calendar arithmetic on "YYYY-MM-DD", no time zone involved. */
export function addDays(day: string, n: number): string {
  return new Date(Date.parse(`${day}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
}

/** The Monday of the week a JST day falls in; the metrics' weeks start on Monday, as SQLite's `weekday` math does in sql.ts. */
export function weekStart(day: string): string {
  return addDays(day, -((new Date(`${day}T00:00:00Z`).getUTCDay() + 6) % 7));
}

/** Month/day in JST, for display ("10/1"). */
export function jstMonthDay(iso: string): string {
  const d = new Date(new Date(iso).getTime() + JST_OFFSET_MS);
  return `${d.getUTCMonth() + 1}/${d.getUTCDate()}`;
}

export function passActive(passUntil: string | null | undefined, now = Date.now()): boolean {
  return !!passUntil && new Date(passUntil).getTime() > now;
}

/** Extends a pass by `days` from whichever is later: now or the current expiry. */
export function extendPass(passUntil: string | null | undefined, days: number, now = Date.now()): string {
  const base = Math.max(now, passUntil ? new Date(passUntil).getTime() : 0);
  return new Date(base + days * 86_400_000).toISOString();
}

/** Messages left today; null means unlimited (monthly pass). */
export function chatLeft(usedToday: number, passUntil: string | null | undefined, now = Date.now()): number | null {
  return passActive(passUntil, now) ? null : Math.max(0, RULES.dailyFreeMessages - usedToday);
}

/** His voice time on one JST day (#74): seconds used, and extensions bought that day. */
export interface VoiceDay { day: string; usedSeconds: number; extensions: number }

/** Voice seconds a day holds: the free or pass minutes, plus every extension bought that day. */
export function voiceAllowance(passUntil: string | null | undefined, extensions: number, now = Date.now()): number {
  const minutes = passActive(passUntil, now) ? VOICE_RULES.passMinutesPerDay : VOICE_RULES.freeMinutesPerDay;
  return (minutes + Math.max(0, extensions) * VOICE_RULES.extendMinutes) * 60;
}

/** Voice seconds left today (never negative). A ledger day other than today's JST day counts as a fresh day. */
export function voiceLeft(v: VoiceDay | null | undefined, passUntil: string | null | undefined, now = Date.now()): number {
  const today = v && v.day === jstDay(now) ? v : { usedSeconds: 0, extensions: 0 };
  return Math.max(0, voiceAllowance(passUntil, today.extensions, now) - today.usedSeconds);
}

/** Full years between a `YYYY-MM-DD` birthday and a JST day; null when the date is not a real calendar date. */
export function ageOn(birthday: string, day: string = jstDay()): number | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(birthday);
  if (!m) return null;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const date = new Date(Date.UTC(y, mo - 1, d));
  if (y < 1900 || date.getUTCMonth() !== mo - 1 || date.getUTCDate() !== d) return null;
  const [ty, tm, td] = day.split('-').map(Number);
  const age = ty - y - (tm < mo || (tm === mo && td < d) ? 1 : 0);
  return age < 0 ? null : age;
}

/**
 * Who may use what (#47: v1.1 charges nothing). Each v1.1 perk names its gate here, so moving one into the monthly
 * pass later is one line. `free` = every signed-in user; `pass` = only while the monthly pass is active.
 */
export const ACCESS: Record<'wakeup' | 'nightWhisper', 'free' | 'pass'> = {
  /** Her wake-up call (#57): planned as a monthly-pass perk, open to everyone in v1.1. */
  wakeup: 'free',
  /**
   * Her goodnight whisper at his ear (#71): a monthly-pass perk (in v1.1 the pass comes only from lucky codes);
   * everyone else gets her plain goodnight.
   */
  nightWhisper: 'pass'
};

/** Whether a perk is open to a user whose pass runs until `passUntil`. */
export const accessOpen = (perk: keyof typeof ACCESS, passUntil: string | null | undefined, now = Date.now()): boolean =>
  ACCESS[perk] === 'free' || passActive(passUntil, now);

/**
 * The wake-up alarm (#57, docs/requirements.md §11.2). One alarm per user, rung by the 5-minute tick in the
 * user's own clock (./alarm.ts), at most once per local day.
 */
export const WAKEUP_RULES = {
  /** 「あと5分」: she calls again this many minutes later… */
  snoozeMinutes: 5,
  /** …at most this many times per morning. */
  maxSnoozes: 1,
  /**
   * A tick later than this after the set time (the service was down, a cron fire was skipped) no longer rings: a
   * wake-up at 10:00 for 07:30 is worse than none. Several ticks wide, so one missed tick never loses a morning.
   */
  ringWindowMs: 30 * 60_000,
  /** The push service drops an undelivered wake-up after this long: a phone offline all morning gets none. */
  pushTtlSeconds: 30 * 60,
  /** Before this hour of his clock, opening her room plays the morning's unopened wake-up (for users without push). */
  sceneUntilHour: 11,
  /** A user who never told us their zone wakes by the business calendar. */
  defaultTz: 'Asia/Tokyo'
} as const;

/**
 * Her year with him (#61, docs/requirements.md §11.5): birthdays, the seasons and their anniversaries (./calendar.ts).
 * 待确认 (#84): every number is a placeholder. Hours are his local clock (users.tz, JST when unknown); her-messages'
 * quiet hours (HER_MESSAGE_RULES.quietHours) apply too, and his her-messages setting decides how many she sends.
 */
export const CALENDAR_RULES = {
  /** She mentions her birthday this many days ahead — in conversation only, never as a message. */
  soonDays: 3,
  /**
   * Only users who spent a day with her (a message or a scene) within this many JST days get her message for the day.
   * Wider than her everyday messages (#58): a birthday is a good reason for a lapsed user to come back.
   */
  activeDays: 30,
  /** His local hours [from, to) in which her message for the day goes out. */
  hours: [9, 21],
  /** Her messages for the day one user gets, all talents together; 「少なめ」 in his her-messages setting is `lessPerDay`. */
  perDay: 2,
  lessPerDay: 1
} as const;

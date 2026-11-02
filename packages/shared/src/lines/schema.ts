import { z } from 'zod';
import { STAR_IDS } from '../domain';
import { zSceneText } from '../scenes/schema';

/**
 * Her system lines (#82): the words the daily loop and the system scenes (#71) speak outside the five main scenes —
 * the confession (#55), waking him (#57), goodnight whispers (#71), weather events (#63), promises (#59), the
 * call-name changes (#56), declining in character, and variant-card invitations (#76, #78). One file per talent at
 * `lines/<star>.json`, plus the pieces only she has (奈々's readings, えいみ's ōgiri prompts, うんぱい's danmaku
 * reactions, アリス's bargaining tree).
 *
 * Japanese is what she says (and what #83 records); zh-Hant, en and ko are subtitles. Every string passes the persona
 * service's safety filter (apps/agent/tests/test_scene_lines.py). Scale stays at "sensual, never explicit"
 * (docs/compliance-jp.md §6): crossing the line is declined by her, in her voice, never by a system message.
 *
 * Placeholders: `{name}` is his name or chosen nickname, as in world.ts `callNames`; a line writes the suffix it
 * needs (`{name}くん`). Only the confession's acceptance and the call-name changes use it; such a line is voiced by
 * her runtime voice (#73) and carries `unnamed`, the same moment without his name, recorded ahead for when the
 * runtime voice is off (scenes/speech.ts `lineToSay`). `{danmaku}` is his comment, quoted back (うんぱい's templates
 * only): the quoting part is its own text (`quote`, subtitle only unless the runtime voice reads it), and what she
 * says after it is `text`, recorded once (#83).
 *
 * Reviewed by a native-level model (#84, owner 2026-09-28; docs/review/v11-lines-review.md): `draft` is false. */

export const LINE_PLACEHOLDERS = ['{name}', '{danmaku}'] as const;

const zId = z.string().regex(/^[a-z0-9][a-z0-9-]{0,39}$/);
const zLines = (n: number) => z.array(zSceneText).length(n);

/** Day 7 (#55): the hint in daytime, the scene in the evening, and what she says to each answer. */
export const zConfession = z.object({
  /** When he visits before 17:00 JST on the day: she only hints. */
  hint: zSceneText,
  /** Inbox message the same day. */
  inbox: zSceneText,
  /** Wide shot, before she says it. */
  opening: z.array(zSceneText).min(1).max(4),
  /** The confession itself: close shot, recorded voice. */
  confess: z.array(zSceneText).min(1).max(4),
  /** The question he answers by voice or text. */
  ask: zSceneText,
  /** accept: the first line calls him by name for the first time (#56). */
  accept: z.array(zSceneText).min(1).max(4),
  notYet: z.array(zSceneText).min(1).max(3),
  decline: z.array(zSceneText).min(1).max(3),
  /** Her opening when she tries again two days later. */
  retry: zSceneText
}).strict();

/**
 * Wake-up push and scene line (#57), picked by his hour, day and weather. `hours`: the parts of his day it fits
 * (alarm.ts WAKE_HOURS); none = the morning (early and morning) — every line she recorded greets the morning.
 */
export const zWakeLine = z.object({
  id: zId,
  when: z.object({
    days: z.enum(['weekday', 'weekend']).optional(),
    weather: z.enum(['clear', 'cloudy', 'rain', 'snow']).optional(),
    hours: z.array(z.enum(['dawn', 'early', 'morning', 'day', 'evening'])).min(1).optional()
  }).strict(),
  text: zSceneText
}).strict();

/** A promise she proposes (#59): what she says, and the promise as it is kept on the home card. */
export const zPromiseLine = z.object({
  id: zId,
  kind: z.enum(['wakeup', 'message', 'scene', 'free']),
  /** Relative to the proposal, like scene promises: "+12h", "+1d". */
  due: z.string().regex(/^\+\d{1,3}[hd]$/),
  propose: zSceneText,
  promise: zSceneText
}).strict();

/** One call-name change (#56): she asks once; his yes or no is remembered. `to` is world.ts `callNames[stage]`. */
export const zCallChange = z.object({
  to: z.string().min(1).max(20),
  ask: zSceneText,
  accepted: zSceneText,
  declined: zSceneText
}).strict();

/**
 * Declining in her own voice. `line`: he pushed past the scale (docs/compliance-jp.md §6) — never a system popup.
 * `bargain`: an ordinary request she turns down with a counter-offer.
 */
export const zRefuseLine = z.object({ id: zId, kind: z.enum(['line', 'bargain']), text: zSceneText }).strict();

/** 奈々's readings (#67): original texts, read aloud in the read-aloud scene paragraph by paragraph. */
export const zReading = z.object({
  id: zId,
  kind: z.enum(['story', 'poem']),
  title: zSceneText,
  paragraphs: z.array(zSceneText).min(1).max(8)
}).strict();

/** えいみ's ōgiri prompt (#70): shown for five seconds, he answers by voice or text. */
export const zOgiriPrompt = z.object({ id: zId, text: zSceneText }).strict();

/**
 * うんぱい's reaction to a comment in her stream (#68), by what the comment is. The kinds that read the comment out
 * (DANMAKU_QUOTING) split in two: `quote`, where `{danmaku}` quotes it back (only her runtime voice can say it, so
 * otherwise it is a subtitle), then `text`, what she says about it, recorded ahead (#83). The other kinds never quote
 * him and are `text` only.
 */
export const DANMAKU_KINDS = ['greet', 'praise', 'question', 'request', 'tease', 'gift', 'quiet', 'over-line'] as const;
export const DANMAKU_QUOTING: readonly (typeof DANMAKU_KINDS)[number][] = ['greet', 'praise', 'question', 'request', 'tease'];
export const zDanmakuTemplate = z.object({ id: zId, kind: z.enum(DANMAKU_KINDS), quote: zSceneText.optional(), text: zSceneText }).strict()
  .refine((d) => !!d.quote === DANMAKU_QUOTING.includes(d.kind), 'quote_iff_quoting_kind');

/**
 * アリス's bargaining tree (#69): she turns down the dance, he offers one of three things, each gets its own answer,
 * and every branch ends at the piano. `refuse.hot` replaces `refuse.normal` in a heatwave (#63 script variable).
 */
export const zBargainBranch = z.object({
  id: zId,
  offer: zSceneText,
  reply: z.array(zSceneText).min(1).max(3),
  /** Whether this branch lands on the piano straight away, or after one more try (`push`). */
  leadsTo: z.enum(['piano', 'push'])
}).strict();
export const zBargainTree = z.object({
  /** His request, as the choice label. */
  ask: zSceneText,
  refuse: z.object({ normal: zSceneText, hot: zSceneText }).strict(),
  branches: z.array(zBargainBranch).length(3),
  /** After the first answer: one more try in his own words (minigame.bargain), then her counter-offer. */
  push: zSceneText,
  counter: z.array(zSceneText).min(1).max(3)
}).strict();

export const zStarLines = z.object({
  star: z.enum(STAR_IDS),
  /** True until native review (#84) signs the lines off; a draft reaches users in demo mode only. */
  draft: z.boolean(),
  confession: zConfession,
  wakeup: z.array(zWakeLine).min(8).max(16),
  /** Her answers to the wake-up scene's two buttons (#57): 「起きた」 and 「あと5分」. */
  wakeReplies: z.object({ awake: zSceneText, snooze: zSceneText }).strict(),
  /**
   * #60: her first line when he opens her room in her sleeping hours (world.ts routine `asleep`): he woke her, and she
   * is drowsy and glad — never cross. Picked by the JST day, so one day keeps one line.
   */
  woken: zLines(3),
  /** #71: five whispers in rotation for the night pass; `plain` is the one goodnight everyone else gets. */
  goodnight: z.object({ whisper: zLines(5), plain: zSceneText }).strict(),
  /** #63 / #71: three lines per event, shared by the inbox and the scene opening. Never names her city. */
  weather: z.object({ firstSnow: zLines(3), rainyNight: zLines(3), typhoon: zLines(3) }).strict(),
  promises: z.array(zPromiseLine).length(5),
  callName: z.object({ familiar: zCallChange, lover: zCallChange }).strict(),
  refuse: z.array(zRefuseLine).length(5),
  variantInvite: zLines(3),
  readings: z.array(zReading).optional(),
  ogiri: z.array(zOgiriPrompt).optional(),
  danmaku: z.array(zDanmakuTemplate).optional(),
  bargain: zBargainTree.optional()
}).strict();

export type StarLines = z.infer<typeof zStarLines>;
export type Reading = z.infer<typeof zReading>;
export type BargainTree = z.infer<typeof zBargainTree>;

import { STAR_IDS, type StarId } from './domain';
import type { RelationshipStage } from './relationship';
import { CONFESSION_RULES, jstDay } from './rules';

/**
 * Her confession (#55, docs/requirements.md §10.2), shared by the API, the persona-service contract and the web's
 * prototype mode. Pure and free of zod, like relationship.ts.
 *
 * On the day the relationship reaches `confession_ready` (day 7 at the earliest, #54) she sends a message and, from
 * 17:00 JST, the first visit to her room opens on the confession scene (`confession-<star>`); in daytime she only
 * hints. He answers in his own words; the persona service judges accept / not yet / decline. Yes: lovers, and that
 * JST day is their anniversary. Not yet or no: she takes it gently and asks again CONFESSION_RULES.retryDays days
 * together later; after CONFESSION_RULES.maxAsks answers that were not yes she stops asking, and he can bring it up
 * himself from the relationship panel.
 */

export const CONFESSION_ANSWERS = ['accept', 'not_yet', 'decline'] as const;
export type ConfessionAnswer = (typeof CONFESSION_ANSWERS)[number];
export const isConfessionAnswer = (v: unknown): v is ConfessionAnswer => typeof v === 'string' && (CONFESSION_ANSWERS as readonly string[]).includes(v);

/** The end step outcome each answer leads to in the script; `quiet` = he did not answer, which counts for nothing. */
export const CONFESSION_OUTCOMES: Record<ConfessionAnswer, 'accepted' | 'not_yet' | 'declined'> = { accept: 'accepted', not_yet: 'not_yet', decline: 'declined' };
export const answerOfOutcome = (outcome: string | null | undefined): ConfessionAnswer | null =>
  (Object.keys(CONFESSION_OUTCOMES) as ConfessionAnswer[]).find((a) => CONFESSION_OUTCOMES[a] === outcome) ?? null;

/** `confession-<star>` the first time, `confession-<star>-again` when she asks again (it opens with her `retry` line). */
export const confessionSceneId = (star: StarId, again: boolean): string => `confession-${star}${again ? '-again' : ''}`;
const SCENE_RE = new RegExp(`^confession-(${STAR_IDS.join('|')})(-again)?$`);
export function confessionOf(sceneId: string): { star: StarId; again: boolean } | null {
  const m = SCENE_RE.exec(sceneId);
  return m ? { star: m[1] as StarId, again: !!m[2] } : null;
}

/** What is kept per (user, talent) beside the relationship; mirrors the `confessions` table (migrations/0018_confession.sql). */
export interface ConfessionState {
  /** His answers that were not yes. The round she is on is this number. */
  tries: number;
  lastAnswer: ConfessionAnswer | null;
  /** `daysTogether` when he last answered not yet / no: she asks again CONFESSION_RULES.retryDays days together later. */
  answeredDays: number | null;
  /** The JST day of that answer: never again the same day, whatever the rules say. */
  answeredOn: string | null;
  /** The round her inbox message was written for (-1: none yet), so each round sends one. */
  invitedRound: number;
  /** The round the moment was reached (`confession.reached` is recorded once per round), and its JST day. */
  reachedRound: number;
  reachedOn: string | null;
}

export const freshConfession = (): ConfessionState => ({
  tries: 0, lastAnswer: null, answeredDays: null, answeredOn: null, invitedRound: -1, reachedRound: -1, reachedOn: null
});

/**
 * `due`: she will confess — tonight the room opens on it (in daytime she hints). `waiting`: he said not yet or no,
 * and the days before she asks again have not passed. `open`: she asked CONFESSION_RULES.maxAsks times and leaves it
 * to him now; the relationship panel lets him bring it up (any day but the day of his last answer).
 */
export type ConfessionPhase = 'due' | 'waiting' | 'open';
export interface ConfessionStatus {
  phase: ConfessionPhase;
  /** The scene to play: the first confession, or the one that opens with her `retry` line. */
  sceneId: string;
  /** 17:00 JST or later: the confession itself instead of the hint. */
  tonight: boolean;
  /** This round's moment was already reached today (he left before answering): no second automatic opening. */
  reachedToday: boolean;
}

const HOUR = 3_600_000;
/** Evening or night in JST (17:00–05:00), the scene engine's `jstSlot`, without importing the engine. */
export function confessionHour(now: number | Date = Date.now()): boolean {
  const ms = typeof now === 'number' ? now : now.getTime();
  const h = new Date(ms + 9 * HOUR).getUTCHours();
  return h >= 17 || h < 5;
}

/** Where his confession stands; null unless the relationship is at `confession_ready`. */
export function confessionStatus(
  star: StarId, rel: { stage: RelationshipStage; daysTogether: number }, c: ConfessionState | null, now: number | Date = Date.now()
): ConfessionStatus | null {
  if (rel.stage !== 'confession_ready') return null;
  const s = c ?? freshConfession();
  const today = jstDay(now);
  const answeredToday = s.answeredOn === today;
  const rested = s.answeredDays === null || rel.daysTogether >= s.answeredDays + CONFESSION_RULES.retryDays;
  const phase: ConfessionPhase = answeredToday ? 'waiting' : s.tries >= CONFESSION_RULES.maxAsks ? 'open' : rested ? 'due' : 'waiting';
  return {
    phase, sceneId: confessionSceneId(star, s.tries > 0), tonight: confessionHour(now),
    reachedToday: s.reachedRound === s.tries && s.reachedOn === today
  };
}

/** His answer was not yes: she will ask again after CONFESSION_RULES.retryDays days together. */
export function afterAnswer(s: ConfessionState, answer: ConfessionAnswer, daysTogether: number, now: number | Date = Date.now()): ConfessionState {
  const on = jstDay(now);
  return answer === 'accept'
    ? { ...s, lastAnswer: answer, answeredOn: on }
    : { ...s, tries: s.tries + 1, lastAnswer: answer, answeredDays: daysTogether, answeredOn: on };
}

/** While her lines await native review (#82, #84), the confession exists on the test site and in demos only. */
export const confessionOffered = (linesDraft: boolean, demoMode: boolean): boolean => !linesDraft || demoMode;

// ---------------------------------------------------------------- reading his answer

/**
 * A word-list reading of his answer, for the prototype mode and the persona service's stub backend (no model).
 * Production judges with the model (apps/agent/app/confession.py). A no wins over a hesitation, a hesitation over a
 * yes, and anything unclear is "not yet": a wrong yes would make them lovers, a wrong "not yet" only means she
 * asks again later.
 */
const NO = [
  /ごめん/, /無理|むり/, /付き合えない|つきあえない/, /なれない/, /友達のまま|友だちのまま/, /お断り|断る/, /いいえ/, /いやだ|嫌だ/, /そういう(?:の|気持ち)じゃ/,
  /\bno\b(?! (?:doubt|problem|question))/i, /\bsorry\b/i, /can'?t\b/i, /cannot/i, /don'?t (?:want|feel|love|like)/i, /not interested/i, /just friends/i, /\bnope\b/i,
  /抱歉|對不起|对不起/, /不行/, /不能/, /不要(?!緊|紧)/, /不喜歡|不喜欢/, /做朋友/, /不好意思/
];
const WAIT = [
  /まだ/, /考えさせ/, /待って/, /時間(?:を|が)?(?:ちょうだい|ください|ほしい)/, /わから|分から/, /迷っ/, /もう少し/,
  /not yet/i, /need (?:some )?time/i, /let me think/i, /\bmaybe\b/i, /not sure/i, /give me (?:some )?time/i, /i don'?t know/i,
  /再想想|讓我想|让我想/, /還沒|还没/, /不知道/, /等等|等一下/, /考慮|考虑/
];
const YES = [
  /はい/, /うん/, /もちろん/, /喜んで/, /よろしく/, /好き/, /なりたい/, /いいよ/, /なる(?:よ|ね|!|！|。|$)/, /付き合(?:おう|いたい)/, /ぜひ/,
  /\byes\b/i, /\byeah\b/i, /of course/i, /i love you/i, /i'?d love/i, /\bsure\b/i, /absolutely/i, /i do\b/i, /let'?s be together/i,
  /願意|愿意/, /當然|当然/, /喜歡你|喜欢你/, /我也是/, /好啊|好呀|好的/, /在一起/
];

export function guessAnswer(text: string): ConfessionAnswer {
  const t = text.normalize('NFKC').trim();
  if (!t) return 'not_yet';
  if (NO.some((r) => r.test(t))) return 'decline';
  if (WAIT.some((r) => r.test(t))) return 'not_yet';
  if (YES.some((r) => r.test(t))) return 'accept';
  return 'not_yet';
}

/**
 * The persona service's verdict, read defensively: only a well-formed, confident `accept` makes them lovers; any
 * other shape, value or doubt reads as "not yet".
 */
export function readVerdict(raw: unknown): { answer: ConfessionAnswer; confident: boolean } {
  if (!raw || typeof raw !== 'object') return { answer: 'not_yet', confident: false };
  const r = raw as { answer?: unknown; confident?: unknown };
  const answer = isConfessionAnswer(r.answer) ? r.answer : 'not_yet';
  const confident = r.confident === true;
  if (answer === 'accept' && !confident) return { answer: 'not_yet', confident: false };
  return { answer, confident: answer === 'not_yet' ? confident : true };
}

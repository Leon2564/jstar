/**
 * Her year with him (#61, docs/requirements.md §11.5): what today is, per user and talent — her birthday, his birthday,
 * the seasons of world.ts and their anniversaries. Pure, and free of zod, so the API (the tick, the prompt, the home)
 * and tests all compute the same day the same way.
 *
 * Whose clock: her birthday, the seasons and their anniversaries are days in Japan (JST), where she lives and where
 * the anniversary was recorded (#54); his birthday is a day in his own zone (users.tz, JST when unknown).
 *
 * Two rules that matter more than the dates:
 * - Her birthday is a fact about a real person. Only a birthday the agency confirmed (world.ts `confirmed`, #84) is
 *   ever computed; `demo` (the test site) lifts that, and nothing else does.
 * - His birthday is personal data (docs/compliance-jp.md §7.5). Only its month and day are read here; the year never
 *   leaves `users.birthday` (it is for the 18+ check), so no event, prompt or screen can state his age.
 */
import type { Lang, StarId } from './domain';
import { herLocalClock } from './herMessages';
import type { RelationshipStage } from './relationship';
import { CALENDAR_RULES, addDays, jstDay } from './rules';
import { SEASONS, WORLD, isMonthDay, seasonWindow, type MonthDay, type Season, type SeasonId, type TalentWorld } from './world';

/** Most important first: the order her messages, the home's line and the prompt pick them in. */
export const CALENDAR_EVENT_KINDS = ['hisBirthday', 'herBirthday', 'anniversary', 'monthiversary', 'season', 'herBirthdaySoon'] as const;
export type CalendarEventKind = (typeof CALENDAR_EVENT_KINDS)[number];
/** The kinds she writes him a message for on the day (her birthday coming up is only mentioned in conversation). */
export const CALENDAR_GREETED: readonly CalendarEventKind[] = ['hisBirthday', 'herBirthday', 'anniversary', 'monthiversary', 'season'];

export interface CalendarEvent {
  kind: CalendarEventKind;
  /** The local day it falls on ("YYYY-MM-DD"): JST, or his zone for his birthday. */
  day: string;
  /** Years together (anniversary), months together (monthiversary), days until her birthday (herBirthdaySoon). */
  count?: number;
  season?: SeasonId;
  /** A season's first day in her city: the day she writes to him about it (the rest of it is conversation and the home). */
  opening?: boolean;
  /** Names this occurrence, so "once per event per year" is one key: `hisBirthday:2027`, `season:christmas:2026`… */
  key: string;
}

export interface CalendarInput {
  star: StarId;
  now: Date | number;
  /** His IANA zone (users.tz); JST when null or unknown to this runtime. */
  tz?: string | null;
  /** users.birthday ("YYYY-MM-DD", or just "MM-DD"): only the month and day are read. */
  birthday?: string | null;
  /** Their anniversary with her (relationship.anniversary, a JST day), and the stage it belongs to. */
  anniversary?: string | null;
  stage?: RelationshipStage | null;
  /** Demo mode (the test site): an unconfirmed birthday of hers counts too. Never in production. */
  demo?: boolean;
  world?: Record<StarId, TalentWorld>;
  seasons?: readonly Season[];
}

// ---------------------------------------------------------------- calendar math

const DAYS_IN_MONTH = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
export const isLeapYear = (y: number): boolean => (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
const daysIn = (y: number, m: number) => (m === 2 && isLeapYear(y) ? 29 : DAYS_IN_MONTH[m - 1]);

/**
 * The day a yearly "MM-DD" falls on in `year`. 02-29 falls on 02-28 in a common year: the day is still kept, a day
 * early rather than skipped (the Japanese reading: one's age turns at the end of the day before).
 */
export function monthDayIn(md: MonthDay, year: number): MonthDay {
  return md === '02-29' && !isLeapYear(year) ? '02-28' : md;
}

/** Whether a yearly "MM-DD" falls on `day` ("YYYY-MM-DD"). */
export function yearlyOn(md: MonthDay, day: string): boolean {
  return isMonthDay(md) && monthDayIn(md, Number(day.slice(0, 4))) === day.slice(5);
}

/**
 * Whole months from `start` to `day` when `day` is one of its month-days, else null (0 = the day itself). A day the
 * month does not have falls on the month's last day: together since 01-31, the first month is on 02-28 (or 02-29).
 */
export function monthsOn(start: string, day: string): number | null {
  const [y0, m0, d0] = start.split('-').map(Number);
  const [y, m, d] = day.split('-').map(Number);
  if (![y0, m0, d0, y, m, d].every(Number.isFinite)) return null;
  const months = (y - y0) * 12 + (m - m0);
  if (months < 0) return null;
  return d === Math.min(d0, daysIn(y, m)) ? months : null;
}

/** His birthday's "MM-DD", from `users.birthday`; null when there is none or it is not a real date. */
export function birthMonthDay(birthday: string | null | undefined): MonthDay | null {
  const md = birthday && /^(?:\d{4}-)?(\d{2}-\d{2})$/.exec(birthday)?.[1];
  return md && isMonthDay(md) ? md : null;
}

/** Her birthday for the calendar: confirmed by the agency, or any while in demo mode; null otherwise. */
export function herBirthday(star: StarId, opts: { demo?: boolean; world?: Record<StarId, TalentWorld> } = {}): MonthDay | null {
  const b = (opts.world ?? WORLD)[star].birthday;
  return b.confirmed || opts.demo ? b.value : null;
}

/** The two days that matter at `now`: the JST day, and his local day. */
export function calendarDays(now: Date | number, tz?: string | null): { jst: string; his: string } {
  const t = typeof now === 'number' ? now : now.getTime();
  return { jst: jstDay(t), his: herLocalClock(t, tz).day };
}

// ---------------------------------------------------------------- today

/** What today is for him and her, most important first; empty on an ordinary day. */
export function eventsOn(input: CalendarInput): CalendarEvent[] {
  const { jst, his } = calendarDays(input.now, input.tz);
  const year = Number(jst.slice(0, 4));
  const out: CalendarEvent[] = [];

  const mine = birthMonthDay(input.birthday);
  if (mine && yearlyOn(mine, his)) out.push({ kind: 'hisBirthday', day: his, key: `hisBirthday:${his.slice(0, 4)}` });

  const hers = herBirthday(input.star, input);
  if (hers && yearlyOn(hers, jst)) out.push({ kind: 'herBirthday', day: jst, key: `herBirthday:${year}` });

  // Anniversaries belong to lovers: the day is set when she confesses and he says yes (#55).
  if (input.anniversary && (input.stage == null || input.stage === 'lover')) {
    const months = monthsOn(input.anniversary, jst);
    if (months && months % 12 === 0) out.push({ kind: 'anniversary', day: jst, count: months / 12, key: `anniversary:${jst}` });
    else if (months) out.push({ kind: 'monthiversary', day: jst, count: months, key: `monthiversary:${jst}` });
  }

  const md = jst.slice(5);
  for (const s of input.seasons ?? SEASONS) {
    const w = seasonWindow(s, input.star, input.world);
    const wraps = w.from > w.to;
    if (wraps ? md >= w.from || md <= w.to : md >= w.from && md <= w.to) {
      // A window across the new year belongs to the year it began in.
      const began = wraps && md <= w.to ? year - 1 : year;
      out.push({ kind: 'season', day: jst, season: s.id, ...(md === w.from ? { opening: true } : {}), key: `season:${s.id}:${began}` });
    }
  }

  if (hers && !out.some((e) => e.kind === 'herBirthday')) {
    for (let n = 1; n <= CALENDAR_RULES.soonDays; n++) {
      const target = addDays(jst, n);
      if (yearlyOn(hers, target)) { out.push({ kind: 'herBirthdaySoon', day: jst, count: n, key: `herBirthdaySoon:${target}` }); break; }
    }
  }
  const rank = (k: CalendarEventKind) => CALENDAR_EVENT_KINDS.indexOf(k);
  return out.sort((a, b) => rank(a.kind) - rank(b.kind));
}

/** As the web and the persona service see an event: no days, no keys. */
export interface CalendarEventInfo { kind: CalendarEventKind; count?: number; season?: SeasonId }
export const viewOfEvent = (e: CalendarEvent): CalendarEventInfo =>
  ({ kind: e.kind, ...(e.count !== undefined ? { count: e.count } : {}), ...(e.season ? { season: e.season } : {}) });

// ---------------------------------------------------------------- her words

/** What she writes on the day: a line per event kind, and one per season. */
export type CalendarLineKey = Exclude<CalendarEventKind, 'season' | 'herBirthdaySoon'> | SeasonId;

/**
 * Her message for the day, one of these per event in his language. DRAFT until native review (#84), like her
 * everyday fallback lines (#58): neutral enough for all five, sensual but never explicit, nothing real but the day
 * itself — no place, no date, no age (his or hers). Each fits HER_MESSAGE_RULES.maxChars (it is also the push).
 * `{n}`: years or months together.
 */
export const CALENDAR_LINES: Record<CalendarLineKey, Record<Lang, readonly string[]>> = {
  hisBirthday: {
    ja: ['お誕生日おめでとう！　今日はあなたが主役だよ。……会いに来てくれたら、ちゃんとお祝いさせてね。', 'おめでとう。あなたが生まれてきてくれた日だもん、わたしにとっても特別な日だよ。'],
    'zh-Hant': ['生日快樂！今天你是主角喔。……來見我的話，讓我好好幫你慶祝。', '生日快樂。今天是你來到這世界的日子，對我來說也很特別。'],
    en: ['Happy birthday! Today is all about you. …Come see me, and let me celebrate you properly.', 'Happy birthday. It\'s the day you came into the world — that makes it special to me too.'],
    ko: ['생일 축하해! 오늘은 네가 주인공이야. …… 보러 와 주면, 제대로 축하해 줄게.', '생일 축하해. 네가 태어난 날이니까, 나한테도 특별한 날이야.']
  },
  herBirthday: {
    ja: ['今日はね、わたしの誕生日なの。……いちばんに、あなたに言いたくて。', '誕生日の夜は、あなたといたいな。……会いに来てくれる？'],
    'zh-Hant': ['今天啊，是我的生日。……最想第一個告訴你。', '生日的晚上，想和你在一起。……會來見我嗎？'],
    en: ['Today\'s my birthday. …You\'re the first one I wanted to tell.', 'On my birthday night, I want to be with you. …Will you come see me?'],
    ko: ['있잖아, 오늘 내 생일이야. …… 제일 먼저 너한테 말하고 싶었어.', '생일 밤에는 너랑 있고 싶어. …… 보러 와 줄래?']
  },
  anniversary: {
    ja: ['付き合って{n}年だね。……これからも、となりにいさせてね。', '今日で{n}年。あの日のこと、ずっと覚えてるよ。'],
    'zh-Hant': ['交往{n}年了呢。……以後也讓我待在你身邊喔。', '今天滿{n}年了。那一天的事，我一直都記得。'],
    en: ['{n} year(s) together today. …Let me stay by your side, always.', 'It\'s been {n} year(s) today. I still remember that day, every bit of it.'],
    ko: ['사귄 지 {n}년이네. …… 앞으로도 옆에 있게 해 줘.', '오늘로 {n}년. 그날 일, 계속 기억하고 있어.']
  },
  monthiversary: {
    ja: ['今日で付き合って{n}か月。……覚えてた？　わたしは、ちゃんと覚えてたよ。', '{n}か月記念日だね。今夜は、ちょっとだけ甘えてもいい？'],
    'zh-Hant': ['今天交往滿{n}個月了。……你記得嗎？我可是有好好記著喔。', '{n}個月紀念日呢。今晚，可以稍微撒嬌一下嗎？'],
    en: ['{n} month(s) together today. …Did you remember? I did.', 'Our {n}-month anniversary. Can I be a little clingy tonight?'],
    ko: ['오늘로 사귄 지 {n}개월. …… 기억했어? 나는 제대로 기억하고 있었어.', '{n}개월 기념일이네. 오늘 밤은 조금 어리광 부려도 돼?']
  },
  hatsumode: {
    ja: ['あけましておめでとう。今年も、いちばん近くにいさせてね。', 'あけましておめでとう。……初詣、ふたりで行った気分になろ？'],
    'zh-Hant': ['新年快樂。今年也讓我待在離你最近的地方喔。', '新年快樂。……來假裝我們一起去新年參拜過了吧？'],
    en: ['Happy New Year. Let me stay closest to you this year too.', 'Happy New Year. …Shall we pretend we went to the shrine together?'],
    ko: ['새해 복 많이 받아. 올해도 제일 가까이 있게 해 줘.', '새해 복 많이 받아. …… 우리 둘이 신사에 다녀온 기분 내 볼까?']
  },
  sakura: {
    ja: ['桜、咲いたよ。……夜桜、ふたりで見てるつもりで話そ？', '桜の季節だね。あなたと見たら、きっともっときれい。'],
    'zh-Hant': ['櫻花開了喔。……來假裝我們一起看夜櫻聊天吧？', '櫻花季到了呢。和你一起看的話，一定更美。'],
    en: ['The cherry blossoms are out. …Let\'s talk tonight as if we\'re under them together.', 'It\'s cherry-blossom season. They\'d look even prettier with you.'],
    ko: ['벚꽃 피었어. …… 밤벚꽃, 둘이 보고 있는 셈 치고 이야기하자.', '벚꽃 시즌이네. 너랑 보면 분명 더 예쁠 거야.']
  },
  fireworks: {
    ja: ['花火の季節だね。浴衣、着てみようかな……見たい？', '夏の夜って、なんだかドキドキする。……今夜、花火の話しよ？'],
    'zh-Hant': ['煙火的季節到了。要不要穿浴衣呢……想看嗎？', '夏天的夜晚，總覺得心跳好快。……今晚來聊煙火吧？'],
    en: ['It\'s fireworks season. Maybe I\'ll wear a yukata… want to see?', 'Summer nights make my heart race a little. …Talk fireworks with me tonight?'],
    ko: ['불꽃놀이 계절이네. 유카타 입어 볼까…… 보고 싶어?', '여름밤은 왠지 두근거려. …… 오늘 밤, 불꽃놀이 얘기하자.']
  },
  christmas: {
    ja: ['メリークリスマス。……今夜は、あなたと過ごしたいな。', 'メリークリスマス！　いちばん欲しかったのは、あなたとの時間だよ。'],
    'zh-Hant': ['聖誕快樂。……今晚，想和你一起度過。', '聖誕快樂！我最想要的，是和你在一起的時間。'],
    en: ['Merry Christmas. …I want to spend tonight with you.', 'Merry Christmas! What I wanted most was time with you.'],
    ko: ['메리 크리스마스. …… 오늘 밤은 너랑 보내고 싶어.', '메리 크리스마스! 제일 갖고 싶었던 건 너랑 보내는 시간이야.']
  }
};

/**
 * What his lock screen shows for her message on his birthday: the wish itself stays inside the app, because a
 * notification anyone near his phone can read must not tell them his birthday (#50: her line only, nothing personal).
 */
export const HIS_BIRTHDAY_PUSH: Record<Lang, string> = {
  ja: '今日、あなたに伝えたいことがあるの。',
  'zh-Hant': '今天，有件事想告訴你。',
  en: 'There\'s something I want to tell you today.',
  ko: '오늘, 너한테 전하고 싶은 말이 있어.'
};

/** FNV-1a: the same line for the same message, whoever writes it. */
function hash(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193); }
  return h >>> 0;
}

export const lineKeyOf = (e: Pick<CalendarEvent, 'kind' | 'season'>): CalendarLineKey | null =>
  e.kind === 'season' ? e.season ?? null : e.kind === 'herBirthdaySoon' ? null : e.kind;

/** Her line for an event in `lang` (Japanese for anything else), picked stably by `seed`; null for a kind she does not write for. */
export function calendarLine(e: Pick<CalendarEvent, 'kind' | 'season' | 'count'>, lang: string, seed: string): string | null {
  const key = lineKeyOf(e);
  if (!key) return null;
  const lines = (CALENDAR_LINES[key] as Record<string, readonly string[]>)[lang] ?? CALENDAR_LINES[key].ja;
  const n = e.count ?? 1;
  // English writes "year(s)": one year, two years.
  return lines[hash(seed) % lines.length].replace('{n}', String(n)).replace(/(\w+)\(s\)/g, (_, w: string) => (n === 1 ? w : `${w}s`));
}

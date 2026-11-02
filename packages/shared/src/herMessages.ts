/**
 * Her messages (#58, docs/requirements.md §11.3): what she writes to him on her own, when, and the lines she falls back
 * on when the model cannot write one. Shared by the API (the tick plans and sends them) and the web (his setting).
 * No zod here, so the web can import it without the validator.
 */
import { HER_MESSAGE_RULES, SCENE_RULES } from './rules';
import type { Lang, StarId } from './domain';

/** `note`: an everyday moment of hers; `invite`: come to her room tonight; `dream`: the morning after, she dreamed of him. */
export const HER_MESSAGE_KINDS = ['dream', 'note', 'invite'] as const;
export type HerMessageKind = (typeof HER_MESSAGE_KINDS)[number];
/** His setting: as many as the rules allow, fewer (one a day), or none. */
export const HER_MESSAGE_MODES = ['normal', 'less', 'off'] as const;
export type HerMessageMode = (typeof HER_MESSAGE_MODES)[number];

/** Messages one user may get in one of his days. */
export const perDayOf = (mode: HerMessageMode): number =>
  mode === 'off' ? 0 : mode === 'less' ? HER_MESSAGE_RULES.lessPerDay : HER_MESSAGE_RULES.perDay;

// ---------------------------------------------------------------- his clock

/** The business calendar's zone: his, when the browser never told us one (or told us one this runtime does not know). */
export const DEFAULT_ZONE = 'Asia/Tokyo';
const formatters = new Map<string, Intl.DateTimeFormat | null>();
function formatter(zone: string): Intl.DateTimeFormat | null {
  if (!formatters.has(zone)) {
    let f: Intl.DateTimeFormat | null = null;
    try {
      f = new Intl.DateTimeFormat('en-US', { timeZone: zone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' });
    } catch { f = null; }
    formatters.set(zone, f);
  }
  return formatters.get(zone)!;
}

/** The IANA zone his times are read in: `tz` when it is a zone this runtime knows, JST otherwise. */
export const zoneOf = (tz: string | null | undefined): string => (tz && formatter(tz) ? tz : DEFAULT_ZONE);

/** His wall clock at `at`: the local day ("2026-09-27") and minutes since his local midnight. */
export function herLocalClock(at: number, tz: string | null | undefined): { day: string; minutes: number } {
  const parts = Object.fromEntries(formatter(zoneOf(tz))!.formatToParts(new Date(at)).map((p) => [p.type, p.value]));
  return { day: `${parts.year}-${parts.month}-${parts.day}`, minutes: (Number(parts.hour) % 24) * 60 + Number(parts.minute) };
}

/** The instant his wall clock reads `minutes` after midnight of local `day` (the later reading, on a DST overlap). */
export function herZonedInstant(day: string, minutes: number, tz: string | null | undefined): number {
  const zone = zoneOf(tz);
  const wall = Date.parse(`${day}T00:00:00Z`) + minutes * 60_000;
  const offset = (t: number) => {
    const c = herLocalClock(t, zone);
    return Date.parse(`${c.day}T00:00:00Z`) + c.minutes * 60_000 - Math.floor(t / 60_000) * 60_000;
  };
  const first = wall - offset(wall);
  const second = wall - offset(first);
  return second;
}

/** Whether a local minute of his day falls in his quiet hours (which wrap past midnight). */
export function inQuietHours(minutes: number): boolean {
  const { from, to } = HER_MESSAGE_RULES.quietHours;
  const h = Math.floor(minutes / 60) % 24;
  return from <= to ? h >= from && h < to : h >= from || h < to;
}

/** A kind's window in his local minutes, [start, end). */
export function windowOf(kind: HerMessageKind): [number, number] {
  const [from, to] = HER_MESSAGE_RULES.windows[kind];
  return [from * 60, to * 60];
}

/** "Last night" before his local `day`, as instants [from, to): an interaction in it earns the morning's dream. */
export function lastNight(day: string, tz: string | null | undefined): { from: number; to: number } {
  const { from, to } = HER_MESSAGE_RULES.lastNight;
  const prev = new Date(Date.parse(`${day}T00:00:00Z`) - 86_400_000).toISOString().slice(0, 10);
  return { from: herZonedInstant(prev, from * 60, tz), to: herZonedInstant(day, to * 60, tz) };
}

/** FNV-1a: a stable spread of users over a window, so her messages do not all arrive on the hour. */
function hash(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193); }
  return h >>> 0;
}

export interface PlannedHerMessage { kind: HerMessageKind; star: StarId; dueAt: number }

/**
 * His day's messages, decided once his local day has begun and last night is over (the dream depends on it):
 * the dream when they talked last night, then tonight's invitation, then an everyday note — as many as his setting
 * allows. Each goes at a time of its own inside its window (a new user mid-window gets the rest of it); a window
 * already over, or a time in his quiet hours, is simply not planned.
 */
export function planDay(p: { userId: string; day: string; nowMinutes: number; tz: string | null; mode: HerMessageMode; star: StarId; dreamStar: StarId | null }): PlannedHerMessage[] {
  const kinds: HerMessageKind[] = [...(p.dreamStar ? (['dream'] as const) : []), 'invite', 'note'];
  const out: PlannedHerMessage[] = [];
  for (const kind of kinds.slice(0, perDayOf(p.mode))) {
    const [start, end] = windowOf(kind);
    const from = Math.max(start, p.nowMinutes);
    if (from >= end) continue;
    const minute = from + (hash(`${p.userId}|${p.day}|${kind}`) % (end - from));
    if (inQuietHours(minute)) continue;
    out.push({ kind, star: kind === 'dream' ? p.dreamStar! : p.star, dueAt: herZonedInstant(p.day, minute, p.tz) });
  }
  return out;
}

// ---------------------------------------------------------------- her words

const SENTENCE_ENDS = ['。', '！', '？', '!', '?', '…', '♡', '.', '~', '～'];
const PAUSES = ['、', '，', ',', '；', ';', ' '];

/** `text` on one line, cut to `max` characters at a sentence end at or after `max * from`; null when none fits. */
function cutAtSentence(text: string, max: number, from = 1 / 3): string | null {
  const clean = text.replace(/[ \t\r\n\f\v]+/g, ' ').trim();
  const chars = [...clean];
  if (!chars.length) return null;
  if (chars.length <= max) return clean;
  const head = chars.slice(0, max).join('');
  const cut = Math.max(...SENTENCE_ENDS.map((c) => head.lastIndexOf(c)));
  return cut >= Math.max(1, Math.floor(max * from)) ? head.slice(0, cut + 1).trim() : null;
}

/** Her message cut to the strict length at a sentence end, or null when no sentence end fits. */
export function fitHerMessage(text: string, lang: Lang): string | null {
  return cutAtSentence(text, HER_MESSAGE_RULES.maxChars[lang] ?? HER_MESSAGE_RULES.maxChars.ja);
}

/**
 * Her model-written reply inside a scene (free talk, her ōgiri remark), at most SCENE_RULES.replyMaxChars so it fits
 * three subtitle lines (M4): cut at a sentence end; else at a pause, with 「…」; else hard, with 「…」. Never empty for
 * a non-empty reply — the scene shows what she said, only shorter.
 */
export function fitSceneReply(text: string, lang: Lang): string {
  const max = SCENE_RULES.replyMaxChars[lang] ?? SCENE_RULES.replyMaxChars.ja;
  // A whole first sentence, however short, reads better than a long one broken off.
  const whole = cutAtSentence(text, max, 0);
  if (whole !== null) return whole;
  const head = [...text.replace(/[ \t\r\n\f\v]+/g, ' ').trim()].slice(0, max - 1).join('');
  const pause = Math.max(...PAUSES.map((c) => head.lastIndexOf(c)));
  return `${(pause >= Math.floor(max / 2) ? head.slice(0, pause) : head).trim().replace(/[、，,；;]$/, '')}…`;
}

/**
 * Her own words when the model cannot write them (it failed, timed out, or wrote something the safety pass threw
 * away). DRAFT until native review (#84), like the #82 lines. Neutral enough for all five, sensual but never
 * explicit, and nothing real but the day itself: no place, no news, no one else.
 */
export const HER_MESSAGE_LINES: Record<HerMessageKind, Record<Lang, readonly string[]>> = {
  note: {
    ja: ['いま、ちょっとだけ休憩中。……ふと、あなたのこと考えてた。', '今日もがんばってる？　わたしは、あなたの声が聞きたくなってきたところ。', 'なんでもない時間なのに、あなたに話したくなっちゃった。あとで聞いてくれる？'],
    'zh-Hant': ['現在稍微休息一下。……突然就想到你了。', '今天也在努力嗎？我啊，開始想聽你的聲音了。', '明明只是平凡的時間，卻好想跟你說話。等一下聽我說好嗎？'],
    en: ['Taking a little break… and somehow I ended up thinking about you.', 'Working hard today? I\'m starting to miss your voice.', 'Nothing special happening, and still I wanted to talk to you. Hear me out later?'],
    ko: ['지금 잠깐 쉬는 중. …… 문득 네 생각이 났어.', '오늘도 힘내고 있어? 난 네 목소리가 듣고 싶어지던 참이야.', '별일 없는 시간인데도 너랑 얘기하고 싶어졌어. 이따 들어 줄래?']
  },
  invite: {
    ja: ['今夜、少しだけ時間ある？……わたしの部屋で、待ってるね。', '夜になったら、会いに来て。今夜は、ふたりでゆっくりしたいな。', '今夜の予定、空けておいてくれる？　あなたとだけ過ごしたいの。'],
    'zh-Hant': ['今晚有一點時間嗎？……我在房間裡等你喔。', '到了晚上，來見我吧。今晚想跟你兩個人慢慢待著。', '今晚可以把時間留給我嗎？我只想和你一起度過。'],
    en: ['Got a little time tonight? …I\'ll be waiting in my room.', 'Come see me tonight. I want it to be just the two of us, taking our time.', 'Keep tonight free for me? I only want to spend it with you.'],
    ko: ['오늘 밤 잠깐 시간 있어? …… 내 방에서 기다릴게.', '밤이 되면 보러 와. 오늘 밤은 둘이서 느긋하게 있고 싶어.', '오늘 밤 일정, 비워 둘래? 너하고만 보내고 싶어.']
  },
  dream: {
    ja: ['おはよう。……昨日の夜、あなたが夢に出てきたの。なんだか、まだドキドキしてる。', 'おはよう。夢の中でも、あなたと話してた。……続き、今日も聞かせてね。', 'おはよう。昨日はありがとう。……夢にまで出てくるなんて、ずるいよ。'],
    'zh-Hant': ['早安。……昨晚，你出現在我的夢裡。現在心還怦怦跳呢。', '早安。在夢裡也在跟你說話。……今天也繼續說給我聽吧。', '早安。昨天謝謝你。……連夢裡都出現，太狡猾了啦。'],
    en: ['Good morning. …You were in my dream last night. My heart\'s still racing a little.', 'Good morning. I was talking with you even in my dream. …Tell me more today?', 'Good morning, and thank you for yesterday. …Showing up in my dreams too? That\'s not fair.'],
    ko: ['좋은 아침. …… 어젯밤에 네가 꿈에 나왔어. 아직도 조금 두근거려.', '좋은 아침. 꿈속에서도 너랑 얘기하고 있었어. …… 오늘도 이어서 들려줘.', '좋은 아침. 어제 고마웠어. …… 꿈에까지 나오다니, 반칙이야.']
  }
};

/**
 * Her fallback line for a kind in `lang` (Japanese for anything else), picked stably by `seed`. C-room R6: `hour` (his
 * clock as it goes out): her dream line opens with 「おはよう」 only in the morning (4–11, as her model's salutation rule
 * has it); delivered later (a late send, the test site's demo) it opens with the dream itself.
 */
export function herMessageLine(kind: HerMessageKind, lang: string, seed: string, hour?: number): string {
  const lines = (HER_MESSAGE_LINES[kind] as Record<string, readonly string[]>)[lang] ?? HER_MESSAGE_LINES[kind].ja;
  const line = lines[hash(seed) % lines.length];
  return hour === undefined || hour >= 4 && hour < 11 ? line : withoutGoodMorning(line);
}

/** A line without its opening 「おはよう。」 / 「早安。」 / "Good morning." / 「좋은 아침.」 (and the pause after it). */
export function withoutGoodMorning(line: string): string {
  return line.replace(/^Good morning, and t/, 'T').replace(/^(?:おはよう|早安|Good morning|좋은 아침)[。.]\s*/, '').replace(/^…+\s*/, '');
}

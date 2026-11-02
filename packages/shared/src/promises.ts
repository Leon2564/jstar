/**
 * Promises (#59, docs/requirements.md §11.4): before a time together ends she agrees on the next one; when it comes she
 * keeps it herself. Vocabulary and her own lines around a promise, shared by the API (the tick, her greeting) and the
 * web (the home card). No zod here, so the web can import it without the validator.
 */
import { PROMISE_RULES, addDays, jstDay } from './rules';
import { inLanguage, type StarId } from './domain';

/** What the promise is: her waking him (#57's wake-up scene), a message from her, a scene together, or anything else. */
export const PROMISE_KINDS = ['wakeup', 'message', 'scene', 'free'] as const;
export type PromiseKind = (typeof PROMISE_KINDS)[number];
/** open → kept (he came within the window) or missed (the window passed). */
export const PROMISE_STATUSES = ['open', 'kept', 'missed'] as const;
export type PromiseStatus = (typeof PROMISE_STATUSES)[number];
/** Where it was made: the memory model heard both agree in chat, he accepted her proposal, or a scene's ending. */
export const PROMISE_SOURCES = ['chat', 'proposal', 'scene'] as const;
export type PromiseSource = (typeof PROMISE_SOURCES)[number];

const HOUR = 3_600_000;

/** A relative due of her scripts ("+12h", "+1d") from `now`; null for anything else. */
export function dueFrom(due: string, now: number): string | null {
  const m = /^\+(\d{1,3})([hd])$/.exec(due);
  return m ? new Date(now + Number(m[1]) * (m[2] === 'd' ? 24 : 1) * HOUR).toISOString() : null;
}

/** Whether `now` falls inside the window around the promised time, when coming means keeping it. */
export function inPromiseWindow(dueAt: string, now: number): boolean {
  const due = Date.parse(dueAt);
  return now >= due - PROMISE_RULES.windowMs && now <= due + PROMISE_RULES.windowMs;
}

/**
 * Her lines around a promise. DRAFT until native review (#84), like the #82 lines: `{promise}` is the promise as it
 * was made, quoted. `early`: he came before the time; `yesterday`: it was made the JST day before; `due`: any other
 * time it comes due (also the push); `missed`: the first time she sees him after the window passed — never a
 * reproach, and said once only.
 */
export type PromiseLineKind = 'early' | 'yesterday' | 'due' | 'missed';
export const PROMISE_LINES: Record<PromiseLineKind, Record<'ja' | 'zh-Hant' | 'en' | 'ko', string>> = {
  early: {
    ja: '来てくれたんだ。「{promise}」の約束、覚えててくれたんだね。',
    'zh-Hant': '你來了呀。「{promise}」的約定，你還記得呢。',
    en: 'You came. You remembered our promise — "{promise}".',
    ko: '와 줬구나. 「{promise}」 약속, 기억하고 있었네.'
  },
  yesterday: {
    ja: '昨日の約束、覚えてる？「{promise}」……ちゃんと、待ってたよ。',
    'zh-Hant': '昨天的約定，還記得嗎？「{promise}」……我一直在等你喔。',
    en: 'Remember yesterday\'s promise? "{promise}" …I\'ve been waiting.',
    ko: '어제 한 약속, 기억해? 「{promise}」…… 계속 기다렸어.'
  },
  due: {
    ja: '約束の時間だよ。「{promise}」……覚えてる？',
    'zh-Hant': '約好的時間到了喔。「{promise}」……還記得嗎？',
    en: 'It\'s time for our promise. "{promise}" …Remember?',
    ko: '약속한 시간이야. 「{promise}」…… 기억해?'
  },
  missed: {
    ja: '「{promise}」、この前はできなかったね。……ううん、気にしてないよ。また約束しよ？',
    'zh-Hant': '「{promise}」，上次沒能做到呢。……沒關係，我不在意喔。我們再約一次好嗎？',
    en: '"{promise}" — we didn\'t get to last time. …It\'s okay, really. Shall we promise again?',
    ko: '「{promise}」, 지난번엔 못 했네. …… 괜찮아, 신경 안 써. 다시 약속하자, 응?'
  }
};

type Lines4 = Record<'ja' | 'zh-Hant' | 'en' | 'ko', string>;
/**
 * Round 13: her missed-promise line in her own voice (it was one line for all five, so アリス lost her polite voice),
 * and アリス's polite forms of the other three (ja 丁寧語, ko 해요체). まひろ keeps PROMISE_LINES.
 */
const STAR_PROMISE_LINES: Partial<Record<StarId, Partial<Record<PromiseLineKind, Partial<Lines4>>>>> = {
  nana: { missed: {
    ja: '「{promise}」、この前はできなかったね……！でも奈々、ぜんぜん怒ってないよ？今度こそ約束しよっ！',
    'zh-Hant': '「{promise}」，上次沒做到耶……！不過我一點都沒生氣喔？這次一定要約好！',
    en: '"{promise}" — we missed it last time…! But I\'m not mad at all, okay? Let\'s promise again — for real this time!',
    ko: '「{promise}」, 지난번엔 못 했네……! 그래도 하나도 화 안 났어? 이번엔 진짜 약속하자!'
  } },
  eimi: { missed: {
    ja: '「{promise}」、すっぽかされちゃった。……ふふ、冗談。気にしてないから、また約束して？',
    'zh-Hant': '「{promise}」，被你放鴿子了呢。……呵呵，開玩笑的。我不在意，再跟我約一次？',
    en: '"{promise}" — you stood me up. …Hehe, kidding. I don\'t mind. Promise me again?',
    ko: '「{promise}」, 바람맞았네. ……후후, 농담이야. 신경 안 써. 다시 약속해 줄래?'
  } },
  alice: {
    early: { ja: '来てくださったんですね。「{promise}」の約束、覚えていてくれたんですね。', ko: '와 주셨네요. 「{promise}」 약속, 기억하고 계셨네요.' },
    yesterday: { ja: '昨日の約束、覚えていますか？「{promise}」……ずっと、待っていました。', ko: '어제 한 약속, 기억하세요? 「{promise}」…… 계속 기다렸어요.' },
    due: { ja: '約束の時間ですね。「{promise}」……覚えていますか？', ko: '약속한 시간이에요. 「{promise}」…… 기억하세요?' },
    missed: {
      ja: '「{promise}」、この前は叶いませんでしたね。……いえ、気にしていません。また、約束してくれますか？',
      'zh-Hant': '「{promise}」，上次沒能實現呢。……不，我不在意的。可以再跟我約定一次嗎？',
      en: '"{promise}" — it didn\'t happen last time. …No, I don\'t mind at all. Will you promise me again?',
      ko: '「{promise}」, 지난번엔 이루지 못했네요. ……아니에요, 신경 쓰지 않아요. 다시 약속해 주실래요?'
    }
  },
  unpai: { missed: {
    ja: '「{promise}」、この前はできなかったね。……ま、そういう日もあるっしょ。また約束しよ。',
    'zh-Hant': '「{promise}」，上次沒成呢。……嘛，總有那種日子的。再約一次吧。',
    en: '"{promise}" — didn\'t happen last time. …Eh, some days are like that. Let\'s promise again.',
    ko: '「{promise}」, 지난번엔 못 했네. ……뭐, 그런 날도 있지. 다시 약속하자.'
  } }
};

/** Our promise by its time, when its words are in another language than his (round 13). */
const BY_TIME: Lines4 = { ja: '{time}の約束', 'zh-Hant': '我們約好的{time}', en: 'Our {time} promise', ko: '{time} 약속' };

/**
 * Her line, in `lang` (Japanese for anything else), with the promise quoted — in her voice (`star`). A promise made in
 * another language (in Japanese, he now reads English) is named by its time instead (`dueAt`, on his clock `tz`), so
 * it is still mentioned, in his language.
 */
export function promiseLine(kind: PromiseLineKind, lang: string, promise: string, o: { star?: StarId; dueAt?: string; tz?: string | null } = {}): string {
  const own = (o.star && STAR_PROMISE_LINES[o.star]?.[kind]) as Record<string, string> | undefined;
  const lines = PROMISE_LINES[kind] as Record<string, string>;
  const line = own?.[lang] ?? lines[lang] ?? own?.ja ?? lines.ja;
  if (lang !== 'ja' && o.dueAt && !inLanguage(promise, lang)) {
    let time = '';
    try {
      time = new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit', hourCycle: 'h23', timeZone: o.tz || 'Asia/Tokyo' }).format(new Date(o.dueAt));
    } catch { time = new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit', hourCycle: 'h23', timeZone: 'Asia/Tokyo' }).format(new Date(o.dueAt)); }
    const token = /「\{promise\}」|"\{promise\}"|\{promise\}/;
    const named = ((BY_TIME as Record<string, string>)[lang] ?? BY_TIME.en).replace('{time}', time);
    // Mid-sentence in English it is "our 21:00 promise", at the start "Our 21:00 promise".
    return line.replace(token, line.search(token) > 0 ? named.charAt(0).toLowerCase() + named.slice(1) : named);
  }
  return line.replace('{promise}', promise);
}

/** Which line keeps a promise at `now`: before its time, made the JST day before, or otherwise. */
export function keepLineKind(p: { dueAt: string; madeAt: string }, now: number): PromiseLineKind {
  if (now < Date.parse(p.dueAt)) return 'early';
  return jstDay(Date.parse(p.madeAt)) === addDays(jstDay(now), -1) ? 'yesterday' : 'due';
}

// ---------------------------------------------------------------- the day of a promise (round 10)

/**
 * A promise's words without its relative day: 「明日の夜9時、ここで待ってる」 written yesterday would still say 明日 on the
 * day itself. The day is always shown from `dueAt` (`promiseDay`); the words keep the time and the plan. 今夜 / 今朝
 * keep their part of the day (夜 / 朝), as do tonight / 오늘 밤 / 今晚.
 */
export function timelessPromise(text: string): string {
  const out = text
    .replace(/今夜|今晩/g, '夜').replace(/今朝/g, '朝')
    .replace(/(?:明後日|あさって|今日|明日|あした|あす)[のも]?/g, '')
    .replace(/\b(?:the\s+day\s+after\s+)?(?:today|tomorrow|tonight)\b\s*/gi, '')
    .replace(/(?:오늘|내일|모레)\s*/g, '')
    .replace(/明晚|今晚/g, '晚上').replace(/明早|今早/g, '早上').replace(/(?:今天|明天|後天|后天)/g, '')
    .replace(/\s{2,}/g, ' ')
    .replace(/^[\s、，,。:：]+/, '')
    .trim();
  if (!out) return text;
  return /^[A-Z]/.test(text) && /^[a-z]/.test(out) ? out[0].toUpperCase() + out.slice(1) : out;
}

const DAY_WORDS: Record<string, { today: string; tonight: string; tomorrow: string }> = {
  ja: { today: '今日', tonight: '今夜', tomorrow: '明日' },
  'zh-Hant': { today: '今天', tonight: '今晚', tomorrow: '明天' },
  en: { today: 'today', tonight: 'tonight', tomorrow: 'tomorrow' },
  ko: { today: '오늘', tonight: '오늘 밤', tomorrow: '내일' }
};

/** The date and hour of `at` on his clock (`tz`, IANA; Japan's by default). */
function clockIn(at: number, tz: string): { day: string; hour: number } {
  try {
    const p = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hourCycle: 'h23' })
      .formatToParts(new Date(at)).map((x) => [x.type, x.value]));
    return { day: `${p.year}-${p.month}-${p.day}`, hour: Number(p.hour) % 24 };
  } catch {
    return { day: jstDay(new Date(at)), hour: new Date(at + 9 * HOUR).getUTCHours() };
  }
}

/**
 * Its day, counted from `now` when shown, on his clock (round 12: `tz`, his own zone — Japan's by default): today /
 * tonight / tomorrow, or null for a later day (the date is shown then). A late-night hour just after midnight
 * (before 4:00) is still tonight.
 */
export function promiseDay(dueAt: string, lang: string, now: number = Date.now(), tz = 'Asia/Tokyo'): string | null {
  const due = Date.parse(dueAt);
  if (Number.isNaN(due)) return null;
  const words = DAY_WORDS[lang] ?? DAY_WORDS.ja;
  const at = clockIn(due, tz);
  const today = clockIn(now, tz);
  const days = Math.round((Date.parse(at.day) - Date.parse(today.day)) / (24 * HOUR));
  if (days === 0) return at.hour >= 18 || at.hour < 4 ? words.tonight : words.today;
  if (days === 1) return at.hour < 4 && today.hour >= 12 ? words.tonight : words.tomorrow;
  return null;
}

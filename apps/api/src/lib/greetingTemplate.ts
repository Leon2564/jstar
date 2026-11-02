import type { Lang, RelationshipStage, StarId } from '@jstar/shared';
import { GREETING_LINES, type Part } from './greetingLines';

/**
 * Her written greeting, when the persona service cannot give one in his language (N-19): down, or twice in the wrong
 * language. The persona service's own templates (apps/agent/app/engine.py GREETING_TEMPLATES), by the gap since he
 * last wrote and the part of her day (JST); `{call}` is what she calls him, else "you" in his language.
 */
// Round 11: each talent's own lines (greetingLines.ts), not one set for all five.
/** Her first words when the weather is the news (#63; engine.py WEATHER_OPENERS): her written greeting says it too. */
const WEATHER: Record<Lang, Record<'rain' | 'snow' | 'first_snow' | 'alert', string>> = {
  ja: { rain: '雨、降ってるね。', snow: '雪、降ってきたよ……！', first_snow: '初雪だよ！', alert: '外、すごく荒れてるね。無理しないでね。' },
  'zh-Hant': { rain: '在下雨呢。', snow: '下雪了……！', first_snow: '初雪耶！', alert: '外面天氣好糟，別勉強喔。' },
  en: { rain: "It's raining here.", snow: "It's snowing…!", first_snow: 'First snow!', alert: "It's wild out there — please be careful." },
  ko: { rain: '비 오네.', snow: '눈 내리기 시작했어……!', first_snow: '첫눈이야!', alert: '밖에 날씨 엄청 험해. 무리하지 마.' }
};

export type WeatherNews = keyof (typeof WEATHER)['ja'];
/**
 * Round 13: her weather words in her own register — アリス speaks politely (ja 丁寧語, ko 해요체), so her opener does
 * too (「雨、降ってるね。また来てくれたんですね。」 mixed the two). The other four are casual, as WEATHER is.
 */
const POLITE_WEATHER: Partial<Record<Lang, Record<WeatherNews, string>>> = {
  ja: { rain: '雨、降っていますね。', snow: '雪、降ってきましたね……！', first_snow: '初雪ですよ！', alert: '外、すごく荒れていますね。無理しないでくださいね。' },
  ko: { rain: '비가 오네요.', snow: '눈이 내리기 시작했어요……!', first_snow: '첫눈이에요!', alert: '밖에 날씨가 많이 험해요. 무리하지 마세요.' }
};
export const POLITE_STARS: ReadonlySet<StarId> = new Set(['alice']);
const weatherWords = (lang: Lang, weather: WeatherNews, star?: StarId) =>
  (star && POLITE_STARS.has(star) && POLITE_WEATHER[lang]?.[weather]) || (WEATHER[lang] ?? WEATHER.ja)[weather];
/** Words that show a line of hers is already about the weather she opens with. */
const WEATHER_WORDS: Record<WeatherNews, RegExp> = {
  rain: /雨|rain|drizzl|pour|비|장마/i,
  snow: /雪|snow|눈/i,
  first_snow: /雪|snow|눈/i,
  alert: /荒れ|無理|気をつけ|wild|careful|safe|storm|天氣|小心|勉強|험해|조심|무리/i
};
const SEP = (lang: Lang) => (lang === 'en' || lang === 'ko' ? ' ' : '');

/**
 * Round 11: rain or snow at her window is in every greeting of hers — her drowsy woken line, her promise line, her
 * confession hint, the model's line and her written one. Combined, never one replacing the other: her weather words
 * first (`before`), or after a line that must come first (`after`: woken, a promise kept or missed). A line already
 * about the weather stays as it is.
 */
export function withWeather(text: string, lang: Lang, weather: WeatherNews | null, at: 'before' | 'after' = 'before', star?: StarId): string {
  if (!weather || WEATHER_WORDS[weather].test(text)) return text;
  const words = weatherWords(lang, weather, star);
  return at === 'before' ? `${words}${SEP(lang)}${text}` : `${text}${SEP(lang) || ''}${words}`;
}

/**
 * Her part of the day in Japan, as the persona service reads it (persona.py day_part) — or (M4) of `hour`, his hour
 * when his time zone is known.
 */
export function dayPart(now: Date, hour?: number): Part {
  const h = hour ?? (now.getUTCHours() + 9) % 24;
  return h < 4 || h >= 22 ? 'late night' : h < 7 ? 'early morning' : h < 11 ? 'morning' : h < 17 ? 'daytime' : 'evening';
}

/**
 * `{call}` in her line: his name when she has one. Without one, Japanese keeps her own word for him (きみ / あなた);
 * the other languages leave the address out — "Welcome back." rather than "Welcome back, you." (round 13).
 */
export function fillCall(line: string, call: string | null, lang: Lang, you: string): string {
  if (call) return line.replace('{call}', call);
  if (lang === 'ja') return line.replace('{call}', you);
  const out = line.replace(/[,，、]\s*\{call\}/, '').replace(/\{call\}\s*[,，、]\s*/, '').replace(/\s*\{call\}/, '');
  return out.charAt(0).toUpperCase() + out.slice(1);
}

/** Close enough that her greeting says she missed him (her `close` words): from their ambiguous stage on. */
const CLOSE: ReadonlySet<RelationshipStage> = new Set(['ambiguous', 'confession_ready', 'lover']);

export function greetingTemplate(lang: Lang, daysSince: number | null, callName: string | null, now: Date = new Date(),
  weather: WeatherNews | null = null, star: StarId = 'mahiro', stage: RelationshipStage = 'new', hour?: number): string {
  const t = (GREETING_LINES[star] ?? GREETING_LINES.mahiro)[lang] ?? GREETING_LINES[star].ja;
  let text = daysSince === null ? t.first : daysSince === 0 ? t.same : daysSince >= 3 ? t.long.replace('{days}', String(daysSince))
    : fillCall(t.next[dayPart(now, hour)], callName, lang, t.you);
  if (daysSince !== null && CLOSE.has(stage)) text = `${text}${SEP(lang)}${t.close}`;
  // Rain, snow or a storm at her window: her first words are about it, written greeting too (not only the model's).
  return withWeather(text, lang, weather, 'before', star);
}

export { wrongTimeSalutation } from '@jstar/shared/salutation';

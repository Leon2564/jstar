import { ja, type Dict, type Key } from './ja';
import type { Star } from '../data/cast';

export type Lang = 'ja' | 'zh-Hant' | 'en' | 'ko';
export const LANGS: Lang[] = ['ja', 'zh-Hant', 'en', 'ko'];
/** Offered in the language picker. Korean joined in v1.1 (owner, 2026-09-28); the Korea geo-block is unchanged. */
export const SELECTABLE_LANGS: Lang[] = ['ja', 'zh-Hant', 'en', 'ko'];
/** Only Japanese ships in the main bundle; other languages are fetched on demand (see ensureLang). */
export const DICTS: Partial<Record<Lang, Dict>> = { ja };
export const LANG_NAMES: Record<Lang, string> = { ja: '日本語', 'zh-Hant': '繁體中文', en: 'English', ko: '한국어' };
const LOADERS: Record<Exclude<Lang, 'ja'>, () => Promise<Dict>> = {
  'zh-Hant': () => import('./zhHant').then((m) => m.zhHant),
  en: () => import('./en').then((m) => m.en),
  ko: () => import('./ko').then((m) => m.ko)
};
const pending: Partial<Record<Lang, Promise<void>>> = {};
export function ensureLang(lang: Lang): Promise<void> {
  if (DICTS[lang]) return Promise.resolve();
  pending[lang] ??= LOADERS[lang as Exclude<Lang, 'ja'>]().then((d) => { DICTS[lang] = d; });
  return pending[lang]!;
}
export type { Key };

export function isLang(v: unknown): v is Lang {
  return typeof v === 'string' && (LANGS as string[]).includes(v);
}

/** Maps a browser language (navigator.language) to a supported locale. */
export function detectLang(nav: string | undefined): Lang {
  const l = (nav ?? '').toLowerCase();
  if (l.startsWith('zh')) return 'zh-Hant';
  if (l.startsWith('ja')) return 'ja';
  if (l.startsWith('en')) return 'en';
  if (l.startsWith('ko')) return 'ko';
  return 'ja';
}

export function translate(lang: Lang, key: Key, vars?: Record<string, string | number>): string {
  const s = DICTS[lang]?.[key] ?? ja[key] ?? key;
  if (!vars) return s;
  const out = s.replace(/\{(\w+)\}/g, (m, k) => (k in vars ? String(vars[k]) : m));
  // L2: English counts of one are singular ("1 day", "1 card", never "1 days").
  return lang === 'en' && Object.values(vars).includes(1) ? out.replace(/(^|[^\d.,])1 ([a-z]*[^su\W])s\b/g, '$11 $2') : out;
}

/** Japanese and Traditional Chinese readers see the kanji/kana name; English and Korean see the romanised one. */
/** The separator between short items (city · sky, timer · status): Japanese 「・」, elsewhere 「 · 」 (QA #6). */
export const dotSep = (lang: string): string => (lang === 'ja' ? '・' : ' · ');

/** Her words in quotes (L2): 「」 in Japanese and Chinese, “ ” in English and Korean. */
export const quoted = (s: string, lang: Lang): string => (lang === 'en' || lang === 'ko' ? `“${s}”` : `「${s}」`);

export function starName(s: Star, lang: Lang): string {
  return lang === 'ja' ? s.name : lang === 'zh-Hant' ? s.zhName : lang === 'ko' ? s.koName : s.romaji;
}
export function starFirst(s: Star, lang: Lang): string {
  return lang === 'ja' ? s.first : lang === 'zh-Hant' ? s.zhFirst : lang === 'ko' ? s.koFirst : s.romajiFirst;
}
export function verticalName(lang: Lang): boolean {
  return lang === 'ja' || lang === 'zh-Hant';
}

/** Fonts are requested per language so a Korean visitor never downloads Japanese font subsets and vice versa. */
const FONT_CSS: Record<Lang, string> = {
  ja: 'family=Shippori+Mincho:wght@400;600&family=Zen+Kaku+Gothic+New:wght@400;500',
  en: 'family=Shippori+Mincho:wght@400;600&family=Zen+Kaku+Gothic+New:wght@400;500',
  // zh-Hant: the house faces first (Shippori Mincho / Zen Kaku Gothic), Noto TC for the hanzi they lack (tokens.css).
  'zh-Hant': 'family=Shippori+Mincho:wght@400;600&family=Zen+Kaku+Gothic+New:wght@400;500&family=Noto+Serif+TC:wght@400;600&family=Noto+Sans+TC:wght@400;500',
  ko: 'family=Noto+Serif+KR:wght@400;600&family=Noto+Sans+KR:wght@400;500'
};
export function loadFonts(lang: Lang): void {
  if (typeof document === 'undefined') return;
  const id = `fonts-${lang}`;
  if (document.getElementById(id)) return;
  const link = document.createElement('link');
  link.id = id;
  link.rel = 'stylesheet';
  link.href = `https://fonts.googleapis.com/css2?${FONT_CSS[lang]}&display=swap`;
  document.head.appendChild(link);
}

/** Month/day in Japan time, the calendar the business runs on ("10/31"). */
export function fmtDate(iso: string, lang: Lang): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return new Intl.DateTimeFormat(lang === 'zh-Hant' ? 'zh-TW' : lang, { month: 'numeric', day: 'numeric', timeZone: 'Asia/Tokyo' }).format(d);
}

/** A promise's time in Japan time, as it was agreed ("9/27(日) 21:00"): promises are made in her world's clock (#59). */
export function fmtWhen(iso: string, lang: Lang): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return new Intl.DateTimeFormat(lang === 'zh-Hant' ? 'zh-TW' : lang, {
    month: 'numeric', day: 'numeric', weekday: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23', timeZone: 'Asia/Tokyo'
  }).format(d);
}

/** Prices are always yen; only the grouping follows Japanese convention. */
export const fmtYen = (n: number) => n.toLocaleString('ja-JP');

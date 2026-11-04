import { RULES } from './rules';

/** Domain vocabulary shared by web, admin, api and the agent service. */
export const STAR_IDS = ['mahiro', 'nana', 'unpai', 'alice', 'eimi'] as const;
export type StarId = (typeof STAR_IDS)[number];

/** "all" = all 125 active cards; "star:<id>" = one talent's 25-card pool. */
export type PoolId = 'all' | `star:${StarId}`;
export const POOL_IDS: PoolId[] = ['all', ...STAR_IDS.map((s) => `star:${s}` as const)];
export const isPoolId = (v: unknown): v is PoolId => typeof v === 'string' && (POOL_IDS as string[]).includes(v);

/** Star Genesis tiers, lowest first (docs/catalog-spec.md). */
export const RARITIES = ['N', 'R', 'SR', 'SSR', 'UR'] as const;
export type Rarity = (typeof RARITIES)[number];
export const RARITY_ORDER: Record<Rarity, number> = { N: 1, R: 2, SR: 3, SSR: 4, UR: 5 };

/** Where the artwork comes from. Always shown to the user (see docs/compliance-jp.md). */
export type CardSource = 'photo' | 'ai';

export const LANGS = ['ja', 'zh-Hant', 'en', 'ko'] as const;
export type Lang = (typeof LANGS)[number];
/** Languages offered at launch (Korean is hidden: not a launch market). */
export const LAUNCH_LANGS = ['ja', 'zh-Hant', 'en'] as const;

/**
 * Text in the languages she is written in. Korean (owner, 2026-09-28) is on every scene and line text and on her
 * templates; elsewhere (card text) it may be missing, and a Korean reader then gets English (`localText`).
 */
export interface LocalText { ja: string; 'zh-Hant': string; en: string; ko?: string }
export interface LocalStory { ja: string[]; 'zh-Hant': string[]; en: string[]; ko?: string[] }

export interface CardDef {
  id: string;
  star: StarId;
  rarity: Rarity;
  title: LocalText;
  /** What she says on this card (recorded as `voice`). */
  line: LocalText | null;
  /** SSR and UR: two episodes unlocked by affinity. */
  story: LocalStory | null;
  source: CardSource;
  /** "/cards/<id>/card.webp" once produced; null while the art is pending. */
  art: string | null;
  voice: string | null;
  /** Legacy variant metadata is retained for previously owned cards. */
  variant?: VariantDef;
}

/** A layer of a variant card's scenes (#76), opened by her variant affinity level (VARIANT_RULES.layerLevels). */
export interface VariantLayer { level: number; scene: string }
/**
 * What makes a card a variant (docs/catalog-spec.md). `scene` is her dress-up entrance (layer 1); the clips and the
 * home video are media ids of the web catalogue, produced by #81 — until then the ids are reserved, nothing plays them.
 */
export interface VariantDef {
  scene: string;
  enterClip: string;
  closeClip: string;
  homeVideo: string;
  layers: VariantLayer[];
}

/**
 * A text in `lang`. Missing languages fall back sensibly: Korean to English (a Korean reader is likelier to read
 * English than Japanese), everything else to Japanese.
 */
export function localText(t: LocalText | null | undefined, lang: string): string {
  if (!t) return '';
  const r = t as unknown as Record<string, string | undefined>;
  return r[lang] || (lang === 'ko' ? t.en : '') || t.ja;
}

const KANA = /[\u3041-\u3096\u30a1-\u30fa\u31f0-\u31ff\uff66-\uff9d]/;
const HANGUL = /[\uac00-\ud7a3\u1100-\u11ff\u3131-\u318e]/;

/**
 * Whether a line she wrote (a model's) is in `lang` (N-05; the persona service's `in_language` is the same rule):
 * outside Japanese no kana is left once his names (which may be in kana) are taken out; Korean has Hangul; Japanese
 * and Chinese have none.
 */
export function inLanguage(text: string, lang: string, keep: readonly (string | null | undefined)[] = []): boolean {
  let rest = text;
  for (const name of keep.filter((k): k is string => !!k).sort((a, b) => b.length - a.length)) rest = rest.split(name).join('');
  if (lang === 'ja') return !HANGUL.test(rest);
  if (KANA.test(rest)) return false;
  return lang === 'ko' ? HANGUL.test(rest) : !HANGUL.test(rest);
}

/**
 * The language a short text he said is in, by its script (N-21): kana → ja, Hangul → ko, Han only → zh-Hant, Latin →
 * en; null when it cannot tell (digits, emoji).
 */
export function scriptLang(text: string): Lang | null {
  if (KANA.test(text)) return 'ja';
  if (HANGUL.test(text)) return 'ko';
  if (/[\u4e00-\u9fff]/.test(text)) return 'zh-Hant';
  return /[A-Za-z]/.test(text) ? 'en' : null;
}

/** A story (card episodes) in `lang`, with localText's fallback. */
export function localStory(s: LocalStory | null | undefined, lang: string): string[] {
  if (!s) return [];
  const r = s as unknown as Record<string, string[] | undefined>;
  return (r[lang]?.length ? r[lang] : lang === 'ko' ? s.en : undefined) ?? s.ja;
}

export interface PublicUser {
  id: string;
  nickname: string;
  via: 'line' | 'email';
  ageConfirmedAt: string;
  lang: Lang;
}

export interface OwnedCard { cardId: string; copies: number; firstOwnedAt: string; viaSerial: boolean }
export interface MemoryCard { id: string; star: StarId; title: string; createdAt: string }

/** `points` is the persisted/API compatibility name for the single user-facing Star Stone balance. */
export interface Wallet { points: number; freePulls: number }
export interface Affinity { star: StarId; xp: number; level: number }

export function levelFromXp(xp: number): number { return Math.floor(xp / RULES.xpPerLevel) + 1; }
export function xpIntoLevel(xp: number): number { return xp % RULES.xpPerLevel; }

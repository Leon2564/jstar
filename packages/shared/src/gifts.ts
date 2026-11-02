import type { LocalText } from './domain';
import { GIFT_RULES } from './rules';

/**
 * The gift catalogue (#77, docs/requirements.md §14.3): what he can give her with points, the same twenty items for all
 * five talents. Five everyday gifts, then fifteen that come from the talents' tastes (persona `likes`, PROVISIONAL
 * until the persona bibles are signed off, #84). Which of them each talent likes is not here: that is her secret,
 * told in conversation (./tastes.ts, which the web never ships in its entry bundle). Ids are neutral on purpose, so
 * the catalogue itself gives nothing away.
 *
 * Every gift is a fixed digital item bought with points: no random box, nothing physical, nothing that can be cashed
 * out, resold or passed to another user (docs/compliance-jp.md §1, §4). Prices live in GIFT_RULES (待确认).
 * Kept free of zod, so the web can import it without the validator.
 */
export const GIFT_IDS = [
  'bouquet', 'macarons', 'candle', 'teddy', 'alarm',
  'melonpan', 'cocoa', 'cat-plush',
  'yakiniku', 'karaoke-mic', 'fes-towel',
  'new-game', 'konbini-sweets', 'blanket',
  'tea-leaves', 'paperback', 'letter-set',
  'lipstick', 'travel-guide', 'night-view'
] as const satisfies readonly (keyof typeof GIFT_RULES.prices)[];
export type GiftId = (typeof GIFT_IDS)[number];
export const isGiftId = (v: unknown): v is GiftId => typeof v === 'string' && (GIFT_IDS as readonly string[]).includes(v);

/** How a gift lands with her: one she likes, an ordinary one, or one she would rather not have. */
export const GIFT_TASTES = ['liked', 'plain', 'disliked'] as const;
export type GiftTaste = (typeof GIFT_TASTES)[number];

export interface GiftDef {
  id: GiftId;
  /** The emoji, kept for plain-text places and as the tile's fallback when its picture cannot load. */
  icon: string;
  /** Its picture (#77, drawn with gpt-image-2: tools/media/src/giftIcons.ts), under the site's public files. */
  image: string;
  name: LocalText;
  price: number;
}

const NAMES: Record<GiftId, [string, LocalText]> = {
  bouquet: ['💐', { ja: '花束', 'zh-Hant': '花束', en: 'Bouquet', ko: '꽃다발' }],
  macarons: ['🧁', { ja: 'マカロン', 'zh-Hant': '馬卡龍', en: 'Macarons', ko: '마카롱' }],
  candle: ['🕯️', { ja: 'アロマキャンドル', 'zh-Hant': '香氛蠟燭', en: 'Aroma candle', ko: '아로마 캔들' }],
  teddy: ['🧸', { ja: 'くまのぬいぐるみ', 'zh-Hant': '小熊玩偶', en: 'Teddy bear', ko: '곰 인형' }],
  alarm: ['⏰', { ja: '目覚まし時計', 'zh-Hant': '鬧鐘', en: 'Alarm clock', ko: '자명종 시계' }],
  melonpan: ['🍈', { ja: 'メロンパン', 'zh-Hant': '菠蘿麵包', en: 'Melon bread', ko: '메론빵' }],
  cocoa: ['☕', { ja: 'ホットココア', 'zh-Hant': '熱可可', en: 'Hot cocoa', ko: '핫초코' }],
  'cat-plush': ['🐈', { ja: 'ねこのぬいぐるみ', 'zh-Hant': '貓咪玩偶', en: 'Cat plush', ko: '고양이 인형' }],
  yakiniku: ['🍖', { ja: '焼肉ディナー', 'zh-Hant': '燒肉晚餐', en: 'Yakiniku dinner', ko: '야키니쿠 디너' }],
  'karaoke-mic': ['🎤', { ja: 'カラオケマイク', 'zh-Hant': '卡拉OK麥克風', en: 'Karaoke mic', ko: '노래방 마이크' }],
  'fes-towel': ['🎪', { ja: 'フェスタオル', 'zh-Hant': '音樂祭毛巾', en: 'Festival towel', ko: '페스티벌 타월' }],
  'new-game': ['🎮', { ja: '新作ゲーム', 'zh-Hant': '新作遊戲', en: 'New video game', ko: '신작 게임' }],
  'konbini-sweets': ['🍮', { ja: 'コンビニスイーツ', 'zh-Hant': '超商甜點', en: 'Konbini sweets', ko: '편의점 디저트' }],
  blanket: ['🛌', { ja: 'ぬくぬく毛布', 'zh-Hant': '暖呼呼毛毯', en: 'Cozy blanket', ko: '포근한 담요' }],
  'tea-leaves': ['🫖', { ja: '紅茶の茶葉', 'zh-Hant': '紅茶茶葉', en: 'Black tea leaves', ko: '홍차 찻잎' }],
  paperback: ['📖', { ja: '文庫本', 'zh-Hant': '文庫本', en: 'Paperback novel', ko: '문고본 소설' }],
  'letter-set': ['✉️', { ja: 'レターセット', 'zh-Hant': '信紙組', en: 'Letter set', ko: '편지지 세트' }],
  lipstick: ['💄', { ja: 'リップ', 'zh-Hant': '唇膏', en: 'Lipstick', ko: '립스틱' }],
  'travel-guide': ['🧳', { ja: '旅行ガイドブック', 'zh-Hant': '旅遊指南', en: 'Travel guidebook', ko: '여행 가이드북' }],
  'night-view': ['🌃', { ja: '夜景ディナー', 'zh-Hant': '夜景晚餐', en: 'Night-view dinner', ko: '야경 디너' }]
};

export const GIFTS: readonly GiftDef[] = GIFT_IDS.map((id) => ({ id, icon: NAMES[id][0], image: `/gifts/${id}.webp`, name: NAMES[id][1], price: GIFT_RULES.prices[id] }));
export const giftById = (id: string): GiftDef | undefined => GIFTS.find((g) => g.id === id);

/**
 * What he has learned she likes, as chat memory keeps it (facts `her_wishes`, #77): gift ids, comma-separated. The
 * API writes it (never the persona service's memory model) when she mentions one or reacts to one he gave her.
 */
export const WISHES_FACT = 'her_wishes';
export function parseWishes(v: string | null | undefined): GiftId[] {
  return [...new Set((v ?? '').split(',').map((s) => s.trim()).filter(isGiftId))];
}
export const formatWishes = (ids: readonly GiftId[]): string => [...new Set(ids)].join(',');

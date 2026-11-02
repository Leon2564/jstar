import type { StarId } from './cast';

/**
 * Card ids without the catalog: the main bundle validates persisted state and API payloads with these, and the
 * 150-card catalog (titles, lines, stories) loads only with the pages that show cards.
 */
const CARD_ID = /^s1-(mahiro|nana|unpai|alice|eimi)-(0[1-9]|[12][0-9]|30)$/;
export const isCardId = (v: unknown): v is string => typeof v === 'string' && CARD_ID.test(v);
export const starOfCard = (id: string): StarId => id.split('-')[1] as StarId;

/**
 * Star Genesis · First Five — the active 125 cards come from @jstar/shared/catalog, the same module
 * the API seeds from, so web and server never disagree about a card.
 */
import { CATALOG, CATALOG_BY_ID, SERIES } from '@jstar/shared/catalog';
import { RARITIES, RARITY_ORDER, localText, type CardDef, type Rarity } from '@jstar/shared/domain';

export type { CardDef, Rarity };
export type Source = CardDef['source'];
export { RARITIES, RARITY_ORDER, SERIES };

export const CARDS: CardDef[] = CATALOG;
export const CARD_BY_ID: Record<string, CardDef> = CATALOG_BY_ID;

export { isCardId } from './cardIds';

export const cardTitle = (card: CardDef, lang: string) => localText(card.title, lang);
export const cardLine = (card: CardDef, lang: string) => localText(card.line, lang);

/** Art variants next to the full card (docs/catalog-spec.md): card.webp, card-sm.webp, lock.webp. */
export function cardArt(card: CardDef, size: 'full' | 'sm' | 'lock' = 'full'): string | null {
  if (!card.art) return null;
  return size === 'full' ? card.art : card.art.replace(/card\.webp$/, size === 'sm' ? 'card-sm.webp' : 'lock.webp');
}

/** A card-level motion portrait, when a matching clip has been visually approved. */
export function cardMotion(card: CardDef): string | null {
  if (!['alice', 'eimi', 'nana', 'unpai'].includes(card.star) || card.rarity === 'N' || !card.art) return null;
  return card.art.replace(/card\.webp$/, 'motion.mp4');
}

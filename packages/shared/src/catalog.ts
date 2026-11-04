import raw from './catalog.s1.json';
import { RARITIES, STAR_IDS, type CardDef, type LocalStory, type LocalText, type Rarity, type StarId, type VariantDef } from './domain';
import { VARIANT_CARDS, VARIANT_RULES } from './rules';

/** One entry of catalog.s1.json (docs/catalog-spec.md). Written by the content workstream. */
export interface CatalogEntry {
  id: string; star: StarId; tier: Rarity; title: LocalText; scene?: string;
  line?: LocalText; story?: LocalStory; art?: string; voice?: string;
}

const nonEmpty = (t?: LocalText) => (t && t.ja ? t : null);
const storyOf = (s?: LocalStory) => (s && s.ja?.some((p) => p.trim()) ? s : null);

/**
 * A variant card's scenes and media, by convention from its talent (docs/catalog-spec.md): one variant per talent,
 * so the ids stay the same whichever card the owner picks (#84). Scripts come from #76, clips from #81.
 */
export function variantDef(star: StarId): VariantDef {
  return {
    scene: `variant-${star}-1`,
    enterClip: `${star}-variant-enter`,
    closeClip: `${star}-variant-close`,
    homeVideo: `${star}-variant-home`,
    layers: VARIANT_RULES.layerLevels.map((level) => ({ level, scene: `variant-${star}-${level}` }))
  };
}

const LEGACY_CATALOG: CardDef[] = (raw as CatalogEntry[]).map((e) => ({
  id: e.id, star: e.star, rarity: e.tier, title: e.title, line: nonEmpty(e.line), story: storyOf(e.story),
  source: 'ai', art: e.art ?? null, voice: e.voice ?? null,
  ...(VARIANT_CARDS.includes(e.id) ? { variant: variantDef(e.star) } : {})
}));

/** Five replaceable scene groups per talent; each has one card of every tier. */
export interface SceneCardGroup { id: string; star: StarId; index: number; cards: Record<Rarity, string> }
const GROUP_CARD_NUMBERS: readonly Record<Rarity, number>[] = [
  { N: 1, R: 11, SR: 19, SSR: 26, UR: 30 },
  { N: 2, R: 12, SR: 20, SSR: 27, UR: 16 },
  { N: 3, R: 13, SR: 21, SSR: 28, UR: 17 },
  { N: 4, R: 14, SR: 22, SSR: 29, UR: 18 },
  { N: 5, R: 15, SR: 23, SSR: 24, UR: 25 }
];
export const SCENE_GROUPS: SceneCardGroup[] = STAR_IDS.flatMap((star) => GROUP_CARD_NUMBERS.map((numbers, index) => ({
  id: `${star}-scene-${index + 1}`, star, index: index + 1,
  cards: Object.fromEntries(RARITIES.map((tier) => [tier, `s1-${star}-${String(numbers[tier]).padStart(2, '0')}`])) as Record<Rarity, string>
})));
const originalById = Object.fromEntries(LEGACY_CATALOG.map((card) => [card.id, card])) as Record<string, CardDef>;
export const CATALOG: CardDef[] = SCENE_GROUPS.flatMap((group) => RARITIES.map((tier) => ({
  ...originalById[group.cards[tier]], rarity: tier
})));
/** Past collection entries stay readable even when they are not in the current draw pool. */
export const CATALOG_BY_ID: Record<string, CardDef> = { ...originalById, ...Object.fromEntries(CATALOG.map((card) => [card.id, card])) };
export const ACTIVE_CARD_IDS: ReadonlySet<string> = new Set(CATALOG.map((card) => card.id));
export const SERIES = { id: 'S1', name: 'Star Genesis', set: 'First Five' } as const;

/**
 * Structural check used by tests and the API at boot: 125 cards, 25 per talent, five per tier; and the
 * variants (#47): every selected card exists and carries its variant, at most one per talent, layers as in VARIANT_RULES.
 */
export function catalogProblems(cards: CardDef[] = CATALOG, variants: readonly string[] = VARIANT_CARDS): string[] {
  const want: Record<Rarity, number> = { N: 5, R: 5, SR: 5, SSR: 5, UR: 5 };
  const out: string[] = [];
  if (new Set(cards.map((c) => c.id)).size !== cards.length) out.push('duplicate ids');
  for (const star of STAR_IDS) {
    const mine = cards.filter((c) => c.star === star);
    for (const r of RARITIES) {
      const n = mine.filter((c) => c.rarity === r).length;
      if (n !== want[r]) out.push(`${star} ${r}: ${n} (want ${want[r]})`);
    }
    const v = mine.filter((c) => c.variant);
    if (v.length > 1) out.push(`${star} variants: ${v.length} (want at most 1)`);
  }
  const layers = JSON.stringify(VARIANT_RULES.layerLevels);
  for (const id of variants) {
    const card = cards.find((c) => c.id === id);
    if (!card) out.push(`variant ${id}: no such card`);
    else if (!card.variant) out.push(`variant ${id}: missing variant`);
    else if (JSON.stringify(card.variant.layers.map((l) => l.level)) !== layers) out.push(`variant ${id}: layers`);
  }
  for (const c of cards) if (c.variant && !variants.includes(c.id)) out.push(`variant ${c.id}: not selected`);
  return out;
}

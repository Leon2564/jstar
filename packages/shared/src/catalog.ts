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

/** Star Genesis · First Five: 5 talents × 30 cards, all AI-generated (labelled in the UI). */
export const CATALOG: CardDef[] = (raw as CatalogEntry[]).map((e) => ({
  id: e.id, star: e.star, rarity: e.tier, title: e.title, line: nonEmpty(e.line), story: storyOf(e.story),
  source: 'ai', art: e.art ?? null, voice: e.voice ?? null,
  ...(VARIANT_CARDS.includes(e.id) ? { variant: variantDef(e.star) } : {})
}));

export const CATALOG_BY_ID: Record<string, CardDef> = Object.fromEntries(CATALOG.map((c) => [c.id, c]));
export const SERIES = { id: 'S1', name: 'Star Genesis', set: 'First Five' } as const;

/**
 * Structural check used by tests and the API at boot: 150 cards, 30 per talent, N10 R8 SR7 SSR4 UR1 each; and the
 * variants (#47): every selected card exists and carries its variant, at most one per talent, layers as in VARIANT_RULES.
 */
export function catalogProblems(cards: CardDef[] = CATALOG, variants: readonly string[] = VARIANT_CARDS): string[] {
  const want: Record<Rarity, number> = { N: 10, R: 8, SR: 7, SSR: 4, UR: 1 };
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

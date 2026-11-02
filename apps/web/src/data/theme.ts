import type { StarId } from './cast';

/**
 * Per-talent art direction, taken from her hero scene: an accent colour for type and light,
 * and where her face sits in the landscape and portrait clips (0–1), so copy is placed around it, never over it.
 * face16 is measured on the hero-16x9 posters (face centre ÷ width); re-measure whenever a hero clip is replaced.
 */
export interface StarTheme { accent: string; face16: number; face9: number }

export const THEME: Record<StarId, StarTheme> = {
  mahiro: { accent: '#E8B98A', face16: 0.74, face9: 0.5 }, // amber lamp, city window
  nana: { accent: '#B8A4E3', face16: 0.69, face9: 0.5 }, // lavender reading nook
  unpai: { accent: '#7ED0F2', face16: 0.86, face9: 0.5 }, // keeps her centred in the profile's tall desktop crop
  alice: { accent: '#A9D8C6', face16: 0.69, face9: 0.5 }, // white roses in the glasshouse
  eimi: { accent: '#EFA0B8', face16: 0.71, face9: 0.55 } // rosé over the skyline
};

/** Autograph images (transparent PNG/WebP), shown only once the agency has supplied them. */
export const SIGNATURE: Partial<Record<StarId, string>> = {};

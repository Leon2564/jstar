/**
 * Her variant scenes' names (#76), without their words: the web player asks here whether a scene id is one of them
 * before it asks the API for the script (drafts are never bundled), and the API and the invite job name them by
 * these. No zod, no JSON, so it costs the bundles nothing.
 *
 * Ids follow catalog.ts `variantDef()`: `variant-<star>-<layer>` for the four layers (VARIANT_RULES.layerLevels), and
 * the clips #81 produces for each variant card, `<star>-variant-enter` / `-close` / `-home`.
 */
import { STAR_IDS, type StarId } from '../domain';
import { VARIANT_RULES } from '../rules';

export const variantSceneId = (star: StarId, layer: number): string => `variant-${star}-${layer}`;

const RE = new RegExp(`^variant-(${STAR_IDS.join('|')})-(\\d{1,2})$`);
/** The talent and layer of a variant scene id, or null for any other id (or a layer that is not one of hers). */
export function variantSceneOf(id: string): { star: StarId; layer: number } | null {
  const m = RE.exec(id);
  const layer = m ? Number(m[2]) : NaN;
  return m && (VARIANT_RULES.layerLevels as readonly number[]).includes(layer) ? { star: m[1] as StarId, layer } : null;
}

/** Her variant card's clips (catalog.ts `variantDef`): entering in it, close in it, her home loop in it. */
export const variantClips = (star: StarId) => ({ enter: `${star}-variant-enter`, close: `${star}-variant-close`, home: `${star}-variant-home` });

/**
 * #81's clips still to be made: a variant scene may use a pending clip before it exists, and until it does the scene is
 * demo-only (./triggers.ts `scenePlayable`), with her own clips in its place (./media.ts `previewScript`). All fifteen
 * landed in the web catalogue on 2026-09-28 (the home also in 16:9; apps/web/src/data/media.scene.gen.ts), so the list is empty: her variant
 * scenes publish, and the web test checks that every clip exists.
 */
export const PENDING_VARIANT_CLIPS: readonly string[] = [];

/**
 * Her four variant scenes (#76, docs/requirements.md §14.1): what her variant card opens, layer by layer, as its own
 * level rises — 1 the reveal (she walks in wearing it), 3 time together in it, 6 close (her voice at his ear; she
 * stops anything beyond, in character), 10 a hug, after which her home shows her in it (and he may pin it there).
 *
 * Reviewed (#84, owner 2026-09-28) and published in SCENES (./index.ts). #81's clips exist (2026-09-28), so by the
 * publish rule (./triggers.ts `scenePlayable`) they play in production as well as on the test site.
 *
 * The scripts name their layer (`trigger.variantLayer`), never a card: the card is her talent's from VARIANT_CARDS,
 * filled in here, so the owner's final pick (#84) is a one-line change in rules.ts. A talent with no variant card
 * selected has no variant scenes.
 */
import type { StarId } from '../domain';
import { variantCardOf } from '../variants';
import type { SceneScript } from './schema';
import mahiro1 from './mahiro/variant-mahiro-1.json';
import mahiro3 from './mahiro/variant-mahiro-3.json';
import mahiro6 from './mahiro/variant-mahiro-6.json';
import mahiro10 from './mahiro/variant-mahiro-10.json';
import nana1 from './nana/variant-nana-1.json';
import nana3 from './nana/variant-nana-3.json';
import nana6 from './nana/variant-nana-6.json';
import nana10 from './nana/variant-nana-10.json';
import unpai1 from './unpai/variant-unpai-1.json';
import unpai3 from './unpai/variant-unpai-3.json';
import unpai6 from './unpai/variant-unpai-6.json';
import unpai10 from './unpai/variant-unpai-10.json';
import alice1 from './alice/variant-alice-1.json';
import alice3 from './alice/variant-alice-3.json';
import alice6 from './alice/variant-alice-6.json';
import alice10 from './alice/variant-alice-10.json';
import eimi1 from './eimi/variant-eimi-1.json';
import eimi3 from './eimi/variant-eimi-3.json';
import eimi6 from './eimi/variant-eimi-6.json';
import eimi10 from './eimi/variant-eimi-10.json';

/** The files as written, before the card is filled in (every one of them, whatever the selection). */
export const VARIANT_SCENE_FILES: SceneScript[] = [
  mahiro1, mahiro3, mahiro6, mahiro10, nana1, nana3, nana6, nana10, unpai1, unpai3, unpai6, unpai10,
  alice1, alice3, alice6, alice10, eimi1, eimi3, eimi6, eimi10
] as unknown as SceneScript[];

/** Her layer's script with her variant card as its trigger; null when she has no variant card selected. */
function withCard(s: SceneScript): SceneScript | null {
  const card = variantCardOf(s.meta.star);
  return card ? { ...s, meta: { ...s.meta, trigger: { ...s.meta.trigger, variantCard: card } } } : null;
}

/** The variant scenes of the current selection (VARIANT_CARDS), ready for parseScene. */
export const VARIANT_SCENES: SceneScript[] = VARIANT_SCENE_FILES.flatMap((s) => withCard(s) ?? []);

export const variantSceneById = (id: string): SceneScript | undefined => VARIANT_SCENES.find((s) => s.meta.id === id);
export const variantScenesFor = (star: StarId): SceneScript[] => VARIANT_SCENES.filter((s) => s.meta.star === star);

export * from './variantIds';

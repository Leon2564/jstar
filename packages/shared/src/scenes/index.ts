/**
 * Every scene script, by id. Add a scene by dropping `<star>/<id>.json` here and listing it below; the API refuses
 * to boot, and the shared tests fail, if a script does not pass `parseScene` (./schema).
 *
 * Published = listed here (lines reviewed, #84: owner, 2026-09-28). Whether a mode may play one is the publish rule
 * (./triggers.ts `scenePlayable`): production plays a scene once its script is reviewed and all its clips exist. Her
 * variant scenes (#76) have #81's clips and play everywhere; the five scenes (#66–#70) wait for #80's, so for now they
 * play on the test site only, her existing clips standing in (./media.ts `previewScript`).
 *
 * This module stays free of zod at runtime so the web player can import the scripts without the validator.
 */
import { localText, type StarId } from '../domain';
import type { SceneScript } from './schema';
import mahiroDemoEvening from './mahiro/demo-evening.json';
import mahiroWelcomeHome from './mahiro/welcome-home.json';
import nanaReadAloud from './nana/read-aloud.json';
import nanaReadAloudRain from './nana/read-aloud-rain.json';
import unpaiPrivateStream from './unpai/private-stream.json';
import aliceNightGreenhouse from './alice/night-greenhouse.json';
import eimiOgiri from './eimi/ogiri.json';
import { VARIANT_SCENES } from './variantScenes';

/** The five scenes (#66–#70; 奈々's has a rainy-night version). */
export const MAIN_SCENES: SceneScript[] = [
  mahiroWelcomeHome, nanaReadAloud, nanaReadAloudRain, unpaiPrivateStream, aliceNightGreenhouse, eimiOgiri
] as unknown as SceneScript[];

/** The demo scene, the five, and her variant scenes (with her variant card filled in, ./variantScenes.ts). */
export const SCENES: SceneScript[] = [mahiroDemoEvening as unknown as SceneScript, ...MAIN_SCENES, ...VARIANT_SCENES];

const BY_ID = new Map(SCENES.map((s) => [s.meta.id, s]));
export const sceneById = (id: string): SceneScript | undefined => BY_ID.get(id);
export const scenesFor = (star: StarId): SceneScript[] => SCENES.filter((s) => s.meta.star === star);

/**
 * A scene's memory card title in `lang` (N-20). The card keeps the title in the language it was made in; this finds
 * the memory it names in its scene (by the scene id, else among her scenes) and gives it in `lang`. A title that is
 * not a scene's (a chat's, written by the model) comes back as it is.
 */
export function sceneMemoryTitle(title: string, lang: string, sceneId?: string | null, star?: StarId): string {
  const scripts = sceneId && BY_ID.get(sceneId) ? [BY_ID.get(sceneId)!] : star ? scenesFor(star) : [];
  for (const script of scripts) {
    for (const step of script.steps) {
      const t = step.type === 'effect' ? step.memory?.title : undefined;
      if (t && Object.values(t).some((v) => typeof v === 'string' && v.slice(0, 40) === title)) return localText(t, lang).slice(0, 40);
    }
  }
  return title;
}

export * from './engine';
export * from './minigames';
export * from './triggers';
export * from './constants';
export * from './media';
export * from './speech';
export { isInteractive, targetsOf } from './graph';
export type * from './schema';

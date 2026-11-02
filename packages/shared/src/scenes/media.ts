/**
 * The clips a scene needs that do not exist yet, and what stands in for them (#80 scene clips, #81 variant clips).
 * Part of the publish rule (./triggers.ts `scenePlayable`): production plays a scene only when every clip it uses
 * exists; until then it is demo-only, and on the test site her existing clips stand in (`previewScript`).
 *
 * "Exists" is declared here, not looked up: the web catalogue (apps/web/src/data/media.gen.ts, the scenes' clips in
 * media.scene.gen.ts) is the web's, and the web test checks the declaration both ways — every clip a script uses is in
 * the catalogue or declared pending here, and nothing declared pending is in the catalogue. #80's clips are listed in LANDED_SCENE_CLIPS and #81's are out of
 * variantIds.ts PENDING_VARIANT_CLIPS (both 2026-09-28), so every scene publishes; a new shot waits here until made.
 */
import type { SceneScript } from './schema';
import { PENDING_VARIANT_CLIPS } from './variantIds';

/**
 * The scenes' own clips (#80): `<star>-scene-<sceneId>-<shot>`, pending until listed in LANDED_SCENE_CLIPS. Her wide
 * shot reuses the catalogue family `<star>-hero` (the player plays her seated talk / idle loops on it,
 * apps/web/src/scene/stage.tsx `baseLoop`), うんぱい's alley `unpai-night`.
 */
export const PENDING_MEDIA_PATTERN = /^(mahiro|nana|unpai|alice|eimi)-scene-[a-z0-9-]+$/;

/**
 * #80's scene clips that have landed in the web catalogue (9:16 1080p as `<id>-9x16`, and `<id>-16x9` for some wide
 * shots; the web unit tests check each is playable). The first 19 on 2026-09-27; the rest of the storyboard on 09-28
 * (うんぱい running off, the prop close-ups, アリス's hands at the piano, 奈々 looking up from the page, えいみ's
 * perfume). A new scene shot is pending until it is listed here.
 */
export const LANDED_SCENE_CLIPS: readonly string[] = [
  'alice-scene-night-greenhouse-flowers', 'alice-scene-night-greenhouse-hands', 'alice-scene-night-greenhouse-piano', 'alice-scene-night-greenhouse-piano-prop', 'alice-scene-night-greenhouse-sleeve',
  'eimi-scene-ogiri-empty', 'eimi-scene-ogiri-hug', 'eimi-scene-ogiri-leave', 'eimi-scene-ogiri-perfume', 'eimi-scene-ogiri-return', 'eimi-scene-ogiri-twirl',
  'mahiro-scene-welcome-home-close', 'mahiro-scene-welcome-home-coffee', 'mahiro-scene-welcome-home-cup', 'mahiro-scene-welcome-home-pout', 'mahiro-scene-welcome-home-rps',
  'nana-scene-read-aloud-book', 'nana-scene-read-aloud-lookup', 'nana-scene-read-aloud-read', 'nana-scene-read-aloud-shy',
  'unpai-scene-private-stream-headphones', 'unpai-scene-private-stream-headphones-prop', 'unpai-scene-private-stream-leave', 'unpai-scene-private-stream-run', 'unpai-scene-private-stream-share'
];

/** The scenes' own clips (#80's, by the pattern) that the scripts use, landed or not, sorted. */
export function sceneClips(scripts: readonly SceneScript[]): string[] {
  const ids = scripts.flatMap((s) => s.steps.flatMap((st) => (st.type === 'clip' && PENDING_MEDIA_PATTERN.test(st.media) ? [st.media] : [])));
  return [...new Set(ids)].sort();
}

/**
 * A clip still to be made: #80's scene clips (by pattern, until landed), or #81's variant clips while declared pending.
 * An exact id (`…-9x16`, `…-16x9`) is its family's.
 */
export const isPendingMedia = (id: string): boolean => {
  const family = id.replace(/-(9x16|16x9|1x1)$/, '');
  return (PENDING_MEDIA_PATTERN.test(family) && !LANDED_SCENE_CLIPS.includes(family)) || PENDING_VARIANT_CLIPS.includes(family);
};

/** Every clip the scripts use (idle loops included) that does not exist yet, sorted. */
export function pendingMedia(scripts: readonly SceneScript[]): string[] {
  const ids = scripts.flatMap((s) => [
    ...(s.meta.idle && isPendingMedia(s.meta.idle) ? [s.meta.idle] : []),
    ...s.steps.flatMap((st) => (st.type === 'clip'
      ? [st.media, ...(st.variants ?? []).map((v) => v.media)].filter(isPendingMedia)
      : []))
  ]);
  return [...new Set(ids)].sort();
}

/** Every clip of the script (and its idle loop) exists. */
export const mediaReady = (script: SceneScript): boolean => pendingMedia([script]).length === 0;

/**
 * Existing clips standing in for pending ones (demo mode only): her in the room for wide shots and entrances, her
 * close breathing loop for close and detail shots, her room at night for empty shots.
 */
export const PREVIEW_STAND_IN: Record<'wide' | 'enter' | 'close' | 'detail' | 'empty', 'hero' | 'breath' | 'night'> = {
  wide: 'hero', enter: 'hero', close: 'breath', detail: 'breath', empty: 'night'
};

/**
 * A script as demo mode plays it: the same steps, with every pending clip replaced by the talent's stand-in
 * (`<star>-hero` / `-breath` / `-night`), and a pending idle loop (the variant scenes' `<star>-variant-home`, #81) by
 * her in the room. A script with every clip in place comes back unchanged. Production never plays a script with
 * pending clips (`scenePlayable`), so this is only ever what the test site and local demos see.
 */
export function previewScript(script: SceneScript): SceneScript {
  if (mediaReady(script)) return script;
  const star = script.meta.star;
  const idle = script.meta.idle && isPendingMedia(script.meta.idle) ? `${star}-${PREVIEW_STAND_IN.wide}` : script.meta.idle;
  return {
    ...script,
    ...(idle !== script.meta.idle ? { meta: { ...script.meta, idle } } : {}),
    steps: script.steps.map((s) => {
      if (s.type !== 'clip') return s;
      // A variant's footage still to come (#81) is not stood in for: the shot as written plays instead, so owning the
      // card never shows a stand-in where the ordinary shot would do.
      const { variants: written, ...clip } = s;
      const variants = written?.filter((v) => !isPendingMedia(v.media));
      const kept = variants?.length ? { ...clip, variants } : clip;
      return isPendingMedia(s.media) ? { ...kept, media: `${star}-${PREVIEW_STAND_IN[s.shot]}` } : kept;
    })
  };
}

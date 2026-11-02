/**
 * What a scene sounds like (#82): its music from the start (`meta.audio.bgm`), a clip that changes it (`clip.music`:
 * アリス's piano on the keys shot, うんぱい's song as she hands over the earphone, silence when the lights go out) and
 * the weather at her window (`meta.audio.ambience`). lib/sound.ts decides whether anything is heard (the sound switch,
 * his first tap); her voice ducks it (player.tsx `playAudio`). Leaving hands the music back to the site.
 */
import { useEffect, useRef } from 'react';
import type { MusicId } from '@jstar/shared/scenes/audio';
import type { ClipStep, SceneScript } from '@jstar/shared/scenes';
import { ambience, sceneMusic } from '../lib/sound';

/** The scene's own music: its BGM, silence when it names weather only, `undefined` when it names nothing (the site's). */
export function baseMusic(script: SceneScript): MusicId | null | undefined {
  return script.meta.audio ? (script.meta.audio.bgm ?? null) : undefined;
}

const cue = (m: ClipStep['music']): MusicId | null | undefined => (m === undefined ? undefined : m === 'none' ? null : m);

/**
 * The music at a clip when the run is picked up after a reload: the nearest cue at or before it in the script, else the
 * scene's own.
 */
export function musicAt(script: SceneScript, clip: ClipStep | null): MusicId | null | undefined {
  const at = clip ? script.steps.findIndex((s) => s.id === clip.id) : -1;
  for (let i = at; i >= 0; i--) {
    const s = script.steps[i];
    if (s.type === 'clip' && s.music !== undefined) return cue(s.music);
  }
  return baseMusic(script);
}

/**
 * Plays the scene's sound while the player is open. `shot` is the clip on screen; `run` the run's id (a new run, "again",
 * starts the music over).
 */
export function useSceneAudio(script: SceneScript, shot: ClipStep | null, run: string | undefined) {
  const base = baseMusic(script);
  const now = useRef<{ run: string | undefined; music: MusicId | null | undefined } | null>(null);

  useEffect(() => {
    ambience(script.meta.audio?.ambience ?? null);
    // Leaving (and StrictMode's rehearsal unmount): the site's music back, and the next mount starts over.
    return () => { sceneMusic(undefined); ambience(null); now.current = null; };
  }, [script]);

  useEffect(() => {
    const prev = now.current;
    // First sight of this run: a reload picks the music up where the run is. Another run ("again"): from the top.
    const opened = !prev || prev.run === undefined;
    const restarted = !opened && prev!.run !== run;
    // Otherwise a cut that names music changes it, and anything else lets it carry on.
    const music = restarted ? base : shot?.music !== undefined ? cue(shot.music) : opened ? (shot ? musicAt(script, shot) : base) : prev!.music;
    // Unchanged: say nothing, or a piece that has already ended (and given way to the scene's BGM) would start again.
    if (!opened && !restarted && music === prev!.music) return;
    now.current = { run, music };
    sceneMusic(music, base ?? null);
  }, [script, shot, run, base]);
}

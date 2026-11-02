/**
 * Sound front door (in the entry bundle, tiny). The synthesiser itself (components/audioEngine.ts) is its own
 * chunk, fetched on the first interaction. The site's own sounds are generated with WebAudio (nothing to license); a
 * scene's music is original Lyria 3 work and its weather is synthesised (docs/asset-bible.md §十三).
 *
 * - Background music and UI sounds start on the first tap/key (browsers refuse audio before that).
 * - The choice is remembered; it defaults to off when the visitor prefers reduced motion or saves data.
 * - Everything pauses while the tab is hidden.
 * - Voice files (/voice/...) are optional: played when present, silently skipped when not.
 * - A scene's music and weather (#82) follow the same switch and the same first tap; her voice ducks them.
 */
import { useSyncExternalStore } from 'react';
import type { MusicId } from '@jstar/shared/scenes/audio';
import type { Ambience, Engine, Score, SfxName } from '../components/audioEngine';

const KEY = 'jstar.sound';
const subs = new Set<() => void>();
let on = readPref();
let unlocked = false;
let engine: Promise<Engine> | null = null;
/** Rain at her window (#63): plays with the music, stops with it. */
let amb: Ambience = null;
/** The scene's music (#82); undefined = the site's own background music. */
let score: Score;

function quiet(): boolean {
  if (typeof window === 'undefined') return true;
  const conn = (navigator as Navigator & { connection?: { saveData?: boolean } }).connection;
  return !!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches || !!conn?.saveData;
}
function readPref(): boolean {
  try {
    const v = localStorage.getItem(KEY);
    if (v === 'on' || v === 'off') return v === 'on';
  } catch { /* storage blocked */ }
  return !quiet();
}

const load = () => (engine ??= import('../components/audioEngine').then((m) => m.createEngine()));
const withEngine = (fn: (e: Engine) => void) => { if (unlocked) void load().then(fn).catch(() => { /* no WebAudio */ }); };

export const soundOn = () => on;
export function setSound(next: boolean) {
  on = next;
  try { localStorage.setItem(KEY, next ? 'on' : 'off'); } catch { /* storage blocked */ }
  subs.forEach((f) => f());
  if (next) { unlocked = true; withEngine((e) => { e.resume(); e.score(score); e.bgm(true); e.ambience(amb); }); } else withEngine((e) => { e.bgm(false); e.ambience(null); });
}
export function useSound(): boolean {
  return useSyncExternalStore((f) => { subs.add(f); return () => subs.delete(f); }, soundOn, () => false);
}

/** A UI sound, if sound is on and the page has been interacted with. */
export function sfx(name: SfxName) { if (on) withEngine((e) => e.sfx(name)); }
/** Lower the music while something else speaks (a PV, a voice line). */
export function duck(down: boolean) { withEngine((e) => e.duck(down)); }
/** The livelier score under the PV. Explicitly asked for, so it plays even when background music is off. */
export function pvScore(play: boolean) { if (play) unlocked = true; withEngine((e) => { e.resume(); e.pv(play); }); }

/** The weather you hear in her room (#63); null stops it. Only with sound on, like the music. */
export function ambience(kind: Ambience) {
  amb = kind;
  if (on && kind) withEngine((e) => e.ambience(kind));
  // Stopping never fetches the engine just to silence it.
  else if (engine) void engine.then((e) => e.ambience(null)).catch(() => { /* no WebAudio */ });
}

/**
 * A scene's music (#82): `music` now (null = silence), `then` after a piece that does not loop; `undefined` gives the
 * music back to the site when he leaves. Remembered, so it starts on his first tap or when he turns sound on.
 */
export function sceneMusic(music: MusicId | null | undefined, then: MusicId | null = null) {
  score = music === undefined ? undefined : { music, then };
  if (on) withEngine((e) => e.score(score));
  // Leaving never fetches the engine just to hand the music back.
  else if (engine) void engine.then((e) => e.score(score)).catch(() => { /* no WebAudio */ });
}

/** Starts listening for the first interaction; call once at start-up. */
export function installSound() {
  if (typeof window === 'undefined') return;
  const first = () => {
    window.removeEventListener('pointerdown', first, true);
    window.removeEventListener('keydown', first, true);
    unlocked = true;
    if (on) withEngine((e) => { e.resume(); e.score(score); e.bgm(true); e.ambience(amb); });
  };
  window.addEventListener('pointerdown', first, true);
  window.addEventListener('keydown', first, true);
  document.addEventListener('visibilitychange', () => withEngine((e) => (document.hidden ? e.suspend() : e.resume())));
}

const found = new Map<string, Promise<boolean>>();
/** Whether an optional audio file exists (SPA fallbacks answer 200 with HTML, so the type is checked too). */
export function audioExists(url: string): Promise<boolean> {
  if (!found.has(url)) {
    found.set(url, fetch(url, { method: 'HEAD' })
      .then((r) => r.ok && (r.headers.get('content-type') ?? '').startsWith('audio/'))
      .catch(() => false));
  }
  return found.get(url)!;
}

let voice: HTMLAudioElement | null = null;
/**
 * Her other voice channels — a scene's (scene/voiceChannel.ts) and her runtime voice in her room (lib/herVoice.ts) —
 * register how to stop them, so a line played here, or stopVoice(), silences them too: one voice of hers at a time
 * (N-32). Returns the unregister.
 */
const hushers = new Set<() => void>();
export function onHush(stop: () => void): () => void {
  hushers.add(stop);
  return () => { hushers.delete(stop); };
}
/** Pauses only the line played here (for another channel that is about to speak). */
export function pauseOwnVoice() { voice?.pause(); }

/**
 * Plays a voice line if the file exists. `force` is for an explicit "listen" button; otherwise it
 * only plays with sound on. The music ducks underneath. Resolves false when nothing was played.
 */
export async function playVoice(url: string, force = false): Promise<boolean> {
  if ((!on && !force) || !(await audioExists(url))) return false;
  hushers.forEach((stop) => stop());
  voice?.pause();
  const a = new Audio(url);
  voice = a;
  duck(true);
  const done = () => { if (voice === a) { voice = null; duck(false); } };
  a.onended = done; a.onerror = done; a.onpause = done;
  try { await a.play(); return true; } catch { done(); return false; }
}
/** Stops every voice of hers: the line played here and the other channels (onHush). */
export function stopVoice() { voice?.pause(); hushers.forEach((stop) => stop()); }

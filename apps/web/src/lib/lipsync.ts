/**
 * Her lip-sync on the web (#73, docs/lipsync.md): her mouth in her clip moves with her voice.
 *
 * - **Recorded lines** (scenes): rendered once onto the clip each plays over, served from R2 by the Worker at
 *   `/lipsync/v1/<clip>/<voice id>-<w>x<h>.mp4`; data/lipsync.gen.json (written by tools/lipsync/publish.py) lists what
 *   exists, loaded lazily with the scene player. A line not listed plays as before (her clip and her voice).
 * - **Her runtime voice** (her room): each sentence `/v1/tts` voiced comes with a `lipsync` token when lip-sync is on
 *   for her; `requestLipsync` has that very audio rendered onto her talk loop (`POST /v1/lipsync`). Late, refused or
 *   failed, the answer is null and she speaks over her talk loop as before.
 *
 * The rendered videos are silent: her voice stays the audio element it always was, and the video starts with it.
 */
import { API_BASE, getToken } from '../services/http';
// Fetched as a file (content, like the scene catalogue), not bundled as code.
import manifestUrl from '../data/lipsync.gen.json?url';
import phasesUrl from '../data/lipsync.phases.gen.json?url';

export type LipsyncManifest = Record<string, string[]>;
let manifest: Promise<LipsyncManifest> | null = null;

/** The renders that exist (once per page; an empty list when the file cannot load). */
const loadJson = <T>(url: string, none: T): Promise<T> => fetch(url).then((r) => (r.ok ? (r.json() as Promise<T>) : none)).catch(() => none);
export function loadLipsyncManifest(): Promise<LipsyncManifest> {
  manifest ??= loadJson<LipsyncManifest>(manifestUrl, {});
  return manifest;
}

/** `/voice/scene/mahiro/41e9e0671ead.mp3` → `41e9e0671ead`. */
export const voiceId = (url: string): string | null => /\/([0-9a-f]{12})\.mp3$/.exec(url)?.[1] ?? null;

/** Both sizes of a render: full (1080x1920 / 1920x1080) and 2/3 of it (720x1280 / 1280x720). */
export function lipsyncSizes(clip: string): { w: number; h: number }[] {
  return clip.endsWith('16x9') ? [{ w: 1920, h: 1080 }, { w: 1280, h: 720 }] : [{ w: 1080, h: 1920 }, { w: 720, h: 1280 }];
}

/**
 * The render of a recorded line on a clip, at the size this screen needs (the smaller one unless the screen's long
 * side, at up to 2x pixels, is over 1280), or null when there is none.
 */
export function lipsyncSrc(m: LipsyncManifest | null, clip: string | undefined, voice: string | undefined, needPx?: number): string | null {
  const id = voice ? voiceId(voice) : null;
  if (!m || !clip || !id || !m[clip]?.includes(id)) return null;
  const need = needPx ?? (typeof window !== 'undefined'
    ? Math.max(window.innerWidth, window.innerHeight) * Math.min(2, window.devicePixelRatio || 1) : 1280);
  const [big, small] = lipsyncSizes(clip);
  const s = need > Math.max(small.w, small.h) ? big : small;
  return `/lipsync/v1/${clip}/${id}-${s.w}x${s.h}.mp4`;
}

export interface LipsyncClip { url: string; endFrame: number }

const b64Bytes = (s: string): Uint8Array<ArrayBuffer> => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
/** Both GPU routes answer members only (the session /v1/tts asks for); without one they are 401 and she plays as before. */
const session = (): Record<string, string> => { const t = getToken(); return t ? { authorization: `Bearer ${t}` } : {}; };

/**
 * One sentence of her runtime voice rendered onto her talk loop `clip`, from loop frame `start`: an object URL of the
 * silent MP4 and the frame the loop ends on, or null (off, refused, failed, offline). Revoke the URL when done.
 */
export async function requestLipsync(o: { clip: string; audio: string; mime: string; token: string; start: number; signal?: AbortSignal },
  doFetch: typeof fetch = fetch): Promise<LipsyncClip | null> {
  try {
    const res = await doFetch(`${API_BASE}/v1/lipsync?clip=${encodeURIComponent(o.clip)}&start=${o.start}`, {
      method: 'POST', body: b64Bytes(o.audio), signal: o.signal,
      headers: { 'content-type': o.mime, 'x-lipsync-token': o.token, ...session() }
    });
    if (!res.ok || !(res.headers.get('content-type') ?? '').startsWith('video/')) return null;
    const blob = await res.blob();
    return { url: URL.createObjectURL(blob), endFrame: Number(res.headers.get('x-end-frame') ?? 0) || 0 };
  } catch {
    return null;
  }
}

/** Her room opened: a GPU is readied for her talk loops (no-op when lip-sync is off for her). Never throws. */
/**
 * Low 7 (278d0e2): the API warms a GPU at most once a minute per account (429 after that, which the browser logs as an
 * error): her room asks again only after WARM_EVERY_MS, or after the Retry-After it was told. Warming is best effort.
 */
export const WARM_EVERY_MS = 60_000;
/** L14 (C-room): kept for the browser session, so a reload or a cold link into her room within the minute asks no 429. */
const WARM_KEY = 'jstar.lipsyncWarm';
const stored = (): number => { try { return Number(sessionStorage.getItem(WARM_KEY)) || -Infinity; } catch { return -Infinity; } };
const store = (at: number) => { try { sessionStorage.setItem(WARM_KEY, String(at)); } catch { /* storage blocked: this page only */ } };
let warmedAt = -Infinity;
let warmAgainAt = -Infinity;
export function warmLipsync(star: string, doFetch: typeof fetch = fetch, now = Date.now()): void {
  if (now - Math.max(warmedAt, stored()) < WARM_EVERY_MS || now < warmAgainAt) return;
  warmedAt = now;
  store(now);
  try {
    void doFetch(`${API_BASE}/v1/lipsync/warm?star=${encodeURIComponent(star)}`, { method: 'POST', headers: session() })
      .then((r) => {
        if (r?.status !== 429) return;
        const secs = Number(r.headers?.get?.('retry-after'));
        warmAgainAt = now + (Number.isFinite(secs) && secs > 0 ? secs * 1000 : WARM_EVERY_MS);
        store(warmAgainAt - WARM_EVERY_MS);
      })
      .catch(() => undefined);
  } catch { /* offline */ }
}
/** Tests. */
export const resetWarm = () => { warmedAt = -Infinity; warmAgainAt = -Infinity; try { sessionStorage.removeItem(WARM_KEY); } catch { /* none */ } };

// --- a recorded line's render, kept on her voice's clock (scenes) -------------------------------------------------

/** The render may run this far from her voice before it is put back in step (seconds). */
export const LIPSYNC_DRIFT_S = 0.04;
/** A render that has to jump lands this far ahead of her voice, then waits for it (covers the seek's own time). */
export const LIPSYNC_LEAD_S = 0.15;

export interface RenderState { time: number; readyState: number; seeking: boolean; paused: boolean; duration: number }
export interface SyncStep { show: boolean; seek?: number; play?: boolean; pause?: boolean }

/**
 * One step of keeping her line's render on her voice's clock (`audioTime`: the voice's currentTime, the render's 0
 * being the line's 0). Called every frame while the line plays:
 * - not loaded far enough, or past its end: not shown (her clip underneath stays on screen); her voice done: held;
 * - behind her voice, or far ahead: paused and moved LIPSYNC_LEAD_S ahead of her voice, then started the moment her
 *   voice reaches that frame — so it starts (or comes back) in step, never late;
 * - a little ahead while playing: paused until her voice catches up;
 * - within LIPSYNC_DRIFT_S while playing: shown.
 * Once shown, a resync keeps it shown (a held frame for a moment, rather than a flash of the clip underneath).
 */
export function syncStep(r: RenderState, audioTime: number, audioDone: boolean, wasShown: boolean): SyncStep {
  // Her voice ended (or was stopped): the render holds its last frame until the player hands back to the clip.
  if (audioDone) return { show: wasShown, pause: true };
  if (r.readyState < 1 || !Number.isFinite(r.duration) || r.duration <= 0) return { show: false };
  // Her voice asked to play but not sounding yet: the render waits, parked on its first frame.
  if (audioTime <= 0) return r.paused ? { show: false } : { show: false, pause: true, seek: 0 };
  if (audioTime >= r.duration - 1 / 48) return { show: false, pause: true };
  if (r.seeking) return { show: wasShown };
  const drift = r.time - audioTime;
  const target = Math.min(audioTime + LIPSYNC_LEAD_S, r.duration - 1 / 24);
  if (r.paused) {
    if (drift < -LIPSYNC_DRIFT_S || drift > LIPSYNC_LEAD_S + 0.1) return { show: wasShown, seek: target };
    // Parked at (or just ahead of) her voice: start the moment she gets there, once there is data to play on.
    if (audioTime >= r.time - 0.008 && r.readyState >= 3) return { show: wasShown || Math.abs(drift) <= LIPSYNC_DRIFT_S, play: true };
    return { show: wasShown };
  }
  if (Math.abs(drift) <= LIPSYNC_DRIFT_S) return { show: true };
  if (drift > 0) return { show: wasShown, pause: true };
  return { show: wasShown, pause: true, seek: target };
}

/**
 * Where the clip under a render should be once the render has taken over (or is about to hand back): the same frame,
 * so the handover shows no jump. `loop`: the clip loops (the render loops it on, from its frame 0).
 */
export function clipTimeFor(renderTime: number, clipDuration: number, loop: boolean): number | null {
  if (!Number.isFinite(clipDuration) || clipDuration <= 0) return null;
  return loop ? renderTime % clipDuration : Math.min(renderTime, clipDuration - 1 / 24);
}

/**
 * The renders to have loaded before they are needed: the line playing or about to (from `from` in `beats`) and the
 * next ones, up to `max`, each on the clip the stage will show while it plays (clip beats change the shot on the way).
 */
export function upcomingRenders<B extends { type: string }, S>(beats: readonly B[], from: number, shot: S,
  shotOf: (b: B) => S | null, srcOf: (b: B, shot: S) => string | null, max = 2): string[] {
  const out: string[] = [];
  let cur = shot;
  for (let k = Math.max(0, from); k < beats.length && out.length < max; k++) {
    const b = beats[k];
    const next = shotOf(b);
    if (next !== null) { cur = next; continue; }
    if (b.type !== 'line') continue;
    const src = srcOf(b, cur);
    if (src && !out.includes(src)) out.push(src);
  }
  return out;
}

/** Her render fades in over its clip (and out) this fast (scene.css `.scn-lipsync`): the handover's crossfade. */
export const LIPSYNC_FADE_MS = 180;

// --- her line starts on the render's first frame (QA of d53e8ba: no pose change at the takeover) ----------------------

/**
 * Renders begin at their clip's frame 0, so her line may only start lip-synced when the clip is there: no pose change
 * when her render takes over. Her voice waits at most this long for the clip to come round to it (seconds).
 */
export const LIPSYNC_ALIGN_WAIT_S = 0.3;

export type AlignPlan = { kind: 'now' } | { kind: 'wrap'; waitS: number } | { kind: 'none' };

/**
 * How her line can start on the render's first frame, the clip being at `time` of `duration` (seconds):
 * - `now`: the clip is (as good as) on its frame 0 — it was just cut to, or is held there;
 * - `wrap`: a looping clip comes round to frame 0 within LIPSYNC_ALIGN_WAIT_S: her voice waits for it;
 * - `none`: it would take longer — her line plays without its render (her clip as it is, no pose change).
 */
export function alignPlan(time: number, duration: number, loop: boolean, maxWaitS = LIPSYNC_ALIGN_WAIT_S): AlignPlan {
  if (!Number.isFinite(time) || !Number.isFinite(duration) || duration <= 0) return { kind: 'none' };
  if (time <= 1 / 48) return { kind: 'now' };
  const left = duration - time;
  return loop && left <= maxWaitS ? { kind: 'wrap', waitS: Math.max(0, left) } : { kind: 'none' };
}

/**
 * Where to start a looping clip at its cut (seconds) so that it comes round to its frame 0 `leadS` after `untilS` —
 * when her lip-synced line on it is due (her voice then waits `leadS` for it, never more than LIPSYNC_ALIGN_WAIT_S).
 */
export function cutStartFor(duration: number, untilS: number, leadS = 0.12): number | null {
  if (!Number.isFinite(duration) || duration <= 0 || !Number.isFinite(untilS) || untilS < 0) return null;
  const s = (duration - ((untilS + leadS) % duration)) % duration;
  return s >= duration - 1 / 48 ? 0 : s;
}

// --- phase renders: her line starts where the clip is (owner's option b) ---------------------------------------------


/**
 * Her recorded lines rendered onto a scene clip from every `step`-th frame of it, 720p (the phone size): `n` is the
 * clip's frame count, `ids` the lines with phase renders on it (tools/lipsync/publish.py). Phase 0 is the line's render
 * in lipsync.gen.json. With them, a line can start wherever the clip is — she waits at most `step` frames for the
 * clip to reach the next phase — and the render still begins on the clip's own frame.
 */
export interface LipsyncPhases { step: number; clips: Record<string, { n: number; ids: string[] }> }
let phases: Promise<LipsyncPhases> | null = null;
export function loadLipsyncPhases(): Promise<LipsyncPhases> {
  phases ??= loadJson<LipsyncPhases>(phasesUrl, { step: 7, clips: {} });
  return phases;
}

/** The render of a line on a clip from phase frame `p` (p > 0: a phase render, 720p), or null when there is none. */
export function phaseSrc(ph: LipsyncPhases | null, clip: string | undefined, voice: string | undefined, p: number): string | null {
  const id = voice ? voiceId(voice) : null;
  const c = clip ? ph?.clips[clip] : undefined;
  if (!ph || !c || !id || !c.ids.includes(id) || p <= 0 || p % ph.step || p >= c.n) return null;
  const s = lipsyncSizes(clip!)[1];
  return `/lipsync/v1/${clip}/${id}-p${p}-${s.w}x${s.h}.mp4`;
}

export type StartPlan = { kind: 'now' } | { kind: 'wrap'; waitS: number } | { kind: 'phase'; frame: number; waitS: number } | { kind: 'none' };

/**
 * Where her line starts on its render, the clip being at `time` of `duration` (s), `n` frames, with phase renders every
 * `step` frames (`phased`) or only the one from frame 0:
 * - `now` / `wrap`: as alignPlan — the clip's frame 0 (the phase-0 render);
 * - `phase`: the next phase frame at least half a frame ahead; her voice waits `waitS` (under step frames) for the
 *   clip to get there, and the clip is held on that frame until she sounds;
 * - `none`: no render starts where the clip is (no phases, or a one-shot clip past its last phase).
 */
export function startPlan(time: number, duration: number, loop: boolean, n: number, step: number, phased: boolean): StartPlan {
  const a = alignPlan(time, duration, loop, phased ? step * (duration / n) + 0.01 : LIPSYNC_ALIGN_WAIT_S);
  if (a.kind !== 'none' || !phased || !(n > 0) || !(step > 0)) return a;
  const fps = n / duration;
  const p = Math.ceil((time * fps + 0.5) / step) * step;
  if (p >= n) return { kind: 'none' };
  return { kind: 'phase', frame: p, waitS: Math.max(0, p / fps - time) };
}

/** Where the clip will be (s) `inS` from now, at `time` of `duration` (wrapping when it loops). */
export const clipTimeIn = (time: number, inS: number, duration: number, loop: boolean): number =>
  loop ? (time + inS) % duration : Math.min(time + inS, duration);

/**
 * The depth stage used by the home page (docs/JSTAR-关键产品决策.md: 恋与深空-style immersion,
 * navy night instead of cold "deep space", rose light instead of blue).
 *
 * Layers, back to front, each moving a different distance with the pointer / device tilt:
 *   scene video (generated, tools/media) → talent slot (official footage) → star field canvas → UI.
 * Budget rules: posters paint first; only the active scene has a <video>; nothing animates when the
 * tab is hidden, the user prefers reduced motion, or the connection asks to save data.
 */
import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { MEDIA, type MediaEntry, type MediaSource } from '../data/media.gen';
import { loadSceneMedia, mediaEntry, sceneMediaLoaded } from '../data/media';
import { heroEntry } from '../data/heroMedia';
import { coverSizes } from '../data/mediaCompact';
import { usesLandscapeFeedback } from '../data/reactions';

/** A clip by id (data/media.ts): the core catalogue, and the scenes' clips once their catalogue has loaded. */
export const media = (id: string): MediaEntry | undefined => mediaEntry(id);

/**
 * Loads the lazy catalogue (data/media.ts) for a screen that plays or shows its clips; true once it is here (or
 * its load failed, and the screen goes on with the core catalogue). Until then the screen shows its loading state.
 * `want` false (a screen that does not need it this time) loads nothing and answers whether it is already here.
 */
export function useSceneMedia(want = true): boolean {
  return useSceneMediaState(want).state === 'ready';
}

/**
 * The scene catalogue's load (N-48): `ready`, `loading`, or `failed` after its tries (data/media.ts). Failed, it is
 * tried again in the background every RETRY_MS — the clips swap in once it comes — and `retry` tries at once.
 */
export function useSceneMediaState(want = true): { state: 'loading' | 'ready' | 'failed'; retry: () => void } {
  const [state, setState] = useState<'loading' | 'ready' | 'failed'>(() => (sceneMediaLoaded() ? 'ready' : 'loading'));
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    if (state === 'ready' || !want) return;
    let live = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    void loadSceneMedia().then((ok) => {
      if (!live) return;
      if (ok) { setState('ready'); return; }
      setState('failed');
      timer = setTimeout(() => setAttempt((n) => n + 1), SCENE_MEDIA_RETRY_MS);
    });
    return () => { live = false; clearTimeout(timer); };
  }, [want, attempt]); // eslint-disable-line react-hooks/exhaustive-deps
  return { state, retry: () => { setState('loading'); setAttempt((n) => n + 1); } };
}
/** How long a failed scene catalogue waits before it is tried again in the background (N-48). */
export const SCENE_MEDIA_RETRY_MS = 8_000;

// e2e only: tests can add clips that the video stream has not delivered yet (entrance / reaction ids).
if (typeof window !== 'undefined') {
  const w = window as unknown as { __E2E__?: boolean; __MEDIA__?: Record<string, MediaEntry> };
  if (w.__E2E__ && w.__MEDIA__) Object.assign(MEDIA, w.__MEDIA__);
}

/** A clip family in the screen's orientation first: `${base}-9x16` / `${base}-16x9`. */
export const mediaFor = (base: string, portrait: boolean): MediaEntry | undefined => {
  // The approved feedback masters are supersampled: phone uses the same landscape file and cover crop.
  if (usesLandscapeFeedback(base)) return media(`${base}-16x9`);
  return media(`${base}-${portrait ? '9x16' : '16x9'}`) ?? media(`${base}-${portrait ? '16x9' : '9x16'}`);
};

/**
 * Where a point of a cover-fitted clip lands on screen, as a fraction of the box width: the clip is scaled to
 * cover the box and centred, so part of it is cropped away on the long side.
 */
export function coverX(frac: number, boxW: number, boxH: number, ratio: string, pos = 0.5): number {
  const [w, h] = ratio === '16:9' ? [16, 9] : [9, 16];
  const dispW = Math.max(boxW, (boxH * w) / h);
  return (frac * dispW - (dispW - boxW) * pos) / boxW;
}

function query(q: string): boolean {
  return typeof window !== 'undefined' && !!window.matchMedia && window.matchMedia(q).matches;
}

/** Motion is allowed unless the user or the network asked us to hold back. */
export function motionAllowed(): boolean {
  const conn = (typeof navigator !== 'undefined' ? (navigator as Navigator & { connection?: { saveData?: boolean } }).connection : undefined);
  return !query('(prefers-reduced-motion: reduce)') && !conn?.saveData;
}

/**
 * What fills the stage for a talent: her in her scene (generated from official photos) when it exists,
 * otherwise the empty scene; the screen's orientation first, the other one as a fallback.
 * The HD loop (`<star>-herohd-*`, #24) comes first: it starts and ends on the same frame as the approved v1
 * hero loop, so entrance and reaction clips hand over to it exactly as they did to the v1 loop.
 */
export const sceneFor = (star: string, portrait: boolean): MediaEntry | undefined => heroEntry(star, portrait);

/** Small still of a media entry (for cards, slats and thumbnails). */
export const stillOf = (e: MediaEntry | undefined, big = false): string | undefined =>
  e ? (big ? e.poster : e.posters?.[0]?.src ?? e.poster) : undefined;

export function usePortrait(): boolean {
  const [portrait, setPortrait] = useState(() => query('(orientation: portrait)'));
  useEffect(() => {
    if (!window.matchMedia) return;
    const m = window.matchMedia('(orientation: portrait)');
    const on = () => setPortrait(m.matches);
    m.addEventListener?.('change', on);
    return () => m.removeEventListener?.('change', on);
  }, []);
  return portrait;
}

/**
 * Picks what to download: the smallest H.264 file at least as wide as the screen needs, preceded
 * by the AV1 file when the browser can decode it and the screen needs the big size anyway.
 */
export function pickSources(sources: MediaSource[], neededWidth: number, canPlay: (type: string) => boolean): MediaSource[] {
  const playable = sources.filter((s) => canPlay(s.type));
  const h264 = playable.filter((s) => s.type.includes('avc1')).sort((a, b) => a.width - b.width);
  const fit = h264.find((s) => s.width >= neededWidth) ?? h264[h264.length - 1];
  const av1 = playable.filter((s) => s.type.includes('av01')).sort((a, b) => b.width - a.width)[0];
  // AV1 only at the size that is needed anyway: many phones decode it in software, which drains battery.
  return [...(av1 && fit && av1.width === fit.width ? [av1] : []), ...(fit ? [fit] : [])];
}

/** The files a clip plays from on this screen (the loader fetches the same ones ahead of the stage). */
export function sourcesFor(entry: MediaEntry): MediaSource[] {
  const need = Math.min(1920, Math.round((typeof window !== 'undefined' ? Math.max(window.innerWidth, window.innerHeight * (entry.ratio === '16:9' ? 16 / 9 : 9 / 16)) : 1280) * Math.min(2, window.devicePixelRatio || 1)));
  const probe = typeof document !== 'undefined' ? document.createElement('video') : null;
  return pickSources(entry.sources, need, (t) => !!probe?.canPlayType?.(t));
}

/**
 * Warms a scene's first clips before it opens (N-17): each poster is fetched, and the start of each video is
 * prefetched into the cache, so the player's first cut and her first line do not wait on the network. Once per clip.
 */
const warmed = new Set<string>();
export function preloadClips(entries: readonly (MediaEntry | undefined)[]) {
  if (typeof document === 'undefined') return;
  for (const e of entries) {
    if (!e || warmed.has(e.id)) continue;
    warmed.add(e.id);
    const img = new Image();
    img.src = e.poster;
    const src = sourcesFor(e)[0]?.src;
    if (!src) continue;
    const link = document.createElement('link');
    link.rel = 'prefetch';
    link.as = 'video';
    link.href = src;
    document.head.appendChild(link);
  }
}

const LQIP: CSSProperties = { filter: 'blur(6px)', transform: 'scale(1.03)' };
const HIDDEN: CSSProperties = { opacity: 0 };
const fetchPriority = (value: 'high' | 'low') => ({ fetchpriority: value }) as Record<string, string>;

/**
 * One generated scene: poster immediately, video only while active and allowed to move. `waitPoster` (the home's
 * first screen, M11) starts the video only once her poster has painted, so on a slow network the poster is never
 * queued behind megabytes of video: she is on screen first, and moves once the clip plays. `cover` (the home stage,
 * A-M11): the poster covers the screen, so its srcset is chosen for the width it is drawn at (coverSizes, the same
 * string the HTML preloads with), and her small poster is drawn sharp, not blurred, when it is already as wide as
 * that (a phone: 540px for 475 CSS px) — on slow 4G she is sharp seconds before the full poster arrives.
 * `hidePoster` is for a primed hand-off whose poster does not match the incoming loop frame.
 */
export function SceneVideo({ entry, active, className, style, loop = true, onDone, onReady, onPlaybackFrame, hold = false, waitPoster, cover, hidePoster = false, requiredPlayback = false, restartAt }: { entry: MediaEntry; active: boolean; className?: string; style?: CSSProperties; loop?: boolean; onDone?: () => void; onReady?: () => void; onPlaybackFrame?: () => void; hold?: boolean; waitPoster?: boolean; cover?: boolean; hidePoster?: boolean; requiredPlayback?: boolean; restartAt?: number }) {
  const ref = useRef<HTMLVideoElement>(null);
  const [playing, setPlaying] = useState(false);
  const [moving] = useState(() => requiredPlayback || motionAllowed());
  const [sources] = useState(() => sourcesFor(entry));
  const smallest = entry.posters && entry.posters.length > 1 ? entry.posters.reduce((a, b) => (b.width < a.width ? b : a)) : null;
  const small = hidePoster ? null : smallest?.src ?? null;
  const [soft] = useState(() => !cover || !smallest || typeof window === 'undefined'
    || smallest.width < Math.max(window.innerWidth, window.innerHeight * (entry.ratio === '16:9' ? 16 / 9 : 9 / 16)));
  const full = useRef<HTMLImageElement>(null);
  const [hq, setHq] = useState(false);
  useEffect(() => { if (full.current?.complete && full.current.naturalWidth > 0) setHq(true); }, []);
  const [painted, setPainted] = useState(!waitPoster || !entry.poster);
  const showVideo = moving && active && sources.length > 0 && (painted || hq);
  useEffect(() => {
    const video = ref.current;
    if (!video || restartAt === undefined) return;
    try { video.currentTime = 0; } catch { /* the next playable frame starts at zero */ }
  }, [restartAt]);
  useEffect(() => {
    const v = ref.current;
    if (!v) return;
    const sync = () => {
      if (active && !hold && !document.hidden) void v.play()?.catch(() => { /* autoplay refused: the poster stays */ done.current?.(); });
      else {
        v.pause();
        // A primed hand-off stays on its decoded first frame until the entrance releases it.
        if (hold && v.currentTime !== 0) v.currentTime = 0;
      }
    };
    sync();
    document.addEventListener('visibilitychange', sync);
    return () => document.removeEventListener('visibilitychange', sync);
  }, [active, hold, showVideo]); // the video can mount later (waitPoster): it is synced from then on
  const ready = useRef(false);
  const reportReady = () => {
    if (ready.current) return;
    ready.current = true;
    onReady?.();
  };
  const firstPlaybackFrame = useRef(false);
  const reportPlaybackFrame = (video: HTMLVideoElement) => {
    if (!onPlaybackFrame || firstPlaybackFrame.current) return;
    firstPlaybackFrame.current = true;
    if ('requestVideoFrameCallback' in video) video.requestVideoFrameCallback(() => onPlaybackFrame());
    else window.requestAnimationFrame(() => onPlaybackFrame());
  };
  // A one-shot clip (entrance, reaction) always reports back: when it ends, fails, never starts, or cannot play here.
  const done = useRef<(() => void) | null>(null);
  done.current = onDone ? () => { const f = onDone; done.current = null; f(); } : null;
  useEffect(() => {
    if (!onDone || !active) return;
    if (!showVideo) {
      if (moving && sources.length > 0 && !painted) return; // still waiting for her poster: the clip comes after it
      const id = setTimeout(() => done.current?.(), 0); return () => clearTimeout(id);
    }
    const stall = setTimeout(() => { if (!ref.current || ref.current.currentTime === 0) done.current?.(); }, 5000);
    const cap = setTimeout(() => done.current?.(), 20000);
    return () => { clearTimeout(stall); clearTimeout(cap); };
  }, [active, showVideo, painted]); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <div className={`scene${playing ? ' is-playing' : ''} ${className ?? ''}`} style={style} data-scene={entry.id}>
      {/* N-52: on a cold open her small poster paints at once (softly), the full one takes over once it has loaded —
          never a large poster drawing itself top-down. */}
      {small && !hq && <img className="scene-poster" src={small} alt="" aria-hidden="true" decoding={active ? 'sync' : 'async'} {...fetchPriority('high')} draggable={false} data-lqip="" style={soft ? LQIP : undefined} onLoad={() => setPainted(true)} onError={() => setPainted(true)} />}
      {!hidePoster && entry.poster && <img ref={full} className="scene-poster" src={entry.poster} srcSet={entry.posters?.map((p) => `${p.src} ${p.width}w`).join(', ')} sizes={entry.posters ? (cover ? coverSizes(entry.ratio) : '100vw') : undefined}
        alt="" decoding={active ? 'sync' : 'async'} {...fetchPriority(active ? 'high' : 'low')} draggable={false} onLoad={() => setHq(true)} onError={() => setPainted(true)} style={small && !hq ? HIDDEN : undefined} />}
      {showVideo && (
        <video ref={ref} className="scene-video" muted loop={loop} playsInline autoPlay={!hold} preload="auto" poster={hidePoster ? undefined : (small ?? entry.poster) || undefined} aria-hidden="true" tabIndex={-1}
          onLoadedData={reportReady} onCanPlay={reportReady} onPlaying={(event) => { reportReady(); setPlaying(true); reportPlaybackFrame(event.currentTarget); }}
          onError={() => { setPlaying(false); done.current?.(); }} onEnded={() => done.current?.()}>
          {sources.map((s, k) => <source key={s.src} src={s.src} type={s.type} onError={k === sources.length - 1 ? () => done.current?.() : undefined} />)}
        </video>
      )}
    </div>
  );
}

export interface Tilt { x: number; y: number }

/**
 * Pointer (or device tilt) → a smoothed value in [-1, 1] written to CSS variables on `el`,
 * so layers move in pure CSS without re-rendering React.
 */
export function useParallax(el: React.RefObject<HTMLElement | null>, enabled: boolean): React.MutableRefObject<Tilt> {
  const tilt = useRef<Tilt>({ x: 0, y: 0 });
  useEffect(() => {
    const node = el.current;
    if (!node || !enabled || !motionAllowed()) return;
    const target = { x: 0, y: 0 };
    let raf = 0;
    const step = () => {
      const t = tilt.current;
      t.x += (target.x - t.x) * 0.08;
      t.y += (target.y - t.y) * 0.08;
      node.style.setProperty('--px', t.x.toFixed(4));
      node.style.setProperty('--py', t.y.toFixed(4));
      raf = Math.abs(target.x - t.x) + Math.abs(target.y - t.y) > 0.001 ? requestAnimationFrame(step) : 0;
    };
    const kick = () => { if (!raf) raf = requestAnimationFrame(step); };
    const onPointer = (e: PointerEvent) => {
      if (e.pointerType === 'touch') return;
      target.x = (e.clientX / window.innerWidth) * 2 - 1;
      target.y = (e.clientY / window.innerHeight) * 2 - 1;
      kick();
    };
    const onTilt = (e: DeviceOrientationEvent) => {
      if (e.gamma == null || e.beta == null) return;
      target.x = Math.max(-1, Math.min(1, e.gamma / 25));
      target.y = Math.max(-1, Math.min(1, (e.beta - 45) / 25));
      kick();
    };
    const onLeave = () => { target.x = 0; target.y = 0; kick(); };
    window.addEventListener('pointermove', onPointer, { passive: true });
    document.documentElement.addEventListener('pointerleave', onLeave);
    window.addEventListener('deviceorientation', onTilt, { passive: true });
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener('pointermove', onPointer);
      document.documentElement.removeEventListener('pointerleave', onLeave);
      window.removeEventListener('deviceorientation', onTilt);
    };
  }, [el, enabled]);
  return tilt;
}

/** Keeps the outgoing child mounted briefly so it can play its exit while the next one enters. */
export function DepthSwitch({ id, children, ms = 900 }: { id: string; children: (id: string, phase: 'enter' | 'leave') => ReactNode; ms?: number }) {
  const [prev, setPrev] = useState<string | null>(null);
  const shown = useRef(id);
  useEffect(() => {
    if (shown.current === id) return;
    setPrev(shown.current);
    shown.current = id;
    const t = setTimeout(() => setPrev(null), ms);
    return () => clearTimeout(t);
  }, [id, ms]);
  return <>{prev && prev !== id && children(prev, 'leave')}{children(id, 'enter')}</>;
}

/**
 * Multi-view viewer for turntable sheets: drag (or arrow keys) to turn the object around.
 * All views are stacked and only the current one is visible, so turning never waits for the network.
 */
export function SpinViewer({ views, label, hint }: { views: string[]; label: string; hint: string }) {
  const [k, setK] = useState(0);
  const drag = useRef<{ x: number; k: number } | null>(null);
  const n = views.length;
  const turn = (to: number) => setK(((to % n) + n) % n);
  return (
    <div className="spin" role="slider" tabIndex={0} aria-label={label} aria-valuemin={1} aria-valuemax={n} aria-valuenow={k + 1}
      aria-valuetext={`${k + 1} / ${n}`} title={hint}
      onKeyDown={(e) => {
        if (e.key === 'ArrowRight' || e.key === 'ArrowUp') { e.preventDefault(); e.stopPropagation(); turn(k + 1); }
        else if (e.key === 'ArrowLeft' || e.key === 'ArrowDown') { e.preventDefault(); e.stopPropagation(); turn(k - 1); }
        else if (e.key === 'Home') { e.preventDefault(); turn(0); }
      }}
      onPointerDown={(e) => { drag.current = { x: e.clientX, k }; e.currentTarget.setPointerCapture?.(e.pointerId); }}
      onPointerMove={(e) => {
        const d = drag.current;
        if (!d) return;
        const step = Math.max(12, e.currentTarget.clientWidth / n);
        turn(d.k - Math.round((e.clientX - d.x) / step));
      }}
      onPointerUp={() => { drag.current = null; }} onPointerCancel={() => { drag.current = null; }}>
      {views.map((src, i) => <img key={src} src={src} alt="" draggable={false} loading="lazy" decoding="async" className={i === k ? 'on' : ''} />)}
      <span className="spin-hint" aria-hidden="true">⟲ {k + 1}/{n}</span>
    </div>
  );
}

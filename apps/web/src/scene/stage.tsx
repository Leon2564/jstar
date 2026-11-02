/**
 * The scene stage: full-screen clips with hard cuts.
 *
 * Every clip the scene is about to need is mounted as its own layer (the one on screen, the idle loop, the next
 * clips of this segment and the first clip behind each answer), so a cut only flips which layer is visible — the
 * next video is already buffering and its poster already painted. Each layer paints its poster first and shows the
 * video only once it is really playing, so iOS Safari never flashes black between clips.
 */
import { useEffect, useRef, useState, type CSSProperties } from 'react';
import type { MediaEntry } from '../data/media.gen';
import { media as mediaById, mediaFor, sourcesFor } from '../components/stage';

/** A script's media: an exact id (`mahiro-hero-9x16`) or a family played in the screen's orientation (`mahiro-hero`). */
export const clipEntry = (media: string | undefined, portrait: boolean): MediaEntry | undefined =>
  media ? mediaById(media) ?? mediaFor(media, portrait) : undefined;

/**
 * Her seated base loops (#80, the storyboard's 坐着待机 / 坐着说话): on her wide shot (`<star>-hero`) the stage plays
 * `<star>-talk` while her line plays and `<star>-idle` while she listens; on her close shot (`<star>-breath`) it plays
 * `<star>-talkclose` while she speaks. Each is locked on the frame the shot it stands for starts on, with the camera
 * still, so these cuts do not jump. Any other clip, or a loop that is not in the catalogue, plays as written.
 */
export function baseLoop(media: string | undefined, speaking: boolean, portrait: boolean): string | undefined {
  const m = media ? /^(mahiro|nana|unpai|alice|eimi)-(hero|breath)(?:-(?:9x16|16x9))?$/.exec(media) : null;
  if (!m) return media;
  const want = m[2] === 'hero' ? `${m[1]}-${speaking ? 'talk' : 'idle'}` : speaking ? `${m[1]}-talkclose` : null;
  return want && clipEntry(want, portrait) ? want : media;
}

/** A close shot of her (her close base loop, or a close step): its listening loop stays close (N-35). */
export const isCloseShot = (shot: { shot?: string; media?: string } | null | undefined): boolean =>
  !!shot && (shot.shot === 'close' || /^(mahiro|nana|unpai|alice|eimi)-(breath|talkclose)(?:-(?:9x16|16x9))?$/.test(shot.media ?? ''));

/**
 * Whether a late clip is covered by her stall line, or waited out in silence over her listening loop (N-33, N-35):
 * never in a tender moment (her confession, a close shot), never right before she waits for his answer, never twice
 * in a row, and at most once a scene unless the network is slow.
 */
export function stallSpoken(o: { tender: boolean; beforeAnswer: boolean; said: number; lastStalled: boolean; slow: boolean }): boolean {
  if (o.tender || o.beforeAnswer || o.lastStalled) return false;
  return o.said === 0 || o.slow;
}

/** A slow connection, as the browser reports it (N-33): the only case for more than one stall line a scene. */
export function slowNetwork(): boolean {
  const c = (typeof navigator !== 'undefined' ? (navigator as unknown as { connection?: { effectiveType?: string; saveData?: boolean } }).connection : undefined);
  return !!c && (!!c.saveData || ['slow-2g', '2g', '3g'].includes(c.effectiveType ?? ''));
}

/** Fetches a clip's poster into the cache so the cut paints it at once. */
export function warmPoster(e: MediaEntry | undefined) {
  if (!e || typeof Image === 'undefined') return;
  const img = new Image();
  if (e.posters) { img.sizes = '100vw'; img.srcset = e.posters.map((p) => `${p.src} ${p.width}w`).join(', '); }
  img.src = e.poster;
}

export interface StageHandle {
  ready(id: string): boolean;
  whenReady(id: string, ms: number): Promise<boolean>;
  /** Its poster is painted (or it has none to wait for): the floor under a line (N-17). */
  whenPainted(id: string, ms: number): Promise<boolean>;
  /** Its video element (her lip-synced line lines the clip up with its render, #73). */
  video?(id: string): HTMLVideoElement | undefined;
}

/**
 * Holds the stage before a cut or a line (N-17, #64): nothing plays until the clip that will be on screen can play.
 * A clip that is not ready within `quickMs` is late: her idle loop is on screen (`onStall(true)`) — its poster at
 * least painted — while her stall lines cover it, until the clip can play or `stallMs` has passed. Still not
 * playable then, the stage stays on her idle loop (her poster, the floor) until it is, and `onStall(false)` comes
 * with the clip. Resolves once the line or the cut may go on.
 */
export async function holdStage(o: {
  stage: StageHandle | null; target: string | undefined; idle: string | undefined; quickMs: number; stallMs: number;
  lines: string[]; onStall: (on: boolean) => void; onLine: (text: string) => void; cancelled: () => boolean;
}): Promise<void> {
  const { stage, target } = o;
  if (!stage || !target || stage.ready(target)) return;
  if (await stage.whenReady(target, o.quickMs)) return;
  if (o.cancelled()) return;
  o.onStall(true);
  if (o.idle) await stage.whenPainted(o.idle, 1500);
  let ok = false;
  for (let k = 0; k < o.lines.length && !o.cancelled(); k++) {
    o.onLine(o.lines[k]);
    if ((ok = await stage.whenReady(target, o.stallMs / o.lines.length))) break;
  }
  if (!o.lines.length && !o.cancelled()) ok = await stage.whenReady(target, o.stallMs);
  if (ok || stage.ready(target)) { o.onStall(false); return; }
  // Late past the stall: go on over her idle loop; the cut is shown the moment the clip can play.
  void stage.whenReady(target, 60_000).then(() => o.onStall(false));
}

const LQIP: React.CSSProperties = { filter: 'blur(6px)', transform: 'scale(1.03)' };
const HIDDEN: React.CSSProperties = { opacity: 0 };

function Layer({ entry, on, loop, held = false, startAt, onVideo, onPoster }: {
  entry: MediaEntry; on: boolean; loop: boolean; held?: boolean; startAt?: number;
  onVideo: (id: string, v: HTMLVideoElement | null) => void; onPoster: (id: string, img: HTMLImageElement | null) => void;
}) {
  const ref = useRef<HTMLVideoElement>(null);
  const heldRef = useRef(held);
  heldRef.current = held;
  const startRef = useRef(startAt);
  startRef.current = startAt;
  const img = useRef<HTMLImageElement>(null);
  // N-52: her small poster paints first (the stage's floor, what `whenPainted` waits for); the full one takes over once
  // it has loaded — never a large poster drawing itself top-down.
  const small = entry.posters && entry.posters.length > 1 ? entry.posters.reduce((a, b) => (b.width < a.width ? b : a)).src : null;
  const full = useRef<HTMLImageElement>(null);
  const [hq, setHq] = useState(false);
  useEffect(() => { if (full.current?.complete && full.current.naturalWidth > 0) setHq(true); }, []);
  useEffect(() => { onPoster(entry.id, (small ? img.current : full.current) ?? full.current); return () => onPoster(entry.id, null); }, [entry.id, onPoster, small]);
  const [playing, setPlaying] = useState(false);
  const [sources] = useState(() => sourcesFor(entry));
  useEffect(() => { onVideo(entry.id, ref.current); return () => onVideo(entry.id, null); }, [entry.id, onVideo]);
  useEffect(() => {
    const v = ref.current;
    if (!v) return;
    if (on) {
      // A cut starts the shot from its first frame (or where the player asks: her lip-synced line, #73, needs the clip
      // at its frame 0 when she starts); a clip coming back (the idle loop) starts over too.
      try { v.currentTime = startRef.current ?? 0; } catch { /* not seekable yet */ }
      const sync = () => { if (document.hidden || heldRef.current) v.pause(); else void v.play()?.catch(() => { /* autoplay refused: the poster stays */ }); };
      sync();
      document.addEventListener('visibilitychange', sync);
      return () => document.removeEventListener('visibilitychange', sync);
    }
    v.pause();
    setPlaying(false);
    return undefined;
  }, [on]);
  // #73: held — paused on the frame it is on (her lip-synced line waits for her voice there), and on again after.
  useEffect(() => {
    const v = ref.current;
    if (!v || !on) return;
    // A clip cut to while held shows its video at once (its frame, the one her render starts on), not the poster.
    if (held) { v.pause(); setPlaying(true); } else if (!document.hidden) void v.play()?.catch(() => undefined);
  }, [held, on]);
  return (
    <div className={`scn-layer${on ? ' on' : ''}${playing ? ' is-playing' : ''}`} data-clip={entry.id} data-ratio={entry.ratio} aria-hidden="true"
      style={entry.ratio === '9:16' ? { '--still': `url("${entry.poster}")` } as CSSProperties : undefined}>
      {small && <img ref={img} className="scn-media scn-poster" src={small} alt="" decoding="async" {...({ fetchpriority: on ? 'high' : 'low' } as Record<string, string>)} draggable={false} data-lqip="" style={hq ? HIDDEN : LQIP} />}
      <img ref={full} className="scn-media scn-poster" src={entry.poster} srcSet={entry.posters?.map((p) => `${p.src} ${p.width}w`).join(', ')} sizes={entry.posters ? '100vw' : undefined}
        alt="" decoding="async" {...({ fetchpriority: on ? 'high' : 'low' } as Record<string, string>)} draggable={false} onLoad={() => setHq(true)} style={small && !hq ? HIDDEN : undefined} />
      {sources.length > 0 && (
        <video ref={ref} className="scn-media scn-video" muted playsInline loop={loop} preload="auto" poster={small ?? entry.poster} tabIndex={-1}
          onPlaying={() => { if (on) setPlaying(true); }} onError={() => setPlaying(false)}>
          {sources.map((s) => <source key={s.src} src={s.src} type={s.type} />)}
        </video>
      )}
    </div>
  );
}

export function ClipStage({ layers, active, loops, handle, held = null, startAt }: {
  layers: MediaEntry[]; active: string | null; loops: Record<string, boolean>; handle: React.MutableRefObject<StageHandle | null>;
  /** #73: the clip held on its frame (her lip-synced line waits for her voice), and where a cut starts a clip (s). */
  held?: string | null; startAt?: Record<string, number>;
}) {
  const videos = useRef(new Map<string, HTMLVideoElement>());
  const onVideo = useRef((id: string, v: HTMLVideoElement | null) => { if (v) videos.current.set(id, v); else videos.current.delete(id); }).current;
  const posters = useRef(new Map<string, HTMLImageElement>());
  const onPoster = useRef((id: string, i: HTMLImageElement | null) => { if (i) posters.current.set(id, i); else posters.current.delete(id); }).current;
  handle.current = {
    // HAVE_FUTURE_DATA: the cut will play without stalling. No video (reduced data, no sources) counts as ready: the poster is the shot.
    ready: (id) => { const v = videos.current.get(id); return !v || v.readyState >= 3; },
    whenReady: (id, ms) => new Promise((resolve) => {
      const v = videos.current.get(id);
      if (!v || v.readyState >= 3) { resolve(true); return; }
      const done = (ok: boolean) => { clearTimeout(timer); v.removeEventListener('canplay', yes); resolve(ok); };
      const yes = () => done(true);
      const timer = setTimeout(() => done(false), ms);
      v.addEventListener('canplay', yes);
    }),
    video: (id) => videos.current.get(id),
    whenPainted: (id, ms) => new Promise((resolve) => {
      const i = posters.current.get(id);
      if (!i || (i.complete && i.naturalWidth > 0)) { resolve(true); return; }
      const done = (ok: boolean) => { clearTimeout(timer); i.removeEventListener('load', yes); resolve(ok); };
      const yes = () => done(true);
      const timer = setTimeout(() => done(false), ms);
      i.addEventListener('load', yes);
    })
  };
  return (
    <div className="scn-stage">
      {layers.map((e) => <Layer key={e.id} entry={e} on={e.id === active} loop={loops[e.id] ?? true} held={held === e.id} startAt={startAt?.[e.id]} onVideo={onVideo} onPoster={onPoster} />)}
    </div>
  );
}

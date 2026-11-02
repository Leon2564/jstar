/**
 * Her recorded line's render (#73, lib/lipsync.ts) over the clip it was rendered from, in scenes: a silent video,
 * mounted (and so loaded) ahead of its line, shown only while it really plays in step with her voice — until then, and
 * if it never does (blocked, failed, too slow), the clip underneath stays on screen, as before.
 *
 * `clock` is her voice's clock (scene/voiceChannel.ts `voiceTime`, the same one her room's lip-sync follows), given
 * once her line's voice was asked to play. Every frame the render follows it (`syncStep`): it starts — or comes in
 * mid-line, if it was late — exactly where her voice is, and is put back in step past LIPSYNC_DRIFT_S.
 *
 * `onShown` reports the video when it takes over (and null when it lets go), so the player can line the clip
 * underneath up with it. `className` / `videoClassName` give it the same box as the clip it covers.
 */
import { useEffect, useRef, useState, type CSSProperties } from 'react';
import { syncStep } from '../lib/lipsync';

export function LipsyncVideo({ src, active, clock, className, videoClassName, style, onShown }: {
  src: string; active: boolean; clock: (() => number | null) | null; className: string; videoClassName: string;
  style?: CSSProperties; onShown?: (v: HTMLVideoElement | null) => void;
}) {
  const ref = useRef<HTMLVideoElement>(null);
  const [shown, setShown] = useState(false);
  const shownRef = useRef(false);
  const report = useRef(onShown);
  report.current = onShown;
  const show = (on: boolean) => {
    if (shownRef.current === on) return;
    shownRef.current = on;
    setShown(on);
    report.current?.(on ? ref.current : null);
  };

  useEffect(() => {
    const v = ref.current;
    if (!v) return undefined;
    if (!active || !clock) { v.pause(); show(false); return undefined; }
    let raf = 0;
    const tick = () => {
      const t = clock();
      const step = syncStep({ time: v.currentTime, readyState: v.readyState, seeking: v.seeking, paused: v.paused, duration: v.duration },
        t ?? 0, t === null, shownRef.current);
      if (step.pause && !v.paused) v.pause();
      if (step.seek !== undefined) { try { v.currentTime = step.seek; } catch { /* not seekable yet */ } }
      if (step.play) void v.play()?.catch(() => undefined);
      show(step.show);
      raf = requestAnimationFrame(tick);
    };
    tick();
    return () => cancelAnimationFrame(raf);
  }, [active, clock, src]);

  return (
    <div className={`${className}${shown ? ' is-playing' : ''}`} data-lipsync={shown ? 'on' : active ? 'ready' : 'preload'} data-src={src} data-testid="lipsync" aria-hidden="true">
      <video ref={ref} className={videoClassName} src={src} style={style} muted playsInline preload="auto" tabIndex={-1} onError={() => show(false)} />
    </div>
  );
}

/**
 * Her sentence lip-synced in her room (#73): the silent render over her talk loop, slaved to her voice. It starts at
 * her voice's position when `playing` turns true — the start of the sentence, or the middle when its render came late
 * — and is put back on her voice whenever they drift more than DRIFT_S apart. Shown only once it really plays; until
 * then, or if it never does, her talk loop underneath stays on screen. `style` is her talk loop's own (pages/roomV2.tsx
 * clipLook): the same crop and box as the loop it was rendered onto.
 */
import { useEffect, useRef, useState, type CSSProperties } from 'react';
import { voiceTime } from '../scene/voiceChannel';

export const DRIFT_S = 0.04;
const CHECK_MS = 200;

export function RoomLipsync({ src, playing, className, videoClassName, style, clock = voiceTime }: {
  src: string; playing: boolean; className: string; videoClassName: string; style?: CSSProperties; clock?: () => number | null;
}) {
  const ref = useRef<HTMLVideoElement>(null);
  const [shown, setShown] = useState(false);
  useEffect(() => {
    const v = ref.current;
    if (!v) return;
    if (!playing) { v.pause(); setShown(false); return; }
    const follow = () => {
      const t = clock();
      if (t === null) return;
      if (Math.abs((v.currentTime || 0) - t) > DRIFT_S) { try { v.currentTime = t; } catch { /* not seekable yet */ } }
    };
    follow();
    void v.play()?.catch(() => setShown(false));
    const id = setInterval(follow, CHECK_MS);
    return () => clearInterval(id);
  }, [playing, src, clock]);
  return (
    <div className={`${className}${shown ? ' is-playing' : ''}`} style={style} data-lipsync={shown ? 'on' : 'ready'} data-testid="lipsync" aria-hidden="true">
      <video ref={ref} className={videoClassName} src={src} muted playsInline preload="auto" tabIndex={-1}
        onPlaying={() => setShown(true)} onError={() => setShown(false)} onEnded={() => setShown(false)} />
    </div>
  );
}

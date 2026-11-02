/**
 * うんぱい's stream (#68): the live-stream layer over her scene while she is on air — LIVE and one viewer at the top,
 * his comments flowing across (the stream's own danmaku), a gift he sent as a banner — and, when she ends it (下播),
 * a short 「配信終了」 before the layer goes and it is just the two of them. The run says when it is live (effect
 * `live`); this only draws it. Reduced motion: comments stack still instead of flowing.
 */
import { useEffect, useRef, useState } from 'react';
import { useT } from '../lib/store';

export interface Comment { id: number; text: string; gift?: boolean }

/** How long 「配信終了」 stays before the stream layer is gone. */
export const OFF_AIR_MS = 1800;
/** Comments kept on screen at once. */
const KEEP = 6;

export function StreamLayer({ live, comments }: { live: boolean; comments: Comment[] }) {
  const t = useT();
  const [ending, setEnding] = useState(false);
  const prev = useRef(live);
  // Going off air (live → not): the end card, then nothing.
  useEffect(() => {
    const was = prev.current;
    prev.current = live;
    if (live) { setEnding(false); return undefined; }
    if (!was) return undefined;
    setEnding(true);
    const id = setTimeout(() => setEnding(false), OFF_AIR_MS);
    return () => clearTimeout(id);
  }, [live]);
  if (!live && !ending) return null;
  return (
    <div className={`scn-live${ending ? ' ending' : ''}`} data-testid="stream-layer" data-live={live ? 'on' : 'off'}>
      <p className="scn-live-badge" aria-label={t('scene.liveLabel')}>
        <b>{t('scene.live')}</b><span aria-hidden="true">{t('scene.viewers', { n: 1 })}</span>
      </p>
      {live && (
        <ol className="scn-dm" aria-hidden="true">
          {comments.slice(-KEEP).map((c, i) => (
            <li key={c.id} className={c.gift ? 'gift' : undefined} style={{ '--row': i, '--lane': c.id % 3 } as React.CSSProperties}>{c.text}</li>
          ))}
        </ol>
      )}
      {ending && <p className="scn-offair" role="status" data-testid="stream-off-air">{t('scene.offAir')}</p>}
    </div>
  );
}

import { useState } from 'react';
import { getStar } from '../data/cast';
import { starName } from '../i18n';
import { useT } from '../lib/store';
import { media, stillOf } from './stage';

/**
 * Round avatar cut from her still — the same face as the home's partner row (falls back to her tint). Used in the
 * chat headers (N-24: the member chat showed an empty circle) and on My page (M4). M10: a still that fails to load
 * (offline, a missing file) leaves her initial on her tint — never the browser's broken-image glyph. B-N9: the initial
 * is the first character of her name in the app's language (唯 in zh-Hant and ja, 타 in ko), not a Latin letter.
 */
export function StarAvatar({ id, size = 36 }: { id: string; size?: number }) {
  const s = getStar(id);
  const t = useT();
  const face = stillOf(media(`${s.id}-hero-9x16`) ?? media(`${s.id}-breath-9x16`));
  const [broken, setBroken] = useState<string | null>(null);
  const shown = face && broken !== face ? face : null;
  return (
    <span className="avatar" data-testid="star-avatar" style={{ width: size, height: size, background: s.tint, overflow: 'hidden', display: 'inline-grid', placeItems: 'center', flexShrink: 0 }} aria-hidden="true">
      {shown
        ? <img src={shown} alt="" onError={() => setBroken(shown)} style={{ width: '100%', height: '100%', objectFit: 'cover', objectPosition: '50% 18%', transform: 'scale(1.9)', transformOrigin: '50% 18%' }} />
        : <span className="serif" style={{ fontSize: Math.round(size * 0.42), color: 'var(--navy)' }}>{Array.from(starName(s, t.lang))[0]}</span>}
    </span>
  );
}

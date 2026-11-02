/**
 * PV lightbox (its own chunk): the five hero clips back to back in a dark in-page theatre, each with her name and
 * line, under the procedural PV score; the background music makes way while it plays.
 * Esc or × closes, ←/→ or the side zones skip, focus stays inside and returns to the button that opened it.
 */
import { useEffect, useRef, useState } from 'react';
import { CAST } from '../data/cast';
import { THEME } from '../data/theme';
import { starName, type Key } from '../i18n';
import { duck, pvScore } from '../lib/sound';
import { useT } from '../lib/store';
import { pickSources, sceneFor, usePortrait } from './stage';
import { Icon } from './ui';
import '../styles/pv.css';

export default function PvLightbox({ start = 0, onClose }: { start?: number; onClose: () => void }) {
  const t = useT();
  const portrait = usePortrait();
  const reel = CAST.map((c) => ({ c, e: sceneFor(c.id, portrait) })).filter((x) => x.e?.sources.length);
  const n = reel.length;
  const [k, setK] = useState(Math.min(start, Math.max(0, n - 1)));
  const [muted, setMuted] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  const bar = useRef<HTMLElement>(null);
  const close = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    const back = document.activeElement as HTMLElement | null;
    close.current?.focus();
    document.documentElement.classList.add('no-scroll');
    duck(true);
    return () => { document.documentElement.classList.remove('no-scroll'); duck(false); pvScore(false); back?.focus?.(); };
  }, []);
  useEffect(() => { pvScore(!muted); }, [muted]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.preventDefault(); onClose(); }
      else if (e.key === 'ArrowRight') setK((x) => (x + 1) % n);
      else if (e.key === 'ArrowLeft') setK((x) => (x + n - 1) % n);
      else if (e.key === 'Tab') {
        const f = [...(box.current?.querySelectorAll<HTMLElement>('button') ?? [])];
        const i = f.indexOf(document.activeElement as HTMLElement);
        if (e.shiftKey ? i <= 0 : i === f.length - 1) { e.preventDefault(); f[e.shiftKey ? f.length - 1 : 0]?.focus(); }
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [n, onClose]);

  const cur = reel[k];
  const need = Math.min(1920, Math.round(Math.max(window.innerWidth, window.innerHeight) * Math.min(2, window.devicePixelRatio || 1)));
  const probe = document.createElement('video');
  const sources = cur ? pickSources(cur.e!.sources, need, (ty) => !!probe.canPlayType?.(ty)) : [];
  return (
    <div ref={box} className="pv" role="dialog" aria-modal="true" aria-label={t('home.pv')} data-testid="pv">
      {cur && (
        <video key={cur.e!.id} className="pv-video" autoPlay muted playsInline preload="auto" poster={cur.e!.poster}
          onTimeUpdate={(e) => { const v = e.currentTarget; bar.current?.style.setProperty('--p', String(v.duration ? v.currentTime / v.duration : 0)); }}
          onEnded={() => setK((x) => (x + 1) % n)}>
          {sources.map((s) => <source key={s.src} src={s.src} type={s.type} />)}
        </video>
      )}
      <div className="pv-vignette" aria-hidden="true" />
      {cur && (
        <div key={`c${k}`} className="pv-copy" style={{ '--accent': THEME[cur.c.id].accent } as React.CSSProperties}>
          <span className="eyebrow">PV　{String(k + 1).padStart(2, '0')} / {String(n).padStart(2, '0')}</span>
          <p className="pv-name">{starName(cur.c, t.lang)}</p>
          <p className="pv-line">{t(`star.${cur.c.id}.line` as Key)}</p>
        </div>
      )}
      <button type="button" className="pv-zone prev" aria-label={t('stars.prev')} onClick={() => setK((x) => (x + n - 1) % n)}><span className="pv-arrow" aria-hidden="true"><Icon name="back" size={22} /></span></button>
      <button type="button" className="pv-zone next" aria-label={t('stars.next')} onClick={() => setK((x) => (x + 1) % n)}><span className="pv-arrow" aria-hidden="true"><Icon name="chev" size={22} /></span></button>
      <div className="pv-bars" aria-hidden="true">
        {reel.map((r, i) => <i key={r.c.id} ref={i === k ? bar : undefined} className={i < k ? 'done' : i === k ? 'cur' : ''} />)}
      </div>
      <div className="pv-ctrl">
        <button type="button" className="icon-btn" aria-pressed={!muted} aria-label={muted ? t('top.soundOn') : t('top.soundOff')} onClick={() => setMuted((m) => !m)}>
          <Icon name={muted ? 'mute' : 'speaker'} size={22} />
        </button>
        <button ref={close} type="button" className="icon-btn" aria-label={t('common.close')} onClick={onClose}><Icon name="close" size={24} /></button>
      </div>
    </div>
  );
}

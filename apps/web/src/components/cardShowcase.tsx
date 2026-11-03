import { useEffect, useRef, useState, type CSSProperties, type PointerEvent as ReactPointerEvent } from 'react';
import { createPortal } from 'react-dom';
import type { CardDef } from '../data/cards';
import { cardMotion } from '../data/cards';
import { getStar } from '../data/cast';
import { starName } from '../i18n';
import { useT } from '../lib/store';
import { playVoice } from '../lib/sound';
import { CardArt } from './cardArt';
import { Icon } from './ui';
import '../styles/site.css';

export function CardShowcase({ card, onClose }: { card: CardDef; onClose: () => void }) {
  const t = useT();
  const ref = useRef<HTMLDivElement>(null);
  const motionRef = useRef<HTMLVideoElement>(null);
  const [rotation, setRotation] = useState({ x: 0, y: 0 });
  const rotationRef = useRef(rotation);
  const gesture = useRef<{ id: number; x: number; y: number; baseX: number; baseY: number; started: number; ready: boolean; dragged: boolean } | null>(null);
  const holdTimer = useRef<number | null>(null);
  const tapTimer = useRef<number | null>(null);
  const [dragging, setDragging] = useState(false);
  const [tapped, setTapped] = useState(false);
  const [motionPlaying, setMotionPlaying] = useState(false);
  const motionSrc = cardMotion(card);
  useEffect(() => {
    ref.current?.focus();
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('keydown', onKey);
      if (holdTimer.current !== null) window.clearTimeout(holdTimer.current);
      if (tapTimer.current !== null) window.clearTimeout(tapTimer.current);
    };
  }, [onClose]);

  function commit(next: { x: number; y: number }) {
    rotationRef.current = next;
    setRotation(next);
  }
  function tapCard() {
    setTapped(false);
    window.requestAnimationFrame(() => setTapped(true));
    if (tapTimer.current !== null) window.clearTimeout(tapTimer.current);
    tapTimer.current = window.setTimeout(() => setTapped(false), 620);
    void playVoice(card.voice ?? `/voice/${card.id}.mp3`, true);
    if (motionSrc) {
      const video = motionRef.current;
      if (video) {
        video.currentTime = 0;
        setMotionPlaying(true);
        void video.play().catch(() => setMotionPlaying(false));
      }
    }
  }
  function pointerDown(e: ReactPointerEvent<HTMLDivElement>) {
    e.preventDefault();
    gesture.current = { id: e.pointerId, x: e.clientX, y: e.clientY, baseX: rotationRef.current.x, baseY: rotationRef.current.y, started: performance.now(), ready: false, dragged: false };
    e.currentTarget.setPointerCapture?.(e.pointerId);
    if (holdTimer.current !== null) window.clearTimeout(holdTimer.current);
    holdTimer.current = window.setTimeout(() => {
      if (!gesture.current || gesture.current.id !== e.pointerId) return;
      gesture.current.ready = true;
      setDragging(true);
    }, 220);
  }
  function pointerMove(e: ReactPointerEvent<HTMLDivElement>) {
    const g = gesture.current;
    if (!g || g.id !== e.pointerId) return;
    const dx = e.clientX - g.x;
    const dy = e.clientY - g.y;
    if (!g.ready && Math.hypot(dx, dy) > 5) {
      g.ready = true;
      g.dragged = true;
      if (holdTimer.current !== null) window.clearTimeout(holdTimer.current);
      setDragging(true);
    }
    if (!g.ready) return;
    if (Math.hypot(dx, dy) > 5) g.dragged = true;
    commit({ x: Math.max(-58, Math.min(58, g.baseX - dy * 0.38)), y: g.baseY + dx * 0.55 });
  }
  function pointerEnd(e: ReactPointerEvent<HTMLDivElement>) {
    const g = gesture.current;
    if (!g || g.id !== e.pointerId) return;
    if (holdTimer.current !== null) window.clearTimeout(holdTimer.current);
    if (!g.dragged && !g.ready && performance.now() - g.started < 320) tapCard();
    gesture.current = null;
    setDragging(false);
    e.currentTarget.releasePointerCapture?.(e.pointerId);
  }
  function resetCard() {
    commit({ x: 0, y: 0 });
    setTapped(false);
  }
  return createPortal((
    <div className={`card-showcase tier-${card.rarity}`} role="presentation">
      <button type="button" className="card-showcase-return" onClick={onClose} aria-label={t('gallery.back')}><Icon name="back" size={22} /></button>
      <section ref={ref} className="card-showcase-stage" role="dialog" aria-modal="true" aria-label={`${t('gallery.showcase')} · ${card.rarity}`} tabIndex={-1}>
        <div className={`card-showcase-physical${dragging ? ' is-dragging' : ''}${tapped ? ' is-tapped' : ''}`} role="button" tabIndex={0} aria-label={t('gallery.tapInspect')}
          onPointerDown={pointerDown} onPointerMove={pointerMove} onPointerUp={pointerEnd} onPointerCancel={pointerEnd}
          onKeyDown={(e) => { if (e.key === ' ' || e.key === 'Enter') { e.preventDefault(); tapCard(); } }}
          onContextMenu={(e) => e.preventDefault()}>
          <div className="card-showcase-inner" style={{ '--showcase-rx': `${rotation.x}deg`, '--showcase-ry': `${rotation.y}deg` } as CSSProperties}>
            {[-5, -4, -3, -2, -1, 0, 1, 2, 3, 4, 5].map((layer) => (
              <i
                key={layer}
                className="card-showcase-core"
                style={{ '--showcase-layer': layer } as CSSProperties}
                aria-hidden="true"
              />
            ))}
            <div className="card-showcase-face">
              <CardArt card={card} />
              {motionSrc && <video ref={motionRef} className={`card-showcase-motion${motionPlaying ? ' is-playing' : ''}`} src={motionSrc} muted playsInline preload="metadata" onEnded={() => setMotionPlaying(false)} onError={() => setMotionPlaying(false)} />}
              {motionSrc && <i className={`card-showcase-motion-fx${motionPlaying ? ' is-playing' : ''}`} aria-hidden="true" />}
            </div>
            <div className="card-showcase-back"><img src="/cards/jstar-genesis-back.webp" alt="" draggable={false} /></div>
          </div>
        </div>
        <div className="card-showcase-copy" aria-live="polite">
          <span className={`badge r-${card.rarity}`}>{card.rarity}</span>
          <strong>{starName(getStar(card.star), t.lang)}</strong>
          <span>{t('gallery.tapInspect')}</span>
        </div>
        <button type="button" className="card-showcase-reset" onClick={resetCard} aria-label={t('gallery.reset')}><span /></button>
      </section>
    </div>
  ), document.body);
}

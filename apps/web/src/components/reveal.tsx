/**
 * Card draw presentation shared by the gacha result and the lucky-card result (its own chunk).
 *
 * card back → omen (light and particles in the tier colour; now and then an SSR first glows like an SR and
 * then breaks into gold) → SSR/UR: her clip full screen with the tier word and her voice line → card face in its
 * tier frame. Tap one card, reveal all, or skip. Only transforms and opacity animate; particles are one 2D
 * canvas that runs only while sparks are alive (60 fps on mid-range phones).
 */
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { RULES } from '@jstar/shared/rules';
import type { CardDef } from '../data/cards';
import { getStar } from '../data/cast';
import { starName } from '../i18n';
import { playVoice, sfx, stopVoice } from '../lib/sound';
import { useT } from '../lib/store';
import { CardArt, TIER_COLOR, rankOf, tierOf, titleOf, type Tier } from './cardArt';
import { SceneVideo, motionAllowed, sceneFor, usePortrait } from './stage';
import { faceBox, placeFace } from './heroLayout';
import { EIMI_BONUS_CARD_ID, eimiBonusIdle } from '../data/eimiBonusMedia';
import '../styles/reveal.css';

export interface RevealItem { card: CardDef; isNew: boolean }

const TIER_BY_RANK: Tier[] = ['N', 'R', 'SR', 'SSR', 'UR'];
/** e2e runs faster; `window.__REVEAL_SPEED__` overrides (1 = real time). */
function speed(): number {
  const w = window as unknown as { __REVEAL_SPEED__?: number; __E2E__?: boolean };
  return w.__REVEAL_SPEED__ ?? (w.__E2E__ ? 0.3 : 1);
}

// ---------------------------------------------------------------- particles

interface Spark { x: number; y: number; vx: number; vy: number; life: number; max: number; r: number; c: string }
const sparks: Spark[] = [];
let canvas: HTMLCanvasElement | null = null;
let raf = 0;
function loop(last: number) {
  const ctx = canvas?.getContext('2d');
  if (!canvas || !ctx) { raf = 0; return; }
  const now = performance.now();
  const dt = Math.min(0.05, (now - last) / 1000);
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const w = window.innerWidth; const h = window.innerHeight;
  if (canvas.width !== Math.round(w * dpr)) { canvas.width = Math.round(w * dpr); canvas.height = Math.round(h * dpr); }
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);
  ctx.globalCompositeOperation = 'lighter';
  for (let i = sparks.length - 1; i >= 0; i--) {
    const p = sparks[i];
    p.life += dt;
    if (p.life >= p.max) { sparks.splice(i, 1); continue; }
    p.vy += 40 * dt; p.vx *= 0.985; p.vy *= 0.985;
    p.x += p.vx * dt; p.y += p.vy * dt;
    const a = 1 - p.life / p.max;
    ctx.globalAlpha = a;
    ctx.fillStyle = p.c;
    ctx.beginPath(); ctx.arc(p.x, p.y, p.r * (0.6 + a * 0.6), 0, Math.PI * 2); ctx.fill();
  }
  ctx.globalAlpha = 1;
  raf = sparks.length ? requestAnimationFrame(() => loop(now)) : 0;
  if (!raf) ctx.clearRect(0, 0, w, h);
}
const UR_HUES = ['#F7A8C8', '#A8D8F7', '#F7E3A8', '#C8A8F7', '#A8F7D4'];
/** Sparks from an element's centre in the tier colour; more and faster for rarer tiers. */
export function burst(el: Element | null, tier: Tier, scale = 1) {
  if (!el || !canvas || !motionAllowed()) return;
  const b = el.getBoundingClientRect();
  const r = TIER_BY_RANK.indexOf(tier);
  const count = Math.round([6, 10, 22, 44, 64][r] * scale);
  for (let i = 0; i < count && sparks.length < 260; i++) {
    const a = Math.random() * Math.PI * 2; const v = (60 + Math.random() * 220) * (0.6 + r * 0.25);
    sparks.push({ x: b.left + b.width / 2, y: b.top + b.height / 2, vx: Math.cos(a) * v, vy: Math.sin(a) * v - 60, life: 0, max: 0.6 + Math.random() * 0.8, r: 1 + Math.random() * 2.2, c: tier === 'UR' ? UR_HUES[i % UR_HUES.length] : TIER_COLOR[tier] });
  }
  if (!raf) { const t0 = performance.now(); raf = requestAnimationFrame(() => loop(t0)); }
}
export function Sparks() {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => { canvas = ref.current; return () => { canvas = null; sparks.length = 0; cancelAnimationFrame(raf); raf = 0; }; }, []);
  return <canvas ref={ref} className="sparks" aria-hidden="true" />;
}

// ---------------------------------------------------------------- state machine

/** `faceUp` (L10): a result he already revealed opens face up, without replaying its reveal. */
export function useReveal(items: RevealItem[], faceUp = false) {
  const [face, setFace] = useState<boolean[]>(() => items.map(() => faceUp));
  const [omen, setOmen] = useState<(Tier | null)[]>(() => items.map(() => null));
  const [special, setSpecial] = useState<number | null>(null);
  const faceRef = useRef(face);
  faceRef.current = face;
  const gen = useRef(0);
  const running = useRef(new Set<number>());
  const shownSpecial = useRef(faceUp);
  /** During "reveal all", only the rarest card gets the full-screen moment. */
  const target = useRef<number | null>(null);
  const resume = useRef<(() => void) | null>(null);
  const at = <T,>(arr: T[], k: number, v: T) => arr.map((x, i) => (i === k ? v : x));
  const wait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms * speed()));
  const el = (k: number) => document.querySelector(`[data-reveal="${k}"]`);

  const one = useCallback(async (k: number, fast: boolean) => {
    if (faceRef.current[k] || running.current.has(k)) return;
    const g = gen.current;
    running.current.add(k);
    const card = items[k].card;
    const tier = tierOf(card);
    const r = rankOf(card);
    // Fake-out: an SSR/UR first shows the tier below, then breaks through.
    const fake = r >= 3 && motionAllowed() && Math.random() < 0.35;
    const shown = fake ? TIER_BY_RANK[r - 1] : tier;
    setOmen((o) => at(o, k, shown));
    sfx(r >= 2 ? 'omen' : 'flip');
    burst(el(k), shown, 0.5);
    await wait(r <= 1 ? (fast ? 140 : 280) : r === 2 ? (fast ? 420 : 700) : fast ? 650 : 1000);
    if (g !== gen.current) return;
    if (fake) {
      setOmen((o) => at(o, k, tier));
      sfx('upgrade');
      burst(el(k), tier);
      await wait(560);
      if (g !== gen.current) return;
    }
    setFace((f) => at(f, k, true));
    setOmen((o) => at(o, k, null));
    if (r >= 2) { sfx('sparkle'); burst(el(k), tier, r >= 3 ? 1.4 : 1); }
    if (r >= 3 && !shownSpecial.current && (target.current === null || target.current === k)) {
      shownSpecial.current = true;
      setSpecial(k);
      await new Promise<void>((res) => { resume.current = res; });
    }
    running.current.delete(k);
  }, [items]); // eslint-disable-line react-hooks/exhaustive-deps

  const tap = useCallback((k: number) => { void one(k, false); }, [one]);
  const revealAll = useCallback(async () => {
    const g = gen.current;
    // The rarest card goes last, so the big moment closes the sequence.
    const order = items.map((_, k) => k).filter((k) => !faceRef.current[k]).sort((a, b) => rankOf(items[a].card) - rankOf(items[b].card) || a - b);
    target.current = order[order.length - 1] ?? null;
    for (const k of order) {
      if (g !== gen.current) return;
      void one(k, true);
      await wait(rankOf(items[k].card) >= 3 ? 700 : 150);
    }
  }, [items, one]); // eslint-disable-line react-hooks/exhaustive-deps
  const closeSpecial = useCallback(() => { setSpecial(null); stopVoice(); resume.current?.(); resume.current = null; }, []);
  const skip = useCallback(() => {
    gen.current++;
    running.current.clear();
    shownSpecial.current = true;
    setFace(items.map(() => true));
    setOmen(items.map(() => null));
    closeSpecial();
  }, [items, closeSpecial]);
  return { face, omen, special, open: face.every(Boolean), tap, revealAll, skip, closeSpecial };
}

// ---------------------------------------------------------------- views

/** One card: a face-down button until turned, then the face in its tier frame with NEW / duplicate. */
export function RevealCard({ k, item, face, omen, onTap, label, dup, children, interactive = true }: {
  k: number; item: RevealItem; face: boolean; omen: Tier | null; onTap: () => void; label: string; dup: ReactNode; children?: ReactNode; interactive?: boolean;
}) {
  return (
    <div className={`rv${face ? ' is-face' : ''}${face && !item.isNew ? ' is-duplicate' : ''}${omen ? ` omen omen-${omen}` : ''}`} data-reveal={k} style={{ '--k': k } as React.CSSProperties}>
      <div className="rv-inner">
        <button type="button" className="rv-back" aria-label={label} onClick={onTap} disabled={!interactive || face || !!omen} tabIndex={!interactive || face ? -1 : 0} aria-hidden={face || undefined}>
          <img src="/cards/jstar-genesis-back.webp" alt="" draggable={false} />
        </button>
        <div className="rv-face" aria-hidden={!face}>{<CardArt card={item.card} small />}</div>
      </div>
      {children}
      {face && !item.isNew && <span className="rv-shatter" aria-hidden="true">{Array.from({ length: 9 }, (_, i) => <i key={i} style={{ '--s': i } as CSSProperties} />)}</span>}
      {face && (item.isNew ? <span className="rv-new" aria-hidden="true">NEW</span> : dup ?? <span className="rv-dup">+{RULES.duplicateShards[tierOf(item.card)]}</span>)}
    </div>
  );
}

/** SSR/UR: her clip full screen, the tier word, her name and the card, with her gacha voice line if recorded. */
/**
 * M2: her clip is cropped from her measured face box so her face sits to one side (left on a phone, right on a wider
 * screen), the card takes the free side above the copy, and the zoom-in is centred on her face, so neither the
 * card nor the copy ever covers it. While it is open the page under it is inert (no focus, no clicks).
 */
function useSpecialLayout(id: string | undefined, ratio: string, copy: React.RefObject<HTMLElement>) {
  const [size, setSize] = useState(() => ({ w: window.innerWidth, h: window.innerHeight }));
  useEffect(() => {
    const on = () => setSize({ w: window.innerWidth, h: window.innerHeight });
    window.addEventListener('resize', on);
    return () => window.removeEventListener('resize', on);
  }, []);
  const [copyTop, setCopyTop] = useState(() => size.h * 0.7);
  useLayoutEffect(() => { const r = copy.current?.getBoundingClientRect(); if (r?.height) setCopyTop(r.top); }, [size, copy]);
  const { w: W, h: H } = size;
  const fb = faceBox(id, ratio);
  const dispW = Math.max(W, H * (ratio === '16:9' ? 16 / 9 : 9 / 16));
  const half = ((fb[2] - fb[0]) * dispW) / 2;
  const tall = H >= W;
  // A phone: her face as far left as the crop allows; wider: in the right part of the screen, clear of the edge.
  const tx = tall ? half + 12 : Math.max(W * 0.45 + half, Math.min(W - 16 - half, W * 0.66));
  const { ox, oy, box } = placeFace(fb, ratio, W, H, tx, H * 0.36);
  const top = 64, bottom = copyTop - 16;
  const [x0, x1] = box[0] > W - box[2] ? [16, box[0] - 16] : [box[2] + 12, W - 12];
  let cw = Math.max(72, Math.min(tall ? 240 : 280, x1 - x0, (bottom - top) * 0.715));
  let ch = cw / 0.715;
  let cy = Math.min(Math.max(top, (box[1] + box[3]) / 2 - ch / 2), Math.max(top, bottom - ch));
  let cx = box[0] > W - box[2] ? Math.max(x0, x1 - cw - (tall ? 0 : 24)) : x0 + (x1 - x0 - cw) / 2;
  // A narrow phone: under her face, above the copy, when that leaves the card bigger than the strip beside her.
  const under = Math.min(240, W - 32, (bottom - box[3] - 12) * 0.715);
  if (tall && under > cw) { cw = under; ch = cw / 0.715; cy = box[3] + 12; cx = W - 16 - cw; }
  return {
    scene: { '--ox': `${(ox * 100).toFixed(1)}%`, '--oy': `${(oy * 100).toFixed(1)}%`, transformOrigin: `${((box[0] + box[2]) / 2).toFixed(0)}px ${((box[1] + box[3]) / 2).toFixed(0)}px` } as CSSProperties,
    card: { left: cx, top: cy, width: cw } as CSSProperties
  };
}

export function SpecialReveal({ card, onClose }: { card: CardDef; onClose: () => void }) {
  const t = useT();
  const portrait = usePortrait();
  const ref = useRef<HTMLDivElement>(null);
  const copy = useRef<HTMLDivElement>(null);
  const star = getStar(card.star);
  const scene = card.id === EIMI_BONUS_CARD_ID ? eimiBonusIdle() : sceneFor(card.star, portrait);
  const tier = tierOf(card);
  const look = useSpecialLayout(scene?.id, scene?.ratio ?? '9:16', copy);
  useEffect(() => {
    ref.current?.focus();
    sfx('reveal');
    void playVoice(`/voice/greet/${card.star}-gacha-ssr.mp3`);
    const auto = setTimeout(onClose, (tier === 'UR' ? 5200 : 4200) * speed());
    const onKey = (e: KeyboardEvent) => { if (['Escape', 'Enter', ' '].includes(e.key)) { e.preventDefault(); onClose(); } };
    window.addEventListener('keydown', onKey);
    // Everything beside it (the result page's cards and buttons) is inert while it is open.
    const others = [...(ref.current?.parentElement?.children ?? [])].filter((el) => el !== ref.current && !el.hasAttribute('inert'));
    others.forEach((el) => el.setAttribute('inert', ''));
    return () => { clearTimeout(auto); window.removeEventListener('keydown', onKey); others.forEach((el) => el.removeAttribute('inert')); };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <div ref={ref} className={`special tier-${tier}`} role="dialog" aria-modal="true" aria-label={`${tier} ${starName(star, t.lang)}「${titleOf(card, t.lang)}」`}
      tabIndex={-1} onClick={onClose} data-testid="special-reveal">
      {scene && <SceneVideo entry={scene} active className="special-scene" style={look.scene} />}
      <i className="special-flash" aria-hidden="true" />
      <div ref={copy} className="special-copy">
        <span className="special-tier" aria-hidden="true">{tier}</span>
        <p className="special-name">{starName(star, t.lang)}</p>
        <p className="special-title">{titleOf(card, t.lang)}</p>
      </div>
      <div className="special-card" style={look.card}><CardArt card={card} tilt /></div>
      <span className="special-hint">{t('gr.tap')}</span>
    </div>
  );
}

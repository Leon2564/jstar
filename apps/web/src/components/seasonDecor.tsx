/**
 * The day on her home (#61): a quiet decoration over her room for the days of their year — New Year's shrine visit,
 * summer fireworks, Halloween, Christmas, her birthday, his birthday, their anniversary. Cherry blossoms are the
 * weather layer's own petals (weatherRoom.tsx), so they are not drawn again here.
 *
 * It lives inside the home's stage, behind everything he taps: absolutely placed, `pointer-events: none`, hidden
 * from screen readers (the day's words are her calendar pill), drawn in the top corners and along the top edge, never
 * across her face. SVG only, in its own lazy chunk; under reduced motion nothing moves.
 */
import type { CSSProperties } from 'react';
import '../styles/season.css';

import type { DecorKind } from '../lib/decor';

const r1 = (n: number) => Math.round(n * 10) / 10;

/** A firework: rays and sparks around a point. */
function Burst({ x, y, r, color, delay }: { x: number; y: number; r: number; color: string; delay: number }) {
  const rays = Array.from({ length: 14 }, (_, i) => {
    const a = (i / 14) * Math.PI * 2;
    return <path key={i} d={`M${r1(x + Math.cos(a) * r * 0.35)} ${r1(y + Math.sin(a) * r * 0.35)}L${r1(x + Math.cos(a) * r)} ${r1(y + Math.sin(a) * r)}`} />;
  });
  const sparks = Array.from({ length: 14 }, (_, i) => {
    const a = ((i + 0.5) / 14) * Math.PI * 2;
    return <circle key={i} cx={r1(x + Math.cos(a) * r * 1.12)} cy={r1(y + Math.sin(a) * r * 1.12)} r="1.4" />;
  });
  return <g className="sd-burst" stroke={color} fill={color} strokeWidth="1.2" strokeLinecap="round" style={{ transformOrigin: `${x}px ${y}px`, animationDelay: `${delay}s` }}>{rays}{sparks}</g>;
}

function Bat({ x, y, s, delay }: { x: number; y: number; s: number; delay: number }) {
  return (
    // The placement is the outer group's; the inner one moves (a CSS transform would replace an SVG one).
    <g transform={`translate(${x} ${y}) scale(${s})`}>
      <g className="sd-bat" style={{ animationDelay: `${delay}s` }}>
        <path d="M0 0c-3-4-8-5-12-3 3 1 4 3 4 5-2-1-5-1-7 1 3 0 5 2 6 4 2-2 5-3 9-2 4-1 7 0 9 2 1-2 3-4 6-4-2-2-5-2-7-1 0-2 1-4 4-5-4-2-9-1-12 3z" />
      </g>
    </g>
  );
}

function Balloon({ x, y, color, delay }: { x: number; y: number; color: string; delay: number }) {
  return (
    <g className="sd-balloon" style={{ animationDelay: `${delay}s` }}>
      <path d={`M${x} ${y + 22}q-3 14 2 26`} stroke="rgba(239,232,237,0.55)" fill="none" strokeWidth="0.8" />
      <ellipse cx={x} cy={y} rx="13" ry="16" fill={color} />
      <ellipse cx={x - 4} cy={y - 6} rx="3" ry="5" fill="rgba(255,255,255,0.35)" />
      <path d={`M${x - 2} ${y + 16}h4l-2 3z`} fill={color} />
    </g>
  );
}

/** Confetti in a corner, seeded so it is the same picture on every visit. */
function Confetti({ colors, n = 28, seed: start = 7 }: { colors: string[]; n?: number; seed?: number }) {
  let seed = start;
  const rnd = () => { seed = (seed * 9301 + 49297) % 233280; return seed / 233280; };
  return (
    <g className="sd-confetti">
      {Array.from({ length: n }, (_, i) => {
        const x = r1(6 + rnd() * 118); const y = r1(6 + rnd() * 130); const rot = Math.round(rnd() * 180);
        return <rect key={i} x={x} y={y} width="5" height="2.4" rx="1" fill={colors[i % colors.length]} transform={`rotate(${rot} ${x} ${y})`} style={{ animationDelay: `${r1(rnd() * 4)}s` }} />;
      })}
    </g>
  );
}

function Heart({ x, y, s, delay }: { x: number; y: number; s: number; delay: number }) {
  return (
    <g transform={`translate(${x} ${y}) scale(${s})`}>
      <path className="sd-heart" style={{ animationDelay: `${delay}s` }} d="M0 3c-2-4-8-4-8 1 0 4 5 7 8 10 3-3 8-6 8-10 0-5-6-5-8-1z" />
    </g>
  );
}

/** One corner's art (a 130 × 170 box) and whether a garland runs along the top edge. */
interface Art { left: JSX.Element; right: JSX.Element; edge?: 'rope' | 'lights' }

function artFor(kind: DecorKind, accent: string): Art {
  const gold = '#e8c77a';
  const rose = '#f2a7b6';
  const shide = (x: number, i: number) => (
    <path key={x} className="sd-shide" style={{ animationDelay: `${i * 0.4}s`, transformOrigin: `${x}px 12px` }} d={`M${x} 10l7 0-5 9 7 0-5 9 7 0-5 9`}
      stroke="#fdfbf7" strokeWidth="2.4" fill="none" />
  );
  switch (kind) {
    case 'hatsumode':
      // Shimenawa along the top with paper shide, and a gold mizuhiki knot in the right corner.
      return {
        edge: 'rope',
        left: <g>{[24, 92].map(shide)}</g>,
        right: (
          <g>
            {[18].map(shide)}
            <circle className="sd-glow" cx="80" cy="72" r="30" fill={gold} opacity="0.12" />
            <g transform="translate(80 72)" stroke={gold} strokeWidth="1.6" fill="none" opacity="0.9">
              <path d="M-16 0c0-10 16-10 16 0s16 10 16 0-16-10-16 0-16 10-16 0z" />
              <path d="M0 0l-10 26M0 0l10 26M-4 0l-12 22M4 0l12 22" />
            </g>
          </g>
        )
      };
    case 'fireworks':
      return {
        left: <g><Burst x={52} y={64} r={40} color="#ffd27a" delay={0} /><Burst x={104} y={126} r={18} color="#a9d6ff" delay={2.4} /></g>,
        right: <Burst x={70} y={52} r={34} color="#ff9fb4" delay={1.3} />
      };
    case 'halloween':
      return {
        left: (
          <g fill="#231a2e">
            <path d="M22 0v58" stroke="rgba(239,232,237,0.4)" strokeWidth="0.8" />
            <g transform="translate(22 64)"><circle r="4" /><path d="M-8-3l4 2M-8 3l4-1M8-3l-4 2M8 3l-4-1" stroke="#231a2e" strokeWidth="1" /></g>
            <Bat x={74} y={60} s={1.1} delay={0} />
            <Bat x={112} y={30} s={0.7} delay={0.8} />
          </g>
        ),
        right: (
          <g fill="#231a2e">
            <circle cx="72" cy="54" r="24" fill="#f6d98e" opacity="0.55" />
            <circle cx="82" cy="48" r="22" fill="rgba(27,30,61,0.55)" />
            <Bat x={30} y={104} s={0.8} delay={1.6} />
          </g>
        )
      };
    case 'christmas':
      return {
        edge: 'lights',
        left: <g transform="translate(40 66)"><path d="M0-40v31" stroke="rgba(239,232,237,0.5)" strokeWidth="0.8" /><circle r="7" fill={gold} /><circle cx="-2" cy="-2" r="2" fill="rgba(255,255,255,0.5)" /></g>,
        right: <g transform="translate(90 60)"><path d="M0-32v23" stroke="rgba(239,232,237,0.5)" strokeWidth="0.8" /><circle r="9" fill="#c8384f" /><circle cx="-3" cy="-3" r="2.5" fill="rgba(255,255,255,0.5)" /></g>
      };
    case 'herBirthday':
      return {
        left: <g><Balloon x={34} y={70} color={accent} delay={0} /><Balloon x={66} y={100} color={gold} delay={0.9} /><Confetti colors={[accent, gold, rose]} n={8} /></g>,
        right: <g><Balloon x={92} y={82} color={rose} delay={0.5} /><Confetti colors={[rose, accent, gold]} n={8} seed={31} /></g>
      };
    case 'hisBirthday':
      return {
        left: <Confetti colors={[gold, rose, '#a9d6ff', '#fdfbf7']} n={14} />,
        right: (
          <g>
            <Confetti colors={['#fdfbf7', gold, rose, '#a9d6ff']} n={10} seed={31} />
            <g transform="translate(86 70)" className="sd-glow"><path d="M-3 10h6v22h-6z" fill="#fdfbf7" /><path d="M0 -2c4 5 4 9 0 12-4-3-4-7 0-12z" fill="#ffd27a" /></g>
          </g>
        )
      };
    case 'anniversary':
      return {
        left: <g fill={accent}><Heart x={30} y={80} s={1.1} delay={0} /><Heart x={64} y={40} s={0.7} delay={1.1} /></g>,
        right: <g fill={accent}><Heart x={92} y={60} s={0.9} delay={0.6} /><Heart x={60} y={112} s={0.6} delay={1.8} /></g>
      };
  }
}

/**
 * Her home's decoration for the day. `accent`: her colour (balloons, hearts). Two corner pieces of a fixed size (they
 * never grow over her on a wide screen), and for some days a garland along the top edge.
 */
export function SeasonDecor({ kind, accent }: { kind: DecorKind; accent: string }) {
  const art = artFor(kind, accent);
  return (
    <div className={`sd sd-${kind}`} data-testid="season-decor" data-kind={kind} aria-hidden="true" style={{ '--accent': accent } as CSSProperties}>
      {art.edge === 'rope' && (
        <svg className="sd-edge" viewBox="0 0 400 30" preserveAspectRatio="none" focusable="false">
          <path d="M-4 8C60 22 150 24 200 18S330 8 404 22" stroke="#c9a15a" strokeWidth="5" fill="none" strokeLinecap="round" vectorEffect="non-scaling-stroke" opacity="0.85" />
        </svg>
      )}
      {art.edge === 'lights' && <i className="sd-lights" />}
      <svg className="sd-corner sd-left" viewBox="0 0 130 170" focusable="false">{art.left}</svg>
      <svg className="sd-corner sd-right" viewBox="0 0 130 170" focusable="false">{art.right}</svg>
    </div>
  );
}

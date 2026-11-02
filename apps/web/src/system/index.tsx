/**
 * JSTAR visual system v1 — the React primitives (#162). Small and presentational: the look is system.css on the tokens
 * of styles/tokens.css; the behaviour stays with the screens that use them. docs/design-system.md says when to use
 * which; /#/design shows them all (test and demo sites only). Imported by lazy screens only (her room, /#/design).
 */
import type { ButtonHTMLAttributes, CSSProperties, InputHTMLAttributes, ReactNode, Ref } from 'react';
import { Link } from 'react-router-dom';
import './system.css';

/** ✦ JSTAR: the rose four-point sparkle and the letter-spaced serif capitals. */
export function BrandMark({ label = 'JSTAR' }: { label?: string }) {
  return <span className="js-brand"><span className="js-spark" aria-hidden="true">✦</span>{label}</span>;
}

/** Her name set vertically (直排), with her romanised name in rose small capitals alongside. */
export function VerticalName({ name, romaji, large, className = '' }: { name: string; romaji: string; large?: boolean; className?: string }) {
  return (
    <span className={`js-vname${large ? ' large' : ''} ${className}`} aria-label={`${name} ${romaji}`} role="img">
      <span className="js-vname-jp" aria-hidden="true">{name}</span>
      <span className="js-vname-ro" aria-hidden="true">{romaji}</span>
    </span>
  );
}

/** A letter-spaced serif label: rose capitals (「HER ROOM 01 / 05」), or ivory meta on the night (`meta`). */
export function SpacedLabel({ children, meta, light, dot, className = '' }: { children: ReactNode; meta?: boolean; light?: boolean; dot?: boolean; className?: string }) {
  return <span className={`js-label${meta ? ' meta' : ''}${light ? ' light' : ''} ${className}`}>{dot && <i className="js-dot" aria-hidden="true" />}{children}</span>;
}

type Btn = ButtonHTMLAttributes<HTMLButtonElement> & { to?: string; large?: boolean; testId?: string };
/** The primary action: the rose block — the only solid rose on a screen. */
export function BtnRose({ to, large, testId, className = '', children, ...rest }: Btn) {
  const cls = `js-btn-rose${large ? ' large' : ''} ${className}`;
  return to ? <Link to={to} className={cls} data-testid={testId}>{children}</Link> : <button type="button" className={cls} data-testid={testId} {...rest}>{children}</button>;
}
/** The secondary action: a double-rule line; on the night by default, `light` on light grounds. */
export function BtnLine({ to, light, testId, className = '', children, ...rest }: Btn & { light?: boolean }) {
  const cls = `js-btn-line${light ? ' light' : ''} ${className}`;
  return to ? <Link to={to} className={cls} data-testid={testId}>{children}</Link> : <button type="button" className={cls} data-testid={testId} {...rest}>{children}</button>;
}

/** A reply he can tap: a double rule on the night; `hot` (her ✦ invitation) is the rose block; `plain` is text only. */
export function ReplyChoice({ to, hot, plain, index, testId, children, ...rest }: Btn & { hot?: boolean; plain?: boolean; index?: number }) {
  const cls = `${hot ? 'js-btn-rose' : plain ? 'js-btn-text' : 'js-btn-line'} js-reply`;
  const body = <>{index !== undefined && <kbd aria-hidden="true">{index}</kbd>}{children}</>;
  return to ? <Link to={to} className={cls} data-testid={testId}>{body}</Link> : <button type="button" className={cls} data-testid={testId} {...rest}>{body}</button>;
}

/** The hairline input: a bottom line, a meta (her voice minutes), and what comes after it (the mic). */
export function HairlineInput({ meta, after, className = '', inputRef, ...input }: InputHTMLAttributes<HTMLInputElement> & { meta?: ReactNode; after?: ReactNode; inputRef?: Ref<HTMLInputElement> }) {
  return (
    <span className={`js-input ${className}`}>
      <input ref={inputRef} {...input} />
      {meta && <span className="js-input-meta">{meta}</span>}
      {after}
    </span>
  );
}

/** The five as thin rules with their names under them; hers has the rose segment. */
export function StarRuleSwitcher({ items, active, onPick, label }: { items: { id: string; label: string; aria?: string; describedBy?: string; dim?: boolean }[]; active: string; onPick: (id: string) => void; label: string }) {
  return (
    <div className="js-stars" role="group" aria-label={label}>
      {items.map((s) => (
        <button key={s.id} type="button" className={`js-star${s.dim ? ' dim' : ''}`} aria-pressed={s.id === active} aria-label={s.aria} aria-describedby={s.describedBy} onClick={() => onPick(s.id)} data-testid={`star-rule-${s.id}`}>
          <i aria-hidden="true" /><span>{s.label}</span>
        </button>
      ))}
    </div>
  );
}

/** Thin rules as a counter (her messages 1 / 3): the current one rose. */
export function RuleCounter({ n, at }: { n: number; at: number }) {
  return <span className="js-rules" aria-hidden="true">{Array.from({ length: n }, (_, i) => <i key={i} className={i === at ? 'on' : undefined} />)}</span>;
}

/** The ┌ hairline corner: the one frame that says "this is a picture". */
export function CornerFrame({ style }: { style?: CSSProperties }) {
  return <span className="js-corner" style={style} aria-hidden="true" />;
}

/** The night over her video: her face clear, the lower half sinking into navy-deep. */
export function NightFade({ variant = 'room' }: { variant?: 'room' | 'pure' | 'morning' | 'index' | 'desk' }) {
  return <span className={`js-night${variant === 'room' ? '' : ` ${variant}`}`} aria-hidden="true" />;
}

/** A few small white four-point sparkles drifting over her video. */
export function Sparkles({ points = DEFAULT_SPARKS }: { points?: { x: string; y: string; size?: number; delay?: number }[] }) {
  return (
    <span className="js-sparkles" aria-hidden="true">
      {points.map((p, i) => <span key={i} style={{ left: p.x, top: p.y, fontSize: p.size ?? 9, animationDelay: `${p.delay ?? i * 1.3}s` }}>✦</span>)}
    </span>
  );
}
const DEFAULT_SPARKS = [{ x: '77%', y: '30%' }, { x: '9%', y: '56%', size: 7 }, { x: '87%', y: '62%', size: 7 }];

/** Her voice note: play, the waveform (rose up to where it has played) and the time. */
export function Waveform({ bars, progress, time, playing, onPlay, label }: { bars: number[]; progress: number; time: string; playing?: boolean; onPlay?: () => void; label: string }) {
  const played = Math.round(bars.length * Math.max(0, Math.min(1, progress)));
  return (
    <span className="js-voice">
      <button type="button" className="js-voice-play" onClick={onPlay} aria-label={label} aria-pressed={playing}>
        <svg viewBox="0 0 14 14" width="13" height="13" aria-hidden="true">{playing ? <path d="M3 2h3v10H3zM8 2h3v10H8z" fill="currentColor" /> : <path d="M3 1.5v11l9-5.5z" fill="currentColor" />}</svg>
      </button>
      <span className="js-wave" aria-hidden="true">{bars.map((h, i) => <i key={i} className={i < played ? 'on' : undefined} style={{ height: h }} />)}</span>
      <span className="js-voice-time">{time}</span>
    </span>
  );
}

/** Her photo as a small print: an ivory border, a slight tilt, on the night. */
export function PrintPhoto({ src, alt, style }: { src: string; alt: string; style?: CSSProperties }) {
  return <img className="js-print" src={src} alt={alt} style={style} decoding="async" loading="lazy" />;
}

/** A double-rule panel (on the night, or `light`). */
export function Panel({ children, light, className = '' }: { children: ReactNode; light?: boolean; className?: string }) {
  return <div className={`js-panel${light ? ' light' : ''} ${className}`}>{children}</div>;
}
/** A hint strip: a rose rule at its left. */
export function Hint({ children, light }: { children: ReactNode; light?: boolean }) {
  return <p className={`js-hint${light ? ' light' : ''}`} role="note">{children}</p>;
}

import { useEffect, useMemo, useRef } from 'react';
import type { Key } from '../i18n';
import { useT } from '../lib/store';
import { ambience } from '../lib/sound';
import type { Room } from '../lib/herWeather';
import '../styles/weather.css';

/**
 * Her window's weather (#63), its own lazy chunk: only a room with something to draw loads it. Rain, snow, petals and
 * a storm are CSS layers moved by `transform` alone (the compositor, not a canvas redrawn every frame); the textures
 * are small SVG tiles made here once. With reduced motion nothing moves: the light, the drops on the glass and the
 * settled flakes stay, so the picture is still right.
 */

type Rng = () => number;
function seeded(seed: number): Rng {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const f1 = (n: number) => n.toFixed(1);
const tile = (size: number, body: string) =>
  `url("data:image/svg+xml,${encodeURIComponent(`<svg xmlns='http://www.w3.org/2000/svg' width='${size}' height='${size}'>${body}</svg>`)}")`;

/** Each mark is drawn again one tile higher, so a mark crossing the bottom edge continues at the top: a seamless loop. */
function marks(size: number, n: number, seed: number, draw: (x: number, y: number, r: Rng) => string): string {
  const r = seeded(seed);
  let out = '';
  for (let i = 0; i < n; i++) {
    const x = r() * size;
    const y = r() * size;
    // Both copies get the same stream, so they are the same mark.
    out += draw(x, y, seeded(seed * 31 + i)) + draw(x, y - size, seeded(seed * 31 + i));
  }
  return out;
}

const streaks = (size: number, n: number, len: number, alpha: number, seed: number) =>
  tile(size, marks(size, n, seed, (x, y, r) => {
    const l = len * (0.6 + r() * 0.8);
    return `<path d='M${f1(x)} ${f1(y)}v${f1(l)}' stroke='rgba(215,228,255,${f1(alpha * (0.5 + r() * 0.5))})' stroke-width='1.1' stroke-linecap='round'/>`;
  }));
const flakes = (size: number, n: number, rMax: number, seed: number) =>
  tile(size, marks(size, n, seed, (x, y, r) => `<circle cx='${f1(x)}' cy='${f1(y)}' r='${f1(0.8 + r() * rMax)}' fill='rgba(255,255,255,${f1(0.45 + r() * 0.5)})'/>`));
const petals = (size: number, n: number, seed: number) =>
  tile(size, marks(size, n, seed, (x, y, r) =>
    `<ellipse cx='${f1(x)}' cy='${f1(y)}' rx='${f1(2.4 + r() * 2)}' ry='${f1(1.4 + r())}' transform='rotate(${Math.round(r() * 180)} ${f1(x)} ${f1(y)})' fill='rgba(255,${190 + Math.round(r() * 30)},${205 + Math.round(r() * 25)},0.85)'/>`));
/** Drops on the window glass, lit from the top left. */
const drops = (size: number, n: number, seed: number) => {
  const r = seeded(seed);
  let body = `<defs><radialGradient id='d' cx='38%' cy='32%' r='70%'><stop offset='0' stop-color='#fff' stop-opacity='.7'/><stop offset='.55' stop-color='#dfe8ff' stop-opacity='.16'/><stop offset='1' stop-color='#fff' stop-opacity='.32'/></radialGradient></defs>`;
  for (let i = 0; i < n; i++) {
    const x = r() * size; const y = r() * size; const s = 1.2 + r() * r() * 5;
    body += `<ellipse cx='${f1(x)}' cy='${f1(y)}' rx='${f1(s)}' ry='${f1(s * 1.15)}' fill='url(#d)'/>`;
  }
  return tile(size, body);
};

interface Layer { image: string; size: number; seconds: number; className: string; sway?: boolean }

function layersFor(room: Room): { falling: Layer[]; still: string | null } {
  switch (room.sky) {
    case 'rain':
      return { falling: [
        { image: streaks(220, 26, 26, 0.55, 3), size: 220, seconds: 0.62, className: 'wx-far' },
        { image: streaks(320, 16, 44, 0.8, 7), size: 320, seconds: 0.48, className: 'wx-near' }
      ], still: drops(260, 20, 11) };
    case 'storm':
      return { falling: [
        { image: streaks(200, 40, 34, 0.6, 5), size: 200, seconds: 0.4, className: 'wx-far wx-slant' },
        { image: streaks(300, 26, 60, 0.85, 9), size: 300, seconds: 0.3, className: 'wx-near wx-slant' }
      ], still: drops(240, 28, 13) };
    case 'snow':
      return { falling: [
        { image: flakes(240, 28, 1.6, 17), size: 240, seconds: 14, className: 'wx-far', sway: true },
        { image: flakes(360, 16, 3, 19), size: 360, seconds: 9, className: 'wx-near', sway: true }
      ], still: flakes(300, 22, 2.2, 23) };
    default:
      return room.sakura
        ? { falling: [{ image: petals(340, 9, 29), size: 340, seconds: 16, className: 'wx-near', sway: true }], still: petals(340, 6, 31) }
        : { falling: [], still: null };
  }
}

function reducedMotion(): boolean {
  try { return !!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches; } catch { return false; }
}

/** The layers over her clip, inside the home's stage. */
export function WeatherLayer({ room, faceAt }: { room: Room; faceAt?: () => number[] | null }) {
  const still = useMemo(reducedMotion, []);
  // M6: where her face is on screen ([left, top, right, bottom]), so the weather keeps clear of it (weather.css).
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!faceAt) return undefined;
    const place = () => {
      const f = faceAt(), el = box.current;
      if (!f || !el) return;
      el.style.setProperty('--wx-x', `${Math.round((f[0] + f[2]) / 2)}px`);
      const w = Math.max(f[2] - f[0], 80), h = Math.max(f[3] - f[1], 80);
      // Her hair and shoulders are wider than her face: half her width is about 1.9 faces; her hair starts a face above it.
      el.style.setProperty('--wx-w', `${Math.round(Math.min(w * 1.9, window.innerWidth * 0.42))}px`);
      el.style.setProperty('--wx-top', `${Math.max(0, Math.round(f[1] - h * 1.1))}px`);
    };
    place();
    const id = setInterval(place, 2000);
    window.addEventListener('resize', place);
    return () => { clearInterval(id); window.removeEventListener('resize', place); };
  }, [faceAt]);
  const { falling, still: texture } = useMemo(() => layersFor(room), [room.sky, room.sakura]); // eslint-disable-line react-hooks/exhaustive-deps
  // Weather you can hear, quietly under everything and only while sound is on (lib/sound.ts): rain on the glass and a
  // snowy night's hush (#82 files), a storm synthesised.
  useEffect(() => {
    ambience(room.sky === 'storm' || room.sky === 'rain' || room.sky === 'snow' ? room.sky : null);
    return () => ambience(null);
  }, [room.sky]);
  const moving = !still && falling.length > 0;
  return (
    <div ref={box} className={`wx wx-sky-${room.sky} wx-phase-${room.phase}${room.hot ? ' wx-hot' : ''}`} data-testid="wx-layer" data-sky={room.sky}
      data-phase={room.phase} data-motion={moving ? 'on' : 'off'} aria-hidden="true">
      <i className="wx-grade" />
      {moving && falling.map((l) => {
        const fall = <i className={`wx-fall ${l.className}`} style={{ backgroundImage: l.image, backgroundSize: `${l.size}px`, '--h': `${l.size}px`, animationDuration: `${l.seconds}s` } as React.CSSProperties} />;
        return l.sway ? <i key={l.className} className="wx-sway">{fall}</i> : <i key={l.className} className="wx-box">{fall}</i>;
      })}
      {/* What stays when nothing moves: drops on the glass in the rain, settled flakes, a few petals. */}
      {texture && (room.sky === 'rain' || room.sky === 'storm' || !moving) && <i className="wx-still" style={{ backgroundImage: texture }} />}
      {room.hot && <i className="wx-glare" />}
    </div>
  );
}

const SKY_KEY: Record<string, Key> = { clear: 'wx.clear', cloudy: 'wx.cloudy', fog: 'wx.fog', rain: 'wx.rain', snow: 'wx.snow', thunder: 'wx.thunder' };

/**
 * The sky and temperature where she is, with the data's credit: Open-Meteo is CC BY 4.0 and is credited wherever its
 * weather is shown. Her city is not named (it is her hometown only once the agency confirms it, #48).
 */
export function WeatherChip({ room }: { room: Room }) {
  const t = useT();
  if (!room.condition) return null;
  return (
    <p className="wx-chip" data-testid="wx-chip" aria-label={t('wx.where')}>
      <span>{t(SKY_KEY[room.condition])}{room.tempC !== null && ` ${room.tempC}°C`}</span>
      <a className="wx-credit" href="https://open-meteo.com/" target="_blank" rel="noopener noreferrer">{t('wx.credit')}</a>
    </p>
  );
}

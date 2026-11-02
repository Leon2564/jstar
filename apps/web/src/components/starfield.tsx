/**
 * Four-pointed stars and rose light dust on a canvas, each at its own depth so it drifts with the
 * parallax. Its own chunk: the home page paints without it and it fades in once loaded.
 */
import { useEffect, useRef } from 'react';
import { motionAllowed, type Tilt } from './stage';

interface Particle { x: number; y: number; z: number; r: number; star: boolean; tw: number; vy: number }

/** Deterministic PRNG so the field looks the same on every visit (and in screenshots). */
function mulberry(seed: number) {
  return () => { seed = (seed + 0x6d2b79f5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t ^= t + Math.imul(t ^ (t >>> 7), 61 | t); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

export function makeParticles(count: number, seed = 7): Particle[] {
  const rnd = mulberry(seed);
  return Array.from({ length: count }, () => {
    const z = 0.2 + rnd() * 0.8;
    return { x: rnd(), y: rnd(), z, r: (0.6 + rnd() * 1.6) * z, star: rnd() < 0.16, tw: rnd() * Math.PI * 2, vy: (0.004 + rnd() * 0.01) * z };
  });
}

/** Out-of-focus lights close to the camera: few, large, faint, moving the most with the tilt (depth cue). */
export function makeBokeh(count: number, seed = 11) {
  const rnd = mulberry(seed);
  return Array.from({ length: count }, () => ({ x: rnd(), y: rnd(), r: 18 + rnd() * 46, a: 0.05 + rnd() * 0.09, vx: (rnd() - 0.5) * 0.006, ph: rnd() * Math.PI * 2 }));
}

export default function StarField({ tilt, density = 70, className, bokeh = false }: { tilt: React.MutableRefObject<Tilt>; density?: number; className?: string; bokeh?: boolean }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const canvas = ref.current;
    const ctx = canvas?.getContext?.('2d');
    if (!canvas || !ctx) return;
    const parts = makeParticles(density);
    const lights = bokeh ? makeBokeh(7) : [];
    // One soft disc, drawn once and stamped: cheaper than a gradient per light per frame.
    const sprite = document.createElement('canvas');
    sprite.width = sprite.height = 64;
    const sc = lights.length ? sprite.getContext?.('2d') : null;
    if (sc) { const g = sc.createRadialGradient(32, 32, 0, 32, 32, 32); g.addColorStop(0, 'rgba(255,226,232,1)'); g.addColorStop(0.55, 'rgba(255,214,224,0.45)'); g.addColorStop(1, 'rgba(255,214,224,0)'); sc.fillStyle = g; sc.fillRect(0, 0, 64, 64); }
    const moving = motionAllowed();
    let w = 0; let h = 0; let raf = 0; let last = performance.now();
    const resize = () => {
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      w = canvas.clientWidth; h = canvas.clientHeight;
      canvas.width = Math.round(w * dpr); canvas.height = Math.round(h * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      if (!moving) draw(0);
    };
    const draw = (dt: number) => {
      ctx.clearRect(0, 0, w, h);
      const { x: tx, y: ty } = tilt.current;
      if (sc) for (const b of lights) {
        if (moving) { b.x += b.vx * dt; if (b.x < -0.1) b.x = 1.1; if (b.x > 1.1) b.x = -0.1; b.ph += dt * 0.4; }
        ctx.globalAlpha = b.a * (0.75 + 0.25 * Math.sin(b.ph));
        ctx.drawImage(sprite, b.x * w - tx * 70 - b.r, b.y * h - ty * 46 - b.r, b.r * 2, b.r * 2);
      }
      ctx.globalAlpha = 1;
      for (const p of parts) {
        if (moving) { p.y -= p.vy * dt; if (p.y < -0.05) p.y = 1.05; p.tw += dt * 0.9; }
        const px = p.x * w - tx * 36 * p.z;
        const py = p.y * h - ty * 24 * p.z;
        const a = (0.35 + 0.45 * Math.sin(p.tw) ** 2) * p.z;
        if (p.star) {
          const s = p.r * 4.2;
          ctx.fillStyle = `rgba(239, 232, 237, ${a.toFixed(3)})`;
          ctx.beginPath();
          ctx.moveTo(px, py - s); ctx.quadraticCurveTo(px, py, px + s, py); ctx.quadraticCurveTo(px, py, px, py + s);
          ctx.quadraticCurveTo(px, py, px - s, py); ctx.quadraticCurveTo(px, py, px, py - s);
          ctx.fill();
        } else {
          ctx.fillStyle = `rgba(227, 168, 178, ${(a * 0.8).toFixed(3)})`;
          ctx.beginPath(); ctx.arc(px, py, p.r, 0, Math.PI * 2); ctx.fill();
        }
      }
    };
    const loop = (now: number) => {
      const dt = Math.min(0.05, (now - last) / 1000);
      last = now;
      draw(dt);
      raf = requestAnimationFrame(loop);
    };
    const start = () => { if (moving && !raf && !document.hidden) { last = performance.now(); raf = requestAnimationFrame(loop); } };
    const stop = () => { cancelAnimationFrame(raf); raf = 0; };
    const onVis = () => (document.hidden ? stop() : start());
    resize();
    start();
    const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(resize) : null;
    ro?.observe(canvas);
    document.addEventListener('visibilitychange', onVis);
    return () => { stop(); ro?.disconnect(); document.removeEventListener('visibilitychange', onVis); };
  }, [density, tilt, bokeh]);
  return <canvas ref={ref} className={`starfield ${className ?? ''}`} aria-hidden="true" />;
}


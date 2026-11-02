/**
 * Site-wide micro-interactions, installed once when the browser is idle (its own chunk):
 * - magnetic buttons (`.magnetic`) lean toward a fine pointer;
 * - cards (`.tilt`) tilt under the pointer with a moving glare;
 * - a soft light follows the cursor on desktop;
 * - on iOS, the first tap asks for motion permission so the gyroscope drives the parallax.
 * All of it is skipped under reduced motion or save-data. Only CSS variables are written: no React re-renders.
 */
import { motionAllowed } from './stage';
import { sfx } from '../lib/sound';

export function installFx(): void {
  if (!motionAllowed()) return;
  const fine = window.matchMedia?.('(hover: hover) and (pointer: fine)').matches;

  // iOS 13+: device orientation needs a permission prompt triggered by a tap.
  const DOE = (window as unknown as { DeviceOrientationEvent?: { requestPermission?: () => Promise<string> } }).DeviceOrientationEvent;
  if (!fine && DOE?.requestPermission) {
    const ask = () => { window.removeEventListener('touchend', ask, true); void DOE.requestPermission!().catch(() => { /* declined: touch parallax only */ }); };
    window.addEventListener('touchend', ask, true);
  }

  // UI tap sound on buttons and links (the engine ignores it until sound is on).
  window.addEventListener('pointerdown', (e) => {
    if ((e.target as Element | null)?.closest?.('button, a, [role="tab"]')) sfx('tap');
  }, { passive: true, capture: true });

  if (!fine) return;
  const light = document.createElement('div');
  light.className = 'cursor-light';
  light.setAttribute('aria-hidden', 'true');
  document.body.appendChild(light);

  let mag: HTMLElement | null = null;
  let tilt: HTMLElement | null = null;
  let raf = 0; let x = 0; let y = 0;
  const release = (el: HTMLElement | null, props: string[]) => { if (el) for (const p of props) el.style.removeProperty(p); };
  const frame = () => {
    raf = 0;
    light.style.transform = `translate3d(${x - 200}px, ${y - 200}px, 0)`;
    if (mag) {
      const b = mag.getBoundingClientRect();
      mag.style.setProperty('--mx', `${((x - b.left) / b.width - 0.5) * 10}px`);
      mag.style.setProperty('--my', `${((y - b.top) / b.height - 0.5) * 8}px`);
    }
    if (tilt) {
      const b = tilt.getBoundingClientRect();
      const u = (x - b.left) / b.width; const v = (y - b.top) / b.height;
      tilt.style.setProperty('--rx', `${(0.5 - v) * 14}deg`);
      tilt.style.setProperty('--ry', `${(u - 0.5) * 16}deg`);
      tilt.style.setProperty('--gx', `${u * 100}%`);
      tilt.style.setProperty('--gy', `${v * 100}%`);
    }
  };
  window.addEventListener('pointermove', (e) => {
    if (e.pointerType !== 'mouse') return;
    x = e.clientX; y = e.clientY;
    const t = e.target as Element | null;
    const m = (t?.closest?.('.magnetic') as HTMLElement | null) ?? null;
    if (m !== mag) { release(mag, ['--mx', '--my']); mag = m; }
    const k = (t?.closest?.('.tilt') as HTMLElement | null) ?? null;
    if (k !== tilt) { release(tilt, ['--rx', '--ry', '--gx', '--gy']); tilt?.classList.remove('tilting'); tilt = k; tilt?.classList.add('tilting'); }
    light.classList.add('on');
    if (!raf) raf = requestAnimationFrame(frame);
  }, { passive: true });
  document.documentElement.addEventListener('pointerleave', () => { light.classList.remove('on'); });
}

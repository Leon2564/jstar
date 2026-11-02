import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App, { prefetchRoutes } from './App';
import { ensureLang, loadFonts } from './i18n';
import { serialFromPath } from './lib/serial';
import { load } from './lib/state';
import { loadConfig } from './services/api';
import { installSound } from './lib/sound';
import { registerServiceWorker } from './lib/push';
import './styles/tokens.css';
import './global.css';
import './immersive.css';

// The QR on the back of a lucky card opens /lucky (any card) or /r/<code> (that card). The app routes in the hash,
// so turn those into the serial screen before the router reads the URL (the Worker redirects them server-side too).
const { pathname } = window.location;
if (/^\/(?:lucky\/?|r\/.*)$/.test(pathname)) {
  let code: string | null = null;
  try { code = serialFromPath(pathname); } catch { /* malformed %-escape: open the empty form */ }
  window.history.replaceState(null, '', `/#/serial${code ? `?code=${code}` : ''}`);
}

// L15: Chrome says when the site can be installed; kept for the guest's install sheet (components/installHint.tsx).
window.addEventListener('beforeinstallprompt', (e) => {
  (window as unknown as { __jstarInstall?: Event }).__jstarInstall = e;
  window.dispatchEvent(new Event('jstar-installable'));
});

const initial = load();
installSound();
loadFonts(initial.lang);
// The active language is fetched before the first render so there is never a flash of the wrong language.
// The API config (demo hints) is fetched alongside it; both are tiny.
void Promise.all([ensureLang(initial.lang), loadConfig()]).finally(() => {
  createRoot(document.getElementById('root')!).render(<StrictMode><App initial={initial} /></StrictMode>);
  const idle = (window as unknown as { requestIdleCallback?: (cb: () => void) => void }).requestIdleCallback ?? ((cb: () => void) => setTimeout(cb, 1200));
  // The service worker only shows notifications (no cache), so registering it for everyone changes nothing else;
  // it also makes the site installable, which iOS needs before it allows push.
  const later = () => idle(() => { prefetchRoutes(); void import('./components/fx').then((m) => m.installFx()); registerServiceWorker(); });
  // A-M11: on the home, the other screens' code (~250 KiB with the card catalogue, all high priority) waits until her
  // first clip plays (or 6 s): fetched at once, it took the 4G bandwidth her clip and her sharp poster were waiting on.
  if (/^(#\/?)?(\?|$)/.test(window.location.hash)) {
    let fired = false;
    const go = () => { if (fired) return; fired = true; document.removeEventListener('playing', go, true); later(); };
    document.addEventListener('playing', go, true);
    setTimeout(go, 6000);
  } else later();
});

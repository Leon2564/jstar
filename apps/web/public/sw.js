/*
 * JSTAR service worker (#50). It exists for two things only: showing her notifications (push) and opening the
 * right room when one is tapped (notificationclick).
 *
 * Deliberately no `fetch` handler and no cache: every request (pages, /v1 API, stage videos with byte ranges) goes
 * to the network exactly as without a service worker, so new media and builds are never held back by a stale copy.
 */

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));

/** Only in-app hash routes are ever opened: a payload can never send the user off-site. */
const ROUTE_RE = /^\/#\/[A-Za-z0-9/_?=&.-]*$/;
const safeRoute = (url) => (typeof url === 'string' && ROUTE_RE.test(url) ? url : '/#/me/home');

self.addEventListener('push', (event) => {
  let data = {};
  try { data = event.data ? event.data.json() : {}; } catch { /* not ours or malformed: show the generic line below */ }
  const title = typeof data.title === 'string' && data.title ? data.title.slice(0, 40) : 'JSTAR';
  const options = {
    body: typeof data.body === 'string' ? data.body.slice(0, 160) : '',
    icon: '/icons/icon-192.png',
    badge: '/icons/badge-96.png',
    lang: 'ja',
    data: { url: safeRoute(data.url) },
    // Same tag replaces the older notification instead of stacking (e.g. two wake-ups from her).
    ...(typeof data.tag === 'string' && data.tag ? { tag: data.tag, renotify: true } : {})
  };
  // Browsers require every push to show something (userVisibleOnly), so a notification is always shown.
  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = safeRoute(event.notification.data && event.notification.data.url);
  event.waitUntil((async () => {
    const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    const open = windows.find((c) => new URL(c.url).origin === self.location.origin);
    if (open) {
      // The app is already open: bring it forward and let its router go to her room (a reload would restart the stage).
      await open.focus();
      open.postMessage({ type: 'jstar:open', url });
      return;
    }
    await self.clients.openWindow(url);
  })());
});

/**
 * Web Push in the browser (#50): the service worker, the permission prompt and the subscription the API sends her
 * wake-ups and messages to.
 *
 * Nothing here runs on its own except registering the (cache-free) service worker: the permission prompt only ever
 * follows a tap on "receive notifications", never a page load.
 */
import { http, serverMode } from '../services/http';

/** From /v1/config; null when the API has push off, and then the web app never offers it. */
let vapidKey: string | null = null;
export const setPushKey = (key: string | null | undefined) => { vapidKey = key || null; };

/**
 * - `unavailable`: push is off on the server or this is prototype mode: show nothing.
 * - `ios-install`: iPhone/iPad Safari outside the home screen, where iOS offers no Web Push: show how to add it.
 * - `unsupported`: this browser has no Web Push at all.
 * - `denied`: the user (or the OS) blocked notifications for this site; only the browser settings can undo it.
 */
export type PushStatus = 'unavailable' | 'ios-install' | 'unsupported' | 'denied' | 'off' | 'on';

type Nav = Navigator & { standalone?: boolean };

/** iPadOS reports itself as a Mac (user agent and platform), so a touch screen is what gives it away. */
export function isIos(nav: Nav = navigator): boolean {
  return /iPad|iPhone|iPod/.test(nav.userAgent) || (/Macintosh/.test(nav.userAgent) && nav.platform === 'MacIntel' && nav.maxTouchPoints > 1);
}
/** Opened from the home screen (installed), where iOS 16.4+ allows Web Push. */
export function isStandalone(nav: Nav = navigator): boolean {
  return nav.standalone === true || (typeof matchMedia === 'function' && matchMedia('(display-mode: standalone)').matches);
}

const hasPushApi = () => typeof navigator !== 'undefined' && 'serviceWorker' in navigator && typeof window !== 'undefined' && 'PushManager' in window && 'Notification' in window;

/** Registers the service worker; harmless to call more than once. Server mode only: prototype builds have no push. */
export function registerServiceWorker(): void {
  if (!serverMode() || typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return;
  navigator.serviceWorker.register('/sw.js').catch(() => { /* private mode or blocked: the app works the same without it */ });
}

/** A tapped notification while the app is open: the service worker asks the page to go to her room. */
export function onNotificationOpen(go: (hashRoute: string) => void): () => void {
  if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return () => {};
  const handler = (e: MessageEvent) => {
    const d = e.data as { type?: unknown; url?: unknown } | null;
    if (d?.type === 'jstar:open' && typeof d.url === 'string' && d.url.startsWith('/#/')) go(d.url.slice(2));
  };
  navigator.serviceWorker.addEventListener('message', handler);
  return () => navigator.serviceWorker.removeEventListener('message', handler);
}

async function registration(): Promise<ServiceWorkerRegistration | null> {
  if (!('serviceWorker' in navigator)) return null;
  return (await navigator.serviceWorker.getRegistration('/').catch(() => undefined)) ?? null;
}

export async function pushStatus(): Promise<PushStatus> {
  if (!serverMode() || !vapidKey) return 'unavailable';
  // iOS Safari has no PushManager at all until the site is opened from the home screen.
  if (isIos() && !isStandalone()) return 'ios-install';
  if (!hasPushApi()) return 'unsupported';
  if (Notification.permission === 'denied') return 'denied';
  const sub = await (await registration())?.pushManager.getSubscription().catch(() => null);
  return sub && Notification.permission === 'granted' ? 'on' : 'off';
}

const b64urlToBytes = (s: string) => {
  const b = atob(s.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (s.length % 4)) % 4));
  return Uint8Array.from(b, (c) => c.charCodeAt(0));
};
const sameKey = (a: ArrayBuffer | null | undefined, b: Uint8Array) => !!a && a.byteLength === b.byteLength && new Uint8Array(a).every((v, i) => v === b[i]);
const timeZone = () => { try { return Intl.DateTimeFormat().resolvedOptions().timeZone || undefined; } catch { return undefined; } };

async function sendToApi(sub: PushSubscription): Promise<void> {
  const j = sub.toJSON() as { endpoint?: string; keys?: { p256dh?: string; auth?: string } };
  if (!j.endpoint || !j.keys?.p256dh || !j.keys.auth) throw new Error('push_subscription_incomplete');
  await http.pushSubscribe({ endpoint: j.endpoint, keys: { p256dh: j.keys.p256dh, auth: j.keys.auth }, tz: timeZone() });
}

/** Must run from a tap: browsers only show the permission prompt for a user gesture. */
export async function enablePush(): Promise<PushStatus> {
  const status = await pushStatus();
  if (status === 'unavailable' || status === 'ios-install' || status === 'unsupported' || status === 'denied') return status;
  const permission = await Notification.requestPermission();
  if (permission !== 'granted') return permission === 'denied' ? 'denied' : 'off';
  registerServiceWorker();
  const reg = await Promise.race([navigator.serviceWorker.ready, new Promise<never>((_, no) => setTimeout(() => no(new Error('sw_timeout')), 10_000))]);
  const key = b64urlToBytes(vapidKey!);
  let sub = await reg.pushManager.getSubscription();
  // A subscription made with an older key can no longer be pushed to: replace it.
  if (sub && !sameKey(sub.options.applicationServerKey, key)) { await sub.unsubscribe().catch(() => false); sub = null; }
  sub ??= await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key });
  await sendToApi(sub);
  return 'on';
}

/**
 * Re-sends this browser's subscription: the account may have changed in this browser, or the API dropped the row
 * after a failed delivery. The API keeps one row per browser, so repeating it is harmless.
 */
export async function syncPush(): Promise<void> {
  if ((await pushStatus()) !== 'on') return;
  const sub = await (await registration())?.pushManager.getSubscription();
  if (sub) await sendToApi(sub).catch(() => { /* next visit */ });
}

/** Turns push off for this browser: first the API (it stops sending), then the browser subscription itself. */
export async function disablePush(token?: string | null): Promise<void> {
  const sub = hasPushApi() ? await (await registration())?.pushManager.getSubscription().catch(() => null) : null;
  if (!sub) return;
  await http.pushUnsubscribe(sub.endpoint, token).catch(() => { /* the API drops it on the next 410 anyway */ });
  await sub.unsubscribe().catch(() => false);
}

/** On sign-out this browser must stop showing the old account's notifications. */
export function pushSignedOut(token: string | null): void {
  if (!token || !serverMode()) return;
  void disablePush(token);
}

/** Test site only: a notification from her to this account's browsers. */
export const sendTestPush = (star: string) => http.pushTest(star);

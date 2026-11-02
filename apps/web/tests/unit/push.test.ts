import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Server mode with a stubbed API: the browser half of Web Push (#50) is what is under test here.
const api = vi.hoisted(() => ({ pushSubscribe: vi.fn(async () => ({ ok: true })), pushUnsubscribe: vi.fn(async () => ({ ok: true, removed: 1 })) }));
vi.mock('../../src/services/http', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../src/services/http')>();
  return { ...real, serverMode: () => true, http: { ...real.http, ...api } };
});

import { disablePush, enablePush, isIos, isStandalone, onNotificationOpen, pushSignedOut, pushStatus, setPushKey } from '../../src/lib/push';

// An application server key's shape (65 bytes, uncompressed P-256 point), base64url like /v1/config sends it.
const keyBytes = () => Uint8Array.from({ length: 65 }, (_, i) => (i === 0 ? 4 : (i * 37) % 256));
const KEY = btoa(String.fromCharCode(...keyBytes())).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

const IPHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1';
const ANDROID = 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Mobile Safari/537.36';

function fakeSubscription(key = keyBytes()) {
  return {
    endpoint: 'https://fcm.googleapis.com/fcm/send/abc',
    options: { applicationServerKey: key.buffer },
    toJSON: () => ({ endpoint: 'https://fcm.googleapis.com/fcm/send/abc', keys: { p256dh: 'p256', auth: 'auth' } }),
    unsubscribe: vi.fn(async () => true)
  };
}

/** A browser with Web Push: a service worker registration whose PushManager holds `current`. */
function installBrowser({ ua = ANDROID, permission = 'default' as NotificationPermission, grant = 'granted' as NotificationPermission, current = null as ReturnType<typeof fakeSubscription> | null } = {}) {
  const state = { current, permission };
  const pushManager = {
    getSubscription: vi.fn(async () => state.current),
    subscribe: vi.fn(async () => { state.current = fakeSubscription(); return state.current; })
  };
  const reg = { pushManager };
  Object.defineProperty(navigator, 'userAgent', { value: ua, configurable: true });
  Object.defineProperty(navigator, 'serviceWorker', {
    configurable: true,
    value: { register: vi.fn(async () => reg), getRegistration: vi.fn(async () => reg), ready: Promise.resolve(reg), addEventListener: vi.fn(), removeEventListener: vi.fn() }
  });
  Object.assign(window, { PushManager: function PushManager() {} });
  const N = { get permission() { return state.permission; }, requestPermission: vi.fn(async () => { state.permission = grant; return grant; }) };
  Object.assign(window, { Notification: N });
  return { state, pushManager, N };
}

beforeEach(() => { setPushKey(KEY); api.pushSubscribe.mockClear(); api.pushUnsubscribe.mockClear(); });
afterEach(() => {
  delete (navigator as unknown as Record<string, unknown>).serviceWorker;
  delete (window as unknown as Record<string, unknown>).PushManager;
  delete (window as unknown as Record<string, unknown>).Notification;
});

describe('Web Push in the browser (#50)', () => {
  it('recognises iPhone and iPad Safari, and the home-screen app', () => {
    expect(isIos({ userAgent: IPHONE, platform: 'iPhone', maxTouchPoints: 5 } as Navigator)).toBe(true);
    // iPadOS asks for the desktop site and reports itself as a Mac with a touch screen.
    expect(isIos({ userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)', platform: 'MacIntel', maxTouchPoints: 5 } as Navigator)).toBe(true);
    expect(isIos({ userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)', platform: 'MacIntel', maxTouchPoints: 0 } as Navigator)).toBe(false);
    expect(isIos({ userAgent: ANDROID, platform: 'Linux', maxTouchPoints: 5 } as Navigator)).toBe(false);
    // Desktop Chrome emulating a phone keeps the Mac platform: the user agent decides.
    expect(isIos({ userAgent: ANDROID, platform: 'MacIntel', maxTouchPoints: 5 } as Navigator)).toBe(false);
    expect(isStandalone({ standalone: true } as Navigator & { standalone: boolean })).toBe(true);
  });

  it('offers nothing while the API has push off', async () => {
    installBrowser();
    setPushKey(null);
    expect(await pushStatus()).toBe('unavailable');
  });

  it('asks iPhone Safari to add the site to the home screen first instead of failing', async () => {
    installBrowser({ ua: IPHONE });
    delete (window as unknown as Record<string, unknown>).PushManager;
    expect(await pushStatus()).toBe('ios-install');
    expect(await enablePush()).toBe('ios-install');
    expect(api.pushSubscribe).not.toHaveBeenCalled();
  });

  it('subscribes with the server key and the device time zone after the user allows it', async () => {
    const b = installBrowser();
    expect(await pushStatus()).toBe('off');
    expect(await enablePush()).toBe('on');
    expect(b.N.requestPermission).toHaveBeenCalledOnce();
    expect(b.pushManager.subscribe).toHaveBeenCalledWith({ userVisibleOnly: true, applicationServerKey: keyBytes() });
    expect(api.pushSubscribe).toHaveBeenCalledWith({ endpoint: 'https://fcm.googleapis.com/fcm/send/abc', keys: { p256dh: 'p256', auth: 'auth' }, tz: Intl.DateTimeFormat().resolvedOptions().timeZone });
    expect(await pushStatus()).toBe('on');
  });

  it('respects a refusal and never subscribes', async () => {
    const b = installBrowser({ grant: 'denied' });
    expect(await enablePush()).toBe('denied');
    expect(b.pushManager.subscribe).not.toHaveBeenCalled();
    expect(await pushStatus()).toBe('denied');
  });

  it('replaces a subscription made with an older server key', async () => {
    const stale = fakeSubscription(new Uint8Array(65).fill(7));
    const b = installBrowser({ permission: 'granted', current: stale });
    expect(await enablePush()).toBe('on');
    expect(stale.unsubscribe).toHaveBeenCalled();
    expect(b.pushManager.subscribe).toHaveBeenCalledOnce();
  });

  it('turns off: the API first, then the browser; and on sign-out with the old session', async () => {
    const sub = fakeSubscription();
    installBrowser({ permission: 'granted', current: sub });
    await disablePush();
    expect(api.pushUnsubscribe).toHaveBeenCalledWith(sub.endpoint, undefined);
    expect(sub.unsubscribe).toHaveBeenCalled();

    const next = fakeSubscription();
    installBrowser({ permission: 'granted', current: next });
    pushSignedOut('old-token');
    await vi.waitFor(() => expect(next.unsubscribe).toHaveBeenCalled());
    expect(api.pushUnsubscribe).toHaveBeenLastCalledWith(next.endpoint, 'old-token');
  });

  it('follows a tapped notification to her room, and only to in-app routes', () => {
    installBrowser();
    const go = vi.fn();
    onNotificationOpen(go);
    const handler = (navigator.serviceWorker.addEventListener as ReturnType<typeof vi.fn>).mock.calls[0][1] as (e: MessageEvent) => void;
    handler({ data: { type: 'jstar:open', url: '/#/me/home?star=nana' } } as MessageEvent);
    handler({ data: { type: 'jstar:open', url: 'https://evil.example/' } } as MessageEvent);
    handler({ data: { type: 'other', url: '/#/me/chat' } } as MessageEvent);
    expect(go.mock.calls).toEqual([['/me/home?star=nana']]);
  });
});

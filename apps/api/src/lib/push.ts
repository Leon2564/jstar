import webpush from 'web-push';
import { PushPayload, type Lang, type PushPayloadT, type StarId } from '@jstar/shared';
import type { PushSubscriptionRow, Repos } from '../db/types';
import { env } from '../env';

/**
 * Web Push (#50): her wake-ups and messages on the lock screen.
 *
 * The API encrypts each notification for the browser (RFC 8291) and signs it with the VAPID key (RFC 8292), then
 * hands the finished request to the push service. The API container has no internet, so on Cloudflare the request
 * goes through the Worker (PUSH_URL, answered by infra/cloudflare), which only forwards to known push services.
 */
export interface VapidKeys { publicKey: string; privateKey: string; subject: string }

/** A finished push request; the transport only moves bytes and answers the push service's HTTP status (0 = unreachable). */
export interface PushRequest { endpoint: string; headers: Record<string, string>; body: Uint8Array | null }
export type PushTransport = (req: PushRequest) => Promise<number>;

export interface PushOptions {
  /** Seconds the push service keeps it for an offline phone. A wake-up that arrives hours late is worse than none. */
  ttl?: number;
  /** `high` wakes a phone in battery saver; for wake-ups only. */
  urgency?: 'very-low' | 'low' | 'normal' | 'high';
}
export interface PushResult { sent: number; removed: number; failed: number }
/**
 * Sends one notification to every browser the user turned push on in. Never throws for a delivery problem: a
 * subscription the push service reports gone (404/410) is deleted, any other failure is marked on the row.
 * The payload is validated (PushPayload): her name and one line, nothing the user wrote.
 */
export type SendPush = (userId: string, payload: PushPayloadT, opts?: PushOptions) => Promise<PushResult>;

const DEFAULT_TTL = 6 * 3600;

/**
 * The keys from the environment, or null when push is off. Malformed keys turn push off with a warning instead of
 * stopping the API: a typo in an optional secret must not take sign-in and chat down with it.
 */
export function vapidFromEnv(
  e: Pick<typeof env, 'VAPID_PUBLIC_KEY' | 'VAPID_PRIVATE_KEY' | 'VAPID_SUBJECT'> = env,
  warn: (msg: string) => void = console.warn
): VapidKeys | null {
  if (!e.VAPID_PUBLIC_KEY || !e.VAPID_PRIVATE_KEY) return null;
  const keys = { publicKey: e.VAPID_PUBLIC_KEY.trim(), privateKey: e.VAPID_PRIVATE_KEY.trim(), subject: e.VAPID_SUBJECT.trim() };
  try {
    // Signing a request is the library's own validation of all three values.
    webpush.generateRequestDetails({ endpoint: 'https://push.invalid/check' } as webpush.PushSubscription, null, { vapidDetails: keys });
    return keys;
  } catch (err) {
    warn(`web push disabled: ${(err as Error).message}`);
    return null;
  }
}

/** Through the Worker relay when `relay` is set (production), straight to the push service otherwise (local dev). */
export function httpTransport(relay: string, f: typeof fetch = fetch): PushTransport {
  return async ({ endpoint, headers, body }) => {
    try {
      if (relay) {
        const res = await f(`${relay}/send`, {
          method: 'POST', headers: { 'content-type': 'application/json' }, signal: AbortSignal.timeout(15_000),
          body: JSON.stringify({ endpoint, headers, body: body ? Buffer.from(body).toString('base64') : null })
        });
        // The relay answers 200 {status} with the push service's status; anything else is the relay refusing.
        if (!res.ok) return 0;
        return Number(((await res.json()) as { status?: unknown }).status) || 0;
      }
      return (await f(endpoint, { method: 'POST', headers, body, signal: AbortSignal.timeout(15_000) })).status;
    } catch {
      return 0;
    }
  };
}

/** fetch sets Content-Length itself, and header values must be strings. */
function headersOf(h: Record<string, unknown>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(h)) if (k.toLowerCase() !== 'content-length' && v !== undefined) out[k] = String(v);
  return out;
}

/** Push services allow a Topic of up to 32 URL-safe characters; a newer message with the same topic replaces an undelivered older one. */
const TOPIC_RE = /^[A-Za-z0-9_-]{1,32}$/;

export function createPusher(repos: Repos, vapid: VapidKeys | null, transport: PushTransport): SendPush {
  return async (userId, payload, opts = {}) => {
    const out: PushResult = { sent: 0, removed: 0, failed: 0 };
    if (!vapid) return out;
    const body = JSON.stringify(PushPayload.parse(payload));
    const subs = await repos.push.forUser(userId);
    await Promise.all(subs.map(async (s: PushSubscriptionRow) => {
      let status: number;
      try {
        const d = webpush.generateRequestDetails({ endpoint: s.endpoint, keys: s.keys }, body, {
          vapidDetails: vapid, TTL: opts.ttl ?? DEFAULT_TTL, urgency: opts.urgency ?? 'normal',
          ...(payload.tag && TOPIC_RE.test(payload.tag) ? { topic: payload.tag } : {})
        });
        status = await transport({ endpoint: d.endpoint, headers: headersOf(d.headers as Record<string, unknown>), body: d.body ?? null });
      } catch {
        // The stored keys cannot encrypt anything (not a P-256 point): this subscription can never receive a push.
        status = 410;
      }
      if (status >= 200 && status < 300) {
        out.sent++;
        if (s.failedAt) await repos.push.setFailed(s.endpoint, null);
      } else if (status === 404 || status === 410) {
        // The browser unsubscribed, the user revoked permission or the app was removed: the endpoint is dead for good.
        out.removed++;
        await repos.push.remove(s.endpoint);
      } else {
        // 429, 5xx and unreachable are temporary: keep the row and leave a mark for operators.
        out.failed++;
        await repos.push.setFailed(s.endpoint, new Date().toISOString());
      }
    }));
    return out;
  };
}

/**
 * First names on the lock screen, as the web app shows them (apps/web/src/data/cast.ts): kana/kanji for Japanese
 * and Chinese readers, romanised otherwise.
 */
const FIRST_NAMES: Record<StarId, { native: string; romaji: string }> = {
  mahiro: { native: 'まひろ', romaji: 'Mahiro' },
  nana: { native: '奈々', romaji: 'Nana' },
  unpai: { native: 'うんぱい', romaji: 'Unpai' },
  alice: { native: 'アリス', romaji: 'Alice' },
  eimi: { native: 'えいみ', romaji: 'Eimi' }
};
export const herName = (star: StarId, lang: Lang) => (lang === 'ja' || lang === 'zh-Hant' ? FIRST_NAMES[star].native : FIRST_NAMES[star].romaji);

const clip = (s: string, n: number) => ([...s].length > n ? `${[...s].slice(0, n - 1).join('')}…` : s);

/**
 * The notification for something she says: title = her name, body = her line, a tap opens her room (or the chat).
 * This is what the inbox delivery (#49) and the wake-up alarm (#57) send; they pass her line and nothing else.
 * `to: 'wake'` opens the wake-up moment of inbox item `inbox` (#57) instead of her room.
 */
export function herPush(star: StarId, lang: Lang, line: string, opts: { to?: 'home' | 'chat' | 'wake'; tag?: string; inbox?: string } = {}): PushPayloadT {
  return {
    title: herName(star, lang),
    body: clip(line.trim(), 160),
    url: `/#/me/${opts.to ?? 'home'}?star=${star}${opts.inbox ? `&inbox=${encodeURIComponent(opts.inbox)}` : ''}`,
    star,
    ...(opts.tag ? { tag: opts.tag } : {})
  };
}

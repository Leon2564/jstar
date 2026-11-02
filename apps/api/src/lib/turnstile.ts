import { env } from '../env';

/** Checks a Turnstile token; resolves false for a missing, used or forged one. */
export type HumanCheck = (token: string | undefined, ip: string) => Promise<boolean>;

/**
 * Turnstile through the Worker (TURNSTILE_URL, answered by infra/cloudflare, which holds the secret): the API
 * container has no internet. Unconfigured (tests, `npm run demo`) means no challenge is ever asked for.
 */
export const turnstileEnabled = () => !!env.TURNSTILE_URL;

export const verifyTurnstile: HumanCheck = async (token, ip) => {
  if (!token || token.length > 2048) return false;
  try {
    const res = await fetch(`${env.TURNSTILE_URL}/verify`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token, ip }), signal: AbortSignal.timeout(10_000)
    });
    return res.ok && ((await res.json()) as { success?: boolean }).success === true;
  } catch {
    return false;
  }
};

/** The header the web app sends a token in, after the API answered 403 `challenge_required`. */
export const TURNSTILE_HEADER = 'x-turnstile-token';

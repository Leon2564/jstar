import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

const b64u = (b: Buffer) => b.toString('base64url');

/** Minimal HS256 JWT. Dependency-free on purpose; swap for a library when you add JWKS rotation. */
export function signJwt(payload: Record<string, unknown>, secret: string, ttlSeconds: number): string {
  const header = b64u(Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })));
  const body = b64u(Buffer.from(JSON.stringify({ ...payload, iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + ttlSeconds })));
  const sig = b64u(createHmac('sha256', secret).update(`${header}.${body}`).digest());
  return `${header}.${body}.${sig}`;
}

export function verifyJwt<T = Record<string, unknown>>(token: string, secret: string): T | null {
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const [header, body, sig] = parts;
  const expected = createHmac('sha256', secret).update(`${header}.${body}`).digest();
  const given = Buffer.from(sig, 'base64url');
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
  try {
    const parsed = JSON.parse(Buffer.from(body, 'base64url').toString()) as { exp?: number };
    if (!parsed.exp || parsed.exp * 1000 < Date.now()) return null;
    return parsed as T;
  } catch { return null; }
}

/**
 * Printed codes are stored as HMAC-SHA256(key, code), exactly as tools/luckcards/scripts/code-gen/generate.mjs
 * wrote them for the print run: a database leak alone does not yield usable codes.
 */
export function hashSerial(code: string, keyHex: string): string {
  return createHmac('sha256', Buffer.from(keyHex, 'hex')).update(code).digest('hex');
}

/**
 * M7: the address of an account closed under 18, kept only as HMAC-SHA256(secret, address) so a returning sign-up can be
 * refused for a while without keeping who it was. Keyed with the server's own secret: the table alone reveals nothing.
 */
export function signupBlockHash(email: string, secret: string): string {
  return createHmac('sha256', secret).update(`signup-block:${email.trim().toLowerCase()}`).digest('hex');
}

export const newId = (prefix: string) => `${prefix}_${randomBytes(9).toString('base64url')}`;
export const sixDigitCode = () => String(randomBytes(4).readUInt32BE() % 1_000_000).padStart(6, '0');

/** Constant-time comparison of two secrets of any length (hashed first, so the length does not leak either). */
export function safeEqual(a: string, b: string): boolean {
  return timingSafeEqual(createHash('sha256').update(a).digest(), createHash('sha256').update(b).digest());
}

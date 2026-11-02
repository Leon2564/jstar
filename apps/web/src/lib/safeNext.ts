const ALLOWED = /^\/(?:[a-z0-9-]+(?:\/[a-z0-9-]+){0,2})?(?:\?[A-Za-z0-9=&_-]{0,80})?$/;

/**
 * Returns an internal path (optionally with a simple query, e.g. a QR serial code)
 * from a `next` parameter, or the fallback.
 * Blocks open redirects: absolute URLs, protocol-relative `//host`, backslashes, schemes, odd characters.
 */
export function safeNext(value: string | null | undefined, fallback = '/me/home'): string {
  if (typeof value !== 'string' || value.length > 128) return fallback;
  if (!value.startsWith('/') || value.startsWith('//') || value.includes('\\') || value.includes(':')) return fallback;
  return ALLOWED.test(value) ? value : fallback;
}

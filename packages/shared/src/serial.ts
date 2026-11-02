/**
 * Codes printed on the back of the physical JSTAR lucky cards (tools/luckcards): 12 digits, the first 1–9,
 * the last a Luhn check digit, printed as 1234-5678-9012. The check digit catches most typos before a
 * request is made. Format checking is a client-side convenience only — validity and one-time use are
 * decided by the API (apps/api/src/modules/serial).
 */
export const SERIAL_LENGTH = 12;
export const SERIAL_RE = /^[1-9]\d{11}$/;

/** Same algorithm as tools/luckcards/scripts/code-gen/luhn.mjs, which generated the printed codes. */
export function luhnCheckDigit(digits: number[]): number {
  let sum = 0;
  for (let i = digits.length - 1, dbl = true; i >= 0; i--, dbl = !dbl) {
    let d = digits[i];
    if (dbl) { d *= 2; if (d > 9) d -= 9; }
    sum += d;
  }
  return (10 - (sum % 10)) % 10;
}

/** Digits only: full-width digits from a Japanese IME become ASCII; spaces, hyphens and ー are dropped. */
export function normalizeSerial(raw: string): string {
  return String(raw ?? '')
    .replace(/[０-９]/g, (d) => String.fromCharCode(d.charCodeAt(0) - 0xfee0))
    .replace(/\D/g, '')
    .slice(0, 16);
}

export function isValidSerialFormat(code: string): boolean {
  if (!SERIAL_RE.test(code)) return false;
  const digits = code.split('').map(Number);
  return luhnCheckDigit(digits.slice(0, 11)) === digits[11];
}

/** 1234-5678-9012, as printed. Partial input is grouped as far as it goes. */
export function formatSerial(code: string): string {
  return (normalizeSerial(code).match(/.{1,4}/g) ?? []).join('-');
}

const wellFormed = (v: string | null | undefined): string | null => {
  if (!v || v.length > 32) return null;
  const n = normalizeSerial(v);
  return isValidSerialFormat(n) ? n : null;
};

/** Accepts a code from a QR query string (`?code=`) only when it is already well formed. */
export function serialFromQuery(search: string): string | null {
  try { return wellFormed(new URLSearchParams(search).get('code')); } catch { return null; }
}

/** The per-card QR variant encodes the code in the path: https://jstarcards.ai/r/<code>. */
export function serialFromPath(pathname: string): string | null {
  const m = /^\/r\/([^/?#]+)\/?$/.exec(pathname);
  return m ? wellFormed(decodeURIComponent(m[1])) : null;
}

/**
 * Codes on the sample cards handed to partners. The API seeds them in DEMO_MODE and the web prototype
 * mode accepts them offline. Each is still single-use; admins issue more from the console.
 */
export const DEMO_SERIALS = ['999000000011', '999000000029', '999000000037', '999000000045', '999000000052'] as const;

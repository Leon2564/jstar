/**
 * Companion home helpers: the greeting slot for the moment, the server greeting (chat stream,
 * GET /v1/chat/greeting) — optional: without it the page keeps its local lines.
 */
import type { PromiseItemT } from '@jstar/shared/contracts';
import { API_BASE, deviceId, getToken, serverMode } from '../services/http';

/** Voice slots of docs/catalog-spec.md. */
export type GreetSlot = 'morning' | 'day' | 'evening' | 'night' | 'welcome' | 'return';

/** Clock slot: 5–11 morning, 11–17 day, 17–21 evening, otherwise night. */
export function clockSlot(h: number): 'morning' | 'day' | 'evening' | 'night' {
  return h >= 5 && h < 11 ? 'morning' : h >= 11 && h < 17 ? 'day' : h >= 17 && h < 21 ? 'evening' : 'night';
}

const SEEN = 'jstar.lastSeen';
/** First visit → welcome; back after two days or more → return; otherwise the clock. Records this visit. */
export function greetSlot(now = Date.now(), h = new Date(now).getHours()): GreetSlot {
  // Decided once per browser session, so moving around the site does not turn "welcome back" into "good evening".
  try {
    const kept = sessionStorage.getItem(SEEN) as GreetSlot | null;
    if (kept === 'welcome' || kept === 'return') return kept;
    if (kept) return clockSlot(h);
  } catch { /* storage blocked */ }
  let last = 0;
  try { last = Number(localStorage.getItem(SEEN) ?? 0); localStorage.setItem(SEEN, String(now)); } catch { /* storage blocked */ }
  const slot: GreetSlot = !last ? 'welcome' : now - last >= 2 * 86_400_000 ? 'return' : clockSlot(h);
  try { sessionStorage.setItem(SEEN, slot); } catch { /* storage blocked */ }
  return slot;
}

/**
 * Server greeting for a talent, or null (prototype mode, API missing, error). `promise`: the promise this line keeps,
 * or the missed one it mentions (#59).
 */
export async function fetchGreeting(star: string, lang: string): Promise<{ text: string; promise: PromiseItemT | null } | null> {
  if (!serverMode()) return null;
  try {
    const token = getToken();
    // M4: his time zone, so her greeting fits his time of day (as his opening replies do).
    let tz = '';
    try { tz = Intl.DateTimeFormat().resolvedOptions().timeZone ?? ''; } catch { /* no zone: hers (JST) */ }
    const r = await fetch(`${API_BASE}/v1/chat/greeting?star=${encodeURIComponent(star)}&lang=${encodeURIComponent(lang)}${tz ? `&tz=${encodeURIComponent(tz)}` : ''}`, {
      headers: { 'x-device-id': deviceId(), ...(token ? { authorization: `Bearer ${token}` } : {}) }
    });
    if (!r.ok) return null;
    const b = (await r.json()) as Record<string, unknown>;
    const text = [b.text, b.greeting, b.line, b.reply].find((v): v is string => typeof v === 'string' && v.trim().length > 0);
    const promise = b.promise && typeof b.promise === 'object' ? (b.promise as PromiseItemT) : null;
    return text ? { text: text.slice(0, 300), promise } : null;
  } catch {
    return null;
  }
}

/**
 * N-44: her chat reads all her delivered lines in one request (POST /v1/inbox/read-star), as it opens and as he leaves
 * it (`keepalive`, so it still goes out while the page closes). Its own module, loaded with the chat: it stays out of
 * the entry bundle (tests/e2e/perf.spec.ts).
 */
import type { InboxResT } from '@jstar/shared/contracts';
import { API_BASE, getToken } from './http';

/** `ids`: only these of hers (her room's ② reads what he saw); without, all her delivered lines (her chat). */
export async function readHerLines(star: string, leaving = false, ids?: string[]): Promise<InboxResT | null> {
  try {
    const res = await fetch(`${API_BASE}/v1/inbox/read-star`, {
      method: 'POST', keepalive: leaving, body: JSON.stringify(ids ? { star, ids } : { star }),
      headers: { 'content-type': 'application/json', authorization: `Bearer ${getToken()}` }
    });
    return res.ok ? ((await res.json()) as InboxResT) : null;
  } catch {
    return null;
  }
}

import type { SqlClient, SqlResult } from './sql';

/**
 * SqlClient for Cloudflare D1. The container has no binding of its own: `DB_URL` (http://db.internal) is
 * answered by the Worker (infra/cloudflare/src/index.ts), which runs each batch with `DB.batch` — one
 * transaction — and is reachable only from inside the API container.
 */
export function createD1Client(base: string, f: typeof fetch = fetch): SqlClient {
  return {
    async batch(stmts) {
      if (!stmts.length) return [];
      let res: Response;
      try {
        res = await f(`${base}/batch`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ stmts }) });
      } catch (e) {
        throw Object.assign(new Error('db_unavailable', { cause: e }), { statusCode: 503 });
      }
      const body = (await res.json().catch(() => null)) as { results?: SqlResult[]; error?: string } | null;
      if (!res.ok || !body?.results) throw Object.assign(new Error(`db_error: ${body?.error ?? `http_${res.status}`}`), { statusCode: 503 });
      return body.results;
    }
  };
}

/**
 * The edge's call into the API container, guarded (round 9: one-off 500s on POST /v1/relationship/demo and GET
 * /v1/chat/greeting). A container that is starting, restarting or dropped the connection made `fetch` throw, and an
 * uncaught throw in the Worker is Cloudflare's bare 500. Now: a call that is safe to repeat — a read, or a demo switch
 * (it sets a state, never adds to one) — is tried once more after a moment, also on a 500/502 from the container;
 * anything else, or a second failure, is a 503 `api_unavailable` with Retry-After, which the web app already treats
 * as "try again" (N-58), never a bare 500.
 */
export const retriable = (method: string, path: string): boolean =>
  method === 'GET' || method === 'HEAD' || (method === 'POST' && /^\/v1\/[a-z-]+\/demo$/.test(path));

export async function forward(req: Request, send: (r: Request) => Promise<Response>, pauseMs = 250): Promise<Response> {
  const again = retriable(req.method, new URL(req.url).pathname);
  // Only a retriable call's body is read into memory (demo bodies are tiny); uploads stream through untouched.
  const body = again && req.method === 'POST' ? await req.arrayBuffer() : null;
  const copy = () => (again ? new Request(req.url, { method: req.method, headers: req.headers, body }) : req);
  const tries = again ? 2 : 1;
  for (let i = 0; i < tries; i++) {
    if (i) await new Promise((ok) => setTimeout(ok, pauseMs));
    try {
      const res = await send(copy());
      if (i + 1 < tries && (res.status === 500 || res.status === 502)) continue;
      return res;
    } catch (e) {
      console.warn(JSON.stringify({ msg: 'api_unreachable', method: req.method, try: i + 1, error: String(e) }));
    }
  }
  return Response.json({ error: 'api_unavailable' }, { status: 503, headers: { 'retry-after': '1' } });
}

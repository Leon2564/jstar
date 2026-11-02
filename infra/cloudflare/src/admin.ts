/**
 * admin.jstarcards.ai — the admin console's static build. API calls go to the jstar-web Worker's
 * AdminGateway entrypoint over a service binding, the only route to /v1/admin/*.
 *
 * The API runs in demo mode (fixed OTP, a known demo admin), so the whole host sits behind a password.
 */
export interface Env {
  APP: Fetcher;
  ASSETS: Fetcher;
  ADMIN_PASSWORD: string;
}

const USER = 'admin';

async function authorized(req: Request, password: string): Promise<boolean> {
  const header = req.headers.get('authorization') ?? '';
  if (!password || !header.startsWith('Basic ')) return false;
  let given: string;
  try { given = atob(header.slice(6)); } catch { return false; }
  // Compare digests so the check takes the same time whatever the input.
  const enc = new TextEncoder();
  const [a, b] = await Promise.all([given, `${USER}:${password}`].map((s) => crypto.subtle.digest('SHA-256', enc.encode(s))));
  return crypto.subtle.timingSafeEqual(a, b);
}

export default {
  async fetch(req, env): Promise<Response> {
    if (!(await authorized(req, env.ADMIN_PASSWORD))) {
      return new Response('Authentication required', { status: 401, headers: { 'www-authenticate': 'Basic realm="JSTAR admin", charset="UTF-8"' } });
    }
    const url = new URL(req.url);
    if (url.pathname === '/v1' || url.pathname.startsWith('/v1/')) {
      const headers = new Headers(req.headers);
      headers.delete('authorization');
      headers.set('x-forwarded-for', req.headers.get('cf-connecting-ip') ?? '');
      // The console sends its API session as X-Admin-Session: Authorization is taken by the Basic credentials.
      const session = req.headers.get('x-admin-session');
      if (session) headers.set('authorization', session);
      headers.delete('x-admin-session');
      return env.APP.fetch(new Request(req, { headers }));
    }
    const res = await env.ASSETS.fetch(req);
    const out = new Response(res.body, res);
    out.headers.set('x-frame-options', 'DENY');
    out.headers.set('x-content-type-options', 'nosniff');
    out.headers.set('referrer-policy', 'no-referrer');
    out.headers.set('strict-transport-security', 'max-age=31536000; includeSubDomains');
    out.headers.set('cache-control', 'private, no-store');
    return out;
  }
} satisfies ExportedHandler<Env>;

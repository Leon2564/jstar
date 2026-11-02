import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  LIPSYNC_LIMITS, TOKEN_TTL_S, lipsyncMedia, type LipsyncBucket, lipsyncOn, lipsyncRender, lipsyncWarm, localLimiter, sessionSub, signAudio,
  signTtsAnswer, ttsStar, verifyAudio, type LipsyncEnv, type Limiter
} from '../../../infra/cloudflare/src/lipsync';
import { signJwt } from '../src/lib/crypto';

/**
 * #73 her lip-sync, the Worker's side (infra/cloudflare/src/lipsync.ts): only her own signed audio is ever rendered
 * onto her face, the switches (LIPSYNC=off, LIPSYNC_STARS) hold, a cold or failing service is a clean fallback, and
 * rendered recorded lines are served from R2 with byte ranges.
 */
const SECRET = 'test-lipsync-secret';
const JWT = 'test-jwt-secret';
/** A limiter that never refuses, so the tests below that are not about limits are not limited by each other. */
const open: Limiter = { limit: async () => ({ success: true }) };
const ON: LipsyncEnv = {
  LIPSYNC_URL: 'https://modal.example/', LIPSYNC_SECRET: SECRET, LIPSYNC_STARS: 'mahiro,nana', JWT_SECRET: JWT,
  LIPSYNC_WARM_USER: open, LIPSYNC_WARM_IP: open, LIPSYNC_RENDER_USER: open, LIPSYNC_RENDER_IP: open
};
/** A member's session, signed by the API's own code (what /v1/auth/otp/verify hands out). */
const session = (sub = 'u_member', ttl = 3600) => `Bearer ${signJwt({ sub }, JWT, ttl)}`;
const members = new Set(['u_member', 'u_other']);
const isMember = async (id: string) => members.has(id);
const audio = new TextEncoder().encode('RIFF....her sentence');
const b64 = (u: Uint8Array) => btoa(String.fromCharCode(...u));
const noWait = () => undefined;

describe('lip-sync switches', () => {
  it('on only with a URL, a secret, her name listed, and no kill switch', () => {
    expect(lipsyncOn(ON, 'mahiro')).toBe(true);
    expect(lipsyncOn(ON, 'unpai')).toBe(false);
    expect(lipsyncOn({ ...ON, LIPSYNC_STARS: '*' }, 'unpai')).toBe(true);
    expect(lipsyncOn({ ...ON, LIPSYNC_STARS: '*' }, 'someone')).toBe(false);
    expect(lipsyncOn({ ...ON, LIPSYNC_STARS: undefined }, 'mahiro')).toBe(false);
    expect(lipsyncOn({ ...ON, LIPSYNC: 'off' }, 'mahiro')).toBe(false);
    expect(lipsyncOn({ ...ON, LIPSYNC: 'OFF' }, 'mahiro')).toBe(false);
    expect(lipsyncOn({ ...ON, LIPSYNC_SECRET: undefined }, 'mahiro')).toBe(false);
    expect(lipsyncOn({ ...ON, LIPSYNC_URL: undefined }, 'mahiro')).toBe(false);
  });
});

describe('only her own audio', () => {
  it('a token holds for this star and this audio, until it expires', async () => {
    const now = 1_790_000_000;
    const t = await signAudio(SECRET, 'mahiro', audio, now);
    expect(await verifyAudio(SECRET, 'mahiro', audio, t, now + 10)).toBe(true);
    expect(await verifyAudio(SECRET, 'nana', audio, t, now + 10)).toBe(false);
    expect(await verifyAudio(SECRET, 'mahiro', new TextEncoder().encode('his words'), t, now + 10)).toBe(false);
    expect(await verifyAudio('another-secret', 'mahiro', audio, t, now + 10)).toBe(false);
    expect(await verifyAudio(SECRET, 'mahiro', audio, t, now + TOKEN_TTL_S + 1)).toBe(false);
    expect(await verifyAudio(SECRET, 'mahiro', audio, 'garbage', now)).toBe(false);
  });

  it('her /v1/tts answer leaves signed when on for her, untouched otherwise', async () => {
    const answer = () => Response.json({ mode: 'voice', audio: b64(audio), mime: 'audio/wav', seconds: 1.2, leftSeconds: 300 }, { headers: { 'x-request-id': 'r1' } });
    const signed = await signTtsAnswer(answer(), 'mahiro', ON);
    const body = (await signed.json()) as { lipsync?: string; audio: string };
    expect(body.audio).toBe(b64(audio));
    expect(await verifyAudio(SECRET, 'mahiro', audio, body.lipsync!)).toBe(true);
    expect(signed.headers.get('x-request-id')).toBe('r1');
    expect(await (await signTtsAnswer(answer(), 'unpai', ON)).json()).not.toHaveProperty('lipsync');
    expect(await (await signTtsAnswer(answer(), 'mahiro', { ...ON, LIPSYNC: 'off' })).json()).not.toHaveProperty('lipsync');
    const subtitle = Response.json({ mode: 'subtitle', reason: 'no_minutes', leftSeconds: 0 });
    expect(await (await signTtsAnswer(subtitle, 'mahiro', ON)).json()).toEqual({ mode: 'subtitle', reason: 'no_minutes', leftSeconds: 0 });
  });

  it('reads the star of a /v1/tts request without using up its body', async () => {
    const req = new Request('https://x/v1/tts', { method: 'POST', body: JSON.stringify({ star: 'nana', line: 'こんばんは。' }) });
    expect(await ttsStar(req)).toBe('nana');
    expect(await req.json()).toEqual({ star: 'nana', line: 'こんばんは。' });
    expect(await ttsStar(new Request('https://x/v1/tts', { method: 'POST', body: '{"star":"../etc"}' }))).toBeNull();
  });
});

describe('POST /v1/lipsync', () => {
  const render = async (env: LipsyncEnv, o: { clip?: string; token?: string; body?: Uint8Array; auth?: string | null; ip?: string;
    fetch?: (u: string, i?: RequestInit) => Promise<Response> } = {}) => {
    const token = o.token ?? (await signAudio(SECRET, 'mahiro', audio));
    const auth = o.auth === undefined ? session() : o.auth;
    const req = new Request(`https://jstarcards.ai/v1/lipsync?clip=${o.clip ?? 'mahiro-talk-9x16'}&start=30`, {
      method: 'POST', body: o.body ?? audio,
      headers: { 'x-lipsync-token': token, 'content-type': 'audio/wav', ...(auth ? { authorization: auth } : {}), ...(o.ip ? { 'cf-connecting-ip': o.ip } : {}) }
    });
    return lipsyncRender(req, env, noWait, isMember, o.fetch);
  };
  const modalOk = vi.fn(async () => new Response(new Uint8Array([0, 0, 0, 24]), {
    status: 200, headers: { 'content-type': 'video/mp4', 'x-end-frame': '118', 'x-gpu-ms': '1700', 'x-audio-ms': '3700', 'x-render-ms': '1900' }
  }));

  it('renders her signed sentence on her talk loop through the service, with its secret', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const res = await render(ON, { fetch: modalOk });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('video/mp4');
    expect(res.headers.get('x-end-frame')).toBe('118');
    const [url, init] = modalOk.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://modal.example/render?clip=mahiro-talk-9x16&start=30');
    expect((init.headers as Record<string, string>).authorization).toBe(`Bearer ${SECRET}`);
    // The meter: one log line per render, with its GPU time and cost estimate.
    const metered = JSON.parse(log.mock.calls[0][0] as string);
    expect(metered).toMatchObject({ event: 'lipsync', star: 'mahiro', gpuMs: 1700, audioMs: 3700 });
    expect(metered.usd).toBeGreaterThan(0);
  });

  it('refuses audio that is not a signed sentence of hers, and anything off', async () => {
    const never = vi.fn(async () => new Response('x'));
    expect((await render(ON, { body: new TextEncoder().encode('his voice'), fetch: never })).status).toBe(403);
    expect((await render(ON, { token: '1790000000.AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA', fetch: never })).status).toBe(403);
    expect((await render(ON, { clip: 'nana-talk-9x16', fetch: never })).status).toBe(403);
    expect((await render(ON, { clip: 'mahiro-scene-welcome-home-close-9x16', fetch: never })).status).toBe(400);
    expect((await render({ ...ON, LIPSYNC: 'off' }, { fetch: never })).status).toBe(404);
    expect((await render({ ...ON, LIPSYNC_STARS: 'nana' }, { fetch: never })).status).toBe(404);
    expect(never).not.toHaveBeenCalled();
  });

  it('answers members only: no session, a forged, expired or foreign one, or a banned account is 401', async () => {
    const never = vi.fn(async () => new Response('x'));
    expect((await render(ON, { auth: null, fetch: never })).status).toBe(401);
    expect((await render(ON, { auth: 'Bearer nonsense', fetch: never })).status).toBe(401);
    expect((await render(ON, { auth: `Bearer ${signJwt({ sub: 'u_member' }, 'another-secret', 3600)}`, fetch: never })).status).toBe(401);
    expect((await render(ON, { auth: session('u_member', -10), fetch: never })).status).toBe(401);
    expect((await render(ON, { auth: session('u_banned'), fetch: never })).status).toBe(401);
    expect((await render({ ...ON, JWT_SECRET: undefined }, { fetch: never })).status).toBe(401);
    // A valid signed sentence does not stand in for a session.
    expect((await render({ ...ON, LIPSYNC: 'off' }, { auth: null, fetch: never })).status).toBe(401);
    expect(never).not.toHaveBeenCalled();
  });

  it('is rate-limited per account and per IP (429 with retry-after), counted for members only', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const env: LipsyncEnv = { ...ON, LIPSYNC_RENDER_USER: localLimiter(2, 10), LIPSYNC_RENDER_IP: localLimiter(4, 60) };
    const ok = async () => new Response(new Uint8Array([0]), { status: 200, headers: { 'content-type': 'video/mp4' } });
    // Strangers are refused before anything is counted.
    for (let i = 0; i < 5; i++) expect((await render(env, { auth: null, ip: '203.0.113.9', fetch: ok })).status).toBe(401);
    expect((await render(env, { ip: '203.0.113.9', fetch: ok })).status).toBe(200);
    expect((await render(env, { ip: '203.0.113.9', fetch: ok })).status).toBe(200);
    const third = await render(env, { ip: '203.0.113.9', fetch: ok });
    expect(third.status).toBe(429);
    expect(third.headers.get('retry-after')).toBe('10');
    // Every request counts against the address too (the refused one included): another member there gets its last slot.
    expect((await render(env, { auth: session('u_other'), ip: '203.0.113.9', fetch: ok })).status).toBe(200);
    const byIp = await render(env, { auth: session('u_other'), ip: '203.0.113.9', fetch: ok });
    expect(byIp.status).toBe(429);
    expect(byIp.headers.get('retry-after')).toBe('60');
  });

  it('a cold, failing or unreachable service is a 502: the room falls back to her talk loop', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const cold = async () => new Response(null, { status: 303, headers: { location: 'https://modal.example/poll' } });
    expect((await render(ON, { fetch: cold })).status).toBe(502);
    expect((await render(ON, { fetch: async () => Response.json({ detail: 'x' }, { status: 500 }) })).status).toBe(502);
    expect((await render(ON, { fetch: async () => { throw new Error('down'); } })).status).toBe(502);
  });
});

describe('POST /v1/lipsync/warm', () => {
  const calls: string[] = [];
  const later: Promise<unknown>[] = [];
  const f = async (u: string) => { calls.push(u); return new Response('{}'); };
  const warm = (env: LipsyncEnv, star = 'mahiro', auth: string | null = session(), ip = '') => lipsyncWarm(new Request(`https://x/v1/lipsync/warm?star=${star}`, {
    method: 'POST', headers: { ...(auth ? { authorization: auth } : {}), ...(ip ? { 'cf-connecting-ip': ip } : {}) }
  }), env, (p) => later.push(p), isMember, f);

  it('readies a GPU for her when on (202), does nothing when off (204)', async () => {
    calls.length = 0;
    expect((await warm(ON)).status).toBe(202);
    await Promise.all(later);
    expect(calls).toEqual(['https://modal.example/warm?star=mahiro']);
    expect((await warm({ ...ON, LIPSYNC: 'off' })).status).toBe(204);
    expect((await warm(ON, 'unpai')).status).toBe(204);
    expect((await warm(ON, 'nobody')).status).toBe(400);
    expect(calls).toHaveLength(1);
  });

  it('wakes nothing for anyone but a member (401), and once a minute per account (429)', async () => {
    calls.length = 0;
    expect((await warm(ON, 'mahiro', null)).status).toBe(401);
    expect((await warm(ON, 'mahiro', 'Bearer x.y.z')).status).toBe(401);
    expect((await warm(ON, 'mahiro', session('u_banned'))).status).toBe(401);
    expect(calls).toHaveLength(0);
    const env: LipsyncEnv = { ...ON, LIPSYNC_WARM_USER: localLimiter(1, 60), LIPSYNC_WARM_IP: localLimiter(10, 60) };
    expect((await warm(env, 'mahiro', session(), '198.51.100.7')).status).toBe(202);
    const again = await warm(env, 'nana', session(), '198.51.100.7');
    expect(again.status).toBe(429);
    expect(again.headers.get('retry-after')).toBe('60');
    expect((await warm(env, 'nana', session('u_other'), '198.51.100.7')).status).toBe(202);
    await Promise.all(later);
    expect(calls).toHaveLength(2);
  });
});

describe('the member session and the limits', () => {
  it('reads exactly the sessions the API signs', async () => {
    const now = Math.floor(Date.now() / 1000);
    expect(await sessionSub(session('u_member'), JWT)).toBe('u_member');
    expect(await sessionSub(session('u_member'), 'wrong')).toBeNull();
    expect(await sessionSub(session('u_member', -1), JWT, now)).toBeNull();
    expect(await sessionSub(`Bearer ${signJwt({}, JWT, 60)}`, JWT)).toBeNull();
    expect(await sessionSub(session('u_member'), undefined)).toBeNull();
    expect(await sessionSub(null, JWT)).toBeNull();
    expect(await sessionSub('Basic abc', JWT)).toBeNull();
    // A body edited after signing (another account) breaks the signature.
    const [h, , sig] = session('u_member').slice(7).split('.');
    const forged = Buffer.from(JSON.stringify({ sub: 'u_other', exp: now + 3600 })).toString('base64url');
    expect(await sessionSub(`Bearer ${h}.${forged}.${sig}`, JWT)).toBeNull();
  });

  it('the isolate-local limiter: a fixed window per key', async () => {
    let t = 0;
    const l = localLimiter(2, 10, () => t);
    expect((await l.limit({ key: 'a' })).success).toBe(true);
    expect((await l.limit({ key: 'a' })).success).toBe(true);
    expect((await l.limit({ key: 'a' })).success).toBe(false);
    expect((await l.limit({ key: 'b' })).success).toBe(true);
    t = 10_000;
    expect((await l.limit({ key: 'a' })).success).toBe(true);
  });

  it('every site with lip-sync binds the same limits as LIPSYNC_LIMITS, under namespace ids of its own', () => {
    const seen = new Set<string>();
    for (const f of ['wrangler.jsonc', 'wrangler.test.jsonc', 'wrangler.nest.jsonc']) {
      const text = readFileSync(new URL(`../../../infra/cloudflare/${f}`, import.meta.url), 'utf8').replace(/^\s*\/\/.*$/gm, '');
      const cfg = JSON.parse(text) as { ratelimits?: { name: string; namespace_id: string; simple: { limit: number; period: number } }[] };
      const bound = Object.fromEntries((cfg.ratelimits ?? []).map((r) => [r.name, r.simple]));
      expect(bound, f).toEqual(LIPSYNC_LIMITS);
      for (const r of cfg.ratelimits ?? []) { expect(seen.has(r.namespace_id), `${f} ${r.namespace_id}`).toBe(false); seen.add(r.namespace_id); }
    }
  });
});

describe('GET /lipsync/v1/... (rendered recorded lines)', () => {
  const data = new Uint8Array(1000).map((_, i) => i % 256);
  const KEY = 'v1/mahiro-talk-9x16/41e9e0671ead-720x1280.mp4';
  const bucket = {
    head: async (k: string) => (k === KEY ? { size: data.length, httpEtag: '"e1"' } : null),
    get: async (k: string, o?: { range?: { offset: number; length: number } }) => {
      if (k !== KEY) return null;
      const r = o?.range;
      return { body: new Response(r ? data.slice(r.offset, r.offset + r.length) : data).body };
    }
  } as unknown as LipsyncBucket;
  const env: LipsyncEnv = { LIPSYNC_MEDIA: bucket };
  const get = (path: string, headers: Record<string, string> = {}, e = env) => lipsyncMedia(new Request(`https://x${path}`, { headers }), e);

  it('whole, by range, and 416 past the end; immutable caching', async () => {
    const whole = await get(`/lipsync/${KEY}`);
    expect(whole.status).toBe(200);
    expect(whole.headers.get('content-type')).toBe('video/mp4');
    expect(whole.headers.get('cache-control')).toContain('immutable');
    expect(new Uint8Array(await whole.arrayBuffer())).toEqual(data);
    const part = await get(`/lipsync/${KEY}`, { range: 'bytes=100-199' });
    expect(part.status).toBe(206);
    expect(part.headers.get('content-range')).toBe('bytes 100-199/1000');
    expect(new Uint8Array(await part.arrayBuffer())).toEqual(data.slice(100, 200));
    expect((await get(`/lipsync/${KEY}`, { range: 'bytes=0-' })).headers.get('content-range')).toBe('bytes 0-999/1000');
    expect((await get(`/lipsync/${KEY}`, { range: 'bytes=5000-' })).status).toBe(416);
  });

  it('phase renders (starting on clip frame p) are served by the same route', async () => {
    const phased = { ...env, LIPSYNC_MEDIA: { ...bucket, head: async (k: string) => (k === 'v1/mahiro-talk-9x16/41e9e0671ead-p42-720x1280.mp4' ? { size: data.length, httpEtag: '"e2"' } : null),
      get: async (k: string) => (k.includes('-p42-') ? { body: new Response(data).body } : null) } as unknown as LipsyncBucket };
    expect((await get('/lipsync/v1/mahiro-talk-9x16/41e9e0671ead-p42-720x1280.mp4', {}, phased)).status).toBe(200);
    expect((await get('/lipsync/v1/mahiro-talk-9x16/41e9e0671ead-px-720x1280.mp4', {}, phased)).status).toBe(404);
  });

  it('404 for anything else: unknown files, odd paths, no bucket, or switched off', async () => {
    expect((await get('/lipsync/v1/mahiro-talk-9x16/000000000000-720x1280.mp4')).status).toBe(404);
    expect((await get('/lipsync/v1/../memory/x.mp4')).status).toBe(404);
    expect((await get(`/lipsync/${KEY}`, {}, {})).status).toBe(404);
    expect((await get(`/lipsync/${KEY}`, {}, { ...env, LIPSYNC: 'off' })).status).toBe(404);
  });
});

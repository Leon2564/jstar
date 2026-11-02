/**
 * Her lip-sync (#73, docs/lipsync.md): her mouth in her clips moves with her voice.
 *
 * - **Recorded lines** (scenes): rendered once (infra/lipsync, the scene batch) into the R2 bucket `jstar-lipsync`
 *   (binding LIPSYNC_MEDIA) and served here at `GET /lipsync/v1/<clip>/<voice id>-<w>x<h>.mp4`, with byte ranges
 *   (iOS Safari plays video only from 206 answers). The web app knows what exists from data/lipsync.gen.json.
 * - **Her runtime voice** (chat): each sentence `POST /v1/tts` returns is rendered onto her talk loop by the Modal
 *   service (infra/lipsync/modal_app.py, LIPSYNC_URL + secret LIPSYNC_SECRET). Only audio that is really hers may be
 *   rendered — never sound of his, which would make her face say anything: the Worker signs each `/v1/tts` answer's
 *   audio as it passes (`lipsync`: `<expiry>.<HMAC of star, expiry and the audio's SHA-256>`), and `POST /v1/lipsync`
 *   renders only audio whose signature checks out. `POST /v1/lipsync/warm` starts a GPU when her room opens.
 *
 * Switches: LIPSYNC=off turns all of it off (kill switch; the room and scenes play as before); LIPSYNC_STARS lists the
 * talents it is on for (comma-separated, `*` = all; unset = none). Recorded lines need only the bucket.
 *
 * Who may wake or use the GPU: `POST /v1/lipsync` and `/v1/lipsync/warm` answer only a signed-in member — the same
 * session the API asks of `/v1/tts` (a Bearer HS256 JWT under JWT_SECRET whose `sub` is an account that is not banned)
 * — 401 otherwise, and 429 past their rate limits (LIPSYNC_LIMITS: per account and per IP, Workers Rate Limiting
 * bindings, with an isolate-local fallback). Both used to be open to anyone: a script could keep GPUs up for nothing.
 * Every render is logged (`event: lipsync`) with its GPU time and estimated cost: the meter, in Workers observability.
 */

/** What the media route needs of the R2 bucket (an R2Bucket binding; a Map in the tests). */
export interface LipsyncBucket {
  head(key: string): Promise<{ size: number; httpEtag: string } | null>;
  get(key: string, options?: { range?: { offset: number; length: number } }): Promise<{ body: ReadableStream | null } | null>;
}

/** A Workers Rate Limiting binding (`ratelimits` in wrangler*.jsonc), or the isolate-local stand-in below. */
export interface Limiter {
  limit(o: { key: string }): Promise<{ success: boolean }>;
}

export interface LipsyncEnv {
  /** The API's session secret: the member check below verifies the same Bearer token the API does. */
  JWT_SECRET?: string;
  LIPSYNC_WARM_USER?: Limiter;
  LIPSYNC_WARM_IP?: Limiter;
  LIPSYNC_RENDER_USER?: Limiter;
  LIPSYNC_RENDER_IP?: Limiter;
  LIPSYNC?: string;
  LIPSYNC_STARS?: string;
  LIPSYNC_URL?: string;
  LIPSYNC_SECRET?: string;
  LIPSYNC_MEDIA?: LipsyncBucket;
}

const STARS = ['mahiro', 'nana', 'unpai', 'alice', 'eimi'] as const;
/** Her talk loops the service has prepared (infra/lipsync/modal_app.py TALK_LOOKS). */
const CLIP = /^(mahiro|nana|unpai|alice|eimi)-(talk-9x16|talkclose-9x16|talk-16x9)$/;
/** A render (`<voice>-<w>x<h>.mp4`) or a phase render starting on clip frame p (`<voice>-p<p>-<w>x<h>.mp4`). */
const MEDIA = /^\/lipsync\/v1\/[a-z0-9-]{3,80}\/[0-9a-f]{12}(?:-p\d{1,4})?-\d{3,4}x\d{3,4}\.mp4$/;
/** How long a signed sentence may be rendered after it was spoken (his reply plays within seconds). */
export const TOKEN_TTL_S = 600;
/** The longest sentence audio rendered (bytes of WAV/MP3; a 30 s 24 kHz WAV is ~1.4 MB). */
const MAX_AUDIO = 3_000_000;
/** Modal L40S in region ap: $0.000542/s × 1.15 (docs/lipsync.md § 5); the meter's estimate per GPU millisecond. */
const USD_PER_GPU_MS = (0.000542 * 1.15) / 1000;

/** Lip-sync of her runtime voice is on for her: switched on, configured, and she is listed. */
export function lipsyncOn(env: LipsyncEnv, star: string): boolean {
  if ((env.LIPSYNC ?? '').toLowerCase() === 'off' || !env.LIPSYNC_URL || !env.LIPSYNC_SECRET) return false;
  const list = (env.LIPSYNC_STARS ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  return list.includes('*') ? (STARS as readonly string[]).includes(star) : list.includes(star);
}

export const isLipsyncMediaPath = (path: string): boolean => path.startsWith('/lipsync/');

/** "bytes=START-END" → an inclusive range within `size` (the same rules as index.ts parseRange). */
function range(header: string, size: number): { offset: number; length: number } | null {
  const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!m || (m[1] === '' && m[2] === '')) return null;
  let start: number; let end: number;
  if (m[1] === '') { start = Math.max(0, size - Number(m[2])); end = size - 1; }
  else { start = Number(m[1]); end = m[2] === '' ? size - 1 : Math.min(Number(m[2]), size - 1); }
  return start <= end && start < size ? { offset: start, length: end - start + 1 } : null;
}

/** `GET|HEAD /lipsync/v1/...`: a render from R2, whole or by range. 404 when absent, unbound or switched off. */
export async function lipsyncMedia(req: Request, env: LipsyncEnv): Promise<Response> {
  const path = new URL(req.url).pathname;
  if ((req.method !== 'GET' && req.method !== 'HEAD') || !MEDIA.test(path) || !env.LIPSYNC_MEDIA || (env.LIPSYNC ?? '').toLowerCase() === 'off') {
    return new Response('not found', { status: 404 });
  }
  const key = path.slice('/lipsync/'.length);
  const head = await env.LIPSYNC_MEDIA.head(key);
  if (!head) return new Response('not found', { status: 404 });
  const headers = new Headers({
    'content-type': 'video/mp4', 'accept-ranges': 'bytes', etag: head.httpEtag,
    // Renders never change in place: a new render is a new version prefix.
    'cache-control': 'public, max-age=31536000, immutable', 'x-content-type-options': 'nosniff'
  });
  const want = req.headers.get('range');
  if (want) {
    const r = range(want, head.size);
    if (!r) return new Response(null, { status: 416, headers: { 'content-range': `bytes */${head.size}` } });
    const obj = req.method === 'HEAD' ? null : await env.LIPSYNC_MEDIA.get(key, { range: r });
    headers.set('content-range', `bytes ${r.offset}-${r.offset + r.length - 1}/${head.size}`);
    headers.set('content-length', String(r.length));
    return new Response(obj?.body ?? null, { status: 206, headers });
  }
  headers.set('content-length', String(head.size));
  if (req.method === 'HEAD') return new Response(null, { status: 200, headers });
  const obj = await env.LIPSYNC_MEDIA.get(key);
  return obj ? new Response(obj.body, { status: 200, headers }) : new Response('not found', { status: 404 });
}

// --- signatures ------------------------------------------------------------------------------------------------------

const enc = new TextEncoder();
const hex = (b: ArrayBuffer) => [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, '0')).join('');
const b64url = (b: ArrayBuffer) => btoa(String.fromCharCode(...new Uint8Array(b))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const sha256 = async (bytes: ArrayBuffer | Uint8Array) => hex(await crypto.subtle.digest('SHA-256', bytes));
async function hmac(secret: string, msg: string): Promise<string> {
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return b64url(await crypto.subtle.sign('HMAC', key, enc.encode(msg)));
}
function base64Bytes(s: string): Uint8Array {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
function same(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}

/** The token for one sentence of her audio: `<expiry s>.<HMAC(secret, star.expiry.sha256)>`. */
export async function signAudio(secret: string, star: string, audio: Uint8Array, nowS = Math.floor(Date.now() / 1000)): Promise<string> {
  const exp = nowS + TOKEN_TTL_S;
  return `${exp}.${await hmac(secret, `${star}.${exp}.${await sha256(audio)}`)}`;
}

export async function verifyAudio(secret: string, star: string, audio: Uint8Array, token: string, nowS = Math.floor(Date.now() / 1000)): Promise<boolean> {
  const m = /^(\d{9,12})\.([A-Za-z0-9_-]{43})$/.exec(token);
  if (!m || Number(m[1]) < nowS || Number(m[1]) > nowS + TOKEN_TTL_S) return false;
  return same(m[2], await hmac(secret, `${star}.${m[1]}.${await sha256(audio)}`));
}

/**
 * Her `/v1/tts` answer on its way to the browser: with lip-sync on for her, a voiced sentence gains `lipsync`, the
 * token that lets the browser have this very audio rendered. Anything else passes through untouched.
 */
export async function signTtsAnswer(res: Response, star: string | null, env: LipsyncEnv): Promise<Response> {
  if (!res.ok || !star || !lipsyncOn(env, star) || !(res.headers.get('content-type') ?? '').includes('application/json')) return res;
  const body = (await res.clone().json().catch(() => null)) as Record<string, unknown> | null;
  if (!body || body.mode !== 'voice' || typeof body.audio !== 'string') return res;
  let audio: Uint8Array;
  try { audio = base64Bytes(body.audio); } catch { return res; }
  const out = Response.json({ ...body, lipsync: await signAudio(env.LIPSYNC_SECRET!, star, audio) }, { status: res.status });
  res.headers.forEach((v, k) => { if (k !== 'content-length' && k !== 'content-type') out.headers.set(k, v); });
  return out;
}

/** The star of a `/v1/tts` request body (the Worker reads a copy; the API gets the original). */
export async function ttsStar(req: Request): Promise<string | null> {
  const b = (await req.clone().json().catch(() => null)) as { star?: unknown } | null;
  return typeof b?.star === 'string' && (STARS as readonly string[]).includes(b.star) ? b.star : null;
}

// --- who is asking, and how often ------------------------------------------------------------------------------------

/**
 * The limits (the `simple` settings of the `ratelimits` bindings in wrangler.jsonc / .test / .nest; keep them equal).
 * - Warm-up: her room sends one when it opens; once a minute per account is plenty (a second room within the minute is
 *   already warm). Per IP a little more, for a household behind one address.
 * - Render: her room asks for each voiced sentence, at most 3 at once (herVoice.ts); a sentence is ≥ ~1.5 s of her voice
 *   and /v1/tts allows 40 sentences a minute, so 8 per 10 s per account covers a fast talker with replays to spare,
 *   while a burst cannot spread over many GPUs.
 * The Rate Limiting API counts per Cloudflare location and is eventually consistent: a bound against abuse, not a meter.
 */
export const LIPSYNC_LIMITS = {
  LIPSYNC_WARM_USER: { limit: 1, period: 60 },
  LIPSYNC_WARM_IP: { limit: 10, period: 60 },
  LIPSYNC_RENDER_USER: { limit: 8, period: 10 },
  LIPSYNC_RENDER_IP: { limit: 120, period: 60 }
} as const;
type LimitName = keyof typeof LIPSYNC_LIMITS;

/** A fixed-window limiter in this isolate: the stand-in where a binding is missing (local runs, tests, an old config). */
export function localLimiter(limit: number, periodS: number, now: () => number = Date.now): Limiter {
  const windows = new Map<string, { start: number; n: number }>();
  return {
    async limit({ key }) {
      const t = now();
      const w = windows.get(key);
      if (!w || t - w.start >= periodS * 1000) {
        if (windows.size > 10_000) for (const [k, v] of windows) if (t - v.start >= periodS * 1000) windows.delete(k);
        windows.set(key, { start: t, n: 1 });
        return { success: true };
      }
      w.n += 1;
      return { success: w.n <= limit };
    }
  };
}
const fallbacks = new Map<LimitName, Limiter>();
function limiter(env: LipsyncEnv, name: LimitName): Limiter {
  const bound = env[name];
  if (bound) return bound;
  let l = fallbacks.get(name);
  if (!l) fallbacks.set(name, (l = localLimiter(LIPSYNC_LIMITS[name].limit, LIPSYNC_LIMITS[name].period)));
  return l;
}

const b64urlBytes = (s: string): Uint8Array => base64Bytes(s.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (s.length % 4)) % 4));

/**
 * The account of a Bearer session, exactly as the API's preHandler reads it (apps/api/src/lib/crypto.ts verifyJwt):
 * HS256 under `secret`, an `exp` still ahead, a string `sub`. Null for anything else.
 */
export async function sessionSub(authorization: string | null, secret: string | undefined, nowS = Math.floor(Date.now() / 1000)): Promise<string | null> {
  if (!secret || !authorization?.startsWith('Bearer ')) return null;
  const parts = authorization.slice(7).split('.');
  if (parts.length !== 3) return null;
  const [header, body, sig] = parts;
  let given: Uint8Array; let claims: { sub?: unknown; exp?: unknown };
  try {
    given = b64urlBytes(sig);
    claims = JSON.parse(new TextDecoder().decode(b64urlBytes(body)));
  } catch { return null; }
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['verify']);
  if (!(await crypto.subtle.verify('HMAC', key, given, enc.encode(`${header}.${body}`)))) return null;
  if (typeof claims.exp !== 'number' || claims.exp < nowS || typeof claims.sub !== 'string' || !claims.sub) return null;
  return claims.sub;
}

/** Whether an account may use her lip-sync: it exists and is not banned (the Worker answers it from D1). */
export type IsMember = (userId: string) => Promise<boolean>;

const unauthorized = () => Response.json({ error: 'unauthorized' }, { status: 401 });

/** The signed-in member asking (the account id), or null: no session, a bad or expired one, a banned or gone account. */
async function memberOf(req: Request, env: LipsyncEnv, isMember: IsMember): Promise<string | null> {
  const sub = await sessionSub(req.headers.get('authorization'), env.JWT_SECRET);
  return sub && (await isMember(sub).catch(() => false)) ? sub : null;
}

/**
 * 429 past either limit (per account, per IP), or null when the request may go on. Counted only for members, so
 * strangers cannot use up a member's allowance.
 */
async function overLimit(req: Request, env: LipsyncEnv, sub: string, kind: 'WARM' | 'RENDER'): Promise<Response | null> {
  const ip = req.headers.get('cf-connecting-ip') ?? '';
  const [byUser, byIp] = await Promise.all([
    limiter(env, `LIPSYNC_${kind}_USER`).limit({ key: `u:${sub}` }),
    ip ? limiter(env, `LIPSYNC_${kind}_IP`).limit({ key: `ip:${ip}` }) : Promise.resolve({ success: true })
  ]);
  if (byUser.success && byIp.success) return null;
  const period = LIPSYNC_LIMITS[`LIPSYNC_${kind}_${byUser.success ? 'IP' : 'USER'}`].period;
  return Response.json({ error: 'rate_limited' }, { status: 429, headers: { 'retry-after': String(period) } });
}

// --- render and warm-up ----------------------------------------------------------------------------------------------

type Fetch = (input: string, init?: RequestInit) => Promise<Response>;

/**
 * `POST /v1/lipsync?clip=<her talk loop>&start=<loop frame>`, body = the sentence's audio exactly as `/v1/tts` gave
 * it, header `x-lipsync-token` = its `lipsync` token → `video/mp4` (video only, her loop from `start`), with
 * `x-end-frame` for the next sentence. 401 without a member's session, 404 when off for her, 429 past the limits,
 * 403 for audio that is not a signed sentence of hers.
 */
export async function lipsyncRender(req: Request, env: LipsyncEnv, waitUntil: (p: Promise<unknown>) => void, isMember: IsMember,
  doFetch: Fetch = fetch): Promise<Response> {
  const url = new URL(req.url);
  const clip = url.searchParams.get('clip') ?? '';
  const start = Number(url.searchParams.get('start') ?? '0');
  const m = CLIP.exec(clip);
  if (req.method !== 'POST' || !m || !Number.isInteger(start) || start < 0 || start > 100_000) return Response.json({ error: 'bad_request' }, { status: 400 });
  const star = m[1];
  const sub = await memberOf(req, env, isMember);
  if (!sub) return unauthorized();
  if (!lipsyncOn(env, star)) return Response.json({ error: 'off' }, { status: 404 });
  const limited = await overLimit(req, env, sub, 'RENDER');
  if (limited) return limited;
  const audio = new Uint8Array(await req.arrayBuffer());
  if (!audio.length || audio.length > MAX_AUDIO) return Response.json({ error: 'bad_audio' }, { status: 400 });
  if (!(await verifyAudio(env.LIPSYNC_SECRET!, star, audio, req.headers.get('x-lipsync-token') ?? ''))) {
    return Response.json({ error: 'not_her_voice' }, { status: 403 });
  }
  const t = Date.now();
  let res: Response;
  try {
    res = await doFetch(`${env.LIPSYNC_URL!.replace(/\/$/, '')}/render?clip=${clip}&start=${start}`, {
      method: 'POST', body: audio,
      headers: { authorization: `Bearer ${env.LIPSYNC_SECRET}`, 'content-type': req.headers.get('content-type') ?? 'application/octet-stream' },
      redirect: 'manual'
    });
  } catch (e) {
    console.error(JSON.stringify({ event: 'lipsync', star, clip, error: (e as Error).message, ms: Date.now() - t }));
    return Response.json({ error: 'lipsync_failed' }, { status: 502 });
  }
  const gpuMs = Number(res.headers.get('x-gpu-ms') ?? 0);
  const log = {
    event: 'lipsync', star, clip, status: res.status, ms: Date.now() - t, gpuMs, audioMs: Number(res.headers.get('x-audio-ms') ?? 0),
    renderMs: Number(res.headers.get('x-render-ms') ?? 0), usd: Number((gpuMs * USD_PER_GPU_MS).toFixed(5))
  };
  // A cold container answers 303 (Modal's long-poll redirect): too late for this sentence; she speaks as before.
  if (res.status !== 200 || !(res.headers.get('content-type') ?? '').startsWith('video/')) {
    console.error(JSON.stringify(log));
    waitUntil(res.body?.cancel() ?? Promise.resolve());
    return Response.json({ error: 'lipsync_failed' }, { status: 502 });
  }
  console.log(JSON.stringify(log));
  const headers = new Headers({ 'content-type': 'video/mp4', 'cache-control': 'no-store' });
  for (const h of ['x-start-frame', 'x-end-frame', 'x-frames', 'x-fps', 'x-render-ms']) {
    const v = res.headers.get(h);
    if (v) headers.set(h, v);
  }
  return new Response(res.body, { status: 200, headers });
}

/**
 * `POST /v1/lipsync/warm?star=` → 202 (a GPU is being readied for her talk loops) or 204 (off for her); 401 without a
 * member's session, 429 when this account (or address) warmed one within the minute.
 */
export async function lipsyncWarm(req: Request, env: LipsyncEnv, waitUntil: (p: Promise<unknown>) => void, isMember: IsMember,
  doFetch: Fetch = fetch): Promise<Response> {
  const star = new URL(req.url).searchParams.get('star') ?? '';
  if (req.method !== 'POST' || !(STARS as readonly string[]).includes(star)) return Response.json({ error: 'bad_request' }, { status: 400 });
  const sub = await memberOf(req, env, isMember);
  if (!sub) return unauthorized();
  // Off for her: nothing to wake, so nothing is counted either.
  if (!lipsyncOn(env, star)) return new Response(null, { status: 204 });
  const limited = await overLimit(req, env, sub, 'WARM');
  if (limited) return limited;
  waitUntil(doFetch(`${env.LIPSYNC_URL!.replace(/\/$/, '')}/warm?star=${star}`, {
    method: 'POST', headers: { authorization: `Bearer ${env.LIPSYNC_SECRET}` }, redirect: 'manual'
  }).then((r) => r.body?.cancel()).catch(() => undefined));
  return Response.json({ ok: true }, { status: 202 });
}

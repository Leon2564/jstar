/**
 * jstarcards.ai — the web app's static build plus the API and persona service, each in its own container.
 *
 * The API runs in production mode: sign-in codes go out by e-mail, admins are the addresses in ADMIN_EMAILS.
 * /v1/admin is still refused on this host: the password-protected admin console reaches the API only through
 * the AdminGateway entrypoint, bound from the admin Worker. The same Worker serves the review and demo sites
 * (STAGE, src/stage.ts).
 */
import { Container, getContainer } from '@cloudflare/containers';
import { forward } from './forward';
import { WorkerEntrypoint } from 'cloudflare:workers';
import { memoryRelay } from './memory';
import { synthesizeRelay, ttsStars } from './tts';
import { isLipsyncMediaPath, lipsyncMedia, lipsyncRender, lipsyncWarm, signTtsAnswer, ttsStar, type LipsyncEnv } from './lipsync';
import { APEX, MAIL_HOST, TURNSTILE_HOST, apiModeVars, geoPreview, noindex, restartOnHost, turnstileHostOk, webOrigin } from './stage';
import models from '../../../config/models.json';

export { ContainerProxy } from '@cloudflare/containers';

export interface Env extends LipsyncEnv {
  API: DurableObjectNamespace<Api>;
  AGENT: DurableObjectNamespace<Agent>;
  ASSETS: Fetcher;
  DB: D1Database;
  /** Cloudflare Email Service (jstarcards.ai onboarded for sending): sign-in codes. Unbound on the demo sites. */
  EMAIL: SendEmail;
  JWT_SECRET: string;
  SERIAL_HMAC_KEY: string;
  AGENT_API_KEY: string;
  /** Turnstile widget secret (the site key below is public). Unset = no bot challenges. */
  TURNSTILE_SECRET?: string;
  /**
   * Unset = production. "review" (nest.jstarcards.ai): production behaviour on its own site, kept out of search.
   * "test" (test / v1.jstarcards.ai): demo mode, no mail or bot checks. See src/stage.ts.
   */
  STAGE?: string;
  /** The host a test Worker serves (v1, test or nest.jstarcards.ai); production is the apex. */
  WEB_HOST?: string;
  /** Comma-separated e-mail addresses that become admins when they sign in. */
  ADMIN_EMAILS?: string;
  /** OpenRouter key for the persona service's chat, safety and memory models. Without it the agent answers with its stub. */
  OPENROUTER_API_KEY?: string;
  /** "on" shows blocked regions the notice page (a var, so launch day is a config change, not a code change). Unset = off. */
  GEO_BLOCK?: string;
  /**
   * Web Push (#50): the VAPID key pair (base64url, from `npx web-push generate-vapid-keys`) and the contact sent to
   * the push services. Without both keys push is off: the web app never offers notifications.
   */
  VAPID_PUBLIC_KEY?: string;
  VAPID_PRIVATE_KEY?: string;
  VAPID_SUBJECT?: string;
  /** Workers AI (wrangler `ai` binding): Whisper for voice input from browsers without speech recognition (#72). */
  AI?: Ai;
  /**
   * His memory files (#51): the private R2 bucket (`r2_buckets` in wrangler*.jsonc). Unbound = the API keeps
   * recordings base64 in D1, as before; the bucket must exist before a deploy that binds it (infra/cloudflare/README.md).
   */
  MEMORY?: R2Bucket;
  /**
   * Her runtime voice (#73, src/tts.ts, docs/tts.md): the default vendor (`fish` | `qwen` | `byteplus`), her cloned
   * voice id per talent (JSON), and the vendors' keys (secrets: FISH_API_KEY, DASHSCOPE_API_KEY,
   * BYTEPLUS_VOICE_API_KEY, or the generic TTS_API_KEY for TTS_PROVIDER). No usable voice = her lines stay subtitles; never a generic voice.
   */
  TTS_PROVIDER?: string;
  TTS_API_KEY?: string;
  TTS_VOICES?: string;
  FISH_API_KEY?: string;
  FISH_TTS_MODEL?: string;
  FISH_TTS_LATENCY?: string;
  FISH_ZH_HINT?: string;
  DASHSCOPE_API_KEY?: string;
  DASHSCOPE_BASE_URL?: string;
  QWEN_TTS_MODEL?: string;
  BYTEPLUS_VOICE_API_KEY?: string;
  BYTEPLUS_TTS_RESOURCE?: string;
  BYTEPLUS_TTS_URL?: string;
}

/**
 * Models the persona service uses, from config/models.json (the one place every model is named; chosen in
 * apps/agent/evals/RESULTS.md). Plain values, not secrets: a change is a reviewed commit. `@deepseek` pins DeepSeek's
 * own endpoint (full precision, steady first-token latency); the fallback takes over when the primary errors or has
 * not started answering within 4 s.
 */
const CHAT_MODEL = models.chat.primary.model;
const CHAT_MODEL_FALLBACK = models.chat.fallback.model;
const SAFETY_MODEL = models.chat.safety.model;
const MEMORY_MODEL = models.chat.memory.model;

/** Host the API container dials for the persona service; answered by the Worker, never the internet. */
const AGENT_HOST = 'agent.internal';
/** Host the API container sends its SQL to; answered by the Worker with the D1 binding (apps/api/src/db/d1.ts). */
const DB_HOST = 'db.internal';
const MAIL_FROM = { email: 'noreply@jstarcards.ai', name: 'JSTAR' };
/** Host the API container sends finished Web Push requests through; answered by the Worker (the container has no internet). */
const PUSH_HOST = 'push.internal';
/** Host the API container asks for the weather through (#62); answered by the Worker, which only forwards to Open-Meteo. */
const WEATHER_HOST = 'weather.internal';
/** Host the API container sends a recording to for speech to text; answered by the Worker with Workers AI. */
const ASR_HOST = 'asr.internal';
/** Host the API container keeps his memory files through (#51); answered by the Worker with the R2 binding. */
const MEMORY_HOST = 'memory.internal';
/** Host the API container asks for her runtime voice through (#73); answered by the Worker, which holds the vendor key. */
const TTS_HOST = 'tts.internal';
/** A single instance, kept awake through a working day; its data lives in D1, so sleeping loses nothing. */
const INSTANCE = 'main';
const SLEEP_AFTER = '8h';

export class Agent extends Container<Env> {
  defaultPort = 8100;
  sleepAfter = SLEEP_AFTER;

  constructor(ctx: DurableObjectState<{}>, env: Env) {
    super(ctx, env);
    // Real models once the OpenRouter key is set; until then the canned stub keeps chat working. The agent needs
    // the internet for OpenRouter, so unlike the API container it keeps outbound access.
    this.envVars = {
      AGENT_API_KEY: env.AGENT_API_KEY,
      MODEL_BACKEND: env.OPENROUTER_API_KEY ? 'openrouter' : 'stub',
      OPENROUTER_API_KEY: env.OPENROUTER_API_KEY ?? '',
      CHAT_MODEL,
      CHAT_MODEL_FALLBACK,
      SAFETY_MODEL,
      MEMORY_MODEL
    };
  }
}

export class Api extends Container<Env> {
  defaultPort = 8080;
  sleepAfter = SLEEP_AFTER;
  enableInternet = false;

  // Assigned, not declared: a `static outboundByHost = …` field (ES2022 define semantics) shadows the base
  // class's static setter, so the handler never reaches the registry ContainerProxy reads and every call
  // to the agent is refused with 520 "Origin is disallowed".
  static {
    this.outboundByHost = {
      [AGENT_HOST]: (req: Request, env: Env) => getContainer(env.AGENT, INSTANCE).fetch(req),
      [DB_HOST]: (req: Request, env: Env) => runSql(req, env.DB),
      [MAIL_HOST]: (req: Request, env: Env) => sendMail(req, env.EMAIL),
      [TURNSTILE_HOST]: (req: Request, env: Env) => verifyHuman(req, env),
      [PUSH_HOST]: (req: Request) => relayPush(req),
      [WEATHER_HOST]: (req: Request) => relayWeather(req),
      [ASR_HOST]: (req: Request, env: Env) => transcribe(req, env.AI),
      [MEMORY_HOST]: (req: Request, env: Env) => memoryRelay(req, env.MEMORY, env.AGENT_API_KEY),
      [TTS_HOST]: (req: Request, env: Env) => synthesizeRelay(req, env)
    };
  }

  constructor(ctx: DurableObjectState<{}>, env: Env) {
    super(ctx, env);
    this.envVars = {
      // Demo sites: fixed code 123456 and demo codes, so nothing is ever mailed and no real account is touched.
      // Production and review: real sign-in codes by e-mail, no demo codes or accounts. /v1/admin stays closed on the
      // public host either way.
      ...apiModeVars(env),
      API_PORT: '8080',
      PUBLIC_WEB_ORIGIN: webOrigin(env),
      PUBLIC_ADMIN_ORIGIN: `https://admin.${APEX}`,
      JWT_SECRET: env.JWT_SECRET,
      SERIAL_HMAC_KEY: env.SERIAL_HMAC_KEY,
      DB: 'd1',
      DB_URL: `http://${DB_HOST}`,
      AGENT_BASE_URL: `http://${AGENT_HOST}`,
      AGENT_API_KEY: env.AGENT_API_KEY,
      // Web Push only with both keys; the API also turns push off by itself when either is missing.
      ...(env.VAPID_PUBLIC_KEY && env.VAPID_PRIVATE_KEY
        ? {
            VAPID_PUBLIC_KEY: env.VAPID_PUBLIC_KEY,
            VAPID_PRIVATE_KEY: env.VAPID_PRIVATE_KEY,
            ...(env.VAPID_SUBJECT ? { VAPID_SUBJECT: env.VAPID_SUBJECT } : {}),
            PUSH_URL: `http://${PUSH_HOST}`
          }
        : {}),
      // Weather (#62): Open-Meteo through the relay below; no key or secret involved.
      WEATHER_URL: `http://${WEATHER_HOST}`,
      // Voice input's server fallback, whenever the Workers AI binding is there.
      ...(env.AI ? { ASR_URL: `http://${ASR_HOST}` } : {}),
      // His memory files (#51) in R2 whenever the bucket is bound; without it they stay base64 in D1.
      ...(env.MEMORY ? { MEMORY_URL: `http://${MEMORY_HOST}` } : {}),
      // Her runtime voice (#73) only when some talent has a cloned voice with its vendor's key; otherwise provider
      // `none` (subtitles). TTS_STARS: who has one, so the API offers it only for her.
      ...(ttsStars(env).length ? { TTS_URL: `http://${TTS_HOST}`, TTS_STARS: ttsStars(env).join(',') } : {}),
      // The links in his export: the API answers on the site's own origin.
      PUBLIC_API_ORIGIN: webOrigin(env),
      // The Worker overwrites X-Forwarded-For below, so the API's rate limits see the real client.
      TRUST_PROXY: 'true'
    };
  }
}

type SqlValue = string | number | null;

/**
 * The API container's database: `POST /batch {stmts: [{sql, params}]}` runs the statements with `DB.batch`,
 * which D1 executes as one transaction. Reachable only through the container's outbound interception,
 * never from the internet.
 */
async function runSql(req: Request, db: D1Database): Promise<Response> {
  if (req.method !== 'POST' || new URL(req.url).pathname !== '/batch') return new Response('not found', { status: 404 });
  const { stmts } = await req.json<{ stmts: { sql: string; params: SqlValue[] }[] }>();
  if (!Array.isArray(stmts) || !stmts.length) return Response.json({ error: 'empty_batch' }, { status: 400 });
  try {
    const results = await db.batch(stmts.map((s) => db.prepare(s.sql).bind(...s.params)));
    return Response.json({ results: results.map((r) => ({ rows: r.results ?? [], changes: r.meta?.changes ?? 0 })) });
  } catch (e) {
    return Response.json({ error: (e as Error).message }, { status: 500 });
  }
}

/**
 * The API container's mail: `POST /send {to, subject, text, html}` goes out from noreply@jstarcards.ai. Reachable
 * only through the container's outbound interception; one recipient per call, so it cannot be used to spam.
 */
async function sendMail(req: Request, email: SendEmail): Promise<Response> {
  if (req.method !== 'POST' || new URL(req.url).pathname !== '/send') return new Response('not found', { status: 404 });
  const m = await req.json<{ to?: unknown; subject?: unknown; text?: unknown; html?: unknown }>();
  if (typeof m.to !== 'string' || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(m.to) || typeof m.subject !== 'string' || typeof m.text !== 'string') {
    return Response.json({ error: 'bad_mail' }, { status: 400 });
  }
  try {
    const r = await email.send({ to: m.to, from: MAIL_FROM, subject: m.subject.slice(0, 200), text: m.text, html: typeof m.html === 'string' ? m.html : undefined });
    return Response.json({ id: r.messageId });
  } catch (e) {
    return Response.json({ error: (e as Error).message }, { status: 502 });
  }
}

/** `POST /verify {token, ip}` → Turnstile siteverify with the secret; answers `{success}` for a token of this site's host. */
async function verifyHuman(req: Request, env: Pick<Env, 'TURNSTILE_SECRET' | 'WEB_HOST'>): Promise<Response> {
  const secret = env.TURNSTILE_SECRET;
  if (req.method !== 'POST' || new URL(req.url).pathname !== '/verify' || !secret) return new Response('not found', { status: 404 });
  const { token, ip } = await req.json<{ token?: unknown; ip?: unknown }>();
  if (typeof token !== 'string' || !token) return Response.json({ success: false });
  const form = new FormData();
  form.append('secret', secret);
  form.append('response', token);
  if (typeof ip === 'string' && ip) form.append('remoteip', ip);
  const res = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', { method: 'POST', body: form });
  const out = await res.json<{ success?: boolean; hostname?: string }>().catch(() => ({ success: false, hostname: undefined }));
  return Response.json({ success: out.success === true && turnstileHostOk(out.hostname, env) });
}

/**
 * Browsers' push services. A subscription endpoint is chosen by the browser, not by us, but only these operators
 * issue them: Chrome/Edge-on-Android (FCM), Firefox (Mozilla autopush), Safari and iOS home-screen apps (Apple),
 * Edge on Windows (WNS). Anything else is refused, so the relay can never be used to reach an arbitrary host.
 */
const PUSH_HOSTS = [/^fcm\.googleapis\.com$/, /^updates\.push\.services\.mozilla\.com$/, /^([a-z0-9-]+\.)*push\.apple\.com$/, /^([a-z0-9-]+\.)*notify\.windows\.com$/];
export const isPushEndpoint = (endpoint: string): boolean => {
  try {
    const u = new URL(endpoint);
    return u.protocol === 'https:' && !u.port && PUSH_HOSTS.some((re) => re.test(u.hostname));
  } catch {
    return false;
  }
};
/** The only headers a Web Push request needs (RFC 8030, 8291, 8292). */
const PUSH_HEADERS = new Set(['ttl', 'content-encoding', 'content-type', 'authorization', 'urgency', 'topic']);

/**
 * The API container's Web Push: `POST /send {endpoint, headers, body (base64)}`, already encrypted and signed by the
 * API, is forwarded to the push service. Answers 200 `{status}` with the push service's status, so the API can drop
 * subscriptions that are gone (404/410). Reachable only through the container's outbound interception.
 */
async function relayPush(req: Request): Promise<Response> {
  if (req.method !== 'POST' || new URL(req.url).pathname !== '/send') return new Response('not found', { status: 404 });
  const m = await req.json<{ endpoint?: unknown; headers?: unknown; body?: unknown }>().catch(() => ({}) as Record<string, unknown>);
  if (typeof m.endpoint !== 'string' || !isPushEndpoint(m.endpoint)) return Response.json({ error: 'push_host_not_allowed' }, { status: 403 });
  const headers = new Headers();
  if (m.headers && typeof m.headers === 'object') {
    for (const [k, v] of Object.entries(m.headers as Record<string, unknown>)) if (PUSH_HEADERS.has(k.toLowerCase()) && typeof v === 'string') headers.set(k, v);
  }
  // A notification is at most 4 KB once encrypted; anything bigger is not one.
  if (m.body !== null && m.body !== undefined && (typeof m.body !== 'string' || m.body.length > 8192)) return Response.json({ error: 'bad_push' }, { status: 400 });
  const body = typeof m.body === 'string' ? Uint8Array.from(atob(m.body), (c) => c.charCodeAt(0)) : null;
  try {
    const res = await fetch(m.endpoint, { method: 'POST', headers, body, redirect: 'manual' });
    return Response.json({ status: res.status });
  } catch (e) {
    return Response.json({ error: (e as Error).message }, { status: 502 });
  }
}

/** Same cap as the API's `POST /v1/asr` (VOICE_INPUT.maxBytes in packages/shared). */
const ASR_MAX_BYTES = 1024 * 1024;
const ASR_LANGS = new Set(['ja', 'zh', 'en', 'ko']);
/** Whisper writes Chinese in either script; a Traditional prompt keeps Taiwan's users in theirs. */
const ASR_PROMPT: Record<string, string> = { zh: '以下是繁體中文的句子。' };

/**
 * The API container's speech to text: `POST /transcribe` with the recording as the body (`x-asr-lang`: ja / zh /
 * en / ko) → `{text, lang}` from Workers AI Whisper. The audio only passes through memory; nothing is stored or
 * logged. Reachable only through the container's outbound interception.
 */
export async function transcribe(req: Request, ai: Pick<Ai, 'run'> | undefined): Promise<Response> {
  if (req.method !== 'POST' || new URL(req.url).pathname !== '/transcribe' || !ai) return new Response('not found', { status: 404 });
  const bytes = new Uint8Array(await req.arrayBuffer());
  if (!bytes.length || bytes.length > ASR_MAX_BYTES) return Response.json({ error: 'bad_audio' }, { status: 400 });
  const lang = req.headers.get('x-asr-lang') ?? '';
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  try {
    const out = await ai.run('@cf/openai/whisper-large-v3-turbo', {
      audio: btoa(bin),
      ...(ASR_LANGS.has(lang) ? { language: lang } : {}),
      ...(ASR_PROMPT[lang] ? { initial_prompt: ASR_PROMPT[lang] } : {}),
      // Silence trimmed first: Whisper tends to invent a sign-off line ("ご視聴ありがとうございました") for quiet audio.
      vad_filter: true,
      condition_on_previous_text: false
    });
    return Response.json({ text: (out.text ?? '').trim(), lang: out.transcription_info?.language ?? null });
  } catch {
    return Response.json({ error: 'asr_failed' }, { status: 502 });
  }
}

/**
 * Open-Meteo (free, no key or account): the forecast and the place search behind the weather (#62). Only these
 * three GET paths are forwarded, each to its own fixed host, and nothing of the container's request but the query
 * string goes out, so the relay can never reach anything else.
 */
const WEATHER_UPSTREAM = new Map([
  ['/v1/forecast', 'https://api.open-meteo.com'],
  ['/v1/search', 'https://geocoding-api.open-meteo.com'],
  ['/v1/get', 'https://geocoding-api.open-meteo.com']
]);

/**
 * The API container's weather: `GET /v1/forecast?…`, `/v1/search?…` or `/v1/get?…`, answered with Open-Meteo's own
 * status and JSON. Reachable only through the container's outbound interception.
 */
async function relayWeather(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const origin = WEATHER_UPSTREAM.get(url.pathname);
  if (req.method !== 'GET' || !origin || url.search.length > 4096) return new Response('not found', { status: 404 });
  try {
    const res = await fetch(`${origin}${url.pathname}${url.search}`, { headers: { accept: 'application/json' }, redirect: 'manual' });
    return new Response(res.body, { status: res.status, headers: { 'content-type': res.headers.get('content-type') ?? 'application/json' } });
  } catch (e) {
    return Response.json({ error: (e as Error).message }, { status: 502 });
  }
}

/**
 * QR codes on the printed lucky cards: the generic one opens /lucky, the per-card variant /r/<code>.
 * Both land on the redeem page of the hash-routed app; a well-formed code is filled in (it survives the age gate).
 */
function luckyRedirect(url: URL): Response | null {
  if (url.pathname === '/lucky' || url.pathname === '/lucky/') return Response.redirect(`${url.origin}/#/serial`, 302);
  const m = /^\/r\/([^/]+)\/?$/.exec(url.pathname);
  if (!m) return null;
  const code = decodeURIComponent(m[1]).replace(/\D/g, '');
  return Response.redirect(`${url.origin}/#/serial${/^[1-9]\d{11}$/.test(code) ? `?code=${code}` : ''}`, 302);
}

const isApiPath = (path: string) => path === '/health' || path.startsWith('/v1/');
const isAdminPath = (path: string) => path === '/v1/admin' || path.startsWith('/v1/admin/');
const isOpsPath = (path: string) => path === '/v1/ops' || path.startsWith('/v1/ops/');
/** The API's scheduled tick (apps/api/src/modules/ops.ts); only the cron handler below calls it. */
const TICK_PATH = '/v1/ops/tick';

/** An account that exists and is not banned: what the API's session check accepts (apps/api/src/app.ts preHandler). */
const isMember = (db: D1Database) => async (userId: string): Promise<boolean> => {
  const row = await db.prepare('SELECT banned FROM users WHERE id = ?').bind(userId).first<{ banned: number }>();
  return !!row && Number(row.banned) !== 1;
};

/** Forwards to the API container with the caller's IP as the only X-Forwarded-For hop. */
function toApi(env: Env, req: Request, clientIp: string): Promise<Response> {
  const headers = new Headers(req.headers);
  headers.set('x-forwarded-for', clientIp);
  return forward(new Request(req, { headers }), (r) => getContainer(env.API, INSTANCE).fetch(r));
}

const CSP = [
  "default-src 'self'",
  "script-src 'self' https://static.cloudflareinsights.com https://challenges.cloudflare.com https://g.alicdn.com",
  "frame-src https://challenges.cloudflare.com",
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
  "font-src 'self' https://fonts.gstatic.com",
  "img-src 'self' data: blob:",
  "media-src 'self' blob:",
  "connect-src 'self' https://cloudflareinsights.com https://*.aliyuncs.com wss://*.aliyuncs.com https://*.aliyun.com wss://*.aliyun.com",
  "worker-src 'self' blob:",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  // Only honoured as a header, which is why this lives here and not in the HTML's <meta> policy.
  "frame-ancestors 'none'"
].join('; ');

/** Media paths: videos, card art and voice. Served with byte ranges (iOS Safari needs 206 to play video). */
const isMediaPath = (path: string) => path.startsWith('/media/') || path.startsWith('/cards/') || path.startsWith('/voice/');

/** "bytes=START-END" (either side optional) → an inclusive range within `size`, or null when unsatisfiable. */
export function parseRange(header: string, size: number): { start: number; end: number } | null {
  const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!m || (m[1] === '' && m[2] === '')) return null;
  let start: number; let end: number;
  if (m[1] === '') { const n = Number(m[2]); start = Math.max(0, size - n); end = size - 1; }
  else { start = Number(m[1]); end = m[2] === '' ? size - 1 : Math.min(Number(m[2]), size - 1); }
  return start <= end && start < size ? { start, end } : null;
}

async function asset(env: Env, req: Request): Promise<Response> {
  const path = new URL(req.url).pathname;
  const range = req.headers.get('range');
  // Workers Assets answers every request with the whole file; slice it here so media is seekable and plays on iOS.
  const res = await env.ASSETS.fetch(isMediaPath(path) && range ? new Request(req.url, { method: 'GET', headers: { accept: req.headers.get('accept') ?? '*/*' } }) : req);
  let out: Response;
  if (isMediaPath(path) && range && res.status === 200) {
    const body = await res.arrayBuffer();
    const r = parseRange(range, body.byteLength);
    if (!r) {
      out = new Response(null, { status: 416, headers: { 'content-range': `bytes */${body.byteLength}` } });
    } else {
      out = new Response(body.slice(r.start, r.end + 1), { status: 206, headers: res.headers });
      out.headers.set('content-range', `bytes ${r.start}-${r.end}/${body.byteLength}`);
      out.headers.set('content-length', String(r.end - r.start + 1));
    }
  } else {
    out = new Response(res.body, res);
  }
  out.headers.set('content-security-policy', CSP);
  // Every site but production stays out of search results.
  if (noindex(env)) out.headers.set('x-robots-tag', 'noindex, nofollow');
  out.headers.set('strict-transport-security', 'max-age=31536000; includeSubDomains');
  out.headers.set('x-content-type-options', 'nosniff');
  out.headers.set('referrer-policy', 'strict-origin-when-cross-origin');
  if (path.startsWith('/assets/')) out.headers.set('cache-control', 'public, max-age=31536000, immutable');
  else if (isMediaPath(path)) { out.headers.set('accept-ranges', 'bytes'); out.headers.set('cache-control', 'public, max-age=86400, stale-while-revalidate=604800'); }
  return out;
}

/**
 * Launch markets are Japan and Taiwan (docs: 正式产品决策 #14). Korea, the EU, the US and mainland China get a
 * notice page instead. Off during the public beta (GEO_BLOCK var unset or "off") so the team can test from anywhere.
 */
const BLOCKED_COUNTRIES = new Set(['KR', 'US', 'CN', 'AT', 'BE', 'BG', 'HR', 'CY', 'CZ', 'DK', 'EE', 'FI', 'FR', 'DE', 'GR', 'HU', 'IE', 'IT', 'LV', 'LT', 'LU', 'MT', 'NL', 'PL', 'PT', 'RO', 'SK', 'SI', 'ES', 'SE']);
function geoBlocked(req: Request, env: Pick<Env, 'GEO_BLOCK' | 'STAGE'>): boolean {
  // Demo sites only: ?geo=KR previews what a visitor from that country sees, without blocking the team.
  const preview = geoPreview(env) ? new URL(req.url).searchParams.get('geo')?.toUpperCase() : undefined;
  if (preview) return BLOCKED_COUNTRIES.has(preview);
  if (env.GEO_BLOCK !== 'on') return false;
  const country = (req as Request & { cf?: { country?: string } }).cf?.country;
  return !!country && BLOCKED_COUNTRIES.has(country);
}
const UNAVAILABLE = `<!doctype html><html lang="ja"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>JSTAR</title>
<body style="margin:0;min-height:100vh;display:grid;place-items:center;background:#10122a;color:#efe8ed;font:15px/1.8 system-ui,sans-serif;text-align:center;padding:24px">
<div><p style="letter-spacing:.3em">JSTAR</p><p>このサービスはお住まいの地域ではご利用いただけません。</p><p>This service is not available in your region.</p><p>此服務在您所在的地區無法使用。</p></div></body></html>`;

export default {
  async fetch(req, env, ctx): Promise<Response> {
    const url = new URL(req.url);
    if (url.hostname === `www.${APEX}`) {
      url.hostname = APEX;
      return Response.redirect(url.toString(), 301);
    }
    if (geoBlocked(req, env)) {
      return isApiPath(url.pathname)
        ? Response.json({ error: 'region_unavailable' }, { status: 451 })
        : new Response(UNAVAILABLE, { status: 451, headers: { 'content-type': 'text/html; charset=utf-8' } });
    }
    // Non-production sites only: the deploy script restarts the containers so they pick up the new settings.
    if (restartOnHost(env) && req.method === 'POST' && url.pathname === '/v1/ops/restart') {
      if (req.headers.get('authorization') !== `Bearer ${env.AGENT_API_KEY}`) return Response.json({ error: 'not_found' }, { status: 404 });
      await Promise.all([getContainer(env.API, INSTANCE).destroy(), getContainer(env.AGENT, INSTANCE).destroy()]);
      return Response.json({ ok: true });
    }
    const lucky = luckyRedirect(url);
    if (lucky) return lucky;
    // Her lip-sync (#73, src/lipsync.ts): rendered recorded lines from R2; per-sentence renders of her runtime voice.
    if (isLipsyncMediaPath(url.pathname)) return lipsyncMedia(req, env);
    // Both wake a GPU: members only (the session /v1/tts asks for), rate-limited per account and per IP.
    if (url.pathname === '/v1/lipsync') return lipsyncRender(req, env, (p) => ctx.waitUntil(p), isMember(env.DB));
    if (url.pathname === '/v1/lipsync/warm') return lipsyncWarm(req, env, (p) => ctx.waitUntil(p), isMember(env.DB));
    if (url.pathname === '/v1/tts' && req.method === 'POST') {
      // Her voiced sentence leaves signed for lip-sync (only her own audio may ever be rendered onto her face).
      const star = await ttsStar(req);
      return signTtsAnswer(await toApi(env, req, req.headers.get('cf-connecting-ip') ?? ''), star, env);
    }
    if (isApiPath(url.pathname)) {
      // /v1/ops/* is for the platform only (the cron tick below); from the internet it does not exist.
      if (isAdminPath(url.pathname) || isOpsPath(url.pathname)) return Response.json({ error: 'not_found' }, { status: 404 });
      return toApi(env, req, req.headers.get('cf-connecting-ip') ?? '');
    }
    return asset(env, req);
  },

  /**
   * Cron Trigger (every 5 minutes, `triggers.crons` in wrangler.jsonc): runs the API's tick (#49), which delivers
   * her inbox and every other job she does on her own. Calling the container wakes it if it was asleep.
   */
  async scheduled(controller, env, ctx): Promise<void> {
    ctx.waitUntil(tick(env, controller.scheduledTime));
  }
} satisfies ExportedHandler<Env>;

/** One tick; the outcome goes to the Workers logs (observability), which is where a missed or failed tick shows. */
async function tick(env: Env, scheduledTime: number): Promise<void> {
  const started = Date.now();
  try {
    const res = await getContainer(env.API, INSTANCE).fetch(new Request(`https://${APEX}${TICK_PATH}`, {
      method: 'POST',
      headers: { authorization: `Bearer ${env.AGENT_API_KEY}` }
    }));
    const body = await res.text();
    const log = { event: 'tick', status: res.status, scheduledTime: new Date(scheduledTime).toISOString(), ms: Date.now() - started, body: body.slice(0, 2000) };
    if (res.ok) console.log(JSON.stringify(log));
    else console.error(JSON.stringify(log));
  } catch (e) {
    console.error(JSON.stringify({ event: 'tick', error: (e as Error).message, ms: Date.now() - started }));
  }
}

/** Bound only from the admin Worker (admin.jstarcards.ai), which forwards /v1/* here including /v1/admin. */
export class AdminGateway extends WorkerEntrypoint<Env> {
  async fetch(req: Request): Promise<Response> {
    // After a deploy the platform swaps the image but restarts the container with the settings it was first
    // started with; only a start from the Durable Object passes the new envVars. The deploy workflow calls this.
    if (req.method === 'POST' && new URL(req.url).pathname === '/v1/ops/restart') {
      await Promise.all([getContainer(this.env.API, INSTANCE).destroy(), getContainer(this.env.AGENT, INSTANCE).destroy()]);
      return Response.json({ ok: true });
    }
    // The tick is the cron's alone, not the console's.
    if (isOpsPath(new URL(req.url).pathname)) return Response.json({ error: 'not_found' }, { status: 404 });
    return toApi(this.env, req, req.headers.get('x-forwarded-for') ?? '');
  }
}

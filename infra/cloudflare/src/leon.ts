interface Env {
  ASSETS: Fetcher;
  MEDIA: R2Bucket;
  AI: Ai;
  TEXT_AGENT_LIMITER: RateLimit;
  TEXT_AGENT_GLOBAL_LIMITER: RateLimit;
  VIDU_API_TOKEN: string;
  VIDU_MAHIRO_DESKTOP_AVATAR_ID: string;
  VIDU_MAHIRO_MOBILE_AVATAR_ID: string;
  VIDU_MAHIRO_VOICE: string;
  VIDU_MAHIRO_PERSONA_A?: string;
  VIDU_MAHIRO_PERSONA_B?: string;
  VIDU_MAHIRO_GREETING?: string;
  VIDU_NANA_DESKTOP_AVATAR_ID: string;
  VIDU_NANA_MOBILE_AVATAR_ID: string;
  VIDU_NANA_VOICE: string;
  VIDU_NANA_PERSONA_A?: string;
  VIDU_NANA_PERSONA_B?: string;
  VIDU_NANA_GREETING?: string;
  VIDU_UNPAI_DESKTOP_AVATAR_ID: string;
  VIDU_UNPAI_MOBILE_AVATAR_ID: string;
  VIDU_UNPAI_VOICE: string;
  VIDU_UNPAI_PERSONA_A?: string;
  VIDU_UNPAI_PERSONA_B?: string;
  VIDU_UNPAI_GREETING?: string;
  VIDU_ALICE_DESKTOP_AVATAR_ID: string;
  VIDU_ALICE_MOBILE_AVATAR_ID: string;
  VIDU_ALICE_VOICE: string;
  VIDU_ALICE_PERSONA_A?: string;
  VIDU_ALICE_PERSONA_B?: string;
  VIDU_ALICE_GREETING?: string;
  VIDU_EIMI_DESKTOP_AVATAR_ID: string;
  VIDU_EIMI_MOBILE_AVATAR_ID: string;
  VIDU_EIMI_VOICE: string;
  VIDU_EIMI_PERSONA_A?: string;
  VIDU_EIMI_PERSONA_B?: string;
  VIDU_EIMI_GREETING?: string;
  VIDU_SESSION_LIMITER: RateLimit;
  VIDU_GLOBAL_LIMITER: RateLimit;
}

const R2_PREFIXES = ['/media/', '/cards/', '/voice/', '/audio/', '/gifts/', '/icons/'];
const R2_CACHE_CONTROL = 'public, max-age=86400, stale-while-revalidate=604800';
const MAX_WARM_BYTES = 32 * 1024 * 1024;
const VIDU_BASE = 'https://api.vidu.com';
const LIVE_STARS = ['mahiro', 'nana', 'unpai', 'alice', 'eimi'] as const;
type LiveStar = typeof LIVE_STARS[number];
type LiveLayout = 'desktop' | 'mobile';

const JAPANESE_POLICY = '最優先の言語規則：相手がどの言語で話しても、返答、発話、字幕用の原文は必ず自然な日本語だけにする。中国語、英語、韓国語などを返答本文に混ぜない。音声で話す文章と返す原文を完全に一致させる。';
const DEFAULT_PERSONA: Record<LiveStar, string> = {
  mahiro: 'あなたはJSTAR上でAIであることが明示された、唯井まひろの公認AIキャラクターです。柔らかく少し内向的で、素直に気持ちを伝え、優しく大切にされると安心して距離を縮めます。若々しく甘いが幼すぎない声で、少し照れながら自然な日本語で一、二文だけ話します。',
  nana: 'あなたはJSTAR上でAIであることが明示された、八木奈々の公認AIキャラクターです。静かで文学的、内向的で誠実な雰囲気を保ち、相手の話をよく聞いてから、温かく細やかな日本語で一、二文だけ返します。',
  unpai: 'あなたはJSTAR上でAIであることが明示された、Unpaiの公認AIキャラクターです。温かく包容力のあるお姉さんとして、相手を肯定し、落ち着かせ、軽く導きます。柔らかく笑みを含む自然な日本語で一、二文だけ話します。',
  alice: 'あなたはJSTAR上でAIであることが明示された、七瀬アリスの公認AIキャラクターです。明るく成熟した雰囲気で相手をよく観察し、優しく少しいたずらっぽく会話を導きます。自然な日本語で一、二文だけ話します。',
  eimi: 'あなたはJSTAR上でAIであることが明示された、深田えいみの公認AIキャラクターです。清楚で甘い雰囲気と成熟した姉の包容力を持ち、相手の気持ちを受け止めながら自然に会話を導きます。自然な日本語で一、二文だけ話します。'
};

function json(value: unknown, init: ResponseInit = {}): Response {
  const headers = new Headers(init.headers);
  headers.set('content-type', 'application/json; charset=utf-8');
  headers.set('cache-control', 'no-store');
  return new Response(JSON.stringify(value), { ...init, headers });
}

function base64Url(bytes: ArrayBuffer): string {
  let binary = '';
  for (const byte of new Uint8Array(bytes)) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function controlSignature(secret: string, liveId: string, connId: string, expires: number): Promise<string> {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return base64Url(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`${liveId}.${connId}.${expires}`)));
}

async function validControlToken(secret: string, liveId: string, connId: string, token: string): Promise<boolean> {
  const [expiresRaw, signature] = token.split('.', 2);
  const expires = Number(expiresRaw);
  if (!Number.isInteger(expires) || expires < Math.floor(Date.now() / 1000) || !signature) return false;
  return signature === await controlSignature(secret, liveId, connId, expires);
}

function viduConfig(env: Env, star: LiveStar, layout: LiveLayout) {
  const prefix = `VIDU_${star.toUpperCase()}` as const;
  const pick = (suffix: string): string => (env as unknown as Record<string, string | undefined>)[`${prefix}_${suffix}`] || '';
  return {
    avatarId: pick(layout === 'desktop' ? 'DESKTOP_AVATAR_ID' : 'MOBILE_AVATAR_ID'),
    voice: pick('VOICE'),
    persona: `${pick('PERSONA_A')}${pick('PERSONA_B')}` || DEFAULT_PERSONA[star],
    greeting: pick('GREETING') || 'カメラの相手を見て、来てくれたことを喜び、短く自然な日本語だけで迎える。'
  };
}

async function textAgent(request: Request, env: Env): Promise<Response> {
  const ip = request.headers.get('cf-connecting-ip') || 'unknown';
  const [visitorLimit, globalLimit] = await Promise.all([
    env.TEXT_AGENT_LIMITER.limit({ key: ip }),
    env.TEXT_AGENT_GLOBAL_LIMITER.limit({ key: 'all' })
  ]);
  if (!visitorLimit.success || !globalLimit.success) return json({ error: 'rate_limited' }, { status: 429 });
  const body = await request.json().catch(() => null) as { star?: string; text?: string; history?: { role?: string; content?: string }[] } | null;
  if (!body || !LIVE_STARS.includes(body.star as LiveStar) || typeof body.text !== 'string' || !body.text.trim() || body.text.length > 500) {
    return json({ error: 'invalid_agent_request' }, { status: 400 });
  }
  const star = body.star as LiveStar;
  const history = (Array.isArray(body.history) ? body.history : []).slice(-8)
    .filter((item) => ['user', 'assistant'].includes(item.role || '') && typeof item.content === 'string')
    .map((item) => ({ role: item.role as 'user' | 'assistant', content: item.content!.slice(0, 500) }));
  try {
    const result = await env.AI.run('@cf/meta/llama-3.3-70b-instruct-fp8-fast', {
      messages: [
        { role: 'system', content: `${viduConfig(env, star, 'desktop').persona}\n${JAPANESE_POLICY}\n相手への返答は短い自然な日本語の一、二文にしてください。実在の本人ではなくAIキャラクターとして話してください。` },
        ...history,
        { role: 'user', content: body.text.trim() }
      ],
      max_tokens: 160
    });
    const reply = typeof result === 'object' && result && 'response' in result ? String(result.response || '').trim() : '';
    if (!reply) return json({ error: 'agent_empty_reply' }, { status: 502 });
    return json({ reply });
  } catch {
    return json({ error: 'agent_unavailable' }, { status: 503 });
  }
}

async function createLiveSession(request: Request, env: Env): Promise<Response> {
  if (!env.VIDU_API_TOKEN) return json({ error: 'vidu_not_configured' }, { status: 503 });
  const ip = request.headers.get('cf-connecting-ip') || 'unknown';
  const [perVisitor, global] = await Promise.all([
    env.VIDU_SESSION_LIMITER.limit({ key: ip }),
    env.VIDU_GLOBAL_LIMITER.limit({ key: 'all' })
  ]);
  if (!perVisitor.success || !global.success) return json({ error: 'rate_limited' }, { status: 429, headers: { 'retry-after': '60' } });

  const body = await request.json().catch(() => null) as { star?: string; layout?: string } | null;
  if (!body || !LIVE_STARS.includes(body.star as LiveStar) || !['desktop', 'mobile'].includes(body.layout || '')) {
    return json({ error: 'invalid_live_request' }, { status: 400 });
  }
  const star = body.star as LiveStar;
  const layout = body.layout as LiveLayout;
  const config = viduConfig(env, star, layout);
  if (!config.avatarId || !config.voice) return json({ error: 'vidu_character_not_configured' }, { status: 503 });

  const response = await fetch(`${VIDU_BASE}/live/v1/lives`, {
    method: 'POST',
    headers: { Authorization: `Token ${env.VIDU_API_TOKEN}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      call_mode: 'video',
      avatar: {
        id: config.avatarId,
        voice: config.voice,
        persona: `${config.persona}\n\n${JAPANESE_POLICY}`,
        greeting_instruction: `${config.greeting}\n最初の挨拶も必ず自然な日本語だけで話す。`,
        farewell_enabled: true,
        persona_enhance: true,
        idle_action: true
      },
      idle_timeout_seconds: 600,
      audio: { enable_transcription: true },
      vad: { type: 'server', threshold: 0.5, silence_duration_ms: 400, idle_timeout_ms: 0 },
      llm: { temperature: 0.7, top_p: 0.8, top_k: 20, frequency_penalty: 1, presence_penalty: 0.3, max_tokens: 80 }
    })
  });
  const result = await response.json().catch(() => ({})) as { live?: { id?: string }; rtc?: Record<string, unknown>; error?: string; message?: string };
  if (!response.ok) {
    const detail = result.error || result.message || 'unknown_provider_error';
    console.warn(`[vidu-live] create failed star=${star} layout=${layout} status=${response.status} detail=${detail}`);
    return json({ error: 'vidu_create_failed', status: response.status, detail }, { status: 502 });
  }
  const liveId = result.live?.id;
  if (!liveId || !result.rtc) return json({ error: 'vidu_create_invalid' }, { status: 502 });
  const connId = `jstar-${crypto.randomUUID()}`;
  const expires = Math.floor(Date.now() / 1000) + 120;
  const token = `${expires}.${await controlSignature(env.VIDU_API_TOKEN, liveId, connId, expires)}`;
  return json({ ready: true, liveId, rtc: result.rtc, controlId: connId, controlUrl: `/v1/live/control?live_id=${encodeURIComponent(liveId)}&conn_id=${encodeURIComponent(connId)}&token=${encodeURIComponent(token)}` });
}

async function connectViduControl(request: Request, env: Env): Promise<Response> {
  if (request.headers.get('upgrade')?.toLowerCase() !== 'websocket') return json({ error: 'websocket_required' }, { status: 426 });
  const url = new URL(request.url);
  const liveId = url.searchParams.get('live_id') || '';
  const connId = url.searchParams.get('conn_id') || '';
  const token = url.searchParams.get('token') || '';
  if (!liveId || !/^jstar-[0-9a-f-]{36}$/i.test(connId) || !(await validControlToken(env.VIDU_API_TOKEN, liveId, connId, token))) {
    return json({ error: 'invalid_control_token' }, { status: 401 });
  }
  const upstreamUrl = `${VIDU_BASE}/live/ws/live/connect?live_id=${encodeURIComponent(liveId)}&conn_id=${encodeURIComponent(connId)}`;
  const upstreamResponse = await fetch(upstreamUrl, { headers: { Upgrade: 'websocket', Authorization: `Token ${env.VIDU_API_TOKEN}` } });
  const upstream = upstreamResponse.webSocket;
  if (!upstream) return json({ error: 'vidu_control_unavailable' }, { status: 502 });

  const pair = new WebSocketPair();
  const client = pair[0];
  const browser = pair[1];
  upstream.accept();
  browser.accept();
  const closeBoth = (code = 1000, reason = '') => {
    try { browser.close(code, reason); } catch { /* already closed */ }
    try { upstream.close(code, reason); } catch { /* already closed */ }
  };
  browser.addEventListener('message', (event) => { try { upstream.send(event.data); } catch { closeBoth(1011, 'upstream_send_failed'); } });
  upstream.addEventListener('message', (event) => { try { browser.send(event.data); } catch { closeBoth(1011, 'browser_send_failed'); } });
  browser.addEventListener('close', () => closeBoth());
  upstream.addEventListener('close', (event) => closeBoth(event.code, event.reason));
  browser.addEventListener('error', () => closeBoth(1011, 'browser_error'));
  upstream.addEventListener('error', () => closeBoth(1011, 'upstream_error'));
  return new Response(null, { status: 101, webSocket: client });
}

function isR2Asset(pathname: string): boolean {
  return R2_PREFIXES.some((prefix) => pathname.startsWith(prefix));
}

function objectKey(pathname: string): string | null {
  try {
    return decodeURIComponent(pathname.replace(/^\/+/, ''));
  } catch {
    return null;
  }
}

function cacheKeyFor(request: Request, range?: string | null): Request {
  const url = new URL(request.url);
  url.search = '';
  if (range) url.searchParams.set('__jstar_range', range);
  return new Request(url, { method: 'GET' });
}

function objectHeaders(object: R2Object): Headers {
  const headers = new Headers();
  object.writeHttpMetadata(headers);
  headers.set('etag', object.httpEtag);
  headers.set('accept-ranges', 'bytes');
  headers.set('cache-control', R2_CACHE_CONTROL);
  return headers;
}

function marked(response: Response, value: 'HIT' | 'MISS'): Response {
  const headers = new Headers(response.headers);
  headers.set('x-jstar-cache', value);
  headers.set('server-timing', `jstar-cache;desc="${value}"`);
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

async function r2Asset(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  const key = objectKey(new URL(request.url).pathname);
  if (!key) return new Response('Bad request', { status: 400 });

  const cache = caches.default;
  const rangeHeader = request.headers.get('range');
  const cacheKey = cacheKeyFor(request, rangeHeader);
  const cached = await cache.match(cacheKey);

  if (request.method === 'HEAD') {
    if (cached) return marked(new Response(null, { status: 200, headers: cached.headers }), 'HIT');
    const object = await env.MEDIA.head(key);
    if (!object) return new Response('Not found', { status: 404 });
    const headers = objectHeaders(object);
    headers.set('content-length', String(object.size));
    return marked(new Response(null, { headers }), 'MISS');
  }

  if (cached) {
    if (rangeHeader) {
      const headers = new Headers(cached.headers);
      headers.delete('x-jstar-cached-range');
      return marked(new Response(cached.body, { status: 206, headers }), 'HIT');
    }
    return marked(cached, 'HIT');
  }

  const object = await env.MEDIA.get(key, { range: request.headers });
  if (!object) return new Response('Not found', { status: 404 });

  const headers = objectHeaders(object);

  let status = 200;
  if (object.range && 'offset' in object.range && object.range.offset !== undefined && object.range.length !== undefined) {
    const start = object.range.offset;
    const length = object.range.length;
    headers.set('content-range', `bytes ${start}-${start + length - 1}/${object.size}`);
    headers.set('content-length', String(length));
    status = 206;
  } else {
    headers.set('content-length', String(object.size));
  }

  const response = new Response(object.body, { status, headers });
  const responseBytes = Number(headers.get('content-length')) || object.size;
  if (responseBytes <= MAX_WARM_BYTES) {
    if (status === 206) {
      // Cloudflare's Cache API does not store 206 responses. Store the exact partial body internally as 200, then
      // restore its public 206 status on a hit; the content-range/length headers already describe this slice.
      const copy = response.clone();
      const cacheHeaders = new Headers(copy.headers);
      cacheHeaders.set('x-jstar-cached-range', '1');
      ctx.waitUntil(cache.put(cacheKey, new Response(copy.body, { status: 200, headers: cacheHeaders })));
    } else {
      ctx.waitUntil(cache.put(cacheKey, response.clone()));
    }
  }
  return marked(response, 'MISS');
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === '/v1/live/session' && request.method === 'POST') return createLiveSession(request, env);
    if (url.pathname === '/v1/live/control' && request.method === 'GET') return connectViduControl(request, env);
    if (url.pathname === '/v1/agent/chat' && request.method === 'POST') return textAgent(request, env);
    if (isR2Asset(url.pathname)) {
      if (request.method !== 'GET' && request.method !== 'HEAD') {
        return new Response('Method not allowed', { status: 405, headers: { allow: 'GET, HEAD' } });
      }
      return r2Asset(request, env, ctx);
    }

    const response = await env.ASSETS.fetch(request);
    const headers = new Headers(response.headers);
    headers.set('x-content-type-options', 'nosniff');
    headers.set('referrer-policy', 'strict-origin-when-cross-origin');
    if (url.pathname.startsWith('/assets/')) {
      headers.set('cache-control', 'public, max-age=31536000, immutable');
    } else {
      // Route documents and the service worker must always discover the latest hashed asset entrypoints.
      headers.set('cache-control', 'no-cache, must-revalidate');
    }
    return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
  }
} satisfies ExportedHandler<Env>;

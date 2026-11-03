interface Env {
  ASSETS: Fetcher;
  MEDIA: R2Bucket;
}

const R2_PREFIXES = ['/media/', '/cards/', '/voice/', '/audio/', '/gifts/', '/icons/'];
const R2_CACHE_CONTROL = 'public, max-age=86400, stale-while-revalidate=604800';
const MAX_WARM_BYTES = 32 * 1024 * 1024;

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
    }
    return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
  }
} satisfies ExportedHandler<Env>;

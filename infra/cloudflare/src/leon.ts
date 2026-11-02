interface Env {
  ASSETS: Fetcher;
  MEDIA: R2Bucket;
}

const R2_PREFIXES = ['/media/', '/cards/', '/voice/', '/audio/', '/gifts/', '/icons/'];

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

async function r2Asset(request: Request, env: Env): Promise<Response> {
  const key = objectKey(new URL(request.url).pathname);
  if (!key) return new Response('Bad request', { status: 400 });

  if (request.method === 'HEAD') {
    const object = await env.MEDIA.head(key);
    if (!object) return new Response('Not found', { status: 404 });
    const headers = new Headers();
    object.writeHttpMetadata(headers);
    headers.set('etag', object.httpEtag);
    headers.set('content-length', String(object.size));
    headers.set('accept-ranges', 'bytes');
    headers.set('cache-control', 'public, max-age=86400, stale-while-revalidate=604800');
    return new Response(null, { headers });
  }

  const object = await env.MEDIA.get(key, { range: request.headers });
  if (!object) return new Response('Not found', { status: 404 });

  const headers = new Headers();
  object.writeHttpMetadata(headers);
  headers.set('etag', object.httpEtag);
  headers.set('accept-ranges', 'bytes');
  headers.set('cache-control', 'public, max-age=86400, stale-while-revalidate=604800');

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

  return new Response(object.body, { status, headers });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (isR2Asset(url.pathname)) {
      if (request.method !== 'GET' && request.method !== 'HEAD') {
        return new Response('Method not allowed', { status: 405, headers: { allow: 'GET, HEAD' } });
      }
      return r2Asset(request, env);
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

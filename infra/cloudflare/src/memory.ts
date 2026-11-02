/**
 * The API container's memory store (#51): his memory files — the recording of his yes (#55), scene stills later — in
 * the private R2 bucket bound as `MEMORY`. Reachable only through the container's outbound interception
 * (`http://memory.internal`), and only with the internal key, so nothing on the internet can reach a file directly;
 * he gets his files through the API (his session, or a signed link from his export).
 *
 * Narrow on purpose: one file by key (`PUT|GET|DELETE /o/<key>`) and one person's files at once (`POST /purge
 * {userId}`, for account deletion). Every key is `<userId>/…` in URL-safe characters, never `..`; nothing lists.
 *
 * No Workers imports here (only the structural types below), so the API's tests run this very handler against a
 * fake bucket (apps/api/tests/memoryAssets.test.ts).
 */

/** The part of R2Bucket this uses. */
export interface MemoryBucket {
  put(key: string, value: ArrayBuffer, options?: { httpMetadata?: { contentType?: string } }): Promise<unknown>;
  get(key: string): Promise<{ body: ReadableStream; httpMetadata?: { contentType?: string }; size: number } | null>;
  delete(keys: string | string[]): Promise<void>;
  list(options: { prefix: string; limit?: number; cursor?: string }): Promise<{ objects: { key: string }[]; truncated: boolean; cursor?: string }>;
}

/** Same shape the API checks (apps/api/src/lib/memoryAssets.ts MEMORY_KEY_RE). */
const KEY_RE = /^[A-Za-z0-9_-]{1,64}(\/[A-Za-z0-9_-]{1,64}){1,4}$/;
const USER_RE = /^[A-Za-z0-9_-]{1,64}$/;
/** MEMORY_RULES.maxFileBytes: a recording is at most 768 KB, a still a few MB. */
export const MEMORY_MAX_BYTES = 5 * 1024 * 1024;
/** Files erased per purge call; the API calls again while `more`. */
const PURGE_PAGE = 500;

/** Constant-time enough for a fixed-length bearer compare inside the platform. */
function sameKey(given: string | null, want: string): boolean {
  if (!given || !want) return false;
  const a = new TextEncoder().encode(given);
  const b = new TextEncoder().encode(`Bearer ${want}`);
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

export async function memoryRelay(req: Request, bucket: MemoryBucket | undefined, internalKey: string): Promise<Response> {
  const url = new URL(req.url);
  // Without a bucket, or without the key, the relay does not exist.
  if (!bucket || !sameKey(req.headers.get('authorization'), internalKey)) return new Response('not found', { status: 404 });

  if (url.pathname === '/purge' && req.method === 'POST') {
    const { userId } = ((await req.json().catch(() => ({}))) ?? {}) as { userId?: unknown };
    if (typeof userId !== 'string' || !USER_RE.test(userId)) return Response.json({ error: 'bad_user' }, { status: 400 });
    const page = await bucket.list({ prefix: `${userId}/`, limit: PURGE_PAGE });
    const keys = page.objects.map((o) => o.key);
    if (keys.length) await bucket.delete(keys);
    return Response.json({ deleted: keys.length, more: page.truncated });
  }

  const key = url.pathname.startsWith('/o/') ? url.pathname.slice(3) : '';
  if (!KEY_RE.test(key)) return Response.json({ error: 'bad_key' }, { status: 400 });
  if (req.method === 'PUT') {
    const type = (req.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase();
    if (!/^(audio|image)\/[a-z0-9.+-]{1,40}$/.test(type)) return Response.json({ error: 'bad_type' }, { status: 415 });
    const body = await req.arrayBuffer();
    if (!body.byteLength || body.byteLength > MEMORY_MAX_BYTES) return Response.json({ error: 'bad_size' }, { status: 413 });
    await bucket.put(key, body, { httpMetadata: { contentType: type } });
    return Response.json({ ok: true });
  }
  if (req.method === 'GET') {
    const obj = await bucket.get(key);
    if (!obj) return new Response('not found', { status: 404 });
    return new Response(obj.body, { headers: { 'content-type': obj.httpMetadata?.contentType ?? 'application/octet-stream', 'content-length': String(obj.size) } });
  }
  if (req.method === 'DELETE') {
    await bucket.delete(key);
    return Response.json({ ok: true });
  }
  return new Response('not found', { status: 404 });
}

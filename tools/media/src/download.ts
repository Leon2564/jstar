import { mkdir, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

/**
 * The Singapore object store throttles each connection (~15 KB/s measured from Japan), but not the
 * sum across connections, so files are fetched as parallel byte ranges and stitched back together.
 */
export const CHUNK = 256 * 1024;

export function ranges(total: number, chunk = CHUNK): [number, number][] {
  if (!Number.isInteger(total) || total <= 0) throw new Error(`bad size ${total}`);
  const out: [number, number][] = [];
  for (let start = 0; start < total; start += chunk) out.push([start, Math.min(total, start + chunk) - 1]);
  return out;
}

/** Content-Range: bytes 0-0/1785197 → 1785197 */
export function totalFromContentRange(h: string | null): number {
  const m = /\/(\d+)\s*$/.exec(h ?? '');
  if (!m) throw new Error(`no size in content-range "${h}"`);
  return Number(m[1]);
}

async function withRetry<T>(fn: () => Promise<T>, tries = 5): Promise<T> {
  let last: unknown;
  for (let i = 0; i < tries; i++) {
    try { return await fn(); } catch (e) { last = e; await new Promise((r) => setTimeout(r, 500 * 2 ** i)); }
  }
  throw last;
}

export async function download(url: string, dest: string, opts: { parallel?: number; fetch?: typeof fetch } = {}): Promise<number> {
  const f = opts.fetch ?? fetch;
  const parallel = opts.parallel ?? 16;
  const probe = await withRetry(async () => {
    const r = await f(url, { headers: { range: 'bytes=0-0' } });
    if (r.status !== 206) throw new Error(`range probe got ${r.status}`);
    await r.arrayBuffer();
    return r;
  });
  const total = totalFromContentRange(probe.headers.get('content-range'));
  const parts = ranges(total);
  const buffers: Buffer[] = new Array(parts.length);
  let next = 0;
  const worker = async () => {
    while (next < parts.length) {
      const i = next++;
      const [a, b] = parts[i];
      buffers[i] = await withRetry(async () => {
        const r = await f(url, { headers: { range: `bytes=${a}-${b}` } });
        if (r.status !== 206) throw new Error(`chunk ${i} got ${r.status}`);
        const buf = Buffer.from(await r.arrayBuffer());
        if (buf.length !== b - a + 1) throw new Error(`chunk ${i} short: ${buf.length}`);
        return buf;
      });
    }
  };
  await Promise.all(Array.from({ length: Math.min(parallel, parts.length) }, worker));
  const file = Buffer.concat(buffers);
  if (file.length !== total) throw new Error(`size mismatch ${file.length} != ${total}`);
  await mkdir(dirname(dest), { recursive: true });
  // Write then rename, so an interrupted run never leaves a truncated file that looks complete.
  await writeFile(`${dest}.part`, file);
  await rename(`${dest}.part`, dest);
  return total;
}

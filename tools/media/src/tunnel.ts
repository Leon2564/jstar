/**
 * Temporary, unguessable HTTPS URLs for a handful of local files — CreateAsset only accepts URLs and
 * the account has no object-storage bucket we can write to.
 *
 * A local server exposes exactly the given files under a random token path; a Cloudflare quick tunnel
 * (trycloudflare, no account config touched) gives it a public https host. Both are closed as soon as
 * the platform has fetched and processed the files.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import { basename, extname } from 'node:path';

const TYPES: Record<string, string> = { '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp' };

/** Serves only `files` (by basename) under /<token>/; everything else is 404. */
export function serveFiles(files: string[], token = randomBytes(16).toString('hex')): Promise<{ server: Server; port: number; token: string }> {
  const allowed = new Map(files.map((f) => [basename(f), f]));
  const server = createServer(async (req, res) => {
    const m = /^\/([0-9a-f]+)\/([^/?#]+)$/.exec(req.url ?? '');
    const file = m && m[1] === token ? allowed.get(decodeURIComponent(m[2])) : undefined;
    if (!file || (req.method !== 'GET' && req.method !== 'HEAD')) { res.writeHead(404).end(); return; }
    const body = await readFile(file);
    res.writeHead(200, { 'content-type': TYPES[extname(file).toLowerCase()] ?? 'application/octet-stream', 'content-length': body.length, 'cache-control': 'no-store' });
    res.end(req.method === 'HEAD' ? undefined : body);
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, port: (server.address() as { port: number }).port, token })));
}

/** The last error cloudflared logged (e.g. SRV lookup or TLS to the edge refused by the network), for the failure message. */
export function lastError(log: string): string {
  const errs = log.split('\n').filter((l) => / ERR /.test(l) && !/Please try|ensure that|Run your system|See GitHub|For example|developers\.cloudflare/.test(l));
  const m = errs.length ? /ERR (.*)$/.exec(errs[errs.length - 1]) : null;
  return m ? `: ${m[1].replace(/\s+(connIndex|event|ip)=\S+/g, '').slice(0, 200)}` : '';
}

/** Picks the public hostname cloudflared prints once the quick tunnel is up. */
export function tunnelUrlFrom(log: string): string | null {
  return /https:\/\/[a-z0-9-]+\.trycloudflare\.com/.exec(log)?.[0] ?? null;
}

export interface Published { urlFor(file: string): string; close(): Promise<void> }

/** One quick tunnel attempt. A fresh hostname each time, so a cached DNS miss never blocks a retry. */
async function openTunnel(port: number, token: string, firstFile: string): Promise<{ base: string; proc: ChildProcess }> {
  const proc: ChildProcess = spawn('cloudflared', ['tunnel', '--no-autoupdate', '--url', `http://127.0.0.1:${port}`], { stdio: ['ignore', 'pipe', 'pipe'] });
  try {
    const base = await new Promise<string>((resolve, reject) => {
      let out = '';
      // Behind a DNS-rewriting proxy cloudflared spends ~20 s on lookups before it even dials the edge.
      const timer = setTimeout(() => reject(new Error(`cloudflared did not come up within 90 s${lastError(out)}`)), 90_000);
      // Wait for the edge connection too: probing the hostname before its DNS record exists makes the
      // system resolver cache the miss, and the link then looks dead for minutes.
      const onData = (b: Buffer) => { out += b.toString(); const u = tunnelUrlFrom(out); if (u && /Registered tunnel connection/.test(out)) { clearTimeout(timer); resolve(u); } };
      proc.stdout?.on('data', onData);
      proc.stderr?.on('data', onData);
      proc.on('exit', (code) => { clearTimeout(timer); reject(new Error(`cloudflared exited (${code})${lastError(out)}`)); });
    });
    const first = `${base}/${token}/${encodeURIComponent(basename(firstFile))}`;
    await new Promise((r) => setTimeout(r, 6000));
    for (let i = 0; i < 15; i++) {
      try { if ((await fetch(first, { method: 'HEAD' })).ok) return { base, proc }; } catch { /* not yet */ }
      await new Promise((r) => setTimeout(r, 3000));
    }
    throw new Error('tunnel never became reachable');
  } catch (e) {
    proc.kill('SIGTERM');
    throw e;
  }
}

export async function publishTemporarily(files: string[], log: (m: string) => void = () => {}, attempts = 3): Promise<Published> {
  const { server, port, token } = await serveFiles(files);
  for (let i = 1; ; i++) {
    try {
      const { base, proc } = await openTunnel(port, token, files[0]);
      log(`  temporary link up (${base.replace('https://', '')}), closes after upload`);
      return {
        urlFor: (f) => `${base}/${token}/${encodeURIComponent(basename(f))}`,
        close: async () => { proc.kill('SIGTERM'); await new Promise<void>((r) => server.close(() => r())); }
      };
    } catch (e) {
      if (i >= attempts) { await new Promise<void>((r) => server.close(() => r())); throw e; }
      log(`  link attempt ${i} failed (${(e as Error).message}); trying a fresh one`);
    }
  }
}

/**
 * Temporary, unguessable HTTPS URLs through a private R2 bucket and a read-only relay Worker — the fallback
 * for tunnel.ts when cloudflared cannot reach the Cloudflare edge (a local proxy that breaks SRV lookups and
 * the tunnel's TLS). CreateAsset only accepts http(s) URLs, and Seedance only accepts a real person as an
 * asset:// from her library, so the photos must be reachable for the minutes it takes to register them.
 *
 * Set up per run (outside the repo, deleted afterwards; see docs/asset-bible.md §5):
 *   JSTAR_RELAY_URL=https://<worker>.<subdomain>.workers.dev   the Worker: GET /<token>/<key> from the bucket, else 404
 *   JSTAR_RELAY_TOKEN_FILE=/path/.token                         64 hex chars, also the Worker's RELAY_TOKEN secret
 *   JSTAR_RELAY_BUCKET=jstar-relay-tmp                           private bucket, no r2.dev URL
 * Cloudflare credentials come from .env.cloudflare.local in the main checkout. Objects get random names and
 * are deleted as soon as the platform has processed them (Published.close).
 */
import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { extname, join, resolve } from 'node:path';
import { promisify } from 'node:util';
import type { Published } from './tunnel';

const exec = promisify(execFile);
const ROOT = resolve(import.meta.dirname, '../../..');
const MAIN_ROOT = ROOT.replace(/\/\.claude\/worktrees\/[^/]+$/, '');
const TYPES: Record<string, string> = { '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp' };

export interface RelayConfig { base: string; token: string; bucket: string; env: Record<string, string> }

/** Random object name that keeps the extension (the Worker serves only these patterns). */
export const relayName = (file: string) => `${randomBytes(12).toString('hex')}${extname(file).toLowerCase() === '.jpeg' ? '.jpg' : extname(file).toLowerCase()}`;

export function relayUrl(base: string, token: string, name: string): string {
  if (!/^https:\/\//.test(base)) throw new Error('JSTAR_RELAY_URL must be https');
  if (!/^[0-9a-f]{64}$/.test(token)) throw new Error('relay token must be 64 hex characters');
  return `${base.replace(/\/+$/, '')}/${token}/${name}`;
}

async function envFile(file: string): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  if (!existsSync(file)) return out;
  for (const line of (await readFile(file, 'utf8')).split('\n')) {
    const m = /^\s*(?:export\s+)?([A-Z0-9_]+)\s*=\s*(.*?)\s*$/.exec(line);
    if (m && !line.trimStart().startsWith('#')) out[m[1]] = m[2].replace(/^['"]|['"]$/g, '');
  }
  return out;
}

/** The relay, when configured through the environment; null means "use the cloudflared tunnel". */
export async function relayConfig(): Promise<RelayConfig | null> {
  const base = process.env.JSTAR_RELAY_URL;
  const tokenFile = process.env.JSTAR_RELAY_TOKEN_FILE;
  if (!base || !tokenFile) return null;
  const token = (await readFile(tokenFile, 'utf8')).trim();
  relayUrl(base, token, 'x.jpg');
  const cf = await envFile(join(MAIN_ROOT, '.env.cloudflare.local'));
  if (!cf.CLOUDFLARE_API_TOKEN) throw new Error('CLOUDFLARE_API_TOKEN missing (.env.cloudflare.local in the main checkout)');
  return { base, token, bucket: process.env.JSTAR_RELAY_BUCKET ?? 'jstar-relay-tmp', env: { ...(process.env as Record<string, string>), ...cf } };
}

const wrangler = () => [join(ROOT, 'node_modules/.bin/wrangler'), join(MAIN_ROOT, 'node_modules/.bin/wrangler')].find((f) => existsSync(f)) ?? 'wrangler';

async function r2(cfg: RelayConfig, args: string[]) {
  // One wrangler at a time (the machine is shared); credentials only through the environment.
  await exec(wrangler(), ['r2', 'object', ...args, '--remote'], { env: cfg.env, maxBuffer: 1 << 22 });
}

export async function publishViaRelay(files: string[], log: (m: string) => void = () => {}, cfg?: RelayConfig): Promise<Published> {
  const c = cfg ?? (await relayConfig());
  if (!c) throw new Error('relay not configured (JSTAR_RELAY_URL, JSTAR_RELAY_TOKEN_FILE)');
  const names = new Map<string, string>();
  try {
    for (const f of files) {
      const name = relayName(f);
      await r2(c, ['put', `${c.bucket}/${name}`, '--file', f, '--content-type', TYPES[extname(f).toLowerCase()] ?? 'application/octet-stream']);
      names.set(f, name);
    }
    const first = relayUrl(c.base, c.token, names.get(files[0])!);
    for (let i = 0; ; i++) {
      // The relay Worker answers GET only: a 1-byte ranged GET checks the object is served without fetching it.
      const r = await fetch(first, { headers: { Range: 'bytes=0-0' } }).then(async (res) => { await res.body?.cancel(); return res; }).catch(() => null);
      if (r?.ok) break;
      if (i >= 10) throw new Error(`relay not serving the upload (${r?.status ?? 'no response'})`);
      await new Promise((res) => setTimeout(res, 2000));
    }
  } catch (e) {
    for (const name of names.values()) await r2(c, ['delete', `${c.bucket}/${name}`]).catch(() => {});
    throw e;
  }
  log(`  relay up: ${files.length} file(s) in ${c.bucket}, deleted after processing`);
  return {
    urlFor: (f) => relayUrl(c.base, c.token, names.get(f) ?? '__missing__.jpg'),
    close: async () => {
      for (const name of names.values()) await r2(c, ['delete', `${c.bucket}/${name}`]).catch((e) => log(`  ! could not delete ${name}: ${(e as Error).message.slice(0, 120)}`));
    }
  };
}

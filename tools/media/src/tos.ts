/**
 * Private hosting for talent photos, just long enough for CreateAsset to fetch them.
 *
 * CreateAsset accepts only a public URL. Talent photos must not sit on a public host, so they are put
 * into a private TOS bucket (BytePlus object storage, S3-compatible API, AWS Signature V4) and handed
 * over as presigned GET URLs that expire after an hour.
 *
 * Configuration (.env.seedance): TOS_BUCKET, optional TOS_ENDPOINT (default tos-s3-ap-southeast-1.bytepluses.com),
 * TOS_REGION (default ap-southeast-1); credentials are the same AK/SK.
 */
import { createHash, createHmac } from 'node:crypto';

export interface TosConfig { ak: string; sk: string; bucket: string; endpoint?: string; region?: string }

const DEFAULT_ENDPOINT = 'tos-s3-ap-southeast-1.bytepluses.com';
const sha256hex = (b: string | Buffer) => createHash('sha256').update(b).digest('hex');
const hmac = (k: Buffer | string, s: string) => createHmac('sha256', k).update(s).digest();
const amzDate = (d: Date) => d.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
/** RFC 3986 encoding as S3 expects: keep unreserved characters, keep "/" in paths. */
const enc = (s: string, keepSlash = false) =>
  encodeURIComponent(s).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`).replace(keepSlash ? /%2F/g : /$^/, '/');

function signingKey(sk: string, day: string, region: string) {
  return hmac(hmac(hmac(hmac(`AWS4${sk}`, day), region), 's3'), 'aws4_request');
}

function hostFor(cfg: TosConfig) {
  return `${cfg.bucket}.${cfg.endpoint ?? DEFAULT_ENDPOINT}`;
}

/** Presigned GET URL (query-string auth), valid for `expires` seconds. */
export function presignGet(cfg: TosConfig, key: string, expires = 3600, now = new Date()): string {
  const region = cfg.region ?? 'ap-southeast-1';
  const host = hostFor(cfg);
  const x = amzDate(now);
  const day = x.slice(0, 8);
  const scope = `${day}/${region}/s3/aws4_request`;
  const params: Record<string, string> = {
    'X-Amz-Algorithm': 'AWS4-HMAC-SHA256',
    'X-Amz-Credential': `${cfg.ak}/${scope}`,
    'X-Amz-Date': x,
    'X-Amz-Expires': String(expires),
    'X-Amz-SignedHeaders': 'host'
  };
  const query = Object.keys(params).sort().map((k) => `${enc(k)}=${enc(params[k])}`).join('&');
  const path = `/${enc(key, true)}`;
  const canonical = ['GET', path, query, `host:${host}\n`, 'host', 'UNSIGNED-PAYLOAD'].join('\n');
  const toSign = ['AWS4-HMAC-SHA256', x, scope, sha256hex(canonical)].join('\n');
  const sig = createHmac('sha256', signingKey(cfg.sk, day, region)).update(toSign).digest('hex');
  return `https://${host}${path}?${query}&X-Amz-Signature=${sig}`;
}

/** Headers for a signed PUT of `body` to `key` (private object). */
export function signPut(cfg: TosConfig, key: string, body: Buffer, contentType: string, now = new Date()): { url: string; headers: Record<string, string> } {
  const region = cfg.region ?? 'ap-southeast-1';
  const host = hostFor(cfg);
  const x = amzDate(now);
  const day = x.slice(0, 8);
  const scope = `${day}/${region}/s3/aws4_request`;
  const payload = sha256hex(body);
  const headers: Record<string, string> = { 'content-type': contentType, host, 'x-amz-content-sha256': payload, 'x-amz-date': x };
  const names = Object.keys(headers).sort();
  const path = `/${enc(key, true)}`;
  const canonical = ['PUT', path, '', names.map((n) => `${n}:${headers[n]}\n`).join(''), names.join(';'), payload].join('\n');
  const toSign = ['AWS4-HMAC-SHA256', x, scope, sha256hex(canonical)].join('\n');
  const sig = createHmac('sha256', signingKey(cfg.sk, day, region)).update(toSign).digest('hex');
  const { host: _host, ...sent } = headers;
  return { url: `https://${host}${path}`, headers: { ...sent, authorization: `AWS4-HMAC-SHA256 Credential=${cfg.ak}/${scope}, SignedHeaders=${names.join(';')}, Signature=${sig}` } };
}

/** Uploads privately and returns a one-hour URL CreateAsset can fetch. */
export async function hostPrivately(cfg: TosConfig, key: string, body: Buffer, contentType: string, f: typeof fetch = fetch): Promise<string> {
  const { url, headers } = signPut(cfg, key, body, contentType);
  const res = await f(url, { method: 'PUT', headers, body });
  if (!res.ok) throw new Error(`TOS upload failed (${res.status}): ${(await res.text()).slice(0, 300)}`);
  return presignGet(cfg, key);
}

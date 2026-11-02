/**
 * BytePlus OpenAPI (control plane) client for the ModelArk asset library.
 * Asset APIs only accept AK/SK signatures (HMAC-SHA256, credential scope date/region/service/request),
 * unlike the inference API, which takes the Bearer API key.
 * Docs: ModelArk "Private real-human asset library guide" and "CreateAsset" API reference.
 */
import { createHash, createHmac } from 'node:crypto';

export const OPENAPI_HOST = 'ark.ap-southeast-1.byteplusapi.com';
export const REGION = 'ap-southeast-1';
export const SERVICE = 'ark';
export const VERSION = '2024-01-01';

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');
const hmac = (key: Buffer | string, s: string) => createHmac('sha256', key).update(s).digest();

/** 20260924T123456Z */
export const xDate = (d = new Date()) => d.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');

export interface SignInput { ak: string; sk: string; action: string; body: string; date?: Date; host?: string }

/** Returns the headers for one signed POST /?Action=…&Version=2024-01-01 request. */
export function sign({ ak, sk, action, body, date = new Date(), host = OPENAPI_HOST }: SignInput): Record<string, string> {
  const x = xDate(date);
  const day = x.slice(0, 8);
  const payloadHash = sha256(body);
  const query = `Action=${encodeURIComponent(action)}&Version=${VERSION}`;
  const headers: Record<string, string> = { 'content-type': 'application/json', host, 'x-content-sha256': payloadHash, 'x-date': x };
  const signed = Object.keys(headers).sort();
  const canonical = ['POST', '/', query, signed.map((k) => `${k}:${headers[k]}\n`).join(''), signed.join(';'), payloadHash].join('\n');
  const scope = `${day}/${REGION}/${SERVICE}/request`;
  const toSign = ['HMAC-SHA256', x, scope, sha256(canonical)].join('\n');
  const key = hmac(hmac(hmac(hmac(sk, day), REGION), SERVICE), 'request');
  const signature = createHmac('sha256', key).update(toSign).digest('hex');
  return { ...headers, authorization: `HMAC-SHA256 Credential=${ak}/${scope}, SignedHeaders=${signed.join(';')}, Signature=${signature}` };
}

export class OpenApiError extends Error {
  constructor(public code: string, message: string, public status: number) { super(`${code}: ${message}`); }
}

export function createOpenApi(ak: string, sk: string, f: typeof fetch = fetch) {
  if (!ak || !sk) throw new Error('ARK_AK / ARK_SK are not set (see .env.seedance)');
  return async function call<T = Record<string, unknown>>(action: string, params: Record<string, unknown> = {}): Promise<T> {
    const body = JSON.stringify(params);
    // Retry only transport failures (the link to Singapore drops now and then); API errors are final.
    let res: Response | undefined;
    for (let attempt = 0; !res; attempt++) {
      try {
        res = await f(`https://${OPENAPI_HOST}/?Action=${action}&Version=${VERSION}`, { method: 'POST', headers: sign({ ak, sk, action, body }), body });
      } catch (e) {
        if (attempt >= 3) throw e;
        await new Promise((r) => setTimeout(r, 1000 * 2 ** attempt));
      }
    }
    const json = (await res.json().catch(() => ({}))) as { ResponseMetadata?: { Error?: { Code?: string; Message?: string } }; Result?: T };
    const err = json.ResponseMetadata?.Error;
    if (!res.ok || err) throw new OpenApiError(err?.Code ?? `http_${res.status}`, err?.Message ?? 'request failed', res.status);
    return (json.Result ?? json) as T;
  };
}
export type OpenApi = ReturnType<typeof createOpenApi>;

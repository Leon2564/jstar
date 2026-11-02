/**
 * Minimal OpenRouter client for the card pipeline: chat (vision judge, Gemini image output) and the
 * images endpoint (gpt-image), with every call's cost appended to out/spend.jsonl (summarised into
 * docs/SPEND.md). A 402 or key-limit error throws `OutOfCredit` so callers can stop cleanly.
 */
import { existsSync } from 'node:fs';
import { appendFile, mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { OUT } from './generate';
import { MAIN_ROOT } from './refs';

export class OutOfCredit extends Error {}

let envCache: Record<string, string> | undefined;
export async function env(): Promise<Record<string, string>> {
  if (envCache) return envCache;
  const out: Record<string, string> = {};
  for (const file of [join(MAIN_ROOT, '.env.openrouter.local')]) {
    if (!existsSync(file)) continue;
    for (const line of (await readFile(file, 'utf8')).split('\n')) {
      const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/.exec(line);
      if (m && !line.trimStart().startsWith('#')) out[m[1]] = m[2].replace(/^['"]|['"]$/g, '');
    }
  }
  envCache = { ...out, ...(process.env as Record<string, string>) };
  if (!envCache.OPENROUTER_API_KEY) throw new Error('OPENROUTER_API_KEY missing (.env.openrouter.local in the main checkout)');
  return envCache;
}

const SPEND = join(OUT, 'spend.jsonl');
export async function logSpend(entry: { model: string; purpose: string; cost: number; id?: string }) {
  await mkdir(OUT, { recursive: true });
  await appendFile(SPEND, `${JSON.stringify({ at: new Date().toISOString(), ...entry })}\n`);
}

export async function spendSoFar(): Promise<number> {
  if (!existsSync(SPEND)) return 0;
  return (await readFile(SPEND, 'utf8')).split('\n').filter(Boolean).reduce((a, l) => a + (JSON.parse(l).cost ?? 0), 0);
}

export const dataUrl = (bytes: Buffer, mime = 'image/jpeg') => `data:${mime};base64,${bytes.toString('base64')}`;

type Part = { type: 'text'; text: string } | { type: 'image_url'; image_url: { url: string } };
export interface ChatResult { text: string; images: Buffer[]; cost: number; raw: unknown }

async function post(path: string, body: unknown, timeoutMs = 240_000): Promise<{ status: number; json: any }> {
  const e = await env();
  const res = await fetch(`${e.OPENROUTER_BASE_URL ?? 'https://openrouter.ai/api/v1'}${path}`, {
    method: 'POST',
    headers: { authorization: `Bearer ${e.OPENROUTER_API_KEY}`, 'content-type': 'application/json', 'x-title': 'JSTAR cards' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs)
  });
  const text = await res.text();
  let json: any;
  try { json = JSON.parse(text); } catch { json = { error: { message: text.slice(0, 300) } }; }
  const msg: string = json?.error?.message ?? '';
  if (res.status === 402 || /insufficient|credit|key limit|limit exceeded/i.test(msg)) throw new OutOfCredit(`${res.status} ${msg.slice(0, 200)}`);
  return { status: res.status, json };
}

export async function chat(opts: { model: string; parts: Part[]; purpose: string; id?: string; imageOut?: { aspect?: string; size?: string }; json?: boolean; maxTokens?: number; temperature?: number }): Promise<ChatResult> {
  const body: Record<string, unknown> = {
    model: opts.model,
    messages: [{ role: 'user', content: opts.parts }],
    usage: { include: true },
    ...(opts.temperature !== undefined ? { temperature: opts.temperature } : {}),
    ...(opts.maxTokens ? { max_tokens: opts.maxTokens } : {}),
    ...(opts.json ? { response_format: { type: 'json_object' } } : {}),
    ...(opts.imageOut ? { modalities: ['image', 'text'], image_config: { ...(opts.imageOut.aspect ? { aspect_ratio: opts.imageOut.aspect } : {}), ...(opts.imageOut.size ? { image_size: opts.imageOut.size } : {}) } } : {})
  };
  const { status, json } = await post('/chat/completions', body);
  const cost = Number(json?.usage?.cost ?? 0);
  if (cost) await logSpend({ model: opts.model, purpose: opts.purpose, cost, id: opts.id });
  if (status >= 400 || json.error) throw new Error(`${opts.model}: ${status} ${String(json?.error?.message ?? '').slice(0, 300)}`);
  const msg = json.choices?.[0]?.message ?? {};
  const images: Buffer[] = (msg.images ?? []).map((im: any) => Buffer.from(String(im.image_url?.url ?? '').replace(/^data:[^,]+,/, ''), 'base64'));
  const text = typeof msg.content === 'string' ? msg.content : Array.isArray(msg.content) ? msg.content.map((c: any) => c.text ?? '').join('') : '';
  return { text, images, cost, raw: json };
}

/** OpenAI image models through OpenRouter's images endpoint (reference images as input_references). */
/**
 * `background: 'transparent'` + `format: 'png'` ask gpt-image for an alpha channel (icons, #77); `refMime` is the refs'
 * type (JPEG photos by default).
 */
export async function images(opts: {
  model: string; prompt: string; refs: Buffer[]; aspect: string; quality?: string; n?: number; purpose: string; id?: string;
  background?: 'transparent' | 'opaque'; format?: 'png' | 'webp' | 'jpeg'; refMime?: string;
}): Promise<{ images: Buffer[]; cost: number }> {
  const { status, json } = await post('/images', {
    model: opts.model, prompt: opts.prompt, aspect_ratio: opts.aspect, quality: opts.quality ?? 'high', n: opts.n ?? 1,
    ...(opts.background ? { background: opts.background } : {}), ...(opts.format ? { output_format: opts.format } : {}),
    input_references: opts.refs.map((b) => ({ type: 'image_url', image_url: { url: dataUrl(b, opts.refMime) } }))
  });
  const cost = Number(json?.usage?.cost ?? 0);
  if (cost) await logSpend({ model: opts.model, purpose: opts.purpose, cost, id: opts.id });
  if (status >= 400 || !json.data?.[0]) throw new Error(`${opts.model}: ${status} ${String(json?.error?.message ?? '').slice(0, 300)}`);
  return { images: json.data.map((d: { b64_json: string }) => Buffer.from(d.b64_json, 'base64')), cost };
}

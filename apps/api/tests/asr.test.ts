import { beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { VOICE_INPUT } from '@jstar/shared';
import { signJwt } from '../src/lib/crypto';
import { createMemoryRepos } from '../src/db/memory';
import { SEED_CARDS } from '../src/db/seed';
import type { Repos } from '../src/db/types';
import { newUserRow } from '../src/lib/account';
import { env } from '../src/env';
import { buildApp } from '../src/app';
import { AsrError, relayTranscriber, type Transcribe } from '../src/lib/asr';

/** Voice input (#72): the server fallback for browsers without speech recognition. The audio is never kept. */
let repos: Repos;
let app: FastifyInstance;
let calls: { bytes: number; mime: string; lang: string | undefined }[];
let answer: () => Promise<{ text: string; lang: string | null }>;

const fake: Transcribe = async (audio, mime, lang) => { calls.push({ bytes: audio.length, mime, lang }); return answer(); };

async function member() {
  const user = await repos.users.create(newUserRow({ email: `${Math.random()}@example.com`, lineSub: null, nickname: 'u', via: 'email', lang: 'ja' }));
  return { authorization: `Bearer ${signJwt({ sub: user.id }, env.JWT_SECRET, 3600)}` };
}
const post = (headers: Record<string, string>, body: Buffer | string, url = '/v1/asr?lang=ja') => app.inject({ method: 'POST', url, headers, payload: body });

describe('POST /v1/asr', () => {
  beforeEach(async () => {
    repos = createMemoryRepos({ cards: SEED_CARDS });
    calls = [];
    answer = async () => ({ text: 'ただいま', lang: 'ja' });
    app = await buildApp({ repos, logger: false, demo: true, transcribe: fake, push: { vapid: null } });
  });

  it('turns a member\'s recording into text and says so in /v1/config', async () => {
    expect((await app.inject({ method: 'GET', url: '/v1/config' })).json().asr).toBe(true);
    const res = await post({ ...(await member()), 'content-type': 'audio/webm;codecs=opus' }, Buffer.alloc(2048, 1));
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ text: 'ただいま', lang: 'ja' });
    expect(calls).toEqual([{ bytes: 2048, mime: 'audio/webm', lang: 'ja' }]);
  });

  it('takes iOS AAC in MP4 and an unspecified language', async () => {
    const res = await post({ ...(await member()), 'content-type': 'audio/mp4' }, Buffer.alloc(64, 1), '/v1/asr');
    expect(res.statusCode).toBe(200);
    expect(calls[0]).toEqual({ bytes: 64, mime: 'audio/mp4', lang: undefined });
  });

  it('refuses visitors, other bodies, empty and oversized recordings, and unknown languages', async () => {
    const h = await member();
    expect((await post({ 'content-type': 'audio/webm' }, Buffer.alloc(10, 1))).statusCode).toBe(401);
    const json = await post({ ...h, 'content-type': 'application/json' }, '{}');
    expect(json.statusCode).toBe(415);
    expect(json.json().error).toBe('unsupported_audio');
    expect((await post({ ...h, 'content-type': 'audio/flac' }, Buffer.alloc(10, 1))).json().error).toBe('unsupported_audio');
    expect((await post({ ...h, 'content-type': 'audio/webm' }, Buffer.alloc(0))).statusCode).toBe(400);
    const big = await post({ ...h, 'content-type': 'audio/webm' }, Buffer.alloc(VOICE_INPUT.maxBytes + 1, 1));
    expect(big.statusCode).toBe(413);
    expect(big.json().error).toBe('audio_too_large');
    expect((await post({ ...h, 'content-type': 'audio/webm' }, Buffer.alloc(10, 1), '/v1/asr?lang=fr')).statusCode).toBe(400);
    expect(calls).toHaveLength(0);
    // Other routes keep the small JSON body limit.
    expect((await app.inject({ method: 'POST', url: '/v1/chat/send', headers: { ...h, 'content-type': 'application/json' }, payload: JSON.stringify({ star: 'mahiro', text: 'x'.repeat(70 * 1024) }) })).statusCode).toBe(413);
  });

  it('answers a stable code when the recogniser fails, and 503 when it is off', async () => {
    answer = async () => { throw new AsrError('asr_failed'); };
    const failed = await post({ ...(await member()), 'content-type': 'audio/ogg' }, Buffer.alloc(10, 1));
    expect(failed.statusCode).toBe(503);
    expect(failed.json().error).toBe('asr_failed');
    const off = await buildApp({ repos, logger: false, demo: true, transcribe: null, push: { vapid: null } });
    expect((await off.inject({ method: 'GET', url: '/v1/config' })).json().asr).toBe(false);
    const res = await off.inject({ method: 'POST', url: '/v1/asr', headers: { ...(await member()), 'content-type': 'audio/webm' }, payload: Buffer.alloc(10, 1) });
    expect(res.statusCode).toBe(503);
    expect(res.json().error).toBe('asr_unavailable');
  });
});

describe('relayTranscriber', () => {
  it('is off without a relay, and passes the audio through the Worker relay with its type and language', async () => {
    expect(relayTranscriber('')).toBeNull();
    const seen: { url: string; type: string | null; lang: string | null; bytes: number }[] = [];
    const f = (async (url: string, init: RequestInit) => {
      const h = new Headers(init.headers);
      seen.push({ url, type: h.get('content-type'), lang: h.get('x-asr-lang'), bytes: (init.body as Buffer).length });
      return Response.json({ text: '  hello  ', lang: 'en' });
    }) as unknown as typeof fetch;
    const t = relayTranscriber('http://asr.internal', f)!;
    expect(await t(Buffer.alloc(5), 'audio/webm', 'en')).toEqual({ text: 'hello', lang: 'en' });
    expect(seen).toEqual([{ url: 'http://asr.internal/transcribe', type: 'audio/webm', lang: 'en', bytes: 5 }]);
  });

  it('maps a missing relay to unavailable and anything else to failed', async () => {
    const down = relayTranscriber('http://asr.internal', (async () => { throw new Error('refused'); }) as unknown as typeof fetch)!;
    await expect(down(Buffer.alloc(1), 'audio/webm', 'ja')).rejects.toMatchObject({ code: 'asr_unavailable' });
    const bad = relayTranscriber('http://asr.internal', (async () => new Response('x', { status: 502 })) as unknown as typeof fetch)!;
    await expect(bad(Buffer.alloc(1), 'audio/webm', 'ja')).rejects.toMatchObject({ code: 'asr_failed' });
  });
});

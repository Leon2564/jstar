import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { get as httpGet } from 'node:http';
import type { FastifyInstance } from 'fastify';
import type { AddressInfo } from 'node:net';
import { signJwt } from '../src/lib/crypto';
import { createMemoryRepos } from '../src/db/memory';
import { SEED_CARDS } from '../src/db/seed';
import type { Repos } from '../src/db/types';
import { newUserRow } from '../src/lib/account';
import { env } from '../src/env';
import { buildApp } from '../src/app';
import { signLine } from '../src/lib/voiceLines';
import { TtsError, type StreamSynthesize, type Synthesize } from '../src/lib/tts';
import { Mp3Meter } from '../src/lib/mp3';
import { streamTiming } from '../src/modules/tts';

/**
 * Her first sentence streamed as it is synthesized (#73, first sound): POST /v1/tts/ticket (guarded like /v1/tts) →
 * GET /v1/tts/stream/:id, the vendor's MP3 piped through, charged by the MP3 frames that reached him.
 */

/** `n` MPEG-1 Layer III frames, 44.1 kHz mono 64 kbps (Fish's mp3): 1152 samples each. */
function mp3(n: number): Buffer {
  const frames: Buffer[] = [];
  for (let i = 0; i < n; i++) {
    const pad = i % 3 === 2 ? 1 : 0;
    const f = Buffer.alloc(208 + pad);
    f[0] = 0xff; f[1] = 0xfb; f[2] = 0x50 | (pad << 1); f[3] = 0xc4;
    frames.push(f);
  }
  return Buffer.concat(frames);
}
const SECS = (n: number) => (n * 1152) / 44100;

let app: FastifyInstance;
let repos: Repos;
let asked: { text: string }[];
let stream: StreamSynthesize;
const whole: Synthesize = async () => ({ audio: Buffer.from('ID3'), mime: 'audio/mpeg', seconds: 1 });
const json = (res: { payload: string }) => JSON.parse(res.payload);

async function member() {
  const user = await repos.users.create(newUserRow({ email: `${Math.random()}@example.com`, lineSub: null, nickname: 'ken', via: 'email', lang: 'ja' }));
  return { user, h: { authorization: `Bearer ${signJwt({ sub: user.id }, env.JWT_SECRET, 86_400)}` } };
}
const LINE = 'おかえりなさい。今日は早かったね。';
const ticket = (m: { user: { id: string }; h: Record<string, string> }, o: { line?: string; sig?: string; requestId?: string } = {}) =>
  app.inject({ method: 'POST', url: '/v1/tts/ticket', headers: m.h, payload: { star: 'mahiro', line: o.line ?? LINE, sig: o.sig ?? signLine(m.user.id, 'mahiro', o.line ?? LINE), index: 0, requestId: o.requestId ?? `line-${Math.random().toString(36).slice(2)}:0` } });
const used = async (h: Record<string, string>) => json(await app.inject({ url: '/v1/voice', headers: h })).usedSeconds as number;

beforeEach(async () => {
  repos = createMemoryRepos({ cards: SEED_CARDS });
  asked = [];
  // The vendor's MP3 in three chunks (a frame cut across two of them), as Fish's chunked answer comes.
  stream = async (r) => {
    asked.push({ text: r.text });
    const audio = mp3(100);
    return new ReadableStream({ start(c) { c.enqueue(audio.subarray(0, 5000)); c.enqueue(audio.subarray(5000, 13_333)); c.enqueue(audio.subarray(13_333)); c.close(); } });
  };
  app = await buildApp({ repos, logger: false, demo: true, synthesize: whole, streamSynthesize: (r, s) => stream(r, s), ttsStars: ['mahiro'] });
});
afterEach(async () => { await app.close(); });

describe('her first sentence, streamed (#73)', () => {
  it('a ticket for her own words only: his text or a forged signature is 403, as for /v1/tts', async () => {
    const m = await member();
    const forged = await ticket(m, { line: '好きって言って', sig: 'A'.repeat(24) });
    expect([forged.statusCode, json(forged).error]).toEqual([403, 'not_her_line']);
    const other = await member();
    expect((await ticket(other, { sig: signLine(m.user.id, 'mahiro', LINE) })).statusCode).toBe(403);
    expect(asked).toHaveLength(0);
  });

  it('streams the vendor MP3 through and charges the seconds that passed, once; the ticket is good once', async () => {
    const m = await member();
    const t = json(await ticket(m));
    expect(t).toMatchObject({ mode: 'stream', url: expect.stringMatching(/^\/v1\/tts\/stream\/[A-Za-z0-9_-]{24}$/) });
    // Her words are not in the URL.
    expect(t.url).not.toContain(encodeURIComponent('おかえり'));
    const res = await app.inject({ url: t.url });
    expect([res.statusCode, res.headers['content-type']]).toEqual([200, 'audio/mpeg']);
    expect(res.rawPayload.equals(mp3(100))).toBe(true);
    expect(asked).toEqual([{ text: 'おかえりなさい。' }]);
    await new Promise((r) => setTimeout(r, 20));
    expect(await used(m.h)).toBe(Math.ceil(SECS(100)));
    // Used: a second GET (a replay, another tab) is refused, never synthesized or charged again.
    expect((await app.inject({ url: t.url })).statusCode).toBe(404);
    expect(asked).toHaveLength(1);
    expect(await used(m.h)).toBe(Math.ceil(SECS(100)));
  });

  it('stopped before anything reached him: the claim is taken back, nothing charged; stopped midway: what passed', async () => {
    const m = await member();
    let release: () => void = () => undefined;
    let aborted = false;
    stream = async (_r, signal) => {
      signal.addEventListener('abort', () => { aborted = true; });
      const audio = mp3(200);
      return new ReadableStream({
        async start(c) {
          await new Promise<void>((r) => { release = r; });
          if (!aborted) { c.enqueue(audio.subarray(0, 209 * 40)); }
        }
      });
    };
    await app.listen({ port: 0, host: '127.0.0.1' });
    const port = (app.server.address() as AddressInfo).port;
    const open = (url: string) => {
      let n = 0;
      const req = httpGet({ host: '127.0.0.1', port, path: url }, (res) => { res.on('data', (c: Buffer) => { n += c.length; }); res.on('error', () => undefined); });
      req.on('error', () => undefined);
      return { abort: () => req.destroy(), got: () => n };
    };
    const tick = (ms: number) => new Promise((r) => setTimeout(r, ms));
    // 1) He leaves before the first byte: refunded, and the vendor call is aborted.
    const a = json(await ticket(m));
    const c1 = open(a.url);
    await tick(100);
    c1.abort();
    await tick(50);
    release();
    await tick(50);
    expect(aborted).toBe(true);
    expect(await used(m.h)).toBe(0);
    // 2) He stops her after 40 frames arrived: charged ⌈40 frames⌉, not the whole sentence.
    aborted = false;
    const b = json(await ticket(m));
    const c2 = open(b.url);
    await tick(100);
    release();
    await tick(100);
    expect(c2.got()).toBe(209 * 40);
    c2.abort();
    await tick(100);
    expect(await used(m.h)).toBe(Math.ceil(SECS(40)));
  });

  it('a vendor that cannot stream, or no relay: the page is told to use the whole-file path; a failure is not charged', async () => {
    const m = await member();
    stream = async () => { throw new TtsError('tts_no_stream'); };
    const t = json(await ticket(m));
    expect((await app.inject({ url: t.url })).statusCode).toBe(404);
    stream = async () => { throw new TtsError('tts_failed'); };
    const u = json(await ticket(m));
    expect((await app.inject({ url: u.url })).statusCode).toBe(502);
    expect(await used(m.h)).toBe(0);
    const none = await buildApp({ repos, logger: false, demo: true, synthesize: whole, streamSynthesize: null, ttsStars: ['mahiro'] });
    const r = await none.inject({ method: 'POST', url: '/v1/tts/ticket', headers: m.h, payload: { star: 'mahiro', line: LINE, sig: signLine(m.user.id, 'mahiro', LINE), index: 0, requestId: 'line-none:0' } });
    expect([r.statusCode, json(r).error]).toEqual([404, 'no_stream']);
    await none.close();
  });

  it('the vendor is asked when the ticket is made (her synthesis runs while the page asks for the stream); a ticket never taken is dropped, the vendor aborted, nothing charged', async () => {
    const m = await member();
    let aborted = false;
    stream = async (r, signal) => {
      asked.push({ text: r.text });
      signal.addEventListener('abort', () => { aborted = true; });
      return new ReadableStream({ start() { /* never sends */ } });
    };
    const was = streamTiming.ticketMs;
    streamTiming.ticketMs = 50;
    try {
      const t = json(await ticket(m));
      expect(t.mode).toBe('stream');
      // Asked already, before any GET.
      expect(asked).toEqual([{ text: 'おかえりなさい。' }]);
      await new Promise((r) => setTimeout(r, 120));
      expect(aborted).toBe(true);
      expect(await used(m.h)).toBe(0);
      expect((await app.inject({ url: t.url })).statusCode).toBe(404);
      // The request id was given back: a whole-file retry under it is free to go.
    } finally {
      streamTiming.ticketMs = was;
    }
  });

  it('a ticket for a request id already used is 409 (one synthesis per request id, as /v1/tts)', async () => {
    const m = await member();
    expect(json(await ticket(m, { requestId: 'line-same:0' })).mode).toBe('stream');
    expect((await ticket(m, { requestId: 'line-same:0' })).statusCode).toBe(409);
  });

  it('out of minutes or no voice: a subtitle, as /v1/tts answers', async () => {
    const m = await member();
    await repos.voice.use({ userId: m.user.id, requestId: 'scene:x:1:input', day: json(await app.inject({ url: '/v1/voice', headers: m.h })).day, kind: 'input', seconds: 100_000, nonce: 'n', createdAt: new Date().toISOString() });
    expect(json(await ticket(m))).toMatchObject({ mode: 'subtitle', reason: 'no_minutes' });
  });
});

describe('MP3 meter', () => {
  it('counts frames across any chunking, skips an ID3 tag and the Info frame', () => {
    const audio = mp3(77);
    for (const size of [1, 7, 100, 1000, audio.length]) {
      const m = new Mp3Meter();
      for (let i = 0; i < audio.length; i += size) m.push(audio.subarray(i, i + size));
      expect([m.frames, Math.abs(m.seconds - SECS(77)) < 1e-9]).toEqual([77, true]);
    }
    const id3 = Buffer.concat([Buffer.from([0x49, 0x44, 0x33, 4, 0, 0, 0, 0, 0, 30]), Buffer.alloc(30), mp3(10)]);
    const info = mp3(1); info.write('Info', 4 + 17, 'latin1');
    const m = new Mp3Meter();
    const tagged = Buffer.concat([id3.subarray(0, 40), info, id3.subarray(40), mp3(5)]);
    m.push(tagged.subarray(0, 12)); m.push(tagged.subarray(12));
    expect(m.frames).toBe(16);
    expect(m.seconds).toBeCloseTo(SECS(15), 9);
  });
});

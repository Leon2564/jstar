import { describe, expect, it } from 'vitest';
import { forward, retriable } from '../../../infra/cloudflare/src/forward';

/** Round 9: the edge never answers a bare 500 because the API container could not be reached for a moment. */
describe('the edge call into the API container', () => {
  const at = (path: string, init: RequestInit = {}) => new Request(`https://jstarcards.ai${path}`, init);

  it('tries a demo switch once more after the container dropped it, with the same body', async () => {
    const bodies: string[] = [];
    const res = await forward(at('/v1/relationship/demo', { method: 'POST', body: '{"star":"mahiro","stage":"familiar"}' }), async (r) => {
      bodies.push(await r.text());
      if (bodies.length === 1) throw new Error('container disconnected');
      return Response.json({ ok: true });
    }, 0);
    expect(res.status).toBe(200);
    expect(bodies).toEqual(['{"star":"mahiro","stage":"familiar"}', '{"star":"mahiro","stage":"familiar"}']);
  });

  it('tries her greeting once more on a 500 from the container; twice down is a 503 with Retry-After, never a 500', async () => {
    let n = 0;
    const ok = await forward(at('/v1/chat/greeting?star=nana&lang=zh-Hant'), async () => (++n === 1 ? new Response('boom', { status: 500 }) : Response.json({ text: 'hi' })), 0);
    expect([ok.status, n]).toEqual([200, 2]);
    const down = await forward(at('/v1/chat/greeting?star=nana&lang=zh-Hant'), async () => { throw new Error('not running'); }, 0);
    expect(down.status).toBe(503);
    expect(down.headers.get('retry-after')).toBe('1');
    expect(await down.json()).toEqual({ error: 'api_unavailable' });
  });

  it('never repeats a call that adds something (a chat send, a draw): it is a 503 at once', async () => {
    let n = 0;
    const res = await forward(at('/v1/chat/stream', { method: 'POST', body: '{}' }), async () => { n++; throw new Error('gone'); }, 0);
    expect([res.status, n]).toEqual([503, 1]);
    const served = await forward(at('/v1/gacha/draw', { method: 'POST', body: '{}' }), async () => new Response('x', { status: 500 }), 0);
    expect(served.status).toBe(500); // the API's own answer, as it gave it
    expect(retriable('POST', '/v1/relationship/demo') && retriable('POST', '/v1/promises/demo') && !retriable('POST', '/v1/chat/send')).toBe(true);
  });
});

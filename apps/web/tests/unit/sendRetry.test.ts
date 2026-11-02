import { describe, expect, it } from 'vitest';
import { ApiError, readChatStream } from '../../src/services/http';
import { retryWaitMs } from '../../src/services/sendRetry';

const res429 = (body: object, after?: string) =>
  new Response(JSON.stringify(body), { status: 429, headers: { 'content-type': 'application/json', ...(after ? { 'retry-after': after } : {}) } });
const thrown = (p: Promise<unknown>) => p.then(() => { throw new Error('resolved'); }, (e: unknown) => e as ApiError);

describe('a rate-limited send (N-58)', () => {
  it('reads the limiter\'s 429 as rate_limited with its Retry-After; our own 429 codes stay', async () => {
    const e = await thrown(readChatStream(res429({ statusCode: 429, error: 'Too Many Requests', message: 'Rate limit exceeded' }, '2'), () => {}));
    expect([e.code, e.status, e.retryAfterMs]).toEqual(['rate_limited', 429, 2000]);
    // As the local API really answers it (the error handler passes the limiter's message through).
    const real = await thrown(readChatStream(res429({ error: 'Rate limit exceeded, retry in 1 minute' }, '21'), () => {}));
    expect([real.code, real.retryAfterMs]).toEqual(['rate_limited', 21_000]);
    const own = await thrown(readChatStream(res429({ error: 'export_limit' }), () => {}));
    expect([own.code, own.retryAfterMs]).toEqual(['export_limit', undefined]);
  });

  it('is tried once more after its Retry-After, never waiting over 3 s; other errors keep their rule', () => {
    expect(retryWaitMs(new ApiError('rate_limited', 429, 2000))).toBe(2000);
    expect(retryWaitMs(new ApiError('rate_limited', 429, 60_000))).toBe(3000);
    expect(retryWaitMs(new ApiError('rate_limited', 429))).toBe(1200);
    expect(retryWaitMs(new ApiError('export_limit', 429))).toBeNull();
    expect(retryWaitMs(new ApiError('network', 0))).toBe(1200);
    expect(retryWaitMs(new ApiError('daily_limit', 402))).toBeNull();
  });
});

import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError, http } from '../../src/services/http';
import * as api from '../../src/services/api';

vi.mock('../../src/services/http', async (importOriginal) => ({ ...(await importOriginal<typeof import('../../src/services/http')>()), serverMode: () => true }));
afterEach(() => { vi.restoreAllMocks(); localStorage.clear(); });

const OK = { talents: [{ star: 'mahiro', stage: 'familiar' }] } as never;

/** Round 13: a 429 from /v1/relationship dropped her status panel's stage row, and it was never asked again. */
describe('her relationships, read again after a rate limit', () => {
  it('retries a 429 after its Retry-After (at most 5 s), then a 5xx with backoff, and keeps the last read', async () => {
    const waits: number[] = [];
    const read = vi.spyOn(http, 'relationship')
      .mockRejectedValueOnce(new ApiError('rate_limited', 429, 2000))
      .mockRejectedValueOnce(new ApiError('rate_limited', 429, 60_000))
      .mockRejectedValueOnce(new ApiError('http_503', 503))
      .mockResolvedValueOnce(OK);
    expect(await api.relationships({ wait: async (ms) => { waits.push(ms); } })).toBe(OK);
    expect(read).toHaveBeenCalledTimes(4);
    expect(waits).toEqual([2000, 5000, 3200]);
    expect(api.lastRelationships()).toEqual(OK);
  });

  it('gives up after its tries (the panel keeps what it shows), and never retries a 4xx', async () => {
    vi.spyOn(http, 'relationship').mockRejectedValue(new ApiError('rate_limited', 429));
    expect(await api.relationships({ tries: 2, wait: async () => undefined })).toBeNull();
    const four = vi.spyOn(http, 'relationship').mockRejectedValue(new ApiError('unauthorized', 401));
    expect(await api.relationships({ wait: async () => undefined })).toBeNull();
    expect(four).toHaveBeenCalledTimes(1);
  });
});

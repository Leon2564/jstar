import { ApiError, errorCode } from './api';

/** Tried once more by themselves before he is told (N-58): her service busy, a timeout, a dropped connection. */
const RETRIED = new Set(['agent_unavailable', 'model_unavailable', 'network', 'http_503', 'http_504', 'timeout', 'upstream_timeout']);
const RETRY_AFTER_MS = 1_200;
/** A 429 is tried once more too, after its Retry-After — never longer than this (N-58). */
const RETRY_429_MAX_MS = 3_000;
/** How long to wait before trying a failed send once more, or null when it is not tried again. */
export const retryWaitMs = (e: unknown): number | null =>
  e instanceof ApiError && e.code === 'rate_limited' ? Math.min(e.retryAfterMs ?? RETRY_AFTER_MS, RETRY_429_MAX_MS)
    : RETRIED.has(errorCode(e)) ? RETRY_AFTER_MS : null;

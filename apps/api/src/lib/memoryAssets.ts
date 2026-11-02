import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { MEMORY_RULES } from '@jstar/shared/memories';
import type { MemoryFileLinkT, MemoryFileQueryT } from '@jstar/shared';
import type { Repos } from '../db/types';

/**
 * His memories as files (#51, docs/compliance-jp.md §7.6): the recording of his yes (#55) now, a scene's still later.
 *
 * Where they live: the memory store, a private R2 bucket (`MEMORY`) the API container reaches only through the
 * Worker's `memory.internal` relay (infra/cloudflare/src/memory.ts). Every key starts with `<userId>/`, so leaving
 * erases one prefix. Without a bucket bound (local dev, tests, or before the bucket exists) there is no store and a
 * recording stays base64 in its D1 row, as #55 kept it; once a store is there it takes those over on the next read
 * of each and a few on every tick, so nothing is lost and nothing has to move by hand.
 */
export interface StoredFile { type: string; bytes: Buffer }
export interface MemoryStore {
  put(key: string, type: string, bytes: Buffer): Promise<void>;
  /** Null when there is no such file. */
  get(key: string): Promise<StoredFile | null>;
  /** Deleting a file that is not there is not an error. */
  delete(key: string): Promise<void>;
  /** Deletes a batch of files under `<userId>/`; `more` = there may be more, call again. */
  purge(userId: string): Promise<{ deleted: number; more: boolean }>;
}

/** The store could not be reached or refused: the request fails whole (503) rather than half-keeping a file. */
export class MemoryStoreError extends Error {
  statusCode = 503;
  constructor(detail: string) { super('memory_store_unavailable'); this.cause = detail; }
}

/** Every key: `<userId>/<kind>/<id>[/<part>]`, URL-safe characters only, so a key is its own path on the relay. */
export const MEMORY_KEY_RE = /^[A-Za-z0-9_-]{1,64}(\/[A-Za-z0-9_-]{1,64}){1,4}$/;
const USER_RE = /^[A-Za-z0-9_-]{1,64}$/;
/** A fresh key per upload: a lost race or a retry can delete its own file without touching anyone else's. */
export const confessionKey = (userId: string, memoryId: string) => `${userId}/confession/${memoryId}/${randomBytes(6).toString('base64url')}`;

/**
 * The Worker relay (`http://memory.internal`, answered with the R2 binding): `PUT|GET|DELETE /o/<key>` and
 * `POST /purge {userId}`, each with the internal key. Empty base = no store (the D1 fallback).
 */
export function relayMemoryStore(base: string, internalKey: string, f: typeof fetch = fetch): MemoryStore | null {
  if (!base) return null;
  const auth = { authorization: `Bearer ${internalKey}` };
  const call = async (path: string, init: RequestInit): Promise<Response> => {
    try {
      return await f(`${base}${path}`, { ...init, headers: { ...auth, ...(init.headers ?? {}) }, signal: AbortSignal.timeout(15_000) });
    } catch (e) {
      throw new MemoryStoreError((e as Error).message);
    }
  };
  const check = (key: string) => { if (!MEMORY_KEY_RE.test(key)) throw new Error(`bad memory key: ${key}`); };
  return {
    async put(key, type, bytes) {
      check(key);
      const res = await call(`/o/${key}`, { method: 'PUT', headers: { 'content-type': type }, body: bytes });
      if (!res.ok) throw new MemoryStoreError(`put ${res.status}`);
    },
    async get(key) {
      check(key);
      const res = await call(`/o/${key}`, { method: 'GET' });
      if (res.status === 404) return null;
      if (!res.ok) throw new MemoryStoreError(`get ${res.status}`);
      return { type: res.headers.get('content-type') ?? 'application/octet-stream', bytes: Buffer.from(await res.arrayBuffer()) };
    },
    async delete(key) {
      check(key);
      const res = await call(`/o/${key}`, { method: 'DELETE' });
      if (!res.ok && res.status !== 404) throw new MemoryStoreError(`delete ${res.status}`);
    },
    async purge(userId) {
      if (!USER_RE.test(userId)) throw new Error('bad user id');
      const res = await call('/purge', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ userId }) });
      const out = (await res.json().catch(() => null)) as { deleted?: unknown; more?: unknown } | null;
      if (!res.ok || !out) throw new MemoryStoreError(`purge ${res.status}`);
      return { deleted: Number(out.deleted) || 0, more: out.more === true };
    }
  };
}

// ---------------------------------------------------------------- signed links (his export)

/** Its own key, derived from the session secret: a link signature can never pass as a session or the other way round. */
const linkKey = (secret: string) => createHmac('sha256', secret).update('jstar memory file links v1').digest();
const signature = (secret: string, q: Pick<MemoryFileQueryT, 'u' | 'kind' | 'id' | 'exp'>) =>
  createHmac('sha256', linkKey(secret)).update(`${q.u}\n${q.kind}\n${q.id}\n${q.exp}`).digest('base64url');

/** A link to one of his files that works without a session until `now + MEMORY_RULES.linkTtlMs`. */
export function fileLink(secret: string, origin: string, ref: Pick<MemoryFileQueryT, 'u' | 'kind' | 'id'>, type: string, now = Date.now()): MemoryFileLinkT {
  const exp = Math.floor((now + MEMORY_RULES.linkTtlMs) / 1000);
  const sig = signature(secret, { ...ref, exp });
  const qs = new URLSearchParams({ u: ref.u, kind: ref.kind, id: ref.id, exp: String(exp), sig });
  return { type, url: `${origin}/v1/memories/file?${qs}`, expiresAt: new Date(exp * 1000).toISOString() };
}

/** The link is the one we signed, for this file, and has not expired. */
export function linkValid(secret: string, q: MemoryFileQueryT, now = Date.now()): boolean {
  if (q.exp * 1000 <= now) return false;
  const want = Buffer.from(signature(secret, q));
  const got = Buffer.from(q.sig);
  return want.length === got.length && timingSafeEqual(want, got);
}

// ---------------------------------------------------------------- the recording of his yes

interface Deps { repos: Repos; store: MemoryStore | null; log: { warn(obj: object, msg?: string): void } }

/**
 * The recording of his yes wherever it lives (the store, or base64 in its row), behind one set of calls: the
 * confession routes, his export and the tick use nothing else.
 */
export function memoryFiles({ repos, store, log }: Deps) {
  const need = (): MemoryStore => {
    if (!store) throw new MemoryStoreError('no store bound');
    return store;
  };
  /** A file written for a change that then did not happen must not stay behind. */
  const discard = (key: string) => need().delete(key).catch((e) => log.warn({ err: (e as Error).message }, 'memory_file_orphaned'));

  /** Keeps it with the time he consented; false when a recording is already kept. */
  async function keepConfessionAudio(userId: string, memoryId: string, type: string, bytes: Buffer, at: string): Promise<boolean> {
    if (!store) return repos.confessions.setAudio(userId, memoryId, type, bytes.toString('base64'), at);
    const key = confessionKey(userId, memoryId);
    await store.put(key, type, bytes);
    if (await repos.confessions.setAudioKey(userId, memoryId, type, key, at)) return true;
    await discard(key);
    return false;
  }

  /** Moves a recording still base64 in its row into the store. True when this call moved it. */
  async function moveConfessionAudio(userId: string, memoryId: string): Promise<boolean> {
    if (!store) return false;
    const legacy = await repos.confessions.audio(userId, memoryId);
    if (!legacy) return false;
    const key = confessionKey(userId, memoryId);
    await store.put(key, legacy.audioType, Buffer.from(legacy.audio, 'base64'));
    if (await repos.confessions.moveAudio(userId, memoryId, key)) return true;
    // Deleted or moved by another request meanwhile: this copy is not his recording's home.
    await discard(key);
    return false;
  }

  /** The recording, to him alone (the caller checked who asks). A row still holding it hands it to the store on the way. */
  async function confessionAudio(userId: string, memoryId: string): Promise<StoredFile | null> {
    const v = await repos.confessions.voice(userId, memoryId);
    if (!v?.audioType) return null;
    if (v.audioKey) {
      const f = await need().get(v.audioKey);
      return f ? { type: v.audioType, bytes: f.bytes } : null;
    }
    const legacy = await repos.confessions.audio(userId, memoryId);
    if (!legacy) return null;
    if (store) await moveConfessionAudio(userId, memoryId).catch((e) => log.warn({ err: (e as Error).message }, 'memory_move_failed'));
    return { type: legacy.audioType, bytes: Buffer.from(legacy.audio, 'base64') };
  }

  /**
   * Deletes the recording, his words stay. The file goes before the row forgets its key, so a failure leaves it
   * findable for the next try; a row that changed meanwhile (moved into the store) is read again.
   */
  async function forgetConfessionAudio(userId: string, memoryId: string): Promise<boolean> {
    for (let tries = 0; tries < 3; tries++) {
      const v = await repos.confessions.voice(userId, memoryId);
      if (!v?.audioType) return false;
      if (v.audioKey) await need().delete(v.audioKey);
      if (await repos.confessions.clearAudio(userId, memoryId, v.audioKey ?? null)) return true;
    }
    return false;
  }

  /** After he left: everything under `<userId>/`. True once nothing is left (always, without a store). */
  async function purge(userId: string, rounds = 10): Promise<boolean> {
    if (!store) return true;
    for (let i = 0; i < rounds; i++) if (!(await store.purge(userId)).more) return true;
    return false;
  }

  return { keepConfessionAudio, moveConfessionAudio, confessionAudio, forgetConfessionAudio, purge, stored: !!store };
}
export type MemoryFiles = ReturnType<typeof memoryFiles>;

/**
 * Right after an account deletion (users.anonymise queued it): erase his files now, and let the tick retry what is
 * left. Never fails the deletion itself: the D1 rows are already gone, the queue keeps the rest.
 */
export async function purgeAfterDeletion(files: MemoryFiles, repos: Repos, userId: string, log: Deps['log']): Promise<void> {
  try {
    if (await files.purge(userId)) await repos.memoryAssets.purgeDone(userId);
    else await repos.memoryAssets.purgeTried(userId, new Date().toISOString());
  } catch (e) {
    log.warn({ err: (e as Error).message }, 'memory_purge_deferred');
    await repos.memoryAssets.purgeTried(userId, new Date().toISOString()).catch(() => undefined);
  }
}

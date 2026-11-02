import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { MemoryExport, jstDay } from '@jstar/shared';
import { MEMORY_RULES } from '@jstar/shared/memories';
import { signJwt } from '../src/lib/crypto';
import { createMemoryRepos } from '../src/db/memory';
import { createSqlRepos } from '../src/db/sql';
import { SEED_CARDS } from '../src/db/seed';
import type { Repos } from '../src/db/types';
import { newUserRow } from '../src/lib/account';
import { env } from '../src/env';
import { buildApp } from '../src/app';
import { JOBS } from '../src/jobs';
import { memoryAssetsJob } from '../src/jobs/memoryAssets';
import { keepPromise, newPromise } from '../src/lib/promises';
import { relayMemoryStore, type MemoryStore } from '../src/lib/memoryAssets';
import { runTick } from '../src/lib/tick';
import { memoryRelay, type MemoryBucket } from '../../../infra/cloudflare/src/memory';
import { createSqliteClient } from './sqlite';

/**
 * #51: his memory files and his export, on both stores (memory, SQLite), each with and without the memory store.
 * "r2" runs the API's relay client against the Worker's own relay handler (infra/cloudflare/src/memory.ts) over a
 * fake bucket, so the whole path the container takes on Cloudflare is exercised; "d1" is no bucket bound (the base64
 * fallback #55 started with).
 */
const KEY = 'internal-key';

/** An R2 bucket in a Map: what the relay needs of R2Bucket, with `fail` to make it unreachable. */
function fakeBucket() {
  const files = new Map<string, { bytes: Uint8Array; type: string }>();
  const state = { fail: false };
  const guard = () => { if (state.fail) throw new Error('r2 down'); };
  const bucket: MemoryBucket = {
    async put(key, value, opts) { guard(); files.set(key, { bytes: new Uint8Array(value), type: opts?.httpMetadata?.contentType ?? '' }); return {}; },
    async get(key) {
      guard();
      const f = files.get(key);
      return f ? { body: new Response(f.bytes).body!, httpMetadata: { contentType: f.type }, size: f.bytes.length } : null;
    },
    async delete(keys) { guard(); for (const k of Array.isArray(keys) ? keys : [keys]) files.delete(k); },
    async list({ prefix, limit = 1000 }) {
      guard();
      const all = [...files.keys()].filter((k) => k.startsWith(prefix)).sort();
      return { objects: all.slice(0, limit).map((key) => ({ key })), truncated: all.length > limit };
    }
  };
  return { bucket, files, state, under: (userId: string) => [...files.keys()].filter((k) => k.startsWith(`${userId}/`)) };
}
type Bucket = ReturnType<typeof fakeBucket>;
/** The container's fetch to memory.internal, answered by the Worker's handler. A bucket that throws is a 500, as on Cloudflare. */
const relayFetch = (b: Bucket, key = KEY) => (async (url: string | URL, init?: RequestInit) => {
  try { return await memoryRelay(new Request(url, init), b.bucket, key); } catch { return new Response('error', { status: 500 }); }
}) as typeof fetch;

const BACKENDS: [string, () => Repos][] = [
  ['memory', () => createMemoryRepos({ cards: SEED_CARDS })],
  ['sql', () => createSqlRepos(createSqliteClient())]
];
const STORES = ['d1', 'r2'] as const;
const silent = { info() {}, error() {} };
const DAY = 86_400_000;
/** 2026-11-02 12:00 JST. */
const NOON = Date.UTC(2026, 10, 2, 3, 0);

const json = (res: { payload: string }) => JSON.parse(res.payload);

describe.each(BACKENDS)('his memory files and export (%s store)', (_name, makeRepos) => {
  describe.each(STORES)('%s', (storeKind) => {
    let app: FastifyInstance;
    let repos: Repos;
    let bucket: Bucket;
    let store: MemoryStore | null;

    beforeEach(async () => {
      vi.useFakeTimers({ toFake: ['Date'] });
      vi.setSystemTime(NOON);
      repos = makeRepos();
      bucket = fakeBucket();
      store = storeKind === 'r2' ? relayMemoryStore('http://memory.internal', KEY, relayFetch(bucket)) : null;
      app = await buildApp({ repos, logger: false, demo: true, memoryStore: store });
    });
    afterEach(() => { vi.useRealTimers(); });

    async function member() {
      const user = await repos.users.create({ ...newUserRow({ email: `${Math.random()}@example.com`, lineSub: null, nickname: 'kenta', via: 'email', lang: 'ja' }) });
      return { user, h: { authorization: `Bearer ${signJwt({ sub: user.id }, env.JWT_SECRET, 60 * 86_400)}` } };
    }
    /** His yes to her confession (#55): the memory card and his words, as the scene writes them. */
    async function confessed(userId: string, memoryId = `mem_c${Math.random().toString(36).slice(2, 8)}`) {
      const at = new Date().toISOString();
      await repos.memories.add({ id: memoryId, userId, star: 'mahiro', title: 'あなたの答え', createdAt: at, kind: 'confession', sceneId: 'confession-mahiro' });
      await repos.confessions.addVoice({ memoryId, userId, star: 'mahiro', transcript: 'ずっと一緒にいたい', audioType: null, consentedAt: null, createdAt: at });
      return memoryId;
    }
    const clip = Buffer.from('fake-opus-bytes-of-his-yes');
    const keep = (h: Record<string, string>, id: string, body: Buffer = clip) =>
      app.inject({ method: 'PUT', url: `/v1/confession/memories/${id}/audio?consent=yes`, headers: { ...h, 'content-type': 'audio/webm' }, payload: body });
    const play = (h: Record<string, string>, id: string) => app.inject({ url: `/v1/confession/memories/${id}/audio`, headers: h });
    const exportOf = (h: Record<string, string>) => app.inject({ url: '/v1/me/export', headers: h });
    const fetchLink = (url: string) => { const u = new URL(url); return app.inject({ url: `${u.pathname}${u.search}` }); };

    it('keeps the recording of his yes in the memory store (or its D1 row without one), plays it, deletes it', async () => {
      const { user, h } = await member();
      const id = await confessed(user.id);
      const saved = await keep(h, id);
      expect(saved.statusCode, saved.payload).toBe(200);
      expect(json(saved).memory).toMatchObject({ memoryId: id, audio: true });
      expect((await keep(h, id)).statusCode).toBe(409);

      const row = await repos.confessions.voice(user.id, id);
      if (storeKind === 'r2') {
        expect(row?.audioKey).toMatch(new RegExp(`^${user.id}/confession/${id}/`));
        expect(bucket.under(user.id)).toEqual([row!.audioKey]);
        expect(await repos.confessions.audio(user.id, id)).toBeNull();
      } else {
        expect(row?.audioKey).toBeNull();
        expect(await repos.confessions.audio(user.id, id)).toEqual({ audioType: 'audio/webm', audio: clip.toString('base64') });
      }

      const heard = await play(h, id);
      expect(heard.statusCode).toBe(200);
      expect(heard.headers['cache-control']).toBe('private, no-store');
      expect(heard.rawPayload.equals(clip)).toBe(true);

      const del = await app.inject({ method: 'DELETE', url: `/v1/confession/memories/${id}/audio`, headers: h });
      expect(json(del).memory).toMatchObject({ audio: false, transcript: 'ずっと一緒にいたい' });
      expect(bucket.files.size).toBe(0);
      expect((await play(h, id)).statusCode).toBe(404);
      expect((await keep(h, id)).statusCode).toBe(200);
    });

    it('a store that cannot be reached fails the request whole: nothing half-kept', async () => {
      if (storeKind === 'd1') return;
      const { user, h } = await member();
      const id = await confessed(user.id);
      bucket.state.fail = true;
      expect((await keep(h, id)).statusCode).toBe(503);
      expect(await repos.confessions.voice(user.id, id)).toMatchObject({ audioType: null, audioKey: null });
      bucket.state.fail = false;
      expect((await keep(h, id)).statusCode).toBe(200);
      bucket.state.fail = true;
      // Deleting while the store is down deletes nothing: the row still knows where the file is, for the next try.
      expect((await app.inject({ method: 'DELETE', url: `/v1/confession/memories/${id}/audio`, headers: h })).statusCode).toBe(503);
      expect((await repos.confessions.voice(user.id, id))?.audioKey).toBeTruthy();
    });

    it('recordings kept base64 before the store (#55) move into it on the next read, and a few on every tick', async () => {
      const { user, h } = await member();
      const a = await confessed(user.id);
      const b = await confessed(user.id);
      // As #55 kept them: base64 in the row.
      expect(await repos.confessions.setAudio(user.id, a, 'audio/mp4', clip.toString('base64'), new Date().toISOString())).toBe(true);
      expect(await repos.confessions.setAudio(user.id, b, 'audio/webm', clip.toString('base64'), new Date().toISOString())).toBe(true);

      const heard = await play(h, a);
      expect(heard.statusCode).toBe(200);
      expect(heard.headers['content-type']).toMatch(/^audio\/mp4/);
      expect(heard.rawPayload.equals(clip)).toBe(true);
      const tick = await runTick(repos, JOBS, { log: silent, demo: true, memoryStore: store ?? undefined });
      const job = tick.jobs.find((j) => j.name === 'memories.assets');
      expect(job?.status).toBe('ok');
      if (storeKind === 'r2') {
        // `a` moved when it was played, `b` on the tick.
        expect(job?.result).toMatchObject({ moved: 1, store: true });
        for (const id of [a, b]) {
          expect(await repos.confessions.audio(user.id, id)).toBeNull();
          expect((await repos.confessions.voice(user.id, id))?.audioKey).toMatch(new RegExp(`^${user.id}/confession/${id}/`));
        }
        expect(bucket.under(user.id)).toHaveLength(2);
      } else {
        expect(job?.result).toMatchObject({ moved: 0, store: false });
        expect(await repos.confessions.audio(user.id, b)).not.toBeNull();
      }
      // Wherever it is now, he hears the same recording.
      expect((await play(h, b)).rawPayload.equals(clip)).toBe(true);
    });

    it('exports everything he has — the same memory cards the page shows, his yes with a signed link, promises, chats — once a day', async () => {
      const { user, h } = await member();
      const other = await member();
      await repos.memories.add({ id: 'mem_chat1', userId: user.id, star: 'nana', title: '雨の日の話', createdAt: new Date().toISOString() });
      const id = await confessed(user.id);
      expect((await keep(h, id)).statusCode).toBe(200);
      const promise = newPromise({ userId: user.id, star: 'nana', text: '明日の朝に起こしてね', dueAt: new Date(Date.now() + 60_000).toISOString(), kind: 'wakeup', source: 'chat', lang: 'ja' }, Date.now());
      expect(await repos.promises.create(promise)).toBe(true);
      expect(await keepPromise(repos, promise, Date.now())).not.toBeNull();
      await repos.messages.add({ id: 'msg1', ownerId: user.id, star: 'nana', role: 'user', text: 'おはよう', createdAt: new Date().toISOString() });
      await repos.messages.add({ id: 'msg2', ownerId: user.id, star: 'nana', role: 'assistant', text: 'おはよう、今日もいい天気', createdAt: new Date().toISOString() });
      await repos.memories.add({ id: 'mem_other', userId: other.user.id, star: 'nana', title: '他人の思い出', createdAt: new Date().toISOString() });

      expect((await exportOf({})).statusCode).toBe(401);
      const res = await exportOf(h);
      expect(res.statusCode, res.payload).toBe(200);
      expect(res.headers['content-disposition']).toBe(`attachment; filename="jstar-memories-${jstDay()}.json"`);
      expect(res.headers['cache-control']).toBe('private, no-store');
      const out = MemoryExport.parse(json(res));
      const page = json(await app.inject({ url: '/v1/auth/me', headers: h })).memories as { id: string }[];
      expect(out.memories.map((m) => m.id).sort()).toEqual(page.map((m) => m.id).sort());
      expect(out.memories.map((m) => m.kind).sort()).toEqual(['chat', 'confession', 'promise']);
      expect(out.memories.find((m) => m.kind === 'confession')).toMatchObject({ id, sceneId: 'confession-mahiro' });
      expect(out.account).toMatchObject({ id: user.id, nickname: 'kenta', email: user.email });
      expect(out.promises).toEqual([expect.objectContaining({ id: promise.id, status: 'kept', text: '明日の朝に起こしてね', keptAt: expect.any(String) })]);
      expect(out.chats).toEqual([{ star: 'nana', messages: [expect.objectContaining({ role: 'user', text: 'おはよう' }), expect.objectContaining({ role: 'assistant' })] }]);
      const [c] = out.confessions;
      expect(c).toMatchObject({ memoryId: id, transcript: 'ずっと一緒にいたい', keptAt: expect.any(String), audio: { type: 'audio/webm' } });
      expect(Date.parse(c.audio!.expiresAt!)).toBe(Math.floor((NOON + MEMORY_RULES.linkTtlMs) / 1000) * 1000);

      // The link works without a session, as a download; altered, it is nothing.
      const file = await fetchLink(c.audio!.url);
      expect(file.statusCode).toBe(200);
      expect(file.rawPayload.equals(clip)).toBe(true);
      expect(file.headers['content-disposition']).toBe(`attachment; filename="confession-${id}.webm"`);
      expect(file.headers['cache-control']).toBe('private, no-store');
      expect((await fetchLink(c.audio!.url.replace(/sig=[^&]+/, 'sig=AAAA'))).statusCode).toBe(404);
      expect((await fetchLink(c.audio!.url.replace(`u=${user.id}`, `u=${other.user.id}`))).statusCode).toBe(404);
      expect((await fetchLink(c.audio!.url.replace(/exp=\d+/, (m) => `exp=${Number(m.slice(4)) + 3600}`))).statusCode).toBe(404);

      // Once a JST day.
      const again = await exportOf(h);
      expect(again.statusCode).toBe(429);
      expect(json(again).error).toBe('export_limit');
      expect((await exportOf(other.h)).statusCode).toBe(200);
      vi.setSystemTime(NOON + DAY);
      // The link has run out; tomorrow's export brings a fresh one.
      expect((await fetchLink(c.audio!.url)).statusCode).toBe(404);
      const tomorrow = await exportOf(h);
      expect(tomorrow.statusCode).toBe(200);
      expect((await fetchLink(MemoryExport.parse(json(tomorrow)).confessions[0].audio!.url)).statusCode).toBe(200);
    });

    it('a recording he deleted is gone from his export and from the links he already had', async () => {
      const { user, h } = await member();
      const id = await confessed(user.id);
      await keep(h, id);
      const link = MemoryExport.parse(json(await exportOf(h))).confessions[0].audio!.url;
      await app.inject({ method: 'DELETE', url: `/v1/confession/memories/${id}/audio`, headers: h });
      expect((await fetchLink(link)).statusCode).toBe(404);
      vi.setSystemTime(NOON + DAY);
      expect(MemoryExport.parse(json(await exportOf(h))).confessions[0]).toMatchObject({ memoryId: id, audio: null, keptAt: null });
    });

    it('leaving erases every file of his; what the store could not take at once, the tick finishes', async () => {
      const a = await member();
      const b = await member();
      const ida = await confessed(a.user.id);
      const idb = await confessed(b.user.id);
      await keep(a.h, ida);
      await keep(b.h, idb);
      const link = MemoryExport.parse(json(await exportOf(a.h))).confessions[0].audio!.url;
      const gone = await app.inject({ method: 'DELETE', url: '/v1/auth/me', headers: a.h, payload: { confirm: 'DELETE' } });
      expect(gone.statusCode, gone.payload).toBe(200);
      expect(bucket.under(a.user.id)).toEqual([]);
      expect(await repos.confessions.voices(a.user.id)).toEqual([]);
      expect(await repos.memoryAssets.purgesPending(10)).toEqual([]);
      expect((await fetchLink(link)).statusCode).toBe(404);
      // Someone else's recording is untouched.
      if (storeKind === 'r2') expect(bucket.under(b.user.id)).toHaveLength(1);
      expect((await play(b.h, idb)).statusCode).toBe(200);

      if (storeKind === 'd1') return;
      // The store is down when he leaves: the account is deleted all the same, the files wait for the tick.
      bucket.state.fail = true;
      expect((await app.inject({ method: 'DELETE', url: '/v1/auth/me', headers: b.h, payload: { confirm: 'DELETE' } })).statusCode).toBe(200);
      expect(await repos.confessions.voices(b.user.id)).toEqual([]);
      expect(await repos.memoryAssets.purgesPending(10)).toEqual([b.user.id]);
      expect(bucket.under(b.user.id)).toHaveLength(1);
      const failed = await runTick(repos, [memoryAssetsJob()], { log: silent, memoryStore: store! });
      expect(failed.jobs[0].result).toMatchObject({ purged: 0, purgeLeft: 1 });
      bucket.state.fail = false;
      vi.setSystemTime(NOON + 2 * 3_600_000);
      const done = await runTick(repos, [memoryAssetsJob()], { log: silent, memoryStore: store! });
      expect(done.jobs[0].result).toMatchObject({ purged: 1, purgeLeft: 0 });
      expect(bucket.under(b.user.id)).toEqual([]);
      expect(await repos.memoryAssets.purgesPending(10)).toEqual([]);
    });

    it('retention: nothing is deleted on a timer by default; when set, only recordings older than it go, his words stay', async () => {
      const { user, h } = await member();
      const old = await confessed(user.id);
      await keep(h, old);
      vi.setSystemTime(NOON + 20 * DAY);
      const recent = await confessed(user.id);
      await keep(h, recent);
      vi.setSystemTime(NOON + 40 * DAY);

      expect(MEMORY_RULES.retentionDays).toBeNull();
      const byDefault = await runTick(repos, JOBS, { log: silent, demo: true, memoryStore: store ?? undefined });
      expect(byDefault.jobs.find((j) => j.name === 'memories.assets')?.result).toMatchObject({ expired: 0, retentionDays: null });
      expect((await play(h, old)).statusCode).toBe(200);

      vi.setSystemTime(NOON + 42 * DAY);
      const set = await runTick(repos, [memoryAssetsJob({ retentionDays: 30 })], { log: silent, memoryStore: store ?? undefined });
      expect(set.jobs[0].result).toMatchObject({ expired: 1, retentionDays: 30 });
      expect((await play(h, old)).statusCode).toBe(404);
      expect(await repos.confessions.voice(user.id, old)).toMatchObject({ transcript: 'ずっと一緒にいたい', audioType: null, audioKey: null });
      expect((await play(h, recent)).statusCode).toBe(200);
      if (storeKind === 'r2') expect(bucket.under(user.id)).toHaveLength(1);
    });

    it('forgets export days after a week', async () => {
      const { user, h } = await member();
      await exportOf(h);
      vi.setSystemTime(NOON + 8 * DAY);
      const run = await runTick(repos, [memoryAssetsJob()], { log: silent, memoryStore: store ?? undefined });
      expect(run.jobs[0].result).toMatchObject({ pruned: 1 });
      expect(await repos.memoryAssets.claimExport(user.id, jstDay(NOON), new Date().toISOString())).toBe(true);
    });
  });

  it('memory cards keep their kind and scene (#51); a promise kept becomes a promise card', async () => {
    const repos = makeRepos();
    const user = await repos.users.create({ ...newUserRow({ email: 'k@example.com', lineSub: null, nickname: 'k', via: 'email', lang: 'ja' }) });
    await repos.memories.add({ id: 'mem_1', userId: user.id, star: 'nana', title: 'chat', createdAt: '2026-11-02T00:00:00.000Z' });
    await repos.memories.add({ id: 'mem_2', userId: user.id, star: 'nana', title: 'scene', createdAt: '2026-11-02T00:00:01.000Z', kind: 'scene', sceneId: 'nana-reading' });
    const now = Date.now();
    const p = newPromise({ userId: user.id, star: 'nana', text: 'また明日', dueAt: new Date(now).toISOString(), kind: 'scene', source: 'scene', sceneId: 'nana-reading', lang: 'ja' }, now);
    await repos.promises.create(p);
    await keepPromise(repos, p, now);
    expect((await repos.memories.forUser(user.id)).map((m) => [m.id.startsWith('mem_') ? m.kind : null, m.sceneId, m.still])).toEqual([
      ['chat', null, null], ['scene', 'nana-reading', null], ['promise', 'nana-reading', null]
    ]);
    expect((await repos.promises.forUser(user.id)).map((r) => r.status)).toEqual(['kept']);
  });
});

describe('the memory relay (Worker, memory.internal)', () => {
  const b = fakeBucket();
  const call = (path: string, init: RequestInit = {}, key: string | null = KEY) =>
    memoryRelay(new Request(`http://memory.internal${path}`, { ...init, headers: { ...(key ? { authorization: `Bearer ${key}` } : {}), ...(init.headers ?? {}) } }), b.bucket, KEY);

  it('answers only with the internal key and a bucket, and only for well-formed keys of one person', async () => {
    expect((await call('/o/usr_a/confession/mem_1/x', {}, null)).status).toBe(404);
    expect((await call('/o/usr_a/confession/mem_1/x', {}, 'wrong')).status).toBe(404);
    expect((await memoryRelay(new Request('http://memory.internal/o/usr_a/c/m'), undefined, KEY)).status).toBe(404);
    expect((await call('/o/usr_a')).status).toBe(400);
    expect((await call('/o/usr_a/c/m%20x')).status).toBe(400);
    expect((await call('/o/usr_a/c/m.webm')).status).toBe(400);
    expect((await call('/o/usr_a/c/m', { method: 'PUT', body: 'x', headers: { 'content-type': 'text/html' } })).status).toBe(415);
    expect((await call('/o/usr_a/c/m', { method: 'PUT', body: new Uint8Array(0), headers: { 'content-type': 'audio/webm' } })).status).toBe(413);
    expect((await call('/o/usr_a/c/m', { method: 'PUT', body: new Uint8Array(5 * 1024 * 1024 + 1), headers: { 'content-type': 'audio/webm' } })).status).toBe(413);
    expect((await call('/purge', { method: 'POST', body: JSON.stringify({ userId: 'usr_a/../' }) })).status).toBe(400);
    expect((await call('/o/usr_a/c/m', { method: 'POST' })).status).toBe(404);
  });

  it('puts, gets, deletes one file, and purges one person page by page', async () => {
    expect((await call('/o/usr_a/c/m1', { method: 'PUT', body: 'abc', headers: { 'content-type': 'audio/webm; codecs=opus' } })).status).toBe(200);
    const got = await call('/o/usr_a/c/m1');
    expect(got.headers.get('content-type')).toBe('audio/webm');
    expect(await got.text()).toBe('abc');
    expect((await call('/o/usr_a/c/nope')).status).toBe(404);
    expect((await call('/o/usr_a/c/m1', { method: 'DELETE' })).status).toBe(200);
    expect((await call('/o/usr_a/c/m1')).status).toBe(404);

    for (let i = 0; i < 501; i++) await b.bucket.put(`usr_a/c/m${i}`, new ArrayBuffer(1));
    await b.bucket.put('usr_ab/c/m', new ArrayBuffer(1));
    expect(await (await call('/purge', { method: 'POST', body: JSON.stringify({ userId: 'usr_a' }) })).json()).toEqual({ deleted: 500, more: true });
    expect(await (await call('/purge', { method: 'POST', body: JSON.stringify({ userId: 'usr_a' }) })).json()).toEqual({ deleted: 1, more: false });
    // `usr_a/` is a folder, not a prefix of other ids.
    expect([...b.files.keys()]).toEqual(['usr_ab/c/m']);
  });
});

describe('migration 0025 tells existing memory cards apart', () => {
  it('confession, scene and promise cards get their kind; the rest stay chat', async () => {
    const state = JSON.stringify({ rewards: { memories: [{ id: 'mem_scene', title: 't', createdAt: '2026-10-01T00:00:00.000Z' }] } });
    const before = `
      INSERT INTO memories (id, user_id, star, title, created_at) VALUES
        ('mem_chat', 'usr_1', 'nana', 'chat', '2026-10-01T00:00:00.000Z'),
        ('mem_scene', 'usr_1', 'nana', 'scene', '2026-10-01T00:00:00.000Z'),
        ('mem_conf', 'usr_1', 'mahiro', 'yes', '2026-10-02T00:00:00.000Z'),
        ('mem_prom', 'usr_1', 'nana', 'promise', '2026-10-03T00:00:00.000Z');
      INSERT INTO scene_runs (id, user_id, star, scene_id, step, state, started_at, updated_at) VALUES ('run_1', 'usr_1', 'nana', 'nana-reading', 'end', '${state}', 'x', 'x');
      INSERT INTO confession_voice (memory_id, user_id, star, transcript, created_at) VALUES ('mem_conf', 'usr_1', 'mahiro', 'はい', '2026-10-02T00:00:00.000Z');
      INSERT INTO promises (id, user_id, star, text, due_at, kind, status, made_at, kept_at, source, lang) VALUES ('prm_1', 'usr_1', 'nana', 'また', 'x', 'free', 'kept', 'x', '2026-10-03T00:00:00.000Z', 'chat', 'ja');`;
    const repos = createSqlRepos(createSqliteClient({ before: { '0025_memory_assets.sql': before } }));
    expect((await repos.memories.forUser('usr_1')).map((m) => [m.id, m.kind, m.sceneId])).toEqual([
      ['mem_chat', 'chat', null], ['mem_scene', 'scene', 'nana-reading'], ['mem_conf', 'confession', null], ['mem_prom', 'promise', null]
    ]);
  });
});

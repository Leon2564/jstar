import { beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { GIFT_IDS, formatWishes } from '@jstar/shared';
import { signJwt } from '../src/lib/crypto';
import { createMemoryRepos } from '../src/db/memory';
import { createSqlRepos } from '../src/db/sql';
import { SEED_CARDS } from '../src/db/seed';
import type { PendingTurn, Repos } from '../src/db/types';
import { newUserRow } from '../src/lib/account';
import { env } from '../src/env';
import { buildApp } from '../src/app';
import { JOBS } from '../src/jobs';
import { memoryFlush } from '../src/jobs/memoryFlush';
import { PENDING_MAX, QUIET_MS, flushMemory, keepTurn, type FlushPersona } from '../src/lib/memoryFlush';
import { runTick } from '../src/lib/tick';
import type { MemoryFlushInput } from '../src/lib/agent';
import { createSqliteClient } from './sqlite';

/**
 * Batched chat memory (cost work, 2026-09-29): the turns the persona service has not taken into memory wait in
 * chat_memory.pending until an update does — on his 5th message (tests/api.test.ts), when he leaves the chat
 * (POST /v1/chat/memory/flush) or when the conversation has gone quiet (tick job `memory.flush`). Both stores.
 */
const BACKENDS: [string, () => Repos][] = [
  ['memory', () => createMemoryRepos({ cards: SEED_CARDS })],
  ['sql', () => createSqlRepos(createSqliteClient())]
];
const turn = (id: string, his: string, hers: string): PendingTurn[] => [{ id, role: 'user', text: his }, { id, role: 'assistant', text: hers }];
const log = { info: () => undefined, error: () => undefined };

/** The persona service's flush: records what it was given; `fail` makes the memory model fail. */
function persona() {
  const calls: MemoryFlushInput[] = [];
  const state = { fail: false };
  const flush: FlushPersona = async (input) => {
    calls.push(input);
    if (state.fail) return { memory: null, saved: false };
    return { memory: { facts: { ...(input.memory?.facts ?? {}), job: 'nurse' }, summary: `heard: ${input.unsaved.filter((t) => t.role === 'user').map((t) => t.text).join(' / ')}` }, saved: true };
  };
  return { flush, calls, state };
}

describe.each(BACKENDS)('batched memory (%s store)', (_name, makeRepos) => {
  let repos: Repos;
  let userId: string;
  beforeEach(async () => {
    repos = makeRepos();
    userId = (await repos.users.create(newUserRow({ email: `${Math.random()}@example.com`, lineSub: null, nickname: 'u', via: 'email', lang: 'en' }))).id;
  });

  it('keeps pending turns in order, the newest PENDING_MAX, and drops exactly the ones taken in', async () => {
    await repos.chatMemory.save(userId, 'nana', { name: 'Kenta' }, 'He is Kenta.');
    await repos.chatMemory.addPending(userId, 'nana', turn('m1', 'a', 'A'), '2026-09-29T10:00:00.000Z', PENDING_MAX);
    await repos.chatMemory.addPending(userId, 'nana', turn('m2', 'b', 'B'), '2026-09-29T10:01:00.000Z', PENDING_MAX);
    const row = await repos.chatMemory.get(userId, 'nana');
    expect(row).toMatchObject({ facts: { name: 'Kenta' }, summary: 'He is Kenta.', pendingAt: '2026-09-29T10:01:00.000Z' });
    expect(row?.pending).toEqual([...turn('m1', 'a', 'A'), ...turn('m2', 'b', 'B')]);
    // Saving memory keeps the buffer; a turn added after an update started is not dropped with the ones it took in.
    await repos.chatMemory.save(userId, 'nana', { name: 'Kenta' }, 'x');
    await repos.chatMemory.addPending(userId, 'nana', turn('m3', 'c', 'C'), '2026-09-29T10:02:00.000Z', PENDING_MAX);
    await repos.chatMemory.dropPending(userId, 'nana', ['m1', 'm2']);
    expect((await repos.chatMemory.get(userId, 'nana'))?.pending).toEqual(turn('m3', 'c', 'C'));
    await repos.chatMemory.dropPending(userId, 'nana', ['m1', 'm2']); // idempotent
    await repos.chatMemory.dropPending(userId, 'nana', ['m3']);
    expect(await repos.chatMemory.get(userId, 'nana')).toMatchObject({ pending: [], pendingAt: null });
    // A buffer that grows while memory keeps failing keeps its newest turns.
    for (let i = 0; i < 25; i++) await repos.chatMemory.addPending(userId, 'eimi', turn(`n${i}`, `h${i}`, `r${i}`), '2026-09-29T11:00:00.000Z', PENDING_MAX);
    const long = (await repos.chatMemory.get(userId, 'eimi'))!.pending;
    expect(long).toHaveLength(PENDING_MAX);
    expect(long[0]).toEqual({ id: 'n5', role: 'user', text: 'h5' });
    expect(long.at(-1)).toEqual({ id: 'n24', role: 'assistant', text: 'r24' });
  });

  it('keepTurn: a turn memory did not take in joins the buffer; one it did clears what was there', async () => {
    await keepTurn(repos, userId, 'alice', null, false, { id: 'm1', text: 'hi', reply: 'hello' });
    const before = await repos.chatMemory.get(userId, 'alice');
    expect(before?.pending).toEqual(turn('m1', 'hi', 'hello'));
    await keepTurn(repos, userId, 'alice', before, undefined, { id: 'm2', text: 'x', reply: 'y' }); // an agent that updates every turn
    expect((await repos.chatMemory.get(userId, 'alice'))?.pending).toEqual([]);
  });

  it('flushMemory folds every pending turn in, keeps them when the model fails, and is free when nothing waits', async () => {
    const p = persona();
    expect(await flushMemory(repos, p.flush, userId, 'mahiro', 'en')).toBe('empty');
    await repos.chatMemory.save(userId, 'mahiro', { name: 'Kenta', her_wishes: formatWishes([GIFT_IDS[0]]) }, null);
    await repos.chatMemory.addPending(userId, 'mahiro', [...turn('m1', 'a', 'A'), ...turn('m2', 'b', 'B')], '2026-09-29T10:00:00.000Z', PENDING_MAX);
    p.state.fail = true;
    expect(await flushMemory(repos, p.flush, userId, 'mahiro', 'en')).toBe('failed');
    expect((await repos.chatMemory.get(userId, 'mahiro'))?.pending).toHaveLength(4);
    p.state.fail = false;
    expect(await flushMemory(repos, p.flush, userId, 'mahiro', 'en')).toBe('saved');
    expect(p.calls.at(-1)).toEqual({ star: 'mahiro', lang: 'en', userId, memory: { facts: { name: 'Kenta' }, summary: null },
      unsaved: [{ role: 'user', text: 'a' }, { role: 'assistant', text: 'A' }, { role: 'user', text: 'b' }, { role: 'assistant', text: 'B' }] });
    // Her tastes (her_wishes) are the API's own fact: kept through the update.
    expect(await repos.chatMemory.get(userId, 'mahiro')).toMatchObject({ facts: { name: 'Kenta', job: 'nurse', her_wishes: formatWishes([GIFT_IDS[0]]) }, summary: 'heard: a / b', pending: [], pendingAt: null });
    expect(p.calls).toHaveLength(2);
  });

  it('the tick folds in quiet conversations only, and only with the persona service', async () => {
    const now = Date.parse('2026-09-29T12:00:00.000Z');
    const quietAt = new Date(now - QUIET_MS - 60_000).toISOString();
    const recentAt = new Date(now - 60_000).toISOString();
    await repos.chatMemory.addPending(userId, 'nana', turn('m1', 'quiet', 'Q'), quietAt, PENDING_MAX);
    await repos.chatMemory.addPending(userId, 'alice', turn('m2', 'still talking', 'S'), recentAt, PENDING_MAX);
    expect(JOBS.map((j) => j.name)).toContain('memory.flush');
    const off = await runTick(repos, [memoryFlush], { log, clock: () => now });
    expect(off.jobs[0]).toMatchObject({ status: 'ok', result: { off: true } });
    const p = persona();
    const res = await runTick(repos, [memoryFlush], { log, clock: () => now + 5 * 60_000, flushMemory: p.flush });
    expect(res.jobs[0]).toMatchObject({ status: 'ok', result: { saved: 1, failed: 0, empty: 0 } });
    expect(p.calls.map((c) => [c.star, c.lang])).toEqual([['nana', 'en']]);
    expect((await repos.chatMemory.get(userId, 'nana'))).toMatchObject({ summary: 'heard: quiet', pending: [] });
    expect((await repos.chatMemory.get(userId, 'alice'))?.pending).toHaveLength(2);
  });

  describe('POST /v1/chat/memory/flush (he left the chat)', () => {
    let app: FastifyInstance;
    let p: ReturnType<typeof persona>;
    const h = () => ({ authorization: `Bearer ${signJwt({ sub: userId }, env.JWT_SECRET, 3600)}` });
    const flush = async (star: string) => app.inject({ method: 'POST', url: '/v1/chat/memory/flush', headers: h(), payload: { star } });
    beforeEach(async () => {
      p = persona();
      app = await buildApp({ repos, logger: false, demo: true, flushMemory: p.flush });
    });

    it('folds his pending turns in, says when there was nothing, and never fails his leaving', async () => {
      expect(JSON.parse((await flush('eimi')).payload)).toEqual({ status: 'empty' });
      await repos.chatMemory.addPending(userId, 'eimi', turn('m1', 'bye', 'see you'), new Date().toISOString(), PENDING_MAX);
      p.state.fail = true;
      expect(JSON.parse((await flush('eimi')).payload)).toEqual({ status: 'failed' });
      p.state.fail = false;
      expect(JSON.parse((await flush('eimi')).payload)).toEqual({ status: 'saved' });
      expect(await repos.chatMemory.get(userId, 'eimi')).toMatchObject({ summary: 'heard: bye', pending: [] });
      expect((await app.inject({ method: 'POST', url: '/v1/chat/memory/flush', payload: { star: 'eimi' } })).statusCode).toBe(401);
      expect((await flush('nobody')).statusCode).toBe(400);
    });

    it('is off without the persona service', async () => {
      const bare = await buildApp({ repos, logger: false, demo: true });
      const res = await bare.inject({ method: 'POST', url: '/v1/chat/memory/flush', headers: h(), payload: { star: 'eimi' } });
      expect(JSON.parse(res.payload)).toEqual({ status: 'off' });
    });
  });
});

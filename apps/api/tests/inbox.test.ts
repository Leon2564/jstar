import { beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { signJwt } from '../src/lib/crypto';
import { createMemoryRepos } from '../src/db/memory';
import { createSqlRepos } from '../src/db/sql';
import { SEED_CARDS } from '../src/db/seed';
import type { InboxRow, Repos } from '../src/db/types';
import { newUserRow } from '../src/lib/account';
import { env } from '../src/env';
import { buildApp } from '../src/app';
import { JOB_LEASE_MS, runTick, type TickJob } from '../src/lib/tick';
import { JOBS } from '../src/jobs';
import type { SendPush } from '../src/lib/push';
import { createSqliteClient } from './sqlite';

/** Same contract for both stores: memory (dev) and SQL (production on D1, here on SQLite). */
const BACKENDS: [string, () => Repos][] = [
  ['memory', () => createMemoryRepos({ cards: SEED_CARDS })],
  ['sql', () => createSqlRepos(createSqliteClient())]
];

const silent = { info() {}, error() {} };
const json = (res: { payload: string }) => JSON.parse(res.payload);
const minutes = (n: number) => new Date(Date.now() + n * 60_000).toISOString();
/** The delivery job's entry in a tick's report (jobs that write rows due now run before it). */
const delivery = (tick: { jobs: { name: string }[] }) => tick.jobs.find((j) => j.name === 'inbox.deliver') as { name: string; status: string; result: Record<string, unknown> | null };

describe.each(BACKENDS)('inbox and tick (%s store)', (_name, makeRepos) => {
  let app: FastifyInstance;
  let repos: Repos;
  let seq = 0;

  beforeEach(async () => {
    repos = makeRepos();
    app = await buildApp({ repos, logger: false, demo: false });
  });

  async function userWith() {
    const user = await repos.users.create(newUserRow({ email: `${Math.random()}@example.com`, lineSub: null, nickname: 'u', via: 'email', lang: 'ja' }));
    return { user, h: { authorization: `Bearer ${signJwt({ sub: user.id }, env.JWT_SECRET, 3600)}` } };
  }
  async function queue(userId: string, dueAt: string, patch: Partial<InboxRow> = {}): Promise<InboxRow> {
    const row: InboxRow = { id: `inb_${++seq}`, userId, star: 'nana', kind: 'message', payload: { text: `hello ${seq}` }, dueAt, deliveredAt: null, readAt: null, createdAt: new Date().toISOString(), ...patch };
    await repos.inbox.add(row);
    return row;
  }
  const tick = () => app.inject({ method: 'POST', url: '/v1/ops/tick', headers: { authorization: `Bearer ${env.AGENT_API_KEY}` } });
  const inbox = async (h: Record<string, string>) => json(await app.inject({ url: '/v1/inbox', headers: h }));
  const unreadOnMe = async (h: Record<string, string>) => json(await app.inject({ url: '/v1/auth/me', headers: h })).inboxUnread;

  it('opening her chat reads all her delivered lines in one request; her badge clears, another\'s stays (N-44)', async () => {
    const { user, h } = await userWith();
    const past = new Date(Date.now() - 60_000).toISOString();
    for (let i = 0; i < 7; i++) await queue(user.id, past, { star: 'unpai', deliveredAt: past, payload: { text: `line ${i}`, herMessage: 'note' } });
    await queue(user.id, past, { star: 'nana', deliveredAt: past });
    expect((await inbox(h)).unread).toBe(8);
    const res = await app.inject({ method: 'POST', url: '/v1/inbox/read-star', headers: h, payload: { star: 'unpai' } });
    expect(res.statusCode, res.payload).toBe(200);
    expect(json(res).unread).toBe(1);
    const items = (await inbox(h)).items as { star: string; readAt: string | null }[];
    expect(items.filter((i) => i.star === 'unpai' && !i.readAt)).toHaveLength(0);
    expect(items.filter((i) => i.star === 'nana' && !i.readAt)).toHaveLength(1);
    expect(await unreadOnMe(h)).toBe(1);
    // Her messages joined the conversation, as opening each would do.
    expect((await repos.messages.recent(user.id, 'unpai', 20)).filter((m) => m.role === 'assistant')).toHaveLength(7);
    expect((await app.inject({ method: 'POST', url: '/v1/inbox/read-star', payload: { star: 'unpai' } })).statusCode).toBe(401);
  });

  it('her room reads only the messages he saw: an invitation he has not seen stays unread (QA #12)', async () => {
    const { h, user } = await userWith();
    const past = new Date(Date.now() - 60_000).toISOString();
    const a = await queue(user.id, past, { star: 'mahiro', deliveredAt: past });
    const b = await queue(user.id, past, { star: 'mahiro', deliveredAt: past });
    const invite = await queue(user.id, past, { star: 'mahiro', deliveredAt: past, payload: { text: 'come', scene: 'confession-mahiro' } });
    const res = await app.inject({ method: 'POST', url: '/v1/inbox/read-star', headers: h, payload: { star: 'mahiro', ids: [a.id, b.id, 'not-hers'] } });
    expect(res.statusCode, res.payload).toBe(200);
    const items = (await inbox(h)).items as { id: string; readAt: string | null }[];
    expect(items.filter((i) => !i.readAt).map((i) => i.id)).toEqual([invite.id]);
    expect((await app.inject({ method: 'POST', url: '/v1/inbox/read-star', headers: h, payload: { star: 'mahiro', ids: [] } })).statusCode).toBe(400);
    // Her chat reads all her lines, but an invitation only when he opens or answers it.
    await app.inject({ method: 'POST', url: '/v1/inbox/read-star', headers: h, payload: { star: 'mahiro' } });
    expect(((await inbox(h)).items as { id: string; readAt: string | null }[]).filter((i) => !i.readAt).map((i) => i.id)).toEqual([invite.id]);
  });

  it('answers the tick only with the internal key (404 otherwise), and without one in demo mode', async () => {
    expect((await app.inject({ method: 'POST', url: '/v1/ops/tick' })).statusCode).toBe(404);
    expect((await app.inject({ method: 'POST', url: '/v1/ops/tick', headers: { authorization: 'Bearer nope' } })).statusCode).toBe(404);
    const ok = await tick();
    expect(ok.statusCode).toBe(200);
    expect(json(ok).jobs).toEqual([
      expect.objectContaining({ name: 'promises.due', status: 'ok', result: { notified: 0, missed: 0 } }),
      // Wake-ups (#57) first, so the delivery right after pushes them in the same tick.
      expect.objectContaining({ name: 'alarm.ring', status: 'ok', result: { alarms: 0, rung: 0 } }),
      // No weather stored: nothing for her to say about it (tests/herWorld.test.ts).
      expect.objectContaining({ name: 'weather.events', status: 'ok', result: { events: 0, sent: 0 } }),
      // Her message for the day (#61): nobody has spent a day with her yet (tests/calendar.test.ts).
      expect.objectContaining({ name: 'calendar.greet', status: 'ok', result: { users: 0, outside: 0, sent: 0, capped: 0 } }),
      // Her confession (#55): her lines are reviewed (#84), so production looks for whom to send it; nobody is due.
      expect.objectContaining({ name: 'confession.invite', status: 'ok', result: { candidates: 0, sent: 0 } }),
      // Her draw-night invite (#76) runs in production: her reveal is reviewed and #81's clips exist (the publish
      // rule; tests/variantInvites.test.ts). Whether its evening is open depends on the hour.
      expect.objectContaining({ name: 'variant.invite', status: 'ok', result: expect.objectContaining({ night: expect.any(String) }) }),
      // Her messages are off without a writer (tests/herMessages.test.ts passes a fake one).
      expect.objectContaining({ name: 'her-messages.plan', status: 'ok', result: { off: true } }),
      expect.objectContaining({ name: 'her-messages.send', status: 'ok', result: { off: true } }),
      expect.objectContaining({ name: 'inbox.deliver', status: 'ok', result: { delivered: 0, pushed: 0 } }),
      expect.objectContaining({ name: 'events.purge', status: 'ok' }),
      // His memory files (#51): no store bound under test, and no retention until #84 decides one.
      expect.objectContaining({ name: 'memories.assets', status: 'ok', result: expect.objectContaining({ store: false, retentionDays: null, expired: 0 }) }),
      // Batched chat memory: off without the persona service (tests/memoryFlush.test.ts passes a fake one).
      expect.objectContaining({ name: 'memory.flush', status: 'ok', result: { off: true } }),
      // No weather provider under test: the job does nothing (tests/weather.test.ts passes a fake one).
      expect.objectContaining({ name: 'weather.refresh', status: 'ok', result: { off: true } })
    ]);
    const demo = await buildApp({ repos, logger: false, demo: true });
    expect((await demo.inject({ method: 'POST', url: '/v1/ops/tick' })).statusCode).toBe(200);
  });

  it('delivers rows once their time has come, and a second tick delivers nothing again', async () => {
    const { user, h } = await userWith();
    const other = await userWith();
    const due = await queue(user.id, minutes(-10));
    await queue(user.id, minutes(30));
    await queue(other.user.id, minutes(-1), { star: 'eimi' });
    // Waiting rows are never shown, nor counted.
    expect(await inbox(h)).toEqual({ items: [], unread: 0 });
    expect(await unreadOnMe(h)).toBe(0);

    const first = json(await tick());
    expect(delivery(first)).toMatchObject({ name: 'inbox.deliver', status: 'ok', result: { delivered: 2 } });
    const list = await inbox(h);
    expect(list.unread).toBe(1);
    expect(list.items).toEqual([expect.objectContaining({ id: due.id, star: 'nana', kind: 'message', payload: { text: due.payload.text }, readAt: null })]);
    const deliveredAt = list.items[0].deliveredAt;
    expect(await unreadOnMe(h)).toBe(1);
    expect((await inbox(other.h)).items.map((i: { star: string }) => i.star)).toEqual(['eimi']);

    const second = json(await tick());
    expect(delivery(second).result).toEqual({ delivered: 0, pushed: 0 });
    expect((await inbox(h)).items[0].deliveredAt).toBe(deliveredAt);
    expect(await repos.inbox.deliverDue(new Date().toISOString(), 10)).toEqual([]);
    // The tick is recorded per job.
    expect(await repos.jobs.get('inbox.deliver')).toMatchObject({ ok: true, error: null, runs: 2, result: { delivered: 0, pushed: 0 } });
  });

  it('sends her delivered line to his lock screen, and a failing push never undoes the delivery (#50)', async () => {
    const { user } = await userWith();
    const a = await queue(user.id, minutes(-2), { star: 'mahiro', payload: { text: 'おはよう。起きてる？' } });
    const b = await queue(user.id, minutes(-1));
    const sent: { userId: string; title: string; body: string; url: string }[] = [];
    const sendPush: SendPush = async (userId, payload) => {
      if (payload.body.startsWith('hello')) throw new Error('push service down');
      sent.push({ userId, title: payload.title, body: payload.body, url: payload.url });
      return { sent: 1, removed: 0, failed: 0 };
    };
    const res = await runTick(repos, JOBS, { log: silent, sendPush });
    expect(delivery(res)).toMatchObject({ name: 'inbox.deliver', status: 'ok', result: { delivered: 2, pushed: 1 } });
    expect(sent).toEqual([{ userId: user.id, title: 'まひろ', body: 'おはよう。起きてる？', url: '/#/me/home?star=mahiro' }]);
    const rows = await repos.inbox.forUser(user.id, 10);
    expect(rows.map((r) => r.id).sort()).toEqual([a.id, b.id].sort());
    expect(rows.every((r) => r.deliveredAt)).toBe(true);
  });

  it('lists unread first, reads an item once, and keeps the badge equal to the list', async () => {
    const { user, h } = await userWith();
    const other = await userWith();
    const a = await queue(user.id, minutes(-30));
    const b = await queue(user.id, minutes(-20), { star: 'mahiro' });
    const c = await queue(user.id, minutes(-10), { star: 'alice', kind: 'wakeup', payload: { at: '07:00' } });
    await tick();
    // Delivered by the same tick: the newest written comes first.
    expect((await inbox(h)).items.map((i: { id: string }) => i.id)).toEqual([c.id, b.id, a.id]);
    expect(await unreadOnMe(h)).toBe(3);

    const read = await app.inject({ method: 'POST', url: `/v1/inbox/${b.id}/read`, headers: h });
    expect(read.statusCode).toBe(200);
    expect(json(read).unread).toBe(2);
    const readAt = json(read).item.readAt;
    expect(readAt).toBeTruthy();
    const again = json(await app.inject({ method: 'POST', url: `/v1/inbox/${b.id}/read`, headers: h }));
    expect(again).toMatchObject({ unread: 2, item: { readAt } });

    const list = await inbox(h);
    expect(list.unread).toBe(2);
    expect(await unreadOnMe(h)).toBe(2);
    // Unread first; the read one goes last.
    expect(list.items.at(-1).id).toBe(b.id);
    expect(list.items.slice(0, 2).every((i: { readAt: string | null }) => i.readAt === null)).toBe(true);

    // Someone else's item, a row not delivered yet, and a missing one all look absent.
    const later = await queue(user.id, minutes(60));
    expect((await app.inject({ method: 'POST', url: `/v1/inbox/${a.id}/read`, headers: other.h })).statusCode).toBe(404);
    expect((await app.inject({ method: 'POST', url: `/v1/inbox/${later.id}/read`, headers: h })).statusCode).toBe(404);
    expect((await app.inject({ method: 'POST', url: '/v1/inbox/nope/read', headers: h })).statusCode).toBe(404);
    expect((await app.inject({ url: '/v1/inbox' })).statusCode).toBe(401);
    expect(await unreadOnMe(h)).toBe(2);
  });

  it('orders unread items newest delivered first', async () => {
    const { user, h } = await userWith();
    const old = await queue(user.id, minutes(-30));
    await tick();
    const fresh = await queue(user.id, minutes(-1));
    // The delivery job may only run once per tick instant; move the clock by running the job directly.
    await repos.inbox.deliverDue(new Date(Date.now() + 1000).toISOString(), 10);
    expect((await inbox(h)).items.map((i: { id: string }) => i.id)).toEqual([fresh.id, old.id]);
  });

  it('deletes her inbox with the account, delivered or still waiting', async () => {
    const { user, h } = await userWith();
    const other = await userWith();
    await queue(user.id, minutes(-5));
    await queue(user.id, minutes(60));
    await queue(other.user.id, minutes(-5));
    await tick();
    expect((await app.inject({ method: 'DELETE', url: '/v1/auth/me', headers: h, payload: { confirm: 'DELETE' } })).statusCode).toBe(200);
    expect(await repos.inbox.forUser(user.id, 50)).toEqual([]);
    expect(await repos.inbox.unread(user.id)).toBe(0);
    // The waiting row went too: nothing of hers is delivered after the account is gone.
    expect(await repos.inbox.deliverDue(minutes(120), 10)).toEqual([]);
    expect(await repos.inbox.unread(other.user.id)).toBe(1);
  });

  it('lets a demo account queue a message to itself; production refuses', async () => {
    const { h } = await userWith();
    expect((await app.inject({ method: 'POST', url: '/v1/inbox/demo', headers: h, payload: { star: 'unpai', text: 'hi' } })).statusCode).toBe(404);
    const demo = await buildApp({ repos, logger: false, demo: true });
    expect((await demo.inject({ method: 'POST', url: '/v1/inbox/demo', payload: { star: 'unpai', text: 'hi' } })).statusCode).toBe(401);
    expect((await demo.inject({ method: 'POST', url: '/v1/inbox/demo', headers: h, payload: { star: 'unpai', text: '' } })).statusCode).toBe(400);
    expect((await demo.inject({ method: 'POST', url: '/v1/inbox/demo', headers: h, payload: { star: 'unpai', text: 'おはよう' } })).statusCode).toBe(200);
    await demo.inject({ method: 'POST', url: '/v1/ops/tick' });
    expect((await inbox(h)).items).toEqual([expect.objectContaining({ star: 'unpai', kind: 'message', payload: { text: 'おはよう' } })]);
  });

  describe('tick runner', () => {
    const job = (name: string, run: TickJob['run'], everyMs = 0): TickJob => ({ name, everyMs, run });

    it('keeps going when a job fails, and records the failure', async () => {
      const ran: string[] = [];
      const res = await runTick(repos, [
        job('a', async () => { ran.push('a'); throw new Error('boom'); }),
        job('b', async () => { ran.push('b'); return { n: 1 }; })
      ], { log: silent });
      expect(ran).toEqual(['a', 'b']);
      expect(res.jobs.map((j) => [j.name, j.status, j.error])).toEqual([['a', 'failed', 'boom'], ['b', 'ok', null]]);
      expect(await repos.jobs.get('a')).toMatchObject({ ok: false, error: 'boom', lastOkAt: null });
      expect(await repos.jobs.get('b')).toMatchObject({ ok: true, result: { n: 1 } });
      // A failed job is not stuck: it runs again on the next tick.
      expect((await runTick(repos, [job('a', async () => ({}))], { log: silent })).jobs[0].status).toBe('ok');
    });

    it('cuts a job off at the time budget and leaves the rest for the next tick', async () => {
      let aborted = false;
      const res = await runTick(repos, [
        job('slow', ({ signal }) => new Promise((resolve) => { signal.addEventListener('abort', () => { aborted = true; resolve({}); }); })),
        job('next', async () => ({}))
      ], { log: silent, budgetMs: 30 });
      expect(res.jobs.map((j) => j.status)).toEqual(['timeout', 'skipped']);
      expect(aborted).toBe(true);
      expect(await repos.jobs.get('next')).toBeNull();
      expect(await repos.jobs.get('slow')).toMatchObject({ ok: false, error: 'timeout' });
    });

    it('runs a job no more often than it asks, and never twice at once', async () => {
      let t = Date.parse('2026-10-01T00:00:00.000Z');
      const clock = () => t;
      let runs = 0;
      const hourly = job('hourly', async () => { runs += 1; }, 60 * 60_000);
      expect((await runTick(repos, [hourly], { log: silent, clock })).jobs[0].status).toBe('ok');
      t += 5 * 60_000;
      expect((await runTick(repos, [hourly], { log: silent, clock })).jobs[0].status).toBe('not_due');
      t += 60 * 60_000;
      expect((await runTick(repos, [hourly], { log: silent, clock })).jobs[0].status).toBe('ok');
      expect(runs).toBe(2);

      // Two overlapping ticks: the second finds the job running.
      let release!: () => void;
      const gate = new Promise<void>((r) => { release = r; });
      const long = job('long', async () => { await gate; });
      const first = runTick(repos, [long], { log: silent, clock });
      await new Promise((r) => setTimeout(r, 5));
      expect((await runTick(repos, [long], { log: silent, clock })).jobs[0].status).toBe('busy');
      release();
      expect((await first).jobs[0].status).toBe('ok');
    });

    it('frees a job whose run never recorded its end once the lease has passed', async () => {
      const at = Date.parse('2026-10-01T00:00:00.000Z');
      const iso = (ms: number) => new Date(ms).toISOString();
      expect(await repos.jobs.claim('crashy', iso(at), iso(at), iso(at - JOB_LEASE_MS))).toBe(true);
      const later = at + 60_000;
      expect(await repos.jobs.claim('crashy', iso(later), iso(later), iso(later - JOB_LEASE_MS))).toBe(false);
      const muchLater = at + JOB_LEASE_MS + 1;
      expect(await repos.jobs.claim('crashy', iso(muchLater), iso(muchLater), iso(muchLater - JOB_LEASE_MS))).toBe(true);
      expect(await repos.jobs.get('crashy')).toMatchObject({ runs: 2, finishedAt: null });
    });
  });
});

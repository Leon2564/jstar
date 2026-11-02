import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { PROMISE_RULES, addDays, jstDay, timelessPromise } from '@jstar/shared';
import { LINES } from '@jstar/shared/lines';
import { signJwt } from '../src/lib/crypto';
import { createMemoryRepos } from '../src/db/memory';
import { createSqlRepos } from '../src/db/sql';
import { SEED_CARDS } from '../src/db/seed';
import { promiseInboxId, type PromiseRow, type Repos } from '../src/db/types';
import { newUserRow } from '../src/lib/account';
import { env } from '../src/env';
import { buildApp } from '../src/app';
import { runTick } from '../src/lib/tick';
import { JOBS } from '../src/jobs';
import { duePromises } from '../src/jobs/duePromises';
import type { SendPush } from '../src/lib/push';
import { createSqliteClient } from './sqlite';

// The persona service has its own suite (apps/agent/tests); this fake follows its contract. "PROMISE" is a turn in
// which both agreed on tomorrow 21:00 JST, as the memory model reports it (and, memory being batched, the turn that
// took the waiting turns into memory: `memorySaved`); everything else is echoed back and waits unsaved.
const agent = vi.hoisted(() => ({ inputs: [] as Record<string, unknown>[], greetings: [] as Record<string, unknown>[] }));
const tomorrowNine = () => `${addDays(jstDay(), 1)}T21:00+09:00`;
vi.mock('../src/lib/agent', () => {
  const answer = (input: Record<string, unknown>) => {
    agent.inputs.push(input);
    const promise = input.text === 'PROMISE' ? { text: '夜9時、朗読を聞かせる', dueAt: tomorrowNine(), kind: 'scene' }
      : input.text === 'BADPROMISE' ? { text: 'x', dueAt: '明日の夜', kind: 'free' } : undefined;
    return { reply: `echo:${String(input.text)}`, blocked: false, boundary: null, memory: null, cardTitle: null, promise, memorySaved: !!promise };
  };
  return {
    askPersona: async (input: Record<string, unknown>) => answer(input),
    streamPersona: async function* (input: Record<string, unknown>) {
      const r = answer(input);
      yield { type: 'delta', text: r.reply };
      yield { type: 'done', reply: r.reply, boundary: null, memory: null, cardTitle: null, promise: r.promise, memorySaved: r.memorySaved };
    },
    greetPersona: async (input: Record<string, unknown>) => { agent.greetings.push(input); return `greet:${String(input.star)}`; }
  };
});

const BACKENDS: [string, () => Repos][] = [
  ['memory', () => createMemoryRepos({ cards: SEED_CARDS })],
  ['sql', () => createSqlRepos(createSqliteClient())]
];
const HOUR = 3_600_000;
const silent = { info() {}, error() {} };
const json = (res: { payload: string }) => JSON.parse(res.payload);
const at = (ms: number) => new Date(Date.now() + ms).toISOString();

let app: FastifyInstance;
let repos: Repos;
let seq = 0;

async function member(lang: 'ja' | 'en' = 'ja') {
  const user = await repos.users.create(newUserRow({ email: `${Math.random()}@example.com`, lineSub: null, nickname: 'u', via: 'email', lang }));
  return { user, h: { authorization: `Bearer ${signJwt({ sub: user.id }, env.JWT_SECRET, 3600)}` } };
}
const get = async (url: string, h: Record<string, string>) => json(await app.inject({ url, headers: h }));
const post = (url: string, payload: object, h: Record<string, string>) => app.inject({ method: 'POST', url, headers: h, payload });
/** An open promise with nana (unless patched), made a day ago and due `dueIn` ms from now. */
async function promised(userId: string, dueIn: number, patch: Partial<PromiseRow> = {}): Promise<PromiseRow> {
  const row: PromiseRow = {
    id: `prm_t${++seq}`, userId, star: 'nana', text: '明日の朝、お茶を淹れて続きを読む', dueAt: at(dueIn), kind: 'scene', status: 'open', source: 'proposal',
    madeAt: at(-24 * HOUR), keptAt: null, sourceMsgId: null, sceneId: null, lang: 'ja', notifiedAt: null, missedAt: null, mentionedAt: null, ...patch
  };
  expect(await repos.promises.create(row)).toBe(true);
  return row;
}
const metrics = async () => {
  const [all] = await repos.events.metrics(addDays(jstDay(), -2), addDays(jstDay(), 2), 'all');
  return { due: all?.promisesDue ?? 0, kept: all?.promisesKept ?? 0 };
};

describe.each(BACKENDS)('promises (%s store)', (_name, makeRepos) => {
  beforeEach(async () => {
    // An evening in Japan, when all five are awake: asleep, her room opens on her woken line instead (#60).
    vi.useFakeTimers({ toFake: ['Date'], now: new Date('2026-10-05T11:00:00.000Z'), shouldAdvanceTime: true });
    repos = makeRepos();
    app = await buildApp({ repos, logger: false, demo: true });
    agent.inputs.length = 0;
    agent.greetings.length = 0;
  });
  afterEach(() => { vi.useRealTimers(); });

  it('needs a session', async () => {
    expect((await app.inject({ url: '/v1/promises' })).statusCode).toBe(401);
    expect((await post('/v1/promises', { star: 'nana', lineId: 'wake' }, {})).statusCode).toBe(401);
  });

  it('offers her proposal, makes it on 「約束する」, and refuses a second one with her until the first is done', async () => {
    const { h } = await member();
    const first = await get('/v1/promises?star=mahiro&lang=ja', h);
    expect(first.promises).toEqual([]);
    const proposal = first.proposal;
    const line = LINES.mahiro.promises.find((l) => l.id === proposal.lineId)!;
    expect(proposal).toMatchObject({ star: 'mahiro', kind: line.kind, propose: line.propose.ja, text: line.promise.ja });

    const made = await post('/v1/promises', { star: 'mahiro', lineId: proposal.lineId }, h);
    expect(made.statusCode).toBe(201);
    const promise = json(made).promise;
    expect(promise).toMatchObject({ star: 'mahiro', status: 'open', source: 'proposal', text: timelessPromise(line.promise.ja), keptAt: null, sceneId: null });
    // Due as her line says, from now ("+12h", "+1d"…).
    const n = Number(/\d+/.exec(line.due)![0]) * (line.due.endsWith('d') ? 24 : 1) * HOUR;
    expect(Math.abs(Date.parse(promise.dueAt) - (Date.now() + n))).toBeLessThan(60_000);

    // One open promise per talent: no second proposal, and a second 「約束する」 is refused.
    expect(await get('/v1/promises?star=mahiro', h)).toEqual({ promises: [promise], proposal: null });
    // N-09: made in Japanese, her written promise reads in his language once he switches.
    for (const lang of ['en', 'ko', 'zh-Hant'] as const) {
      expect((await get(`/v1/promises?star=mahiro&lang=${lang}`, h)).promises[0].text).toBe(timelessPromise(line.promise[lang] ?? ''));
    }
    expect((await post('/v1/promises', { star: 'mahiro', lineId: 'cocoa' }, h)).statusCode).toBe(409);
    expect(await repos.promises.open((await repos.promises.byId(promise.id))!.userId)).toHaveLength(1);
    // Another talent is another promise.
    expect((await post('/v1/promises', { star: 'nana', lineId: 'wake' }, h)).statusCode).toBe(201);
    expect((await get('/v1/promises', h)).promises.map((p: { star: string }) => p.star).sort()).toEqual(['mahiro', 'nana']);
    expect((await post('/v1/promises', { star: 'nana', lineId: 'nope' }, h)).statusCode).toBe(404);
  });

  it('keeps her draft lines out of production: no proposal, no 「約束する」, no demo route', async () => {
    // Her lines are reviewed now (#84, owner 2026-09-28); the gate must still hold for a draft, so one is made here
    // (lib/promises.ts reads LINES directly).
    LINES.nana.draft = true;
    try {
      const prod = await buildApp({ repos, logger: false, demo: false });
      const { h } = await member();
      expect(json(await prod.inject({ url: '/v1/promises?star=nana', headers: h })).proposal).toBeNull();
      expect((await prod.inject({ method: 'POST', url: '/v1/promises', headers: h, payload: { star: 'nana', lineId: 'wake' } })).statusCode).toBe(404);
      expect((await prod.inject({ method: 'POST', url: '/v1/promises/demo', headers: h, payload: { star: 'nana' } })).statusCode).toBe(404);
    } finally {
      LINES.nana.draft = false;
    }
  });

  it('offers her reviewed lines in production too, but never the demo route', async () => {
    expect(LINES.nana.draft).toBe(false);
    const prod = await buildApp({ repos, logger: false, demo: false });
    const { h } = await member();
    const proposal = json(await prod.inject({ url: '/v1/promises?star=nana&lang=ja', headers: h })).proposal;
    const line = LINES.nana.promises.find((l) => l.id === proposal?.lineId)!;
    expect(proposal).toMatchObject({ star: 'nana', kind: line.kind, propose: line.propose.ja, text: line.promise.ja });
    const made = await prod.inject({ method: 'POST', url: '/v1/promises', headers: h, payload: { star: 'nana', lineId: 'wake' } });
    expect(made.statusCode, made.payload).toBe(201);
    expect(json(made).promise).toMatchObject({ star: 'nana', status: 'open', source: 'proposal' });
    expect((await prod.inject({ method: 'POST', url: '/v1/promises/demo', headers: h, payload: { star: 'nana' } })).statusCode).toBe(404);
  });

  it('makes the promise both agreed on in chat, due tomorrow 21:00 JST, and her next turn knows it', async () => {
    const { user, h } = await member();
    const res = await post('/v1/chat/send', { star: 'nana', text: 'PROMISE', lang: 'ja' }, h);
    expect(res.statusCode).toBe(200);
    const made = json(res).promise;
    expect(made).toMatchObject({ star: 'nana', text: '夜9時、朗読を聞かせる', kind: 'scene', status: 'open', source: 'chat' });
    expect(made.dueAt).toBe(new Date(tomorrowNine()).toISOString());
    const row = (await repos.promises.byId(made.id))!;
    const [said] = (await repos.messages.recent(user.id, 'nana', 2)).filter((m) => m.role === 'user');
    expect(row.sourceMsgId).toBe(said.id);
    // The home card lists it.
    expect((await get('/v1/promises?star=nana', h)).promises).toEqual([made]);

    // Written to memory: the persona service is told about it on the next turn, and her greeting too.
    await post('/v1/chat/send/stream', { star: 'nana', text: 'PROMISE', lang: 'ja' }, h);
    expect(agent.inputs.at(-1)).toMatchObject({ promise: { text: '夜9時、朗読を聞かせる', dueAt: made.dueAt, kind: 'scene', status: 'open' } });
    // A second agreement while the first is open makes nothing (the stream path included).
    expect(await repos.promises.open(user.id, 'nana')).toHaveLength(1);
    await get('/v1/chat/greeting?star=nana', h);
    expect(agent.greetings.at(-1)).toMatchObject({ promise: { text: '夜9時、朗読を聞かせる', status: 'open' } });
  });

  it('a clear agreement after turns that waited unsaved makes the promise, in the agent\'s own wire shape (#59 regression)', async () => {
    // The agent reports a promise only once her own reply said yes to that time (apps/agent memory.py promise_agreed,
    // tests/test_chat_cost.py). Here: the proposal and her yes waited in the batched-memory buffer, and the turn with
    // the agreement both makes the promise and takes the waiting turns into memory.
    const { user, h } = await member();
    await post('/v1/chat/send', { star: 'nana', text: '明日の夜9時に朗読してくれる？', lang: 'ja', tz: 'Asia/Taipei' }, h);
    // Round 12: the time he names is on his clock — his browser's zone goes to the persona service (a bad one never).
    expect(agent.inputs.at(-1)).toMatchObject({ tz: 'Asia/Taipei' });
    await post('/v1/chat/send', { star: 'mahiro', text: 'hi', lang: 'ja', tz: 'Mars/Olympus' }, h);
    expect(agent.inputs.at(-1)).not.toHaveProperty('tz');
    expect((await repos.chatMemory.get(user.id, 'nana'))?.pending.map((t) => t.text)).toEqual(['明日の夜9時に朗読してくれる？', 'echo:明日の夜9時に朗読してくれる？']);
    const evs = (await app.inject({ method: 'POST', url: '/v1/chat/send/stream', headers: h, payload: { star: 'nana', text: 'PROMISE', lang: 'ja' } })).payload
      .split('\n').filter(Boolean).map((l) => JSON.parse(l));
    expect(agent.inputs.at(-1)).toMatchObject({ memoryMode: 'batch', unsaved: [{ role: 'user', text: '明日の夜9時に朗読してくれる？' }, { role: 'assistant', text: 'echo:明日の夜9時に朗読してくれる？' }] });
    const made = evs.at(-1).result.promise;
    expect(made).toMatchObject({ star: 'nana', text: '夜9時、朗読を聞かせる', kind: 'scene', status: 'open', source: 'chat' });
    expect(made.dueAt).toBe(new Date(tomorrowNine()).toISOString());
    expect(await repos.promises.open(user.id, 'nana')).toHaveLength(1);
    expect((await repos.chatMemory.get(user.id, 'nana'))?.pending).toEqual([]);
  });

  it('ignores a promise the model got wrong', async () => {
    const { user, h } = await member();
    const res = json(await post('/v1/chat/send', { star: 'nana', text: 'BADPROMISE', lang: 'ja' }, h));
    expect(res.promise).toBeNull();
    expect(await repos.promises.open(user.id)).toEqual([]);
  });

  it('turns a promise falling due into her inbox line and a push in the same tick, exactly once', async () => {
    const { user, h } = await member();
    const due = await promised(user.id, -60_000);
    const later = await promised(user.id, 5 * HOUR, { star: 'mahiro' });
    const sent: { body: string; url: string }[] = [];
    const sendPush: SendPush = async (_u, p) => { sent.push({ body: p.body, url: p.url }); return { sent: 1, removed: 0, failed: 0 }; };

    const first = await runTick(repos, JOBS, { log: silent, sendPush });
    // By name: other jobs (the wake-up alarm, #57) also run between the promises and the delivery.
    expect(['promises.due', 'inbox.deliver'].map((n) => first.jobs.find((j) => j.name === n))).toEqual([
      expect.objectContaining({ name: 'promises.due', status: 'ok', result: { notified: 1, missed: 0 } }),
      expect.objectContaining({ name: 'inbox.deliver', status: 'ok', result: { delivered: 1, pushed: 1 } })
    ]);
    // Made "yesterday": 「昨日の約束、覚えてる？」.
    // Round 10: never a frozen 「明日」 in her line on the day itself.
    const text = '昨日の約束、覚えてる？「朝、お茶を淹れて続きを読む」……ちゃんと、待ってたよ。';
    expect(sent).toEqual([{ body: text, url: '/#/me/home?star=nana' }]);
    const inbox = await get('/v1/inbox', h);
    expect(inbox.unread).toBe(1);
    expect(inbox.items).toEqual([expect.objectContaining({
      id: promiseInboxId(due.id), star: 'nana', kind: 'promise_due', payload: { text, texts: expect.objectContaining({ ja: text }), promiseId: due.id, kind: 'scene', sceneId: 'promise-kept-nana' }
    })]);
    // M18: kept in every language, so it reads in his after he switches.
    const texts = inbox.items[0].payload.texts as Record<string, string>;
    expect(Object.keys(texts).sort()).toEqual(['en', 'ja', 'ko', 'zh-Hant']);
    expect(texts['zh-Hant']).not.toBe(text);
    expect(await metrics()).toEqual({ due: 1, kept: 0 });

    // Idempotent: another tick, or the job run again at the same instant, writes and pushes nothing more.
    const second = await runTick(repos, JOBS, { log: silent, sendPush });
    expect(second.jobs[0].result).toEqual({ notified: 0, missed: 0 });
    expect(await repos.promises.notify(due.id, new Date().toISOString(), null)).toBe(false);
    expect(sent).toHaveLength(1);
    expect((await get('/v1/inbox', h)).items).toHaveLength(1);
    // Two runs overlapping on a promise that just fell due: one line between them.
    const racing = await promised(user.id, -1000, { star: 'alice' });
    const ctx = { repos, now: new Date(), signal: new AbortController().signal, log: silent };
    const both = (await Promise.all([duePromises.run(ctx), duePromises.run(ctx)])) as { notified: number }[];
    expect(both[0].notified + both[1].notified).toBe(1);
    expect((await repos.inbox.deliverDue(new Date().toISOString(), 10)).map((r) => r.id)).toEqual([promiseInboxId(racing.id)]);
    expect((await repos.promises.byId(later.id))!.notifiedAt).toBeNull();
    expect(await metrics()).toEqual({ due: 2, kept: 0 });
  });

  it('keeps the promise when he opens her line within the window: kept, a memory card, promise.kept, the badge gone', async () => {
    const { user, h } = await member();
    const due = await promised(user.id, -HOUR, { sceneId: 'demo-evening', star: 'mahiro' });
    await runTick(repos, JOBS, { log: silent });
    const read = await post(`/v1/inbox/${promiseInboxId(due.id)}/read`, {}, h);
    expect(read.statusCode).toBe(200);
    const body = json(read);
    expect(body).toMatchObject({ unread: 0, item: { kind: 'promise_due' }, promise: { id: due.id, status: 'kept', sceneId: 'demo-evening' } });
    expect((await repos.promises.byId(due.id))!.keptAt).not.toBeNull();
    expect(json(await app.inject({ url: '/v1/auth/me', headers: h })).memories).toEqual([expect.objectContaining({ star: 'mahiro', title: due.text })]);
    expect(await metrics()).toEqual({ due: 1, kept: 1 });
    // Opening it again changes nothing.
    expect(json(await post(`/v1/inbox/${promiseInboxId(due.id)}/read`, {}, h)).promise.status).toBe('kept');
    expect(await metrics()).toEqual({ due: 1, kept: 1 });
    expect(json(await app.inject({ url: '/v1/auth/me', headers: h })).memories).toHaveLength(1);
    // Kept: her next chat turn is her following through on it.
    await post('/v1/chat/send', { star: 'mahiro', text: 'hi', lang: 'ja' }, h);
    expect(agent.inputs.at(-1)).toMatchObject({ promise: { text: timelessPromise(due.text), status: 'kept' } });
    // And a new promise with her can be made.
    expect((await get('/v1/promises?star=mahiro', h)).proposal).not.toBeNull();
  });

  it('keeps it when he comes to her room within the window: her greeting is the keeping, uncached', async () => {
    const { user, h } = await member();
    const soon = await promised(user.id, HOUR);
    const greet = await get('/v1/chat/greeting?star=nana&lang=ja', h);
    // Before its time (and before the tick came): 「来てくれたんだ」.
    expect(greet).toMatchObject({ cached: false, text: '来てくれたんだ。「朝、お茶を淹れて続きを読む」の約束、覚えててくれたんだね。', promise: { id: soon.id, status: 'kept' } });
    expect(agent.greetings).toHaveLength(0);
    // The tick has nothing left to send, and the revisit rate counts it.
    expect((await runTick(repos, JOBS, { log: silent })).jobs[0].result).toEqual({ notified: 0, missed: 0 });
    expect(await metrics()).toEqual({ due: 1, kept: 1 });
    // The next visit is her ordinary greeting.
    expect(await get('/v1/chat/greeting?star=nana&lang=ja', h)).toEqual({ text: 'greet:nana', cached: false });
  });

  it('does not keep a promise whose time is still far off', async () => {
    const { user, h } = await member('en');
    const far = await promised(user.id, PROMISE_RULES.windowMs + HOUR);
    expect(await get('/v1/chat/greeting?star=nana&lang=en', h)).toEqual({ text: 'greet:nana', cached: false });
    expect((await repos.promises.byId(far.id))!.status).toBe('open');
  });

  it('misses a promise once the window has passed; she brings it up once, gently, and never again', async () => {
    const { user, h } = await member();
    const gone = await promised(user.id, -2 * HOUR);
    await runTick(repos, JOBS, { log: silent });
    expect((await get('/v1/inbox', h)).unread).toBe(1);
    // An hour past the window: the next tick marks it missed and her unread line is put away.
    await repos.promises.expire(at(-PROMISE_RULES.windowMs + 2 * HOUR), at(0), 10);
    const row = (await repos.promises.byId(gone.id))!;
    expect(row).toMatchObject({ status: 'missed', keptAt: null });
    expect((await get('/v1/inbox', h)).unread).toBe(0);
    // Opening the old line now keeps nothing.
    expect(json(await post(`/v1/inbox/${promiseInboxId(gone.id)}/read`, {}, h)).promise.status).toBe('missed');

    const first = await get('/v1/chat/greeting?star=nana&lang=ja', h);
    expect(first).toMatchObject({ cached: false, promise: { id: gone.id, status: 'missed' } });
    expect(first.text).toContain('「朝、お茶を淹れて続きを読む」');
    expect(first.text).toContain('ぜんぜん怒ってないよ'); // round 13: 奈々's own missed line, never a reproach
    expect(await get('/v1/chat/greeting?star=nana&lang=ja', h)).toEqual({ text: 'greet:nana', cached: false });
    expect(await get('/v1/chat/greeting?star=nana&lang=ja', h)).toEqual({ text: 'greet:nana', cached: true });
    expect(await metrics()).toEqual({ due: 1, kept: 0 });
  });

  it('misses a promise the tick never reached in time without a push, and still counts it as due', async () => {
    const { user } = await member();
    const old = await promised(user.id, -PROMISE_RULES.windowMs - HOUR);
    const sent: string[] = [];
    const res = await runTick(repos, JOBS, { log: silent, sendPush: async (_u, p) => { sent.push(p.body); return { sent: 1, removed: 0, failed: 0 }; } });
    expect(res.jobs[0].result).toEqual({ notified: 1, missed: 1 });
    expect(sent).toEqual([]);
    expect(await repos.inbox.forUser(user.id, 10)).toEqual([]);
    expect((await repos.promises.byId(old.id))!.status).toBe('missed');
    expect(await metrics()).toEqual({ due: 1, kept: 0 });
  });

  it('measures the revisit rate: kept / (kept + missed)', async () => {
    const a = await member();
    const b = await member();
    const kept = await promised(a.user.id, -HOUR);
    await promised(b.user.id, -2 * HOUR);
    await runTick(repos, JOBS, { log: silent });
    await post(`/v1/inbox/${promiseInboxId(kept.id)}/read`, {}, a.h);
    await repos.promises.expire(at(HOUR), at(0), 10);
    expect(await metrics()).toEqual({ due: 2, kept: 1 });
  });

  it('writes the promise a scene ends with, once, and not while one with her is open', async () => {
    const { user, h } = await member();
    const play = async () => {
      const run = json(await post('/v1/scene/start', { sceneId: 'demo-evening' }, h)).run;
      const talk = json(await post('/v1/scene/step', { runId: run.id, seq: run.seq, choice: 'missed' }, h)).run;
      return json(await post('/v1/scene/step', { runId: talk.id, seq: talk.seq, input: '今日は雨だった' }, h)).run;
    };
    const done = await play();
    expect(done.rewards.promises).toEqual([expect.objectContaining({ text: '明日も、ここで待ってるね' })]);
    const [row] = await repos.promises.open(user.id, 'mahiro');
    expect(row).toMatchObject({ text: '明日も、ここで待ってるね', kind: 'scene', source: 'scene', sceneId: 'demo-evening', status: 'open' });
    expect(Math.abs(Date.parse(row.dueAt) - (Date.now() + 24 * HOUR))).toBeLessThan(60_000);

    // Someone who already has a promise with her plays it: no second one, and the ending does not show one.
    const other = await member();
    await promised(other.user.id, 5 * HOUR, { star: 'mahiro' });
    const run = json(await post('/v1/scene/start', { sceneId: 'demo-evening' }, other.h)).run;
    const talk = json(await post('/v1/scene/step', { runId: run.id, seq: run.seq, choice: 'missed' }, other.h)).run;
    const end = json(await post('/v1/scene/step', { runId: talk.id, seq: talk.seq, input: 'x' }, other.h)).run;
    expect(end.rewards).toMatchObject({ affinity: 15, promises: [] });
    expect(await repos.promises.open(other.user.id, 'mahiro')).toHaveLength(1);
  });

  it('writes a demo promise due in minutes (demo mode only)', async () => {
    const { h } = await member();
    const res = await post('/v1/promises/demo', { star: 'eimi', inMinutes: 5 }, h);
    expect(res.statusCode).toBe(201);
    const p = json(res).promise;
    expect(p).toMatchObject({ star: 'eimi', status: 'open', text: timelessPromise(LINES.eimi.promises[1].promise.ja) });
    expect(Math.abs(Date.parse(p.dueAt) - (Date.now() + 5 * 60_000))).toBeLessThan(60_000);
    expect((await post('/v1/promises/demo', { star: 'eimi', inMinutes: 5 }, h)).statusCode).toBe(409);
  });

  it('deletes his promises with the account', async () => {
    const { user, h } = await member();
    const other = await member();
    await promised(user.id, HOUR);
    const kept = await promised(other.user.id, HOUR);
    expect((await app.inject({ method: 'DELETE', url: '/v1/auth/me', headers: h, payload: { confirm: 'DELETE' } })).statusCode).toBe(200);
    expect(await repos.promises.open(user.id)).toEqual([]);
    expect(await repos.promises.latest(user.id, 'nana')).toBeNull();
    expect(await repos.promises.byId(kept.id)).not.toBeNull();
  });
});

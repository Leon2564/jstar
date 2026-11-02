import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { CONFESSION_RULES, jstDay } from '@jstar/shared';
import { LINES } from '@jstar/shared/lines';
import { signJwt } from '../src/lib/crypto';
import { createMemoryRepos } from '../src/db/memory';
import { createSqlRepos } from '../src/db/sql';
import { SEED_CARDS } from '../src/db/seed';
import type { Repos } from '../src/db/types';
import { newUserRow } from '../src/lib/account';
import { env } from '../src/env';
import { buildApp } from '../src/app';
import { JOBS } from '../src/jobs';
import { runTick } from '../src/lib/tick';
import { createSqliteClient } from './sqlite';

// The persona service has its own suites (apps/agent/tests/test_confession.py for the judge). Here the judge follows
// its contract by keyword: YES → accept, NO → decline, anything else → not yet.
const judged = vi.hoisted(() => ({ inputs: [] as { star: string; lang: string; text: string; ask: string }[] }));
vi.mock('../src/lib/confessionJudge', () => ({
  judgeConfession: async (input: { star: string; lang: string; text: string; ask: string }) => {
    judged.inputs.push(input);
    const answer = /YES/.test(input.text) ? 'accept' : /NO/.test(input.text) ? 'decline' : 'not_yet';
    return { answer, confident: true, source: 'agent' };
  }
}));
vi.mock('../src/lib/agent', () => ({
  askPersona: async (input: { text: string }) => ({ reply: `echo:${input.text}`, blocked: false, boundary: null, memory: null, cardTitle: null }),
  streamPersona: async function* () { yield { type: 'error', error: 'unused' }; },
  greetPersona: async () => 'model greeting'
}));

const BACKENDS: [string, () => Repos][] = [
  ['memory', () => createMemoryRepos({ cards: SEED_CARDS })],
  ['sql', () => createSqlRepos(createSqliteClient())]
];
const silent = { info() {}, error() {} };
/** 2026-11-02, 20:00 JST (evening) and 12:00 JST (daytime). */
const EVENING = Date.UTC(2026, 10, 2, 11, 0);
const NOON = Date.UTC(2026, 10, 2, 3, 0);
const DAY = 86_400_000;

let app: FastifyInstance;
let repos: Repos;
let events: { name: string; props: Record<string, unknown> }[];

async function member(lang: 'ja' | 'en' = 'ja') {
  const user = await repos.users.create({ ...newUserRow({ email: `${Math.random()}@example.com`, lineSub: null, nickname: 'kenta', via: 'email', lang }) });
  return { user, h: { authorization: `Bearer ${signJwt({ sub: user.id }, env.JWT_SECRET, 60 * 86_400)}` } };
}
const json = (res: { payload: string }) => JSON.parse(res.payload);
const post = (url: string, payload: object, headers: Record<string, string>) => app.inject({ method: 'POST', url, headers, payload });
const get = (url: string, headers: Record<string, string>) => app.inject({ url, headers });
type Run = { id: string; seq: number; status: string; outcome: string | null; waiting: { id: string; type: string } | null; beats: { id: string; type: string; text?: { ja: string } }[]; rewards: { memories: { id: string; title: string }[] } };

const ready = async (h: Record<string, string>, star = 'mahiro') => {
  const res = await post('/v1/relationship/demo', { star, stage: 'confession_ready' }, h);
  expect(res.statusCode, res.payload).toBe(200);
  return json(res);
};
const talent = async (h: Record<string, string>, star = 'mahiro') =>
  (json(await get('/v1/relationship', h)).talents as { star: string; stage: string; anniversary: string | null; confession?: { phase: string; sceneId: string; tonight: boolean; reachedToday: boolean } | null }[])
    .find((t) => t.star === star)!;
const start = async (h: Record<string, string>, sceneId = 'confession-mahiro') => post('/v1/scene/start', { sceneId }, h);
async function confess(h: Record<string, string>, answer: string, sceneId = 'confession-mahiro'): Promise<Run> {
  const res = await start(h, sceneId);
  expect(res.statusCode, res.payload).toBe(200);
  const run = json(res).run as Run;
  expect(run.waiting).toMatchObject({ id: 'answer', type: 'input' });
  const step = await post('/v1/scene/step', { runId: run.id, seq: run.seq, input: answer }, h);
  expect(step.statusCode, step.payload).toBe(200);
  return json(step).run;
}
const tick = (demo = true) => runTick(repos, JOBS, { log: silent, demo });
const said = (run: Run) => run.beats.flatMap((b) => (b.type === 'line' && b.text ? [b.text.ja] : []));

afterEach(() => { vi.useRealTimers(); });

describe.each(BACKENDS)('her confession (%s store)', (_name, makeRepos) => {
  beforeEach(async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(EVENING);
    repos = makeRepos();
    app = await buildApp({ repos, logger: false, demo: true });
    events = [];
    judged.inputs.length = 0;
    const record = app.recordEvent.bind(app);
    app.recordEvent = (async (userId, name, props) => { events.push({ name, props: props as Record<string, unknown> }); return record(userId, name, props); }) as typeof app.recordEvent;
  });

  it('on her confession day she writes once (before the delivery), and the message opens the confession', async () => {
    const { user, h } = await member();
    expect((await talent(h)).confession ?? null).toBeNull();
    await ready(h);
    expect((await talent(h)).confession).toEqual({ phase: 'due', sceneId: 'confession-mahiro', tonight: true, reachedToday: false });
    const first = await tick();
    const names = first.jobs.map((j) => j.name);
    expect(names.indexOf('confession.invite')).toBeLessThan(names.indexOf('inbox.deliver'));
    expect(first.jobs.find((j) => j.name === 'confession.invite')).toMatchObject({ status: 'ok', result: { sent: 1 } });
    const items = await repos.inbox.forUser(user.id, 10);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ star: 'mahiro', kind: 'message', payload: { text: LINES.mahiro.confession.inbox.ja, scene: 'confession-mahiro' } });
    expect(items[0].deliveredAt).not.toBeNull();
    await tick();
    expect(await repos.inbox.forUser(user.id, 10)).toHaveLength(1);
  });

  it('in production nothing is sent or offered while her lines are drafts (#84)', async () => {
    // Her lines are reviewed now (owner, 2026-09-28); the gate must still hold for a draft, so the flag is set here
    // (the job and the routes read LINES directly). The scripts themselves were built from the reviewed lines at load
    // (a draft script is `demo`, packages/shared tests), so the start is refused by her confession's own gate.
    const stars = Object.values(LINES);
    for (const l of stars) l.draft = true;
    try {
      const { user, h } = await member();
      await ready(h);
      const prod = await buildApp({ repos, logger: false, demo: false });
      expect((await tick(false)).jobs.find((j) => j.name === 'confession.invite')).toMatchObject({ result: { off: true } });
      expect(await repos.inbox.forUser(user.id, 10)).toHaveLength(0);
      expect(json(await prod.inject({ method: 'POST', url: '/v1/scene/start', headers: h, payload: { sceneId: 'confession-mahiro' } }))).toEqual({ error: 'scene_locked' });
      expect(await repos.sceneRuns.active(user.id)).toBeNull();
      const view = json(await prod.inject({ url: '/v1/relationship', headers: h })).talents.find((t: { star: string }) => t.star === 'mahiro');
      expect(view.confession ?? null).toBeNull();
    } finally {
      for (const l of stars) l.draft = false;
    }
  });

  it('in production, with her lines reviewed (#84), she writes, and the confession opens in the evening', async () => {
    const { user, h } = await member();
    await ready(h);
    const prod = await buildApp({ repos, logger: false, demo: false });
    expect((await tick(false)).jobs.find((j) => j.name === 'confession.invite')).toMatchObject({ status: 'ok', result: { sent: 1 } });
    const items = await repos.inbox.forUser(user.id, 10);
    expect(items).toEqual([expect.objectContaining({ star: 'mahiro', kind: 'message', payload: { text: LINES.mahiro.confession.inbox.ja, texts: expect.any(Object), scene: 'confession-mahiro' } })]);
    const view = json(await prod.inject({ url: '/v1/relationship', headers: h })).talents.find((t: { star: string }) => t.star === 'mahiro');
    expect(view.confession).toEqual({ phase: 'due', sceneId: 'confession-mahiro', tonight: true, reachedToday: false });
    const res = await prod.inject({ method: 'POST', url: '/v1/scene/start', headers: h, payload: { sceneId: 'confession-mahiro' } });
    expect(res.statusCode, res.payload).toBe(200);
    // Production keeps the evening: by day it waits for tonight.
    const other = await member();
    await ready(other.h);
    vi.setSystemTime(NOON);
    expect(json(await prod.inject({ method: 'POST', url: '/v1/scene/start', headers: other.h, payload: { sceneId: 'confession-mahiro' } }))).toEqual({ error: 'confession_tonight' });
  });

  it('by day she only hints (her greeting), in the evening the home opens on it', async () => {
    const { h } = await member();
    await ready(h);
    vi.setSystemTime(NOON);
    expect((await talent(h)).confession).toMatchObject({ phase: 'due', tonight: false });
    const hint = json(await get('/v1/chat/greeting?star=mahiro&lang=ja', h));
    expect(hint).toEqual({ text: LINES.mahiro.confession.hint.ja, cached: false });
    expect(json(await get('/v1/chat/greeting?star=mahiro&lang=en', h)).text).toBe(LINES.mahiro.confession.hint.en);
    vi.setSystemTime(EVENING);
    expect(json(await get('/v1/chat/greeting?star=mahiro&lang=ja', h)).text).toBe('model greeting');
  });

  it('only at confession_ready, and only the right scene for the round', async () => {
    const { h } = await member();
    expect(json(await start(h))).toEqual({ error: 'scene_locked' });
    await post('/v1/relationship/demo', { star: 'mahiro', stage: 'lover' }, h);
    expect(json(await start(h))).toEqual({ error: 'scene_locked' });
    await ready(h);
    expect(json(await start(h, 'confession-mahiro-again'))).toEqual({ error: 'scene_locked' });
    expect(json(await start(h, 'confession-nana'))).toEqual({ error: 'scene_locked' });
    // Demo mode waives the evening so the test site can be accepted by day.
    vi.setSystemTime(NOON);
    expect((await start(h)).statusCode).toBe(200);
  });

  it('yes: lovers, today is their anniversary, the memory card and his words, reached and answered once', async () => {
    const { user, h } = await member();
    await ready(h);
    const run = await confess(h, 'YES, I want to be with you');
    expect(run).toMatchObject({ status: 'ended', outcome: 'accepted' });
    expect(said(run)).toEqual(LINES.mahiro.confession.accept.map((t) => t.ja));
    expect(run.rewards.memories).toEqual([expect.objectContaining({ title: '告白' })]);
    expect(judged.inputs).toEqual([{ star: 'mahiro', lang: 'ja', text: 'YES, I want to be with you', ask: LINES.mahiro.confession.ask.ja }]);

    const view = await talent(h);
    expect(view).toMatchObject({ stage: 'lover', anniversary: jstDay(EVENING) });
    expect(view.confession ?? null).toBeNull();
    const me = json(await get('/v1/auth/me', h));
    expect(me.memories.map((m: { title: string }) => m.title)).toContain('告白');
    // #51: the card knows it is his yes, and which scene it was made in.
    expect((await repos.memories.forUser(user.id)).find((m) => m.id === run.rewards.memories[0].id)).toMatchObject({ kind: 'confession', sceneId: 'confession-mahiro' });
    const memories = json(await get('/v1/confession/memories', h)).memories;
    expect(memories).toEqual([{ memoryId: run.rewards.memories[0].id, star: 'mahiro', transcript: 'YES, I want to be with you', audio: false, createdAt: expect.any(String) }]);
    expect(events.filter((e) => e.name.startsWith('confession.'))).toEqual([
      { name: 'confession.reached', props: { star: 'mahiro' } },
      { name: 'confession.answered', props: { star: 'mahiro', answer: 'accept' } }
    ]);
    expect(events).toContainEqual({ name: 'stage.changed', props: { star: 'mahiro', from: 'confession_ready', to: 'lover' } });
    expect(events).toContainEqual({ name: 'scene.trigger', props: { star: 'mahiro', sceneId: 'confession-mahiro', source: 'proposed' } });
    // The admin's confession reach rate counts her.
    const metrics = await repos.events.metrics(jstDay(EVENING), jstDay(EVENING), 'all');
    expect(metrics[0]).toMatchObject({ newUsers: 1, confessed: 1 });

    // The same answer again (a retry after a dropped connection) changes nothing.
    const again = await post('/v1/scene/step', { runId: run.id, seq: run.seq - 1, input: 'YES' }, h);
    expect(json(again).replayed).toBe(true);
    expect(events.filter((e) => e.name === 'confession.answered')).toHaveLength(1);
    expect(json(await start(h))).toEqual({ error: 'scene_locked' });
    expect(user.id).toBeTruthy();
  });

  it('her confession-day message is read once the confession is played, and always shows in his language (U-29)', async () => {
    const { user, h } = await member();
    await ready(h);
    await tick();
    const [invite] = await repos.inbox.forUser(user.id, 10);
    expect(invite.payload.texts).toMatchObject({ 'zh-Hant': LINES.mahiro.confession.inbox['zh-Hant'], en: LINES.mahiro.confession.inbox.en });
    // He switched to zh-Hant after it was written: her line in his language. A row from before `texts` too.
    await repos.users.update(user.id, { lang: 'zh-Hant' });
    const at = new Date(EVENING).toISOString();
    await repos.inbox.add({ id: 'inb_old', userId: user.id, star: 'mahiro', kind: 'message', payload: { text: LINES.mahiro.confession.inbox.en, scene: 'confession-mahiro' }, dueAt: at, deliveredAt: at, readAt: null, createdAt: at });
    const shown = json(await get('/v1/inbox', h)).items as { id: string; readAt: string | null; payload: { text: string } }[];
    expect(shown.find((i) => i.id === invite.id)!.payload.text).toBe(LINES.mahiro.confession.inbox['zh-Hant']);
    expect(shown.find((i) => i.id === 'inb_old')!.payload.text).toBe(LINES.mahiro.confession.inbox['zh-Hant']);

    await confess(h, 'YES');
    // Played: what invited him to it is read — her room no longer leads with 「今晚有很重要的話…」.
    const after = json(await get('/v1/inbox', h)).items as { id: string; readAt: string | null }[];
    expect(after.filter((i) => i.id === invite.id || i.id === 'inb_old').every((i) => i.readAt)).toBe(true);
  });

  it('not yet: her gentle reply, never again the same day, again two days together later with her retry line', async () => {
    const { user, h } = await member();
    await ready(h);
    await tick();
    const run = await confess(h, 'まだ考えたい');
    expect(run.outcome).toBe('not_yet');
    expect(said(run)).toEqual(LINES.mahiro.confession.notYet.map((t) => t.ja));
    expect(run.rewards.memories).toEqual([]);
    expect((await talent(h))).toMatchObject({ stage: 'confession_ready', confession: { phase: 'waiting' } });
    expect(json(await start(h, 'confession-mahiro-again'))).toEqual({ error: 'confession_waiting' });
    expect(events).toContainEqual({ name: 'confession.answered', props: { star: 'mahiro', answer: 'not_yet' } });

    // Calendar days alone do not count: only days together.
    vi.setSystemTime(EVENING + 3 * DAY);
    expect((await talent(h)).confession?.phase).toBe('waiting');
    await tick();
    expect(await repos.inbox.forUser(user.id, 10)).toHaveLength(1);
    const days = (await repos.relationship.get(user.id, 'mahiro'))!.daysTogether;
    for (let i = 1; i <= CONFESSION_RULES.retryDays; i++) await repos.relationship.touch(user.id, 'mahiro', jstDay(EVENING + (3 + i) * DAY), new Date().toISOString());
    expect((await repos.relationship.get(user.id, 'mahiro'))!.daysTogether).toBe(days + CONFESSION_RULES.retryDays);
    expect((await talent(h)).confession).toMatchObject({ phase: 'due', sceneId: 'confession-mahiro-again' });
    await tick();
    const inbox = await repos.inbox.forUser(user.id, 10);
    expect(inbox).toHaveLength(2);
    expect(inbox.find((i) => i.payload.scene === 'confession-mahiro-again')?.payload.text).toBe(LINES.mahiro.confession.retry.ja);
    const second = await confess(h, 'YES', 'confession-mahiro-again');
    expect(second.outcome).toBe('accepted');
    expect((await talent(h)).stage).toBe('lover');
  });

  it('after three answers that are not yes she stops asking; he can bring it up himself', async () => {
    const { user, h } = await member();
    await ready(h);
    let t = EVENING;
    for (let i = 0; i < CONFESSION_RULES.maxAsks; i++) {
      const run = await confess(h, i === 1 ? 'NO, sorry' : 'hmm', i ? 'confession-mahiro-again' : 'confession-mahiro');
      expect(run.outcome).toBe(i === 1 ? 'declined' : 'not_yet');
      t += DAY;
      vi.setSystemTime(t);
      for (let k = 0; k < CONFESSION_RULES.retryDays; k++) await repos.relationship.touch(user.id, 'mahiro', jstDay(t + k * DAY), new Date().toISOString());
      t += DAY;
      vi.setSystemTime(t);
    }
    expect((await talent(h))).toMatchObject({ stage: 'confession_ready', confession: { phase: 'open', sceneId: 'confession-mahiro-again' } });
    const before = (await repos.inbox.forUser(user.id, 20)).length;
    await tick();
    expect(await repos.inbox.forUser(user.id, 20)).toHaveLength(before);
    expect((await confess(h, 'YES', 'confession-mahiro-again')).outcome).toBe('accepted');
  });

  it('silence is no answer: nothing is counted', async () => {
    const { h } = await member();
    await ready(h);
    const run = json(await start(h)).run as Run;
    vi.setSystemTime(EVENING + 301_000);
    const quiet = json(await post('/v1/scene/step', { runId: run.id, seq: run.seq, timeout: true }, h)).run as Run;
    expect(quiet.outcome).toBe('quiet');
    expect(judged.inputs).toHaveLength(0);
    expect((await talent(h)).confession).toMatchObject({ phase: 'due', sceneId: 'confession-mahiro', reachedToday: true });
    expect(events.filter((e) => e.name === 'confession.answered')).toHaveLength(0);
  });

  it('keeps the recording only with his consent, plays it to him alone, deletes it alone, and forgets all of it with the account', async () => {
    const a = await member();
    const b = await member();
    await ready(a.h);
    const run = await confess(a.h, 'YES');
    const id = run.rewards.memories[0].id;
    const clip = Buffer.from('fake-opus-bytes');
    const put = (h: Record<string, string>, query = '?consent=yes', type = 'audio/webm', body: Buffer = clip) =>
      app.inject({ method: 'PUT', url: `/v1/confession/memories/${id}/audio${query}`, headers: { ...h, 'content-type': type }, payload: body });
    expect((await put(a.h, '')).statusCode).toBe(400);
    expect(json(await put(a.h, '')).error).toBe('consent_required');
    expect((await put(a.h, '?consent=yes', 'text/plain')).statusCode).toBe(415);
    expect((await put(b.h)).statusCode).toBe(404);
    expect((await put(a.h, '?consent=yes', 'audio/webm', Buffer.alloc(CONFESSION_RULES.voiceMaxBytes + 1))).statusCode).toBe(413);
    const saved = await put(a.h);
    expect(saved.statusCode, saved.payload).toBe(200);
    expect(json(saved).memory).toMatchObject({ memoryId: id, audio: true, transcript: 'YES' });
    expect((await put(a.h)).statusCode).toBe(409);

    const play = await get(`/v1/confession/memories/${id}/audio`, a.h);
    expect(play.statusCode).toBe(200);
    expect(play.headers['content-type']).toMatch(/^audio\/webm/);
    expect(play.headers['cache-control']).toBe('private, no-store');
    expect(play.rawPayload.equals(clip)).toBe(true);
    expect((await get(`/v1/confession/memories/${id}/audio`, b.h)).statusCode).toBe(404);
    expect((await get(`/v1/confession/memories/${id}/audio`, {})).statusCode).toBe(401);

    const del = await app.inject({ method: 'DELETE', url: `/v1/confession/memories/${id}/audio`, headers: a.h });
    expect(json(del).memory).toMatchObject({ audio: false, transcript: 'YES' });
    expect((await get(`/v1/confession/memories/${id}/audio`, a.h)).statusCode).toBe(404);
    expect((await put(a.h)).statusCode).toBe(200);

    const gone = await app.inject({ method: 'DELETE', url: '/v1/auth/me', headers: a.h, payload: { confirm: 'DELETE' } });
    expect(gone.statusCode, gone.payload).toBe(200);
    expect(await repos.confessions.voices(a.user.id)).toEqual([]);
    expect(await repos.confessions.audio(a.user.id, id)).toBeNull();
    expect(await repos.confessions.get(a.user.id, 'mahiro')).toBeNull();
  });

  it('demo: setting the stage again starts her confession over', async () => {
    const { user, h } = await member();
    await ready(h);
    await tick();
    await confess(h, 'hmm');
    expect((await talent(h)).confession?.phase).toBe('waiting');
    await ready(h);
    expect((await talent(h)).confession).toMatchObject({ phase: 'due', sceneId: 'confession-mahiro' });
    await tick();
    expect(await repos.inbox.forUser(user.id, 10)).toHaveLength(2);
  });
});

describe('the judge client never turns doubt into a yes', () => {
  it('reads only a confident, well-formed accept as accept; errors, timeouts and junk are "not yet"', async () => {
    const { judgeConfession } = await vi.importActual<typeof import('../src/lib/confessionJudge')>('../src/lib/confessionJudge');
    const input = { star: 'mahiro' as const, lang: 'ja' as const, text: 'はい', ask: '？' };
    const reply = (status: number, body: unknown) => (async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch;
    expect(await judgeConfession(input, reply(200, { answer: 'accept', confident: true }))).toEqual({ answer: 'accept', confident: true, source: 'agent' });
    expect((await judgeConfession(input, reply(200, { answer: 'accept', confident: false }))).answer).toBe('not_yet');
    expect((await judgeConfession(input, reply(200, { answer: 'decline', confident: true }))).answer).toBe('decline');
    expect((await judgeConfession(input, reply(200, 'accept'))).answer).toBe('not_yet');
    expect(await judgeConfession(input, reply(503, {}))).toEqual({ answer: 'not_yet', confident: false, source: 'fallback' });
    const broken = (async () => new Response('not json', { status: 200 })) as unknown as typeof fetch;
    expect((await judgeConfession(input, broken)).answer).toBe('not_yet');
    const down = (async () => { throw new TypeError('fetch failed'); }) as unknown as typeof fetch;
    expect(await judgeConfession(input, down)).toEqual({ answer: 'not_yet', confident: false, source: 'fallback' });
  });
});

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { RULES, SCENE_RULES, STAGE_RULES } from '@jstar/shared';
import { signJwt } from '../src/lib/crypto';
import { createMemoryRepos } from '../src/db/memory';
import { createSqlRepos } from '../src/db/sql';
import { MAIN_SCENES, pendingMedia } from '@jstar/shared/scenes';
import { SCRIPTS } from '../src/lib/sceneTriggers';
import { SEED_CARDS } from '../src/db/seed';
import type { Repos } from '../src/db/types';
import { newUserRow } from '../src/lib/account';
import { env } from '../src/env';
import { buildApp } from '../src/app';
import { createSqliteClient } from './sqlite';

// The persona service has its own suite; this fake follows its contract (see api.test.ts): BLOCK is hard-blocked,
// anything else is echoed back. A "JUMP" turn carries a directive to a step the script does not declare as a jump,
// which the scene must not follow (#65; declared jumps: scene-triggers.test.ts).
vi.mock('../src/lib/agent', () => {
  const answer = (input: { text: string }) => {
    if (input.text === 'BLOCK') return { reply: '', blocked: true, reason: 'minor' };
    return { reply: `echo:${input.text}`, blocked: false, boundary: null, memory: null, cardTitle: null, directive: input.text === 'JUMP' ? { jumpTo: 'end' } : undefined };
  };
  return {
    askPersona: async (input: { text: string }) => answer(input),
    streamPersona: async function* () { yield { type: 'error', error: 'unused' }; },
    greetPersona: async () => 'hi'
  };
});

const BACKENDS: [string, () => Repos][] = [
  ['memory', () => createMemoryRepos({ cards: SEED_CARDS })],
  ['sql', () => createSqlRepos(createSqliteClient())]
];
const SCENE = 'demo-evening';

let app: FastifyInstance;
let repos: Repos;

async function member() {
  const user = await repos.users.create({ ...newUserRow({ email: `${Math.random()}@example.com`, lineSub: null, nickname: 'u', via: 'email', lang: 'ja' }) });
  return { user, h: { authorization: `Bearer ${signJwt({ sub: user.id }, env.JWT_SECRET, 3600)}` } };
}
const json = (res: { payload: string }) => JSON.parse(res.payload);
const post = (url: string, payload: object, headers: Record<string, string>) => app.inject({ method: 'POST', url, headers, payload });
const get = (url: string, headers: Record<string, string>) => app.inject({ url, headers });
const me = async (h: Record<string, string>) => json(await get('/v1/auth/me', h));
type Run = { id: string; seq: number; status: string; outcome: string | null; beats: { id: string; type: string; agent?: boolean; text?: { ja: string } }[];
  waiting: { id: string; type: string } | null; upcoming: string[]; rewardable: boolean; affinityXp: number;
  rewards: { affinity: number; memories: { title: string }[]; promises: { text: string; dueAt: string }[] } };
const ids = (r: Run) => r.beats.map((b) => b.id);

async function start(h: Record<string, string>): Promise<Run> {
  const res = await post('/v1/scene/start', { sceneId: SCENE }, h);
  expect(res.statusCode).toBe(200);
  return json(res).run;
}
async function step(h: Record<string, string>, run: Run, answer: object): Promise<{ run: Run; replayed: boolean }> {
  const res = await post('/v1/scene/step', { runId: run.id, seq: run.seq, ...answer }, h);
  expect(res.statusCode, res.payload).toBe(200);
  return json(res);
}
/** Plays the demo scene to its end: a choice, then free talk. */
async function playThrough(h: Record<string, string>, choice = 'missed') {
  const first = await start(h);
  const talk = (await step(h, first, { choice })).run;
  return (await step(h, talk, { input: '今日は雨だった' })).run;
}

afterEach(() => { vi.useRealTimers(); });

describe.each(BACKENDS)('scene engine (%s store)', (_name, makeRepos) => {
  beforeEach(async () => {
    repos = makeRepos();
    app = await buildApp({ repos, logger: false, demo: true });
  });

  it('needs a session, and keeps the demo scene out of production', async () => {
    expect((await post('/v1/scene/start', { sceneId: SCENE }, {})).statusCode).toBe(401);
    expect((await get('/v1/scene/current', {})).statusCode).toBe(401);
    const { h } = await member();
    expect(json(await post('/v1/scene/start', { sceneId: 'no-such-scene' }, h))).toEqual({ error: 'scene_not_found' });
    const prod = await buildApp({ repos, logger: false, demo: false });
    const res = await prod.inject({ method: 'POST', url: '/v1/scene/start', headers: h, payload: { sceneId: SCENE } });
    expect(res.statusCode).toBe(404);
  });

  it('starts the five in production as on the test site, now that #80\'s clips exist, with their conditions applied', async () => {
    // The publish rule (owner, 2026-09-28): their lines are reviewed (#82, #84) and every clip is made (#80).
    const prod = await buildApp({ repos, logger: false, demo: false });
    for (const on of [prod, app]) {
      const { h } = await member();
      for (const s of MAIN_SCENES) {
        expect(pendingMedia([s]), s.meta.id).toEqual([]);
        // Played as written: nothing stands in.
        expect(SCRIPTS.get(s.meta.id), s.meta.id).toEqual(s);
        const res = await on.inject({ method: 'POST', url: '/v1/scene/start', headers: h, payload: { sceneId: s.meta.id } });
        expect([200, 403], `${s.meta.id}: ${res.payload}`).toContain(res.statusCode);
        if (res.statusCode === 403) expect(json(res)).toEqual({ error: 'scene_locked' });
      }
    }
  });

  it('starts with the wide shot and her line, waits on the choice, and names the clips to preload', async () => {
    const { h } = await member();
    const run = await start(h);
    expect(ids(run)).toEqual(['wide', 'hello', 'ask']);
    expect(run.waiting).toMatchObject({ id: 'ask', type: 'choice' });
    expect(run.seq).toBe(0);
    expect(run.upcoming).toEqual(['mahiro-night']);
    expect(run.rewardable).toBe(true);
  });

  it('branches on the choice and pays the option reward on the server', async () => {
    const a = await member();
    const missed = (await step(a.h, await start(a.h), { choice: 'missed' })).run;
    expect(ids(missed)).toEqual(['ask~missed', 'missed', 'away', 'empty', 'close', 'late', 'talk']);
    expect(missed.affinityXp).toBe(5);
    const b = await member();
    const tired = (await step(b.h, await start(b.h), { choice: 'tired' })).run;
    expect(ids(tired).slice(0, 2)).toEqual(['ask~tired', 'tired']);
    expect((await me(b.h)).affinity.mahiro).toBe(3);
    expect(json(await post('/v1/scene/step', { runId: tired.id, seq: tired.seq, choice: 'nope' }, b.h))).toEqual({ error: 'invalid_submission' });
  });

  it('treats the same step submitted twice as one, including in parallel', async () => {
    const { h } = await member();
    const run = await start(h);
    const once = await step(h, run, { choice: 'missed' });
    const again = await step(h, run, { choice: 'missed' });
    expect(once.replayed).toBe(false);
    expect(again.replayed).toBe(true);
    expect(again.run.seq).toBe(1);
    expect((await me(h)).affinity.mahiro).toBe(5);
    // A different answer to an already answered step is not applied either.
    expect((await step(h, run, { choice: 'tired' })).run.seq).toBe(1);
    expect((await post('/v1/scene/step', { runId: run.id, seq: 5, choice: 'missed' }, h)).statusCode).toBe(409);

    const other = await member();
    const r2 = await start(other.h);
    const both = await Promise.all([step(other.h, r2, { choice: 'missed' }), step(other.h, r2, { choice: 'tired' })]);
    expect(both.filter((x) => !x.replayed)).toHaveLength(1);
    expect([5, 3]).toContain((await me(other.h)).affinity.mahiro);
  });

  it('D-N2: a leftover answer to a step the run took already is a repeat, never a 409 on the step it waits on now', async () => {
    const { h } = await member();
    const run = await start(h);
    const talk = (await step(h, run, { step: 'ask', choice: 'missed' })).run;
    expect(talk).toMatchObject({ seq: 1, waiting: { id: 'talk' } });
    // Her countdown on 「ask」, run out after he had answered it, sent with the run's seq now: without the step's name
    // the server can only read it as a timeout of 「talk」, 90 s early — the 409 the player showed as 「沒有送達。」.
    const blind = await post('/v1/scene/step', { runId: run.id, seq: talk.seq, timeout: true }, h);
    expect(blind.statusCode).toBe(409);
    expect(json(blind)).toEqual({ error: 'too_early' });
    // Naming the step it is for, it is what it is: an answer to a step the run is past. Nothing moves, nothing is refused.
    const leftover = await post('/v1/scene/step', { runId: run.id, seq: talk.seq, step: 'ask', timeout: true }, h);
    expect(leftover.statusCode, leftover.payload).toBe(200);
    expect(json(leftover)).toMatchObject({ replayed: true, run: { seq: 1, status: 'active', waiting: { id: 'talk' } } });
    // Nor is any other answer for it applied to 「talk」 (here, as the free talk it would have been taken for).
    expect(json(await post('/v1/scene/step', { runId: run.id, seq: talk.seq, step: 'ask', input: 'こんばんは' }, h))).toMatchObject({ replayed: true, run: { seq: 1 } });
    expect((await me(h)).affinity.mahiro).toBe(5);
    // The same answer at the seq it was given at stays a plain repeat; the step the run waits on still takes his answer.
    expect((await step(h, run, { step: 'ask', timeout: true })).replayed).toBe(true);
    const done = await step(h, talk, { step: 'talk', input: '今日は雨だった' });
    expect(done).toMatchObject({ replayed: false, run: { status: 'ended' } });
  });

  it('resumes after a reload: current run, the run by id, and starting the same scene again', async () => {
    const { h } = await member();
    const run = (await step(h, await start(h), { choice: 'tired' })).run;
    const current = json(await get('/v1/scene/current', h)).run;
    expect(current).toMatchObject({ id: run.id, seq: 1, status: 'active', waiting: { id: 'talk' } });
    expect(ids(current)).toEqual(ids(run));
    expect(json(await get('/v1/scene/current?star=nana', h)).run).toBeNull();
    expect(json(await get(`/v1/scene/runs/${run.id}`, h)).run.seq).toBe(1);
    const again = json(await post('/v1/scene/start', { sceneId: SCENE }, h));
    expect(again).toMatchObject({ replayed: true, run: { id: run.id, seq: 1 } });
    // Someone else's run is not visible.
    const other = await member();
    expect((await get(`/v1/scene/runs/${run.id}`, other.h)).statusCode).toBe(404);
  });

  it('hands free talk to the chat path: her reply is her line, the message counts and is kept', async () => {
    const { h } = await member();
    const talk = (await step(h, await start(h), { choice: 'missed' })).run;
    const left = (await me(h)).chat.left;
    const done = (await step(h, talk, { input: 'JUMP' })).run;
    expect(done.beats[0]).toMatchObject({ id: 'talk~reply', type: 'line', agent: true, text: { ja: 'echo:JUMP' } });
    // The directive names a step the script does not offer as a jump: the scene carries on as written.
    expect(ids(done).slice(1, 3)).toEqual(['thanks', 'reward']);
    expect((await me(h)).chat.left).toBe(left - 1);
    const history = json(await get('/v1/chat/history?star=mahiro', h)).messages.map((m: { text: string }) => m.text);
    expect(history).toEqual(['JUMP', 'echo:JUMP']);
  });

  it('a blocked free-talk message moves nothing and is not counted', async () => {
    const { h } = await member();
    const talk = (await step(h, await start(h), { choice: 'missed' })).run;
    const left = (await me(h)).chat.left;
    const res = await post('/v1/scene/step', { runId: talk.id, seq: talk.seq, input: 'BLOCK' }, h);
    expect(res.statusCode).toBe(422);
    expect(json(await get('/v1/scene/current', h)).run.seq).toBe(talk.seq);
    expect((await me(h)).chat.left).toBe(left);
  });

  it('ends with a memory card, affinity and a promise, paid once per scene per day', async () => {
    const { h, user } = await member();
    const done = await playThrough(h);
    expect(done).toMatchObject({ status: 'ended', outcome: 'complete', waiting: null });
    expect(ids(done).slice(-3)).toEqual(['reward', 'bye', 'end']);
    expect(done.rewards.affinity).toBe(15);
    expect(done.rewards.memories).toMatchObject([{ title: 'おかえりの夜' }]);
    expect(done.rewards.promises[0].text).toBe('明日も、ここで待ってるね');
    const after = await me(h);
    // 5 (choice) + 10 (the ending) + the free-talk message's own chat XP.
    expect(after.affinity.mahiro).toBe(15 + RULES.xpPerMessage);
    expect(after.memories).toEqual([expect.objectContaining({ star: 'mahiro', title: 'おかえりの夜' })]);
    // #51: a scene card, and which scene.
    expect(await repos.memories.forUser(user.id)).toEqual([expect.objectContaining({ kind: 'scene', sceneId: SCENE })]);
    // Level 1 → 1 at 23 XP: no free pull yet. A second play the same day plays but pays nothing.
    expect(after.wallet.freePulls).toBe(user.freePulls);
    const replay = await playThrough(h);
    expect(replay.rewardable).toBe(false);
    expect(replay.rewards).toMatchObject({ affinity: 0, memories: [], promises: [] });
    expect((await me(h)).memories).toHaveLength(1);
    expect((await me(h)).affinity.mahiro).toBe(15 + 2 * RULES.xpPerMessage);
    // The ended run still reads back the same after a reload.
    expect(json(await get(`/v1/scene/runs/${done.id}`, h)).run).toMatchObject({ status: 'ended', rewards: { memories: [{ title: 'おかえりの夜' }] } });
  });

  it('is a day together, and pays a free pull for a stage entered in a scene, like chat does (#54)', async () => {
    const { h, user } = await member();
    // Two days together already, 2 XP short of the next stage: the scene's +5 moves them on.
    await repos.relationship.touch(user.id, 'mahiro', '2000-01-01', new Date().toISOString());
    await repos.relationship.touch(user.id, 'mahiro', '2000-01-02', new Date().toISOString());
    await repos.affinity.add(user.id, 'mahiro', STAGE_RULES.stages.new.xp - 2);
    await step(h, await start(h), { choice: 'missed' });
    expect((await me(h)).wallet.freePulls).toBe(user.freePulls + 1);
    expect(await repos.relationship.get(user.id, 'mahiro')).toMatchObject({ stage: 'familiar', daysTogether: 3 });
  });

  it('refuses a countdown answer before the countdown ends, and takes it after', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const { h } = await member();
    const run = await start(h);
    const early = await post('/v1/scene/step', { runId: run.id, seq: 0, timeout: true }, h);
    expect(json(early)).toEqual({ error: 'too_early' });
    vi.setSystemTime(Date.now() + 45_000);
    expect(ids((await step(h, run, { timeout: true })).run).slice(0, 2)).toEqual(['quiet', 'away']);
  });

  it('ends by itself after 30 minutes, and on request (idle or leaving) without taking anything back', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const a = await member();
    const run = (await step(a.h, await start(a.h), { choice: 'missed' })).run;
    vi.setSystemTime(Date.now() + SCENE_RULES.maxRunMs + 1000);
    expect(json(await get('/v1/scene/current', a.h)).run).toBeNull();
    const late = await step(a.h, run, { input: 'still here?' });
    expect(late).toMatchObject({ replayed: true, run: { status: 'ended', outcome: 'timeout' } });
    expect((await me(a.h)).affinity.mahiro).toBe(5);
    vi.useRealTimers();

    const b = await member();
    const r = (await step(b.h, await start(b.h), { choice: 'tired' })).run;
    const ended = json(await post('/v1/scene/end', { runId: r.id, reason: 'idle' }, b.h));
    expect(ended.run).toMatchObject({ status: 'ended', outcome: 'idle', rewards: { affinity: 3 } });
    expect(json(await post('/v1/scene/end', { runId: r.id }, b.h)).replayed).toBe(true);
    expect((await me(b.h)).affinity.mahiro).toBe(3);
    // A new run can start at once.
    expect((await start(b.h)).id).not.toBe(r.id);
  });

  it('keeps one active run per user in storage and forgets runs on account deletion', async () => {
    const { h, user } = await member();
    const run = await start(h);
    const stored = (await repos.sceneRuns.byId(run.id))!;
    expect(await repos.sceneRuns.start({ ...stored, id: 'scn_second' }, { affinity: 50, memories: [] })).toBe(false);
    expect(await repos.affinity.get(user.id, 'mahiro')).toBe(0);
    const del = await app.inject({ method: 'DELETE', url: '/v1/auth/me', headers: h, payload: { confirm: 'DELETE' } });
    expect(del.statusCode).toBe(200);
    expect(await repos.sceneRuns.byId(run.id)).toBeNull();
  });
});

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { HER_MESSAGE_RULES, STAR_IDS, WORLD, addDays, type StarId } from '@jstar/shared';
import { HER_MESSAGE_LINES, inQuietHours, lastNight, herLocalClock, planDay, herZonedInstant } from '@jstar/shared/herMessages';
import { signJwt } from '../src/lib/crypto';
import { createMemoryRepos } from '../src/db/memory';
import { createSqlRepos } from '../src/db/sql';
import { SEED_CARDS } from '../src/db/seed';
import type { HerMessageRow, Repos, UserRow } from '../src/db/types';
import { newUserRow } from '../src/lib/account';
import { env } from '../src/env';
import { buildApp } from '../src/app';
import { runTick } from '../src/lib/tick';
import { JOBS } from '../src/jobs';
import { planHerMessages, sendHerMessages } from '../src/jobs/herMessages';
import { deliverInbox } from '../src/jobs/deliverInbox';
import type { HerMessageInput } from '../src/lib/agent';
import { inviteScene, type HerMessages } from '../src/lib/herMessages';
import type { SendPush } from '../src/lib/push';
import { createSqliteClient } from './sqlite';

const BACKENDS: [string, () => Repos][] = [
  ['memory', () => createMemoryRepos({ cards: SEED_CARDS })],
  ['sql', () => createSqlRepos(createSqliteClient())]
];
const silent = { info() {}, error() {} };
const json = (res: { payload: string }) => JSON.parse(res.payload);
/** Monday 5 October 2026: every clock below is on this day or around it. */
const D = '2026-10-05';
const jst = (day: string, h: number, m = 0) => new Date(`${day}T${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:00+09:00`);
const ALL_FALLBACK = new Set(Object.values(HER_MESSAGE_LINES).flatMap((byLang) => Object.values(byLang).flat()));
const JOBS_HERE = [planHerMessages, sendHerMessages, deliverInbox];

describe('her messages: the day plan (#58)', () => {
  it('reads his clock in his zone, and JST when he has none or one nobody knows', () => {
    const at = Date.parse('2026-10-05T03:00:00Z');
    expect(herLocalClock(at, null)).toEqual({ day: '2026-10-05', minutes: 12 * 60 });
    expect(herLocalClock(at, 'Mars/Olympus')).toEqual({ day: '2026-10-05', minutes: 12 * 60 });
    expect(herLocalClock(at, 'Asia/Taipei')).toEqual({ day: '2026-10-05', minutes: 11 * 60 });
    expect(herLocalClock(at, 'America/Los_Angeles')).toEqual({ day: '2026-10-04', minutes: 20 * 60 });
    expect(new Date(herZonedInstant('2026-10-05', 9 * 60, 'Europe/London')).toISOString()).toBe('2026-10-05T08:00:00.000Z');
    // Across a DST change: the wall clock is still right.
    expect(new Date(herZonedInstant('2026-11-01', 12 * 60, 'America/New_York')).toISOString()).toBe('2026-11-01T17:00:00.000Z');
    expect(lastNight(D, null)).toEqual({ from: jst('2026-10-04', 18).getTime(), to: jst(D, 5).getTime() });
  });

  it('keeps his night quiet: 22:00–07:00', () => {
    expect([21, 22, 3, 6, 7, 12].map((h) => inQuietHours(h * 60))).toEqual([false, true, true, true, false, false]);
  });

  it('plans the dream after an evening together, then the invitation, then a note — as many as his setting allows', () => {
    const base = { userId: 'usr_a', day: D, nowMinutes: 6 * 60, tz: null, star: 'nana' as StarId };
    const kinds = (p: Parameters<typeof planDay>[0]) => planDay(p).map((x) => `${x.kind}:${x.star}`);
    expect(kinds({ ...base, mode: 'normal', dreamStar: null })).toEqual(['invite:nana', 'note:nana']);
    expect(kinds({ ...base, mode: 'normal', dreamStar: 'eimi' })).toEqual(['dream:eimi', 'invite:nana']);
    expect(kinds({ ...base, mode: 'less', dreamStar: null })).toEqual(['invite:nana']);
    expect(kinds({ ...base, mode: 'off', dreamStar: 'eimi' })).toEqual([]);
    // Each inside its window, never in his night, at a time of its own.
    for (const p of planDay({ ...base, mode: 'normal', dreamStar: 'eimi' })) {
      const [from, to] = HER_MESSAGE_RULES.windows[p.kind];
      expect(p.dueAt).toBeGreaterThanOrEqual(jst(D, from).getTime());
      expect(p.dueAt).toBeLessThan(jst(D, to).getTime());
    }
    const spread = new Set(Array.from({ length: 20 }, (_, i) => planDay({ ...base, userId: `usr_${i}`, mode: 'normal', dreamStar: null })[0].dueAt));
    expect(spread.size).toBeGreaterThan(10);
    // A window already over is not planned; a new user mid-window gets the rest of it.
    const late = planDay({ ...base, nowMinutes: 17 * 60, mode: 'normal', dreamStar: 'eimi' });
    expect(late.map((p) => p.kind)).toEqual(['invite']);
    expect(late[0].dueAt).toBeGreaterThanOrEqual(jst(D, 17).getTime());
  });
});

describe.each(BACKENDS)('her messages through the tick (%s store)', (_name, makeRepos) => {
  let app: FastifyInstance;
  let repos: Repos;
  let asked: HerMessageInput[];
  let answer: (i: HerMessageInput) => Promise<string | null>;
  let her: HerMessages;
  const cap = HER_MESSAGE_RULES.dailyCap;

  beforeEach(async () => {
    repos = makeRepos();
    asked = [];
    answer = async (i) => `${i.kind}:${i.star}、あなたのこと考えてた。`;
    her = { write: async (i) => { asked.push(i); return answer(i); }, demo: true };
    app = await buildApp({ repos, logger: false, demo: true, her });
  });
  afterEach(() => { (HER_MESSAGE_RULES as { dailyCap: number }).dailyCap = cap; vi.useRealTimers(); });

  async function member(patch: Partial<UserRow> = {}) {
    const user = await repos.users.create({ ...newUserRow({ email: `${Math.random()}@example.com`, lineSub: null, nickname: 'ケンタ', via: 'email', lang: 'ja' }), ...patch });
    return { user, h: { authorization: `Bearer ${signJwt({ sub: user.id }, env.JWT_SECRET, 3600)}` } };
  }
  /** He talked with her at `at`: a message of his, and the day counted as a day together. */
  async function talk(userId: string, star: StarId, at: Date) {
    await repos.messages.add({ id: `msg_${Math.random()}`, ownerId: userId, star, role: 'user', text: 'やあ', createdAt: at.toISOString() });
    await repos.relationship.touch(userId, star, herLocalClock(at.getTime(), null).day, at.toISOString());
  }
  const tick = (at: Date, jobs = JOBS_HERE, sendPush?: SendPush) => runTick(repos, jobs, { log: silent, clock: () => at.getTime(), her, sendPush });
  const inbox = async (h: Record<string, string>) => json(await app.inject({ url: '/v1/inbox', headers: h })) as { items: { id: string; star: string; kind: string; payload: Record<string, unknown> }[]; unread: number };
  const sent = (r: Awaited<ReturnType<typeof tick>>) => r.jobs.find((j) => j.name === 'her-messages.send')?.result as Record<string, unknown> | null;

  it('writes an active user his day — a note and tonight\'s invitation — once, however often the tick comes; an inactive one gets nothing', async () => {
    const { user, h } = await member();
    await talk(user.id, 'mahiro', jst(addDays(D, -2), 12));
    const gone = await member();
    await talk(gone.user.id, 'nana', jst(addDays(D, -(HER_MESSAGE_RULES.activeDays + 1)), 12));

    const plan = await tick(jst(D, 6));
    expect(plan.jobs[0]).toMatchObject({ name: 'her-messages.plan', status: 'ok', result: { users: 1, planned: 2 } });
    expect((await inbox(h)).items).toEqual([]);

    // Late in the note's window: the note is due, the invitation not yet.
    const noon = await tick(jst(D, 15, 59));
    expect(sent(noon)).toMatchObject({ model: 1, fallback: 0 });
    let items = (await inbox(h)).items;
    expect(items).toEqual([expect.objectContaining({ star: 'mahiro', kind: 'message', payload: { text: 'note:mahiro、あなたのこと考えてた。', herMessage: 'note', lang: 'ja' } })]);
    // The invitation, with the scene she has for tonight: her signature scene.
    await tick(jst(D, 19, 59));
    items = (await inbox(h)).items;
    expect(items.map((i) => i.payload.herMessage).sort()).toEqual(['invite', 'note']);
    expect(items.find((i) => i.payload.herMessage === 'invite')!.payload).toMatchObject({ sceneId: WORLD.mahiro.signatureScene.id });
    // Production invites only to what it may play (the publish rule): the five are reviewed and #80's clips exist, so
    // production invites to her signature scene too.
    for (const star of STAR_IDS) {
      expect(inviteScene(star, true), star).toBe(WORLD[star].signatureScene.id);
      expect(inviteScene(star, false), star).toBe(WORLD[star].signatureScene.id);
    }

    // Idempotent: more ticks the same day (and the plan job again) write and ask nothing more.
    await tick(jst(D, 19, 59));
    await tick(jst(D, 20));
    await tick(jst(D, 21));
    expect((await inbox(h)).items).toHaveLength(2);
    expect(asked).toHaveLength(2);
    expect((await inbox(gone.h)).items).toEqual([]);
    expect(await repos.herMessages.sentOn(user.id, D)).toBe(2);
  });

  it('tells the persona service who he is, where they stand, what she is doing and her weather', async () => {
    const { user } = await member();
    await talk(user.id, 'nana', jst(addDays(D, -1), 12));
    await repos.chatMemory.save(user.id, 'nana', { name: 'ケンタ', job: '看護師' }, '夜勤の多い看護師');
    const at = jst(D, 15, 59);
    // Her own city (長野, confirmed by the owner 2026-09-28).
    await repos.weather.saved('nagano', 36.6, 138.2, new Date(at.getTime() - 10 * 60_000).toISOString(), {
      code: 61, tempC: 18.4, precipMm: 1.2, snowCm: 0, windMs: 2, gustMs: 4, utcOffsetSeconds: 32400, alert: null, next6h: [],
      days: [{ date: D, sunrise: jst(D, 5, 40).toISOString(), sunset: jst(D, 17, 20).toISOString() }]
    });
    await tick(jst(D, 6));
    await tick(at);
    expect(asked).toEqual([expect.objectContaining({
      star: 'nana', kind: 'note', lang: 'ja', userId: user.id, callName: 'ケンタさん',
      memory: { facts: { name: 'ケンタ', job: '看護師' }, summary: '夜勤の多い看護師' }, stage: 'new', daysTogether: 1,
      status: 'Out and about', weather: 'rain, 18°C', scene: null
    })]);
    expect(asked[0]).not.toHaveProperty('nickname'); // round 10: the account nickname is never sent as his name
  });

  it('writes the dream the morning after an evening together — with her he was with — and none without one', async () => {
    const { user, h } = await member();
    await talk(user.id, 'mahiro', jst(addDays(D, -3), 12));
    await talk(user.id, 'eimi', jst(addDays(D, -1), 21, 30));
    const quiet = await member();
    await talk(quiet.user.id, 'eimi', jst(addDays(D, -1), 12));

    await tick(jst(D, 6));
    await tick(jst(D, 10, 59));
    expect((await inbox(h)).items).toEqual([expect.objectContaining({ star: 'eimi', payload: { text: 'dream:eimi、あなたのこと考えてた。', herMessage: 'dream', lang: 'ja' } })]);
    expect((await inbox(quiet.h)).items).toEqual([]);
    // With the dream and the invitation his day is full: no note.
    await tick(jst(D, 15, 59));
    await tick(jst(D, 19, 59));
    expect((await inbox(h)).items.map((i) => i.payload.herMessage).sort()).toEqual(['dream', 'invite']);
    expect((await inbox(quiet.h)).items.map((i) => i.payload.herMessage).sort()).toEqual(['invite', 'note']);
  });

  it('plans and sends by his own clock: another zone waits for his morning', async () => {
    const tokyo = await member();
    const la = await member({ tz: 'America/Los_Angeles' });
    const odd = await member({ tz: 'Mars/Olympus' });
    for (const u of [tokyo, la, odd]) await talk(u.user.id, 'nana', jst(addDays(D, -1), 12));

    // 13:00 JST is 21:00 the day before in Los Angeles: only the Tokyo clocks (and the unknown zone, read as JST) plan.
    expect((await tick(jst(D, 13))).jobs[0].result).toMatchObject({ users: 2 });
    // 06:00 in Los Angeles (22:00 JST, too late to plan in Tokyo): his day, his windows.
    const laMorning = new Date(herZonedInstant(D, 6 * 60, 'America/Los_Angeles'));
    expect((await tick(laMorning)).jobs[0].result).toMatchObject({ users: 1 });
    await tick(new Date(herZonedInstant(D, 15 * 60 + 59, 'America/Los_Angeles')));
    const items = (await inbox(la.h)).items;
    expect(items).toEqual([expect.objectContaining({ payload: expect.objectContaining({ herMessage: 'note' }) })]);
  });

  it('never sends in his night: a message whose window passed while the tick was down is dropped', async () => {
    const { user, h } = await member();
    await talk(user.id, 'nana', jst(addDays(D, -1), 12));
    await tick(jst(D, 6));
    const night = await tick(jst(D, 23, 30));
    expect(sent(night)).toMatchObject({ skipped: { quiet: 2 } });
    expect((await inbox(h)).items).toEqual([]);
    // The next day the tick comes back only at 21:00, past both windows (and their grace): late, never sent.
    await tick(jst(addDays(D, 1), 6));
    expect(sent(await tick(jst(addDays(D, 1), 21)))).toMatchObject({ skipped: { late: 2 } });
    expect((await inbox(h)).items).toEqual([]);
  });

  it('stops at the daily cap for everyone but monthly-pass holders', async () => {
    (HER_MESSAGE_RULES as { dailyCap: number }).dailyCap = 1;
    const a = await member();
    const b = await member();
    const pass = await member({ passUntil: jst(addDays(D, 20), 0).toISOString() });
    for (const u of [a, b, pass]) await talk(u.user.id, 'nana', jst(addDays(D, -1), 12));
    await tick(jst(D, 6));
    const r = sent(await tick(jst(D, 15, 59))) as { model: number; skipped: { cap: number } };
    const got = await Promise.all([a, b, pass].map(async (u) => (await inbox(u.h)).items.length));
    // The pass holder always gets his; of the other two, only one fits under the cap, and only if he came first.
    expect(got[2]).toBe(1);
    expect(got[0] + got[1]).toBeLessThanOrEqual(1);
    expect(r.model).toBe(1 + got[0] + got[1]);
    expect(r.skipped.cap).toBe(2 - got[0] - got[1]);
    // A skipped message was never written: the model was asked only for what was sent.
    expect(asked).toHaveLength(r.model);
  });

  it('falls back to her own line when the model fails, writes too long, or a run died after taking it', async () => {
    const { user, h } = await member();
    await talk(user.id, 'nana', jst(addDays(D, -1), 12));
    answer = async () => { throw new Error('agent_unavailable'); };
    await tick(jst(D, 6));
    expect(sent(await tick(jst(D, 15, 59)))).toMatchObject({ model: 0, fallback: 1 });
    answer = async () => 'あ'.repeat(200);
    expect(sent(await tick(jst(D, 19, 59)))).toMatchObject({ model: 0, fallback: 1 });
    const items = (await inbox(h)).items;
    expect(items).toHaveLength(2);
    for (const i of items) expect(ALL_FALLBACK.has(String(i.payload.text))).toBe(true);
    expect(asked).toHaveLength(2);

    // The next day a run took his note and died before writing it: after the lease it goes out without asking again.
    const next = addDays(D, 1);
    await tick(jst(next, 6));
    const note = (await repos.herMessages.due(jst(next, 16).toISOString(), '', 10)).find((r) => r.kind === 'note')!;
    expect(await repos.herMessages.take(note, jst(next, 15).toISOString(), '')).toBe(true);
    answer = async () => 'ちゃんと書けたよ。';
    asked.length = 0;
    expect(sent(await tick(jst(next, 15, 5)))).toEqual({ due: 0 });
    expect(sent(await tick(jst(next, 15, 11)))).toMatchObject({ model: 0, fallback: 1 });
    expect(asked).toEqual([]);
    const today = (await inbox(h)).items.filter((i) => i.payload.herMessage === 'note');
    expect(today).toHaveLength(2);
    for (const i of today) expect(ALL_FALLBACK.has(String(i.payload.text))).toBe(true);
  });

  it('lets him choose less or none, from My page, at once', async () => {
    const { user, h } = await member();
    expect((await app.inject({ url: '/v1/her-messages/settings' })).statusCode).toBe(401);
    expect(json(await app.inject({ url: '/v1/her-messages/settings', headers: h }))).toEqual({ mode: 'normal' });
    expect((await app.inject({ method: 'PUT', url: '/v1/her-messages/settings', headers: h, payload: { mode: 'sometimes' } })).statusCode).toBe(400);
    expect(json(await app.inject({ method: 'PUT', url: '/v1/her-messages/settings', headers: h, payload: { mode: 'less' } }))).toEqual({ mode: 'less' });
    expect(json(await app.inject({ url: '/v1/her-messages/settings', headers: h }))).toEqual({ mode: 'less' });
    const other = await member();
    for (const u of [user.id, other.user.id]) await talk(u, 'nana', jst(addDays(D, -1), 12));
    await tick(jst(D, 6));
    // Off after his day was planned: what was planned is not sent.
    await app.inject({ method: 'PUT', url: '/v1/her-messages/settings', headers: other.h, payload: { mode: 'off' } });
    expect(sent(await tick(jst(D, 19, 59)))).toMatchObject({ model: 1, skipped: { off: 2 } });
    expect((await inbox(h)).items.map((i) => i.payload.herMessage)).toEqual(['invite']);
    expect((await inbox(other.h)).items).toEqual([]);
    // And the next day nothing is planned for him: only the one message of 「少なめ」.
    expect((await tick(jst(addDays(D, 1), 6))).jobs[0].result).toMatchObject({ users: 1, planned: 1 });
  });

  it('forgets a deleted account: nothing planned or sent, and the rows and setting go with it', async () => {
    const { user, h } = await member();
    await talk(user.id, 'nana', jst(addDays(D, -1), 12));
    await app.inject({ method: 'PUT', url: '/v1/her-messages/settings', headers: h, payload: { mode: 'less' } });
    await tick(jst(D, 6));
    expect(await repos.herMessages.due(jst(D, 23).toISOString(), '', 10)).toHaveLength(1);
    expect((await app.inject({ method: 'DELETE', url: '/v1/auth/me', headers: h, payload: { confirm: 'DELETE' } })).statusCode).toBeLessThan(300);
    expect(await repos.herMessages.due(jst(D, 23).toISOString(), '', 10)).toEqual([]);
    expect(await repos.herMessages.mode(user.id)).toBe('normal');
    expect(sent(await tick(jst(D, 19, 59)))).toEqual({ due: 0 });
    expect((await tick(jst(addDays(D, 1), 6))).jobs[0].result).toMatchObject({ users: 0 });
    // A banned account is skipped the same way.
    const banned = await member();
    await talk(banned.user.id, 'nana', jst(addDays(D, 1), 7));
    await tick(jst(addDays(D, 1), 7, 20));
    await repos.users.update(banned.user.id, { banned: true });
    expect(sent(await tick(jst(addDays(D, 1), 19, 59)))).toMatchObject({ skipped: { inactive: 2 } });
  });

  it('is delivered like any inbox item — badge and push — and opening it makes it her line in the chat', async () => {
    const { user, h } = await member();
    await talk(user.id, 'nana', jst(addDays(D, -1), 12));
    const pushed: string[] = [];
    const sendPush: SendPush = async (_u, p) => { pushed.push(p.body); return { sent: 1, removed: 0, failed: 0 }; };
    await tick(jst(D, 6));
    await tick(jst(D, 15, 59), JOBS_HERE, sendPush);
    expect(pushed).toEqual(['note:nana、あなたのこと考えてた。']);
    const { items, unread } = await inbox(h);
    expect(unread).toBe(1);
    const read = await app.inject({ method: 'POST', url: `/v1/inbox/${items[0].id}/read`, headers: h });
    expect(json(read).unread).toBe(0);
    await app.inject({ method: 'POST', url: `/v1/inbox/${items[0].id}/read`, headers: h });
    const history = json(await app.inject({ url: '/v1/chat/history?star=nana', headers: h })).messages as { role: string; text: string }[];
    expect(history.filter((m) => m.role === 'assistant')).toEqual([expect.objectContaining({ text: 'note:nana、あなたのこと考えてた。' })]);
    // Not a message of his: his allowance is untouched.
    expect((await repos.users.byId(user.id))!.chatUsedToday).toBe(0);
  });

  it('writes one on demand in demo mode (404 in production), through the same tick', async () => {
    const { user, h } = await member();
    const prod = await buildApp({ repos, logger: false, demo: false, her });
    expect((await prod.inject({ method: 'POST', url: '/v1/her-messages/demo', headers: h, payload: {} })).statusCode).toBe(404);
    const res = await app.inject({ method: 'POST', url: '/v1/her-messages/demo', headers: h, payload: { kind: 'invite', star: 'alice' } });
    expect(res.statusCode).toBe(202);
    await runTick(repos, JOBS, { log: silent, her });
    // In demo mode her invitation points to her signature scene (demo-only while its clips are pending).
    expect((await inbox(h)).items).toEqual([expect.objectContaining({ star: 'alice', payload: { text: 'invite:alice、あなたのこと考えてた。', herMessage: 'invite', lang: 'ja', sceneId: 'night-greenhouse' } })]);
    expect(asked[0]).toMatchObject({ userId: user.id, kind: 'invite', scene: 'The greenhouse at night — and a little longer' });
  });

  it('C-room R6: her dream fallback sent at 11:10 (the demo) opens with the dream, not 「おはよう」 — in every language', async () => {
    vi.useFakeTimers({ toFake: ['Date'], now: jst(D, 11, 10) });
    const { h } = await member({ tz: 'Asia/Tokyo' } as Partial<UserRow>);
    answer = async () => null;
    expect((await app.inject({ method: 'POST', url: '/v1/her-messages/demo', headers: h, payload: { kind: 'dream', star: 'alice' } })).statusCode).toBe(202);
    await runTick(repos, JOBS, { log: silent, her, clock: () => jst(D, 11, 10).getTime() });
    const [item] = (await inbox(h)).items;
    expect(item.payload.herMessage).toBe('dream');
    const texts = item.payload.texts as Record<string, string>;
    for (const line of [String(item.payload.text), ...Object.values(texts)]) expect(line).not.toMatch(/おはよう|早安|good morning|좋은 아침/i);
    vi.useRealTimers();
  });

  it('stays off without a writer, as in every other suite', async () => {
    const { user } = await member();
    await talk(user.id, 'nana', jst(addDays(D, -1), 12));
    const r = await runTick(repos, JOBS_HERE, { log: silent, clock: () => jst(D, 15, 59).getTime() });
    expect(r.jobs.slice(0, 2).map((j) => j.result)).toEqual([{ off: true }, { off: true }]);
    const rows: HerMessageRow[] = await repos.herMessages.due(jst(D, 23).toISOString(), '', 10);
    expect(rows).toEqual([]);
  });
});

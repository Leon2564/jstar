import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { CALENDAR_LINES, CALENDAR_RULES, HIS_BIRTHDAY_PUSH, WORLD, addDays, type StarId } from '@jstar/shared';
import { signJwt } from '../src/lib/crypto';
import { createMemoryRepos } from '../src/db/memory';
import { createSqlRepos } from '../src/db/sql';
import { SEED_CARDS } from '../src/db/seed';
import type { Repos, UserRow } from '../src/db/types';
import { newUserRow } from '../src/lib/account';
import { env } from '../src/env';
import { buildApp } from '../src/app';
import { runTick } from '../src/lib/tick';
import { JOBS } from '../src/jobs';
import { calendarGreetings } from '../src/jobs/calendarGreetings';
import { deliverInbox } from '../src/jobs/deliverInbox';
import { CALENDAR_INBOX_PREFIX, calendarInboxId } from '../src/lib/calendar';
import type { SendPush } from '../src/lib/push';
import type { PushPayloadT } from '@jstar/shared';
import { createSqliteClient } from './sqlite';

/**
 * Her year with him (#61): her message on the day (the tick), what the home shows (GET /v1/calendar), what the persona
 * service is told, and the test site's "pretend it is that day". The persona service is faked and records its input.
 */
const agent = vi.hoisted(() => ({ inputs: [] as Record<string, unknown>[], greetings: [] as Record<string, unknown>[] }));
vi.mock('../src/lib/agent', () => {
  const answer = (input: Record<string, unknown>) => {
    agent.inputs.push(input);
    return { reply: 'うん', blocked: false, boundary: null, memory: null, cardTitle: null };
  };
  return {
    askPersona: async (input: Record<string, unknown>) => answer(input),
    streamPersona: async function* (input: Record<string, unknown>) {
      const r = answer(input);
      yield { type: 'delta', text: r.reply };
      yield { type: 'done', reply: r.reply, boundary: null, memory: null, cardTitle: null };
    },
    greetPersona: async (input: Record<string, unknown>) => { agent.greetings.push(input); return `greet:${agent.greetings.length}`; }
  };
});

const BACKENDS: [string, () => Repos][] = [
  ['memory', () => createMemoryRepos({ cards: SEED_CARDS })],
  ['sql', () => createSqlRepos(createSqliteClient())]
];
const silent = { info() {}, error() {} };
const json = (res: { payload: string }) => JSON.parse(res.payload);
/** A Tuesday in autumn: no season, nobody's birthday. */
const D = '2026-10-13';
const jst = (day: string, h: number, m = 0) => new Date(`${day}T${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:00+09:00`);
const ALL_LINES = (key: keyof typeof CALENDAR_LINES) => Object.values(CALENDAR_LINES[key]).flat().map((l) => l.replace('{n}', ''));
/**
 * Runs `fn` with her birthday unconfirmed, as the five were until the owner confirmed them (2026-09-28). The API reads
 * world.ts WORLD directly (no world parameter on these routes), so the gate — never an unconfirmed birthday in
 * production — is checked by flipping the flag for the duration and restoring it.
 */
async function unconfirmed<T>(star: StarId, fn: () => Promise<T>): Promise<T> {
  const b = WORLD[star].birthday;
  expect(b.confirmed).toBe(true);
  b.confirmed = false;
  try { return await fn(); } finally { b.confirmed = true; }
}

describe.each(BACKENDS)('her year with him (%s store)', (_name, makeRepos) => {
  let repos: Repos;
  let app: FastifyInstance;

  beforeEach(async () => {
    repos = makeRepos();
    app = await buildApp({ repos, logger: false, demo: false });
    agent.inputs.length = 0;
    agent.greetings.length = 0;
  });
  afterEach(() => { vi.useRealTimers(); });

  async function member(patch: Partial<UserRow> = {}) {
    const user = await repos.users.create({ ...newUserRow({ email: `${Math.random()}@example.com`, lineSub: null, nickname: 'ケンタ', via: 'email', lang: 'ja' }), ...patch });
    return { user, h: { authorization: `Bearer ${signJwt({ sub: user.id }, env.JWT_SECRET, 86_400)}` } };
  }
  /** A day together with her (a message or a scene), on JST `day`. */
  const together = (userId: string, star: StarId, day: string) => repos.relationship.touch(userId, star, day, jst(day, 12).toISOString());
  /** Lovers since `anniversary`. */
  async function lovers(userId: string, star: StarId, anniversary: string, lastDay: string) {
    const row = await together(userId, star, lastDay);
    await repos.relationship.change(row, { ...row, stage: 'lover', anniversary, confessedAt: jst(anniversary, 21).toISOString(), loverXp: 0, rev: `rel_${star}` }, 0);
  }
  const tick = (at: Date, opts: { demo?: boolean; sendPush?: SendPush } = {}) =>
    runTick(repos, [calendarGreetings, deliverInbox], { log: silent, clock: () => at.getTime(), ...opts });
  const inbox = async (h: Record<string, string>) =>
    json(await app.inject({ url: '/v1/inbox', headers: h })) as { items: { id: string; star: StarId; kind: string; payload: Record<string, unknown> }[] };
  const greeted = (r: Awaited<ReturnType<typeof tick>>) => r.jobs.find((j) => j.name === 'calendar.greet')?.result as Record<string, number>;

  describe('her message on the day (the tick)', () => {
    it('runs before the delivery, so what it writes is delivered by the same tick', () => {
      const names = JOBS.map((j) => j.name);
      expect(names.indexOf('calendar.greet')).toBeGreaterThanOrEqual(0);
      expect(names.indexOf('calendar.greet')).toBeLessThan(names.indexOf('inbox.deliver'));
    });

    it('wishes him a happy birthday once — from her he was with last — inside his hours, with a lock screen that does not say so', async () => {
      const { user, h } = await member({ birthday: `1990-${D.slice(5)}` });
      await together(user.id, 'nana', addDays(D, -5));
      await together(user.id, 'eimi', addDays(D, -1));
      const gone = await member({ birthday: `1990-${D.slice(5)}` });
      await together(gone.user.id, 'nana', addDays(D, -CALENDAR_RULES.activeDays));
      const pushed: PushPayloadT[] = [];
      const sendPush: SendPush = async (_u, p) => { pushed.push(p); return { sent: 1, removed: 0, failed: 0 }; };

      // Before his hours: nothing yet.
      expect(greeted(await tick(jst(D, 8, 40), { sendPush }))).toMatchObject({ sent: 0, outside: 1 });
      const first = await tick(jst(D, 9, 5), { sendPush });
      expect(greeted(first)).toMatchObject({ users: 1, sent: 1 });
      const items = (await inbox(h)).items;
      expect(items).toEqual([expect.objectContaining({ star: 'eimi', kind: 'event', payload: expect.objectContaining({ calendar: 'hisBirthday', push: HIS_BIRTHDAY_PUSH.ja }) })]);
      expect(ALL_LINES('hisBirthday')).toContain(items[0].payload.text);
      expect(items[0].id.startsWith(CALENDAR_INBOX_PREFIX)).toBe(true);
      // His birthday stays off his lock screen, and neither its date nor its year is in what she wrote.
      expect(pushed.map((p) => p.body)).toEqual([HIS_BIRTHDAY_PUSH.ja]);
      expect(JSON.stringify(items[0].payload)).not.toMatch(/1990|10-13|10月13日/);
      expect(items[0].id).not.toMatch(/1990/);
      // Once: more ticks the same day add nothing; the one who stopped coming gets nothing.
      await tick(jst(D, 12));
      await tick(jst(D, 20, 50));
      expect((await inbox(h)).items).toHaveLength(1);
      expect((await inbox(gone.h)).items).toEqual([]);
    });

    it('keeps a 02-29 birthday on 02-28 in a common year', async () => {
      const { user, h } = await member({ birthday: '2000-02-29' });
      await together(user.id, 'mahiro', '2027-02-27');
      await tick(jst('2027-02-28', 10));
      expect((await inbox(h)).items.map((i) => i.payload.calendar)).toEqual(['hisBirthday']);
    });

    it('goes by his own clock: in Los Angeles her message waits for his morning', async () => {
      const { user, h } = await member({ birthday: `1990-${D.slice(5)}`, tz: 'America/Los_Angeles' });
      await together(user.id, 'mahiro', addDays(D, -1));
      // 10:00 in Tokyo on his birthday is still the evening before in Los Angeles.
      await tick(jst(D, 10));
      expect((await inbox(h)).items).toEqual([]);
      // 09:30 in Los Angeles on the day (01:30 JST the next day).
      await tick(new Date(`${D}T09:30:00-07:00`));
      expect((await inbox(h)).items.map((i) => i.payload.calendar)).toEqual(['hisBirthday']);
    });

    it('never celebrates her unconfirmed birthday in production; the test site does', async () => {
      await unconfirmed('mahiro', async () => {
        const { user, h } = await member();
        await together(user.id, 'mahiro', '2027-03-03');
        await tick(jst('2027-03-04', 10));
        expect((await inbox(h)).items).toEqual([]);

        const demoRepos = makeRepos();
        repos = demoRepos;
        const other = await member();
        await together(other.user.id, 'mahiro', '2027-03-03');
        app = await buildApp({ repos, logger: false, demo: true });
        await tick(jst('2027-03-04', 10), { demo: true });
        const items = (await inbox(other.h)).items;
        expect(items).toEqual([expect.objectContaining({ star: 'mahiro', payload: expect.objectContaining({ calendar: 'herBirthday' }) })]);
        expect(items[0].payload.push).toBeUndefined();
      });
    });

    it('celebrates her confirmed birthday in production (まひろ 03-04, owner 2026-09-28), from her', async () => {
      const { user, h } = await member();
      await together(user.id, 'mahiro', '2027-03-03');
      await together(user.id, 'nana', '2027-03-03');
      await tick(jst('2027-03-04', 10));
      const items = (await inbox(h)).items;
      expect(items).toEqual([expect.objectContaining({ star: 'mahiro', payload: expect.objectContaining({ calendar: 'herBirthday' }) })]);
      expect(ALL_LINES('herBirthday')).toContain(items[0].payload.text);
      expect(items[0].payload.push).toBeUndefined();
    });

    it('marks their anniversary every month and every year, from her', async () => {
      const { user, h } = await member();
      await lovers(user.id, 'alice', '2026-08-31', addDays(D, -2));
      // 08-31 → 09-30 was the first month; 10-13 is nothing.
      await tick(jst(D, 10));
      expect((await inbox(h)).items).toEqual([]);
      await together(user.id, 'alice', '2026-10-30');
      await tick(jst('2026-10-31', 10));
      const [item] = (await inbox(h)).items;
      expect(item).toMatchObject({ star: 'alice', payload: { calendar: 'monthiversary', count: 2 } });
      expect(item.payload.text).toMatch(/2か月/);
      expect(item.id).toBe(calendarInboxId(user.id, 'alice', 'monthiversary:2026-10-31'));
    });

    it('says a season\'s first day once per user, not once per talent, and keeps to his daily allowance and setting', async () => {
      const eve = '2026-12-24';
      const { user, h } = await member({ birthday: `1995-${eve.slice(5)}` });
      await together(user.id, 'nana', addDays(eve, -3));
      await lovers(user.id, 'mahiro', '2026-11-24', addDays(eve, -1));
      await tick(jst(eve, 10));
      // Three things today (his birthday, a month with mahiro, Christmas Eve): the two most important.
      expect((await inbox(h)).items.map((i) => `${i.payload.calendar}:${i.star}`).sort()).toEqual(['hisBirthday:mahiro', 'monthiversary:mahiro']);
      await tick(jst(eve, 15));
      expect((await inbox(h)).items).toHaveLength(CALENDAR_RULES.perDay);

      const christmas = await member();
      await together(christmas.user.id, 'nana', addDays(eve, -2));
      await together(christmas.user.id, 'unpai', addDays(eve, -1));
      // 「少なめ」: one a day. Off: none.
      const less = await member({ birthday: `1995-${eve.slice(5)}` });
      await lovers(less.user.id, 'mahiro', '2026-11-24', addDays(eve, -1));
      await repos.herMessages.setMode(less.user.id, 'less', jst(eve, 0).toISOString());
      const off = await member({ birthday: `1995-${eve.slice(5)}` });
      await together(off.user.id, 'mahiro', addDays(eve, -1));
      await repos.herMessages.setMode(off.user.id, 'off', jst(eve, 0).toISOString());
      await tick(jst(eve, 16));
      expect((await inbox(christmas.h)).items.map((i) => `${i.payload.season}:${i.star}`)).toEqual(['christmas:unpai']);
      expect((await inbox(less.h)).items.map((i) => i.payload.calendar)).toEqual(['hisBirthday']);
      expect((await inbox(off.h)).items).toEqual([]);
      // The 25th is still Christmas, but not its first day: nothing more.
      await tick(jst('2026-12-25', 11));
      expect((await inbox(christmas.h)).items).toHaveLength(1);
    });

    it('keeps his quiet hours', async () => {
      const { user, h } = await member({ birthday: `1990-${D.slice(5)}` });
      await together(user.id, 'nana', addDays(D, -1));
      await tick(jst(D, 21, 30));
      await tick(jst(D, 23));
      expect((await inbox(h)).items).toEqual([]);
    });
  });

  describe('what the home and the prompt see', () => {
    it('lists today with each of the five — his birthday as a kind only, her unconfirmed birthday never', async () => {
      vi.useFakeTimers({ toFake: ['Date'], now: jst('2027-03-04', 12) });
      const { h } = await member({ birthday: '1992-03-04' });
      await unconfirmed('mahiro', async () => {
        const res = await app.inject({ url: '/v1/calendar', headers: h });
        expect(res.statusCode).toBe(200);
        expect(res.headers['cache-control']).toBe('private, no-store');
        const body = json(res);
        expect(body.talents.map((t: { star: string }) => t.star)).toEqual(['mahiro', 'nana', 'unpai', 'alice', 'eimi']);
        for (const t of body.talents) expect(t.events).toEqual([{ kind: 'hisBirthday' }]);
        expect(res.payload).not.toMatch(/1992|03-04|herBirthday/);
      });
      // Confirmed (まひろ 03-04, owner 2026-09-28): her birthday is on her home too — still as a kind only.
      const res = await app.inject({ url: '/v1/calendar', headers: h });
      const body = json(res);
      const events = (star: string) => body.talents.find((t: { star: string }) => t.star === star).events;
      expect(events('mahiro')).toEqual(expect.arrayContaining([{ kind: 'hisBirthday' }, { kind: 'herBirthday' }]));
      expect(events('mahiro')).toHaveLength(2);
      for (const star of ['nana', 'unpai', 'alice', 'eimi']) expect(events(star)).toEqual([{ kind: 'hisBirthday' }]);
      expect(res.payload).not.toMatch(/1992|03-04/);
      expect((await app.inject({ url: '/v1/calendar' })).statusCode).toBe(401);
    });

    it('tells the persona service what today is, and never her unconfirmed birthday', async () => {
      vi.useFakeTimers({ toFake: ['Date'], now: jst('2027-03-04', 12) });
      const { h } = await member({ birthday: '1992-03-04' });
      await unconfirmed('mahiro', async () => {
        await app.inject({ method: 'POST', url: '/v1/chat/send', headers: h, payload: { star: 'mahiro', text: 'やあ', lang: 'ja' } });
        expect((agent.inputs[0].world as { today?: unknown }).today).toEqual([{ kind: 'hisBirthday' }]);
        expect(JSON.stringify(agent.inputs[0])).not.toMatch(/herBirthday|1992/);
        // A visitor: hers and the season's only — nothing today.
        await app.inject({ method: 'POST', url: '/v1/chat/trial', headers: { 'x-device-id': 'dev-calendar-1' }, payload: { star: 'mahiro', text: 'hi', lang: 'ja' } });
        expect(agent.inputs[1].world).toBeNull();
        // Her greeting knows it too.
        expect(json(await app.inject({ url: '/v1/chat/greeting?star=mahiro&lang=ja', headers: h }))).toMatchObject({ cached: false });
        expect((agent.greetings[0].world as { today?: unknown }).today).toEqual([{ kind: 'hisBirthday' }]);
      });
      // Confirmed (owner, 2026-09-28): she knows it is her birthday; a visitor is told so too (hers, not his).
      await app.inject({ method: 'POST', url: '/v1/chat/send', headers: h, payload: { star: 'mahiro', text: 'やあ', lang: 'ja' } });
      expect((agent.inputs[2].world as { today?: unknown }).today).toEqual(expect.arrayContaining([{ kind: 'hisBirthday' }, { kind: 'herBirthday' }]));
      expect(JSON.stringify(agent.inputs[2])).not.toMatch(/1992/);
      await app.inject({ method: 'POST', url: '/v1/chat/trial', headers: { 'x-device-id': 'dev-calendar-2' }, payload: { star: 'mahiro', text: 'hi', lang: 'ja' } });
      expect((agent.inputs[3].world as { today?: unknown }).today).toEqual([{ kind: 'herBirthday' }]);
    });

    it('keeps the test site\'s day to the test site', async () => {
      const { h } = await member();
      expect((await app.inject({ method: 'POST', url: '/v1/calendar/demo', headers: h, payload: { day: '2027-03-04' } })).statusCode).toBe(404);
    });

    it('lets the test site pretend it is her birthday: the home, her messages and the prompt follow, for a while', async () => {
      app = await buildApp({ repos, logger: false, demo: true });
      vi.useFakeTimers({ toFake: ['Date'], now: jst(D, 12) });
      const { user, h } = await member();
      const res = await app.inject({ method: 'POST', url: '/v1/calendar/demo', headers: h, payload: { day: '2027-03-04' } });
      expect(res.statusCode).toBe(200);
      const body = json(res);
      expect(body).toMatchObject({ day: '2027-03-04', sent: 1 });
      expect(body.talents.find((t: { star: string }) => t.star === 'mahiro').events).toEqual([{ kind: 'herBirthday' }]);
      expect(body.talents.find((t: { star: string }) => t.star === 'nana').events).toEqual([]);
      // Her message is due now: the next tick delivers it.
      await runTick(repos, [deliverInbox], { log: silent, clock: () => Date.now() });
      expect((await inbox(h)).items).toEqual([expect.objectContaining({ star: 'mahiro', payload: expect.objectContaining({ calendar: 'herBirthday' }) })]);
      // Again on demand (a fresh id each time).
      expect(json(await app.inject({ method: 'POST', url: '/v1/calendar/demo', headers: h, payload: { day: '2027-03-04' } })).sent).toBe(1);
      await app.inject({ method: 'POST', url: '/v1/chat/send', headers: h, payload: { star: 'mahiro', text: 'やあ', lang: 'ja' } });
      expect((agent.inputs[0].world as { today?: unknown }).today).toEqual([{ kind: 'herBirthday' }]);
      // After two hours the real day is back.
      vi.setSystemTime(jst(D, 14, 1));
      expect(json(await app.inject({ url: '/v1/calendar', headers: h })).talents[0].events).toEqual([]);
      // null: back at once.
      vi.setSystemTime(jst(D, 15));
      await app.inject({ method: 'POST', url: '/v1/calendar/demo', headers: h, payload: { day: '2027-12-24' } });
      expect(json(await app.inject({ url: '/v1/calendar', headers: h })).talents[0].events).toEqual([{ kind: 'season', season: 'christmas' }]);
      expect(json(await app.inject({ method: 'POST', url: '/v1/calendar/demo', headers: h, payload: { day: null } }))).toMatchObject({ day: null, sent: 0 });
      expect(json(await app.inject({ url: '/v1/calendar', headers: h })).talents[0].events).toEqual([]);
      // What the demo wrote is his only.
      expect((await repos.inbox.forUser(user.id, 50)).every((r) => r.userId === user.id)).toBe(true);
    });
  });
});

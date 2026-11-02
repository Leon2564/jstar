import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { ACCESS, localClock, zonedInstant, type Lang } from '@jstar/shared';
import { LINES } from '@jstar/shared/lines';
import greetings from '../../../tools/voice/greetings.json';
import { buildApp } from '../src/app';
import { createMemoryRepos } from '../src/db/memory';
import { SEED_CARDS } from '../src/db/seed';
import { createSqlRepos } from '../src/db/sql';
import type { EventRow, InboxRow, Repos } from '../src/db/types';
import { env } from '../src/env';
import { JOBS } from '../src/jobs';
import { newUserRow } from '../src/lib/account';
import { signJwt } from '../src/lib/crypto';
import type { PushOptions, SendPush } from '../src/lib/push';
import { runTick } from '../src/lib/tick';
import type { PushPayloadT } from '@jstar/shared';
import { createSqliteClient } from './sqlite';

/** Same contract for both stores: memory (dev) and SQL (production on D1, here on SQLite). */
const BACKENDS: [string, () => Repos][] = [
  ['memory', () => createMemoryRepos({ cards: SEED_CARDS })],
  ['sql', () => createSqlRepos(createSqliteClient())]
];

const silent = { info() {}, error() {} };
const json = (res: { payload: string }) => JSON.parse(res.payload);
const MIN = 60_000;
const DAY = 86_400_000;
const EVERY_DAY = [0, 1, 2, 3, 4, 5, 6];
const TAIPEI = 'Asia/Taipei';
/** A morning a few days ahead, so a ring then is never blocked by anything the real clock did today. */
const ahead = (tz: string, days = 3) => localClock(Date.now() + days * DAY, tz).date;
const at730 = (day: string, tz: string) => zonedInstant(day, 7 * 60 + 30, tz);

describe.each(BACKENDS)('wake-up alarm (%s store)', (_name, makeRepos) => {
  let app: FastifyInstance;
  let repos: Repos;
  let events: EventRow[];
  let pushes: { userId: string; payload: PushPayloadT; opts?: PushOptions }[];
  const sendPush: SendPush = async (userId, payload, opts) => { pushes.push({ userId, payload, opts }); return { sent: 1, removed: 0, failed: 0 }; };

  beforeEach(async () => {
    repos = makeRepos();
    events = [];
    pushes = [];
    const add = repos.events.add.bind(repos.events);
    repos.events.add = async (e) => { events.push(e); await add(e); };
    app = await buildApp({ repos, logger: false, demo: true });
  });
  afterEach(() => { vi.useRealTimers(); });

  async function userWith(lang: Lang = 'ja') {
    const user = await repos.users.create(newUserRow({ email: `${Math.random()}@example.com`, lineSub: null, nickname: 'u', via: 'email', lang }));
    return { user, h: { authorization: `Bearer ${signJwt({ sub: user.id }, env.JWT_SECRET, 30 * 86_400)}` } };
  }
  const put = (h: Record<string, string>, body: Record<string, unknown>) => app.inject({ method: 'PUT', url: '/v1/alarm', headers: h, payload: body });
  const setAlarm = async (h: Record<string, string>, body: Record<string, unknown> = {}) => {
    const res = await put(h, { star: 'nana', time: '07:30', days: EVERY_DAY, tz: TAIPEI, ...body });
    expect(res.statusCode).toBe(200);
    return json(res).alarm;
  };
  const tickAt = async (ms: number, demo = true) => {
    const res = await runTick(repos, JOBS, { log: silent, sendPush, clock: () => ms, demo });
    const job = (name: string) => res.jobs.find((j) => j.name === name)!;
    return { ring: job('alarm.ring').result, deliver: job('inbox.deliver').result };
  };
  const wakeups = async (userId: string) => (await repos.inbox.forUser(userId, 50)).filter((r) => r.kind === 'wakeup');
  /** Freezes Date only (timers stay real), for the routes that read "today" from the clock. */
  const clockAt = (ms: number) => { vi.useFakeTimers({ toFake: ['Date'], now: ms }); };

  it('sets, shows and changes his alarm; saving makes the zone his clock and counts alarm.set', async () => {
    const { user, h } = await userWith();
    expect(json(await app.inject({ url: '/v1/alarm', headers: h }))).toEqual({ alarm: null });
    const alarm = await setAlarm(h, { days: [5, 1, 3] });
    expect(alarm).toMatchObject({ star: 'nana', time: '07:30', days: [1, 3, 5], enabled: true, tz: TAIPEI });
    expect(Date.parse(alarm.nextAt)).toBeGreaterThan(Date.now());
    expect(json(await app.inject({ url: '/v1/alarm', headers: h })).alarm).toEqual(alarm);
    expect((await repos.users.byId(user.id))!.tz).toBe(TAIPEI);
    expect(events.map((e) => [e.name, e.props])).toEqual([['alarm.set', { star: 'nana' }]]);

    // Another talent wakes him, then the alarm is turned off: settings kept, nothing next, nothing counted.
    expect((await setAlarm(h, { star: 'eimi', time: '06:05' })).star).toBe('eimi');
    const off = await setAlarm(h, { star: 'eimi', time: '06:05', enabled: false });
    expect(off).toMatchObject({ enabled: false, nextAt: null, time: '06:05' });
    expect(events.filter((e) => e.name === 'alarm.set')).toHaveLength(2);
  });

  it('refuses what is not an alarm, and answers only a signed-in user', async () => {
    const { h } = await userWith();
    expect((await app.inject({ url: '/v1/alarm' })).statusCode).toBe(401);
    expect((await put({}, { star: 'nana', time: '07:30', days: EVERY_DAY })).statusCode).toBe(401);
    for (const bad of [{ time: '7:30' }, { time: '24:00' }, { days: [] }, { days: [1, 1] }, { days: [7] }, { star: 'someone' }]) {
      expect((await put(h, { star: 'nana', time: '07:30', days: EVERY_DAY, ...bad })).statusCode).toBe(400);
    }
    // A zone the runtime does not know is ignored: he keeps the clock on file (JST until he reports one).
    expect((await setAlarm(h, { tz: 'Mars/Olympus' })).tz).toBe('Asia/Tokyo');
  });

  it('is behind the ACCESS gate in rules.ts (free in v1.1)', async () => {
    const { h } = await userWith();
    ACCESS.wakeup = 'pass';
    try {
      expect(json(await put(h, { star: 'nana', time: '07:30', days: EVERY_DAY }))).toEqual({ error: 'pass_required' });
    } finally {
      ACCESS.wakeup = 'free';
    }
    await setAlarm(h);
  });

  it('rings 07:30 in Taipei on the first tick at or after it, once, and her line reaches the lock screen with a way into the wake-up', async () => {
    const { user, h } = await userWith();
    await setAlarm(h);
    const day = ahead(TAIPEI);
    const t = at730(day, TAIPEI);

    expect((await tickAt(t - 5 * MIN)).ring).toEqual({ alarms: 1, rung: 0 });
    const first = await tickAt(t + 3_000);
    expect(first.ring).toEqual({ alarms: 1, rung: 1 });
    expect(first.deliver).toEqual({ delivered: 1, pushed: 1 });

    const [row] = await wakeups(user.id);
    const line = LINES.nana.wakeup.find((l) => l.id === row.payload.lineId)!;
    expect(row).toMatchObject({ star: 'nana', kind: 'wakeup', dueAt: new Date(t + 3_000).toISOString(), readAt: null, payload: { day, text: line.text.ja } });
    expect(pushes).toEqual([{
      userId: user.id,
      payload: { title: '奈々', body: line.text.ja, url: `/#/me/home?star=nana&inbox=${row.id}`, star: 'nana', tag: 'wake-nana' },
      // Wakes a phone in battery saver; dropped when it cannot arrive within the morning.
      opts: { ttl: 30 * 60, urgency: 'high' }
    }]);

    // Idempotent: the next ticks of the morning (and a repeated tick) ring nothing more.
    expect((await tickAt(t + 3_000)).ring).toEqual({ alarms: 1, rung: 0 });
    expect(await tickAt(t + 5 * MIN)).toEqual({ ring: { alarms: 1, rung: 0 }, deliver: { delivered: 0, pushed: 0 } });
    expect(await wakeups(user.id)).toHaveLength(1);
    // The next morning rings again.
    expect((await tickAt(t + DAY + 2_000)).ring).toEqual({ alarms: 1, rung: 1 });
    expect(await wakeups(user.id)).toHaveLength(2);
  });

  it('rings with a line for his hour: before dawn her before-dawn line, never 「天亮了」; by day and in the evening their own (PR 5)', async () => {
    const { user, h } = await userWith('zh-Hant');
    await setAlarm(h, { time: '04:22' });
    const day = ahead(TAIPEI);
    expect((await tickAt(zonedInstant(day, 4 * 60 + 22, TAIPEI) + 3_000)).ring).toEqual({ alarms: 1, rung: 1 });
    const [dawn] = await wakeups(user.id);
    expect(dawn.payload.lineId).toBe('dawn');
    expect(dawn.payload.text).toBe(LINES.nana.wakeup.find((l) => l.id === 'dawn')!.text['zh-Hant']);
    expect(dawn.payload.text).not.toMatch(/早安|天亮/);
    expect(pushes.at(-1)!.payload.body).toBe(dawn.payload.text);
    // M12: the wake screen at that hour opens on that same wake-up line of hers — never her goodnight.
    const opened = JSON.parse((await app.inject({ method: 'POST', url: '/v1/alarm/wake/open', headers: h, payload: { id: dawn.id } })).payload);
    expect([opened.lineId, opened.line]).toEqual(['dawn', dawn.payload.text]);
    const night = [LINES.nana.goodnight.plain, ...LINES.nana.goodnight.whisper].map((l) => l['zh-Hant']);
    expect(night).not.toContain(opened.line);
    for (const [time, minutes, id] of [['14:00', 14 * 60, 'day'], ['19:30', 19 * 60 + 30, 'evening']] as const) {
      const other = await userWith('en');
      await setAlarm(other.h, { time });
      await tickAt(zonedInstant(day, minutes, TAIPEI) + 3_000);
      expect((await wakeups(other.user.id))[0].payload.lineId, time).toBe(id);
    }
  });

  it('claims a morning once even when two ticks race for it', async () => {
    const { user, h } = await userWith();
    await setAlarm(h);
    const day = ahead(TAIPEI);
    const row = (id: string): InboxRow => ({ id, userId: user.id, star: 'nana', kind: 'wakeup', payload: { text: 'x', lineId: 'any', day }, dueAt: '2026-01-01T00:00:00.000Z', deliveredAt: null, readAt: null, createdAt: '2026-01-01T00:00:00.000Z' });
    const results = await Promise.all([repos.alarms.ring(user.id, day, row('inb_a')), repos.alarms.ring(user.id, day, row('inb_b'))]);
    expect(results.sort()).toEqual([false, true]);
    expect(await repos.inbox.deliverDue('2026-01-02T00:00:00.000Z', 10)).toHaveLength(1);
  });

  it('rings by his new zone once he moves: from the alarm screen, or from turning push on', async () => {
    const { user, h } = await userWith();
    await setAlarm(h);
    const day = ahead(TAIPEI);
    expect((await setAlarm(h, { tz: 'America/Los_Angeles' })).tz).toBe('America/Los_Angeles');
    expect((await tickAt(at730(day, TAIPEI) + 1_000)).ring).toMatchObject({ rung: 0 });
    expect((await tickAt(at730(day, 'America/Los_Angeles') + 1_000)).ring).toMatchObject({ rung: 1 });

    // Push re-subscribed from a device in London (#50 saves its zone as users.tz): the alarm follows.
    await repos.push.subscribe({ endpoint: 'https://push.example/london', userId: user.id, keys: { p256dh: 'k', auth: 'a' }, tz: 'Europe/London', createdAt: new Date().toISOString() });
    expect(json(await app.inject({ url: '/v1/alarm', headers: h })).alarm.tz).toBe('Europe/London');
    // 07:30 in Los Angeles is the afternoon in London: nothing; the next London 07:30 rings.
    const next = ahead('Europe/London', 5);
    expect((await tickAt(at730(next, 'America/Los_Angeles') + 1_000)).ring).toMatchObject({ rung: 0 });
    const after = localClock(at730(next, 'America/Los_Angeles') + DAY, 'Europe/London').date;
    expect((await tickAt(at730(after, 'Europe/London') + 1_000)).ring).toMatchObject({ rung: 1 });
  });

  it('rings only on his days, lets a long-missed morning go, and never rings while off', async () => {
    const { user, h } = await userWith();
    await setAlarm(h, { days: [1, 2, 3, 4, 5] });
    // 2027-01-09 is a Saturday, 2027-01-11 a Monday.
    expect((await tickAt(at730('2027-01-09', TAIPEI) + 1_000)).ring).toMatchObject({ rung: 0 });
    // Ten minutes late (a skipped tick) still rings; forty-five minutes late (downtime) does not.
    expect((await tickAt(at730('2027-01-11', TAIPEI) + 45 * MIN)).ring).toMatchObject({ rung: 0 });
    expect((await tickAt(at730('2027-01-12', TAIPEI) + 10 * MIN)).ring).toMatchObject({ rung: 1 });
    await setAlarm(h, { enabled: false });
    expect((await tickAt(at730('2027-01-13', TAIPEI) + 1_000)).ring).toEqual({ alarms: 0, rung: 0 });
    expect(await wakeups(user.id)).toHaveLength(1);
  });

  it('saved after this morning’s time it waits for tomorrow; saved for later today it rings today, even after an earlier ring', async () => {
    const { user, h } = await userWith();
    const day = ahead(TAIPEI);
    clockAt(at730(day, TAIPEI) + 10 * MIN);
    await setAlarm(h);
    expect((await tickAt(at730(day, TAIPEI) + 10 * MIN)).ring).toMatchObject({ rung: 0 });
    expect((await tickAt(at730(day, TAIPEI) + 15 * MIN)).ring).toMatchObject({ rung: 0 });
    // Now 07:45: he asks for 07:50.
    clockAt(at730(day, TAIPEI) + 15 * MIN);
    await setAlarm(h, { time: '07:50' });
    expect((await tickAt(at730(day, TAIPEI) + 20 * MIN)).ring).toMatchObject({ rung: 1 });
    expect(await wakeups(user.id)).toHaveLength(1);
  });

  it('opens her wake-up: her line and answers in his language, read once, counted once', async () => {
    const { user, h } = await userWith();
    await setAlarm(h);
    const day = ahead(TAIPEI);
    await tickAt(at730(day, TAIPEI) + 1_000);
    const [row] = await wakeups(user.id);
    clockAt(at730(day, TAIPEI) + 2 * MIN);

    const open = (id: string, lang?: string, headers = h) => app.inject({ method: 'POST', url: '/v1/alarm/wake/open', headers, payload: { id, ...(lang ? { lang } : {}) } });
    const res = await open(row.id);
    expect(res.statusCode).toBe(200);
    const line = LINES.nana.wakeup.find((l) => l.id === row.payload.lineId)!;
    expect(json(res)).toMatchObject({
      id: row.id, star: 'nana', day, line: line.text.ja, lineId: line.id,
      replies: { awake: LINES.nana.wakeReplies.awake.ja, snooze: LINES.nana.wakeReplies.snooze.ja },
      snoozeLeft: 1, snoozeMinutes: 5, unread: 0, item: { id: row.id, kind: 'wakeup' }
    });
    expect(json(res).item.readAt).toBeTruthy();
    expect(json(await open(row.id, 'en')).line).toBe(line.text.en);
    expect(events.filter((e) => e.name === 'wakeup.opened').map((e) => e.props)).toEqual([{ star: 'nana' }]);

    // Nobody else's, and nothing but a wake-up.
    const other = await userWith();
    expect((await open(row.id, undefined, other.h)).statusCode).toBe(404);
    await repos.inbox.add({ id: 'inb_msg', userId: user.id, star: 'nana', kind: 'message', payload: { text: 'hi' }, dueAt: new Date(0).toISOString(), deliveredAt: null, readAt: null, createdAt: new Date(0).toISOString() });
    await repos.inbox.deliverDue(new Date().toISOString(), 10);
    expect((await open('inb_msg')).statusCode).toBe(404);
  });

  it('「あと5分」 finds the morning\'s wake-up however many unread messages came after it (N-37)', async () => {
    const { user, h } = await userWith();
    await setAlarm(h);
    const day = ahead(TAIPEI);
    const t = at730(day, TAIPEI);
    await tickAt(t + 1_000);
    const [first] = await wakeups(user.id);
    await app.inject({ method: 'POST', url: '/v1/alarm/wake/open', headers: h, payload: { id: first.id } });
    // Sixty messages from her after it, all unread: the opened wake-up is far past the newest fifty.
    for (let i = 0; i < 60; i++) {
      const at = new Date(t + 2_000 + i).toISOString();
      await repos.inbox.add({ id: `inb_later_${i}`, userId: user.id, star: 'nana', kind: 'message', payload: {}, dueAt: at, deliveredAt: at, readAt: null, createdAt: at });
    }
    clockAt(t + MIN);
    const res = await app.inject({ method: 'POST', url: '/v1/alarm/wake/snooze', headers: h, payload: { id: first.id } });
    expect(res.statusCode, res.payload).toBe(200);
    // Really gone (not his): still a 404.
    expect((await app.inject({ method: 'POST', url: '/v1/alarm/wake/snooze', headers: h, payload: { id: 'inb_nope' } })).statusCode).toBe(404);
  });

  it('「あと5分」 calls once more five minutes later with another line, only once a morning, only that morning', async () => {
    const { user, h } = await userWith();
    await setAlarm(h);
    const day = ahead(TAIPEI);
    const t = at730(day, TAIPEI);
    await tickAt(t + 1_000);
    const [first] = await wakeups(user.id);
    clockAt(t + MIN);
    const snooze = (id: string) => app.inject({ method: 'POST', url: '/v1/alarm/wake/snooze', headers: h, payload: { id } });
    const open = (id: string) => app.inject({ method: 'POST', url: '/v1/alarm/wake/open', headers: h, payload: { id } });
    await open(first.id);

    const res = await snooze(first.id);
    expect(res.statusCode).toBe(200);
    expect(json(res)).toMatchObject({ dueAt: new Date(t + 6 * MIN).toISOString(), snoozeLeft: 0 });
    expect(json(await snooze(first.id))).toEqual({ error: 'snooze_used' });
    // Snoozed, the first call is answered: it never rings again.
    expect((await repos.inbox.mine(user.id, first.id))!.readAt).toBeTruthy();

    // Not before its time; then delivered and pushed like the first call, replacing it on the lock screen.
    expect((await tickAt(t + 5 * MIN)).deliver).toEqual({ delivered: 0, pushed: 0 });
    expect((await tickAt(t + 6 * MIN + 1_000)).deliver).toEqual({ delivered: 1, pushed: 1 });
    const again = (await wakeups(user.id)).find((r) => r.id !== first.id)!;
    expect(again.payload).toMatchObject({ day, snooze: true });
    expect(again.payload.lineId).not.toBe(first.payload.lineId);
    expect(pushes.at(-1)!.payload).toMatchObject({ url: `/#/me/home?star=nana&inbox=${again.id}`, tag: 'wake-nana' });
    // The second call offers no third, and is not a second "opened" of the morning.
    expect(json(await open(again.id)).snoozeLeft).toBe(0);
    expect(json(await snooze(again.id))).toEqual({ error: 'snooze_used' });
    expect(events.filter((e) => e.name === 'wakeup.opened')).toHaveLength(1);

    // The next day, yesterday's call cannot be snoozed.
    await tickAt(t + DAY + 1_000);
    clockAt(t + DAY + MIN);
    expect(json(await snooze(first.id))).toEqual({ error: 'wake_over' });
  });

  it('answering her call calls off the 「あと5分」 still to come: no second ring, no 409 loop, no message later (U-41)', async () => {
    const { user, h } = await userWith();
    await setAlarm(h);
    const day = ahead(TAIPEI);
    const t = at730(day, TAIPEI);
    await tickAt(t + 1_000);
    const [first] = await wakeups(user.id);
    // Her ringtone is the recording of the line she wakes him with (#12).
    expect(first.payload.voice).toBe(LINES.nana.wakeup.find((l) => l.id === first.payload.lineId)!.text.voice);
    clockAt(t + MIN);
    const snooze = (id: string) => app.inject({ method: 'POST', url: '/v1/alarm/wake/snooze', headers: h, payload: { id } });
    const open = (id: string) => app.inject({ method: 'POST', url: '/v1/alarm/wake/open', headers: h, payload: { id } });
    expect((await snooze(first.id)).statusCode).toBe(200);
    // He answers before her second call comes (his phone rang again on its own): he is up.
    clockAt(t + 3 * MIN);
    expect((await open(first.id)).statusCode).toBe(200);
    // Her second call is called off: nothing is delivered or pushed, nothing rings again.
    pushes = [];
    expect((await tickAt(t + 6 * MIN + 1_000)).deliver).toEqual({ delivered: 0, pushed: 0 });
    expect(pushes).toHaveLength(0);
    const rows = await wakeups(user.id);
    expect(rows.map((r) => r.id)).toEqual([first.id]);
    // Nothing of that morning is left unread to turn up later as one of her messages.
    expect((await repos.inbox.forUser(user.id, 50)).filter((r) => r.kind === 'wakeup' && !r.readAt)).toHaveLength(0);
    expect(json(await app.inject({ method: 'GET', url: '/v1/inbox', headers: h })).unread).toBe(0);
  });

  it('an open room rings her snoozed call at its time: delivered then, never pushed by the tick as well (F-04)', async () => {
    const { user, h } = await userWith();
    await setAlarm(h);
    const day = ahead(TAIPEI);
    const t = at730(day, TAIPEI);
    await tickAt(t + 1_000);
    const [first] = await wakeups(user.id);
    clockAt(t + MIN);
    const snoozed = json(await app.inject({ method: 'POST', url: '/v1/alarm/wake/snooze', headers: h, payload: { id: first.id } }));
    expect(snoozed.next).toMatchObject({ star: 'nana', kind: 'wakeup', payload: { day, snooze: true }, deliveredAt: snoozed.dueAt });
    const ring = (id: string) => app.inject({ method: 'POST', url: '/v1/alarm/wake/ring', headers: h, payload: { id } });
    // Not before its time.
    vi.setSystemTime(t + 3 * MIN);
    expect((await ring(snoozed.next.id)).statusCode).toBe(404);
    // At its time (his clock a little ahead is fine): delivered now, once.
    vi.setSystemTime(t + 6 * MIN - 30_000);
    const rung = await ring(snoozed.next.id);
    expect(rung.statusCode, rung.payload).toBe(200);
    expect((await ring(snoozed.next.id)).statusCode).toBe(200);
    pushes = [];
    expect((await tickAt(t + 10 * MIN)).deliver).toEqual({ delivered: 0, pushed: 0 });
    expect(pushes).toHaveLength(0);
    // Answered as usual.
    expect((await app.inject({ method: 'POST', url: '/v1/alarm/wake/open', headers: h, payload: { id: snoozed.next.id } })).statusCode).toBe(200);
    // Someone else's: 404.
    const other = await userWith();
    expect((await app.inject({ method: 'POST', url: '/v1/alarm/wake/ring', headers: other.h, payload: { id: snoozed.next.id } })).statusCode).toBe(404);
  });

  it('answering her second call reads the first one too', async () => {
    const { user, h } = await userWith();
    await setAlarm(h);
    const day = ahead(TAIPEI);
    const t = at730(day, TAIPEI);
    await tickAt(t + 1_000);
    const [first] = await wakeups(user.id);
    clockAt(t + MIN);
    // An old client snoozed without the first being read; the second call comes and he answers it.
    const next: InboxRow = { id: 'inb_second', userId: user.id, star: 'nana', kind: 'wakeup', payload: { text: 'x', lineId: first.payload.lineId as string, day, snooze: true },
      dueAt: new Date(t + 2 * MIN).toISOString(), deliveredAt: null, readAt: null, createdAt: new Date(t + MIN).toISOString() };
    await repos.inbox.add(next);
    await tickAt(t + 2 * MIN + 1_000);
    clockAt(t + 3 * MIN);
    expect((await app.inject({ method: 'POST', url: '/v1/alarm/wake/open', headers: h, payload: { id: next.id } })).statusCode).toBe(200);
    expect((await repos.inbox.mine(user.id, first.id))!.readAt).toBeTruthy();
    // The second call cannot be snoozed again — and the web app never offers it (no 409 loop).
    expect(json(await app.inject({ method: 'POST', url: '/v1/alarm/wake/snooze', headers: h, payload: { id: next.id } }))).toEqual({ error: 'snooze_used' });
  });

  it('in production wakes him with her reviewed morning greeting while the wake-up lines are drafts', async () => {
    // Her lines are reviewed now (#84, owner 2026-09-28); the gate must still hold for a draft, so one is made here.
    expect(LINES.nana.draft).toBe(false);
    LINES.nana.draft = true;
    try {
      const prod = await buildApp({ repos, logger: false, demo: false });
      const { user, h } = await userWith('en');
      await setAlarm(h);
      const day = ahead(TAIPEI);
      await tickAt(at730(day, TAIPEI) + 1_000, false);
      const [row] = await wakeups(user.id);
      const greet = (greetings as unknown as Record<string, { morning: Record<string, string> }>).nana.morning;
      expect(row.payload).toMatchObject({ lineId: 'greet-morning', text: greet.en });
      clockAt(at730(day, TAIPEI) + MIN);
      const res = json(await prod.inject({ method: 'POST', url: '/v1/alarm/wake/open', headers: h, payload: { id: row.id, lang: 'ja' } }));
      expect(res).toMatchObject({ line: greet.ja, lineId: 'greet-morning', replies: null, snoozeLeft: 1 });
    } finally {
      LINES.nana.draft = false;
    }
  });

  it('in production wakes him with her own wake-up line and answers, now they are reviewed', async () => {
    const prod = await buildApp({ repos, logger: false, demo: false });
    const { user, h } = await userWith('en');
    await setAlarm(h);
    const day = ahead(TAIPEI);
    await tickAt(at730(day, TAIPEI) + 1_000, false);
    const [row] = await wakeups(user.id);
    const line = LINES.nana.wakeup.find((l) => l.id === row.payload.lineId)!;
    expect(line).toBeDefined();
    expect(row.payload.text).toBe(line.text.en);
    clockAt(at730(day, TAIPEI) + MIN);
    const res = json(await prod.inject({ method: 'POST', url: '/v1/alarm/wake/open', headers: h, payload: { id: row.id, lang: 'ja' } }));
    expect(res).toMatchObject({
      line: line.text.ja, lineId: line.id, snoozeLeft: 1,
      replies: { awake: LINES.nana.wakeReplies.awake.ja, snooze: LINES.nana.wakeReplies.snooze.ja }
    });
  });

  it('goes with the account: deleting it deletes the alarm, and nothing rings after', async () => {
    const { user, h } = await userWith();
    await setAlarm(h);
    const del = await app.inject({ method: 'DELETE', url: '/v1/auth/me', headers: h, payload: { confirm: 'DELETE' } });
    expect(del.statusCode).toBe(200);
    expect(await repos.alarms.get(user.id)).toBeNull();
    expect((await tickAt(at730(ahead(TAIPEI), TAIPEI) + 1_000)).ring).toEqual({ alarms: 0, rung: 0 });
  });
});

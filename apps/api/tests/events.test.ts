import { beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { EVENT_RETENTION_DAYS, addDays, jstDay, weekStart, type AdminMetricsResT, type EventName } from '@jstar/shared';
import { createMemoryRepos } from '../src/db/memory';
import { createSqlRepos } from '../src/db/sql';
import { SEED_CARDS } from '../src/db/seed';
import { zeroCounts, type Repos } from '../src/db/types';
import { newUserRow } from '../src/lib/account';
import { signJwt } from '../src/lib/crypto';
import { purgeExpiredEvents, recordEvent } from '../src/lib/events';
import { env } from '../src/env';
import { buildApp } from '../src/app';
import { createSqliteClient } from './sqlite';

/** Both stores must compute the same metrics: memory (dev, e2e) and SQL (production on D1, here on SQLite). */
const BACKENDS: [string, () => Repos][] = [
  ['memory', () => createMemoryRepos({ cards: SEED_CARDS })],
  ['sql', () => createSqlRepos(createSqliteClient())]
];

let repos: Repos;
const put = (userId: string | null, day: string, name: EventName, props: Record<string, unknown> = {}) =>
  repos.events.add({ userId, name, props: { star: 'nana', ...props }, day, createdAt: `${day}T03:00:00.000Z` });

/**
 * Three weeks of a small world (week of Mon 9/7, 9/14):
 * - A (first seen 9/7) triggers a scene on day 0, sets an alarm, keeps promise p1, reaches the confession on day 6,
 *   is prompted a variant, draws it and opens its scene the same day, and comes back on day 8.
 * - B (9/7) only enters the room, twice, and never comes back: the chat-only user.
 * - C (9/8) triggers two scenes, misses promise p2, is prompted and draws the next day without opening the scene,
 *   and comes back on day 8.
 * - D (9/8) enters once and deletes the account: gone from the cohorts, the room entry still counted.
 */
async function seedWorld() {
  await put('A', '2026-09-07', 'room.entered');
  await put('A', '2026-09-07', 'scene.trigger', { sceneId: 'welcome', source: 'request' });
  await put('A', '2026-09-08', 'alarm.set');
  await put('A', '2026-09-09', 'variant.prompted', { cardId: 's1-nana-30' });
  await put('A', '2026-09-09', 'variant.drawn', { cardId: 's1-nana-30' });
  await put('A', '2026-09-09', 'variant.scene_opened', { cardId: 's1-nana-30' });
  await put('A', '2026-09-10', 'promise.due', { promiseId: 'prm_1' });
  await put('A', '2026-09-10', 'promise.kept', { promiseId: 'prm_1' });
  await put('A', '2026-09-13', 'confession.reached');
  await put('A', '2026-09-15', 'room.entered');
  await put('B', '2026-09-07', 'room.entered');
  await put('B', '2026-09-08', 'room.entered');
  await put('C', '2026-09-08', 'room.entered');
  await put('C', '2026-09-08', 'scene.trigger', { sceneId: 'reading', source: 'proposed' });
  await put('C', '2026-09-09', 'scene.trigger', { sceneId: 'wakeup', source: 'time' });
  await put('C', '2026-09-09', 'promise.due', { promiseId: 'prm_2' });
  await put('C', '2026-09-09', 'variant.prompted', { cardId: 's1-nana-30' });
  await put('C', '2026-09-10', 'variant.drawn', { cardId: 's1-nana-30' });
  await put('C', '2026-09-16', 'room.entered');
  const d = await repos.users.create(newUserRow({ email: 'd@example.com', lineSub: null, nickname: 'd', via: 'email', lang: 'ja' }));
  await put(d.id, '2026-09-08', 'room.entered');
  await repos.users.anonymise(d.id, new Date().toISOString());
}

describe.each(BACKENDS)('events and metrics (%s store)', (_name, makeRepos) => {
  beforeEach(() => { repos = makeRepos(); });

  it('computes every metric from seeded events, by day', async () => {
    await seedWorld();
    const byDay = new Map((await repos.events.metrics('2026-09-07', '2026-09-13', 'day')).map((r) => [r.period, r]));
    expect([...byDay.keys()]).toEqual(['2026-09-07', '2026-09-08', '2026-09-09', '2026-09-10', '2026-09-13']);
    // A sets the alarm on 9/8: on 9/7 nobody active had one yet; from 9/8 on, A counts on every day A is active.
    expect(byDay.get('2026-09-07')).toMatchObject({
      newUsers: 2, confessed: 1, activeUsers: 2, alarmSet: 0, roomEntries: 2, sceneTriggers: 1, triggerSources: { request: 1, proposed: 0, time: 0 },
      sceneUsers: 1, sceneRetained: 1, chatOnlyUsers: 1, chatOnlyRetained: 0
    });
    // D deleted the account: no longer a cohort member, but the room entry stays in the counts.
    expect(byDay.get('2026-09-08')).toMatchObject({ newUsers: 1, activeUsers: 3, alarmSet: 1, sceneUsers: 1, sceneRetained: 1, roomEntries: 3, triggerSources: { proposed: 1 } });
    // C drew the variant the next day: in the daily view that is another period.
    expect(byDay.get('2026-09-09')).toMatchObject({ promisesDue: 1, promisesKept: 0, variantPrompted: 2, variantDrawn: 1, variantSceneOpened: 1, triggerSources: { time: 1 } });
    expect(byDay.get('2026-09-10')).toMatchObject({ promisesDue: 1, promisesKept: 1, activeUsers: 2, alarmSet: 1 });
    expect(byDay.get('2026-09-13')).toEqual({ period: '2026-09-13', ...zeroCounts(), activeUsers: 1, alarmSet: 1 });
  });

  it('computes the same metrics by week and for the whole range', async () => {
    await seedWorld();
    const weeks = await repos.events.metrics('2026-09-07', '2026-09-20', 'week');
    expect(weeks.map((w) => w.period)).toEqual(['2026-09-07', '2026-09-14']);
    const first = {
      newUsers: 3, confessed: 1, activeUsers: 3, alarmSet: 1, promisesDue: 2, promisesKept: 1, roomEntries: 5, sceneTriggers: 3,
      triggerSources: { request: 1, proposed: 1, time: 1 }, variantPrompted: 2, variantDrawn: 2, variantSceneOpened: 1,
      sceneUsers: 2, sceneRetained: 2, chatOnlyUsers: 1, chatOnlyRetained: 0
    };
    expect(weeks[0]).toEqual({ period: '2026-09-07', ...first });
    // Returning visits of week two are activity, not new users.
    // A and C come back in week two: active, not new; A still has the alarm set in week one.
    expect(weeks[1]).toEqual({ period: '2026-09-14', ...zeroCounts(), roomEntries: 2, activeUsers: 2, alarmSet: 1 });
    expect(await repos.events.metrics('2026-09-07', '2026-09-20', 'all')).toEqual([{ period: '2026-09-07', ...first, roomEntries: 7 }]);
    // Each of the five metrics is a number: confession 1/3, alarm 1/3 of the active users, promises kept 1/2, 1 trigger per 1.4 entries, variant 1/2.
    const [all] = await repos.events.metrics('2026-09-07', '2026-09-20', 'all');
    for (const [n, d] of [[all.confessed, all.newUsers], [all.alarmSet, all.activeUsers], [all.promisesKept, all.promisesDue], [all.sceneTriggers, all.roomEntries], [all.variantSceneOpened, all.variantPrompted]]) {
      expect(Number.isFinite(n / d) && d > 0).toBe(true);
    }
  });

  it('the alarm set rate is over the active users, not the new ones (#57)', async () => {
    // O was first seen before the range and sets the alarm inside it; R is a returning user without one; N is new
    // and sets one only after the range; L set one long ago and is active in the range.
    await put('O', '2026-08-01', 'room.entered');
    await put('O', '2026-09-08', 'alarm.set');
    await put('R', '2026-08-02', 'room.entered');
    await put('R', '2026-09-09', 'room.entered');
    await put('N', '2026-09-10', 'room.entered');
    await put('N', '2026-09-21', 'alarm.set');
    await put('L', '2026-07-01', 'alarm.set');
    await put('L', '2026-09-12', 'room.entered');
    const [all] = await repos.events.metrics('2026-09-07', '2026-09-20', 'all');
    // Four active users (O, R, N, L); O and L had set an alarm by 9/20, N only on 9/21. One new user (N).
    expect(all).toMatchObject({ newUsers: 1, activeUsers: 4, alarmSet: 2 });
    const weeks = await repos.events.metrics('2026-09-07', '2026-09-20', 'week');
    expect(weeks.map((w) => [w.period, w.activeUsers, w.alarmSet])).toEqual([['2026-09-07', 4, 2]]);
    // By day: O counts from the day the alarm was set, never before.
    const days = new Map((await repos.events.metrics('2026-09-07', '2026-09-20', 'day')).map((r) => [r.period, [r.activeUsers, r.alarmSet]]));
    expect(Object.fromEntries(days)).toEqual({ '2026-09-08': [1, 1], '2026-09-09': [1, 0], '2026-09-10': [1, 0], '2026-09-12': [1, 1] });
  });

  it('returns nothing for a range without events', async () => {
    expect(await repos.events.metrics('2026-01-01', '2026-01-31', 'week')).toEqual([]);
    expect(await repos.events.metrics('2026-01-01', '2026-01-31', 'all')).toEqual([]);
  });

  it('records validated events on the JST day, and refuses free text or unknown props', async () => {
    // 2026-09-26 23:30 UTC is already 9/27 in Japan.
    await recordEvent(repos, 'u1', 'scene.trigger', { star: 'alice', sceneId: 'greenhouse', source: 'time' }, new Date('2026-09-26T23:30:00Z'));
    expect((await repos.events.metrics('2026-09-27', '2026-09-27', 'day'))[0]).toMatchObject({ period: '2026-09-27', newUsers: 1, sceneTriggers: 1, triggerSources: { time: 1 } });
    await expect(recordEvent(repos, 'u1', 'gift.sent', { star: 'alice', giftId: 'I love you so much' })).rejects.toThrow();
    await expect(recordEvent(repos, 'u1', 'alarm.set', { star: 'alice', text: 'hi' } as never)).rejects.toThrow();
  });

  it('keeps 180 days and deletes older ones a day at a time', async () => {
    const today = '2026-09-26';
    const oldest = addDays(today, -(EVENT_RETENTION_DAYS - 1));
    for (const day of [addDays(oldest, -2), addDays(oldest, -1), oldest, today]) await put('A', day, 'room.entered');
    await put('B', addDays(oldest, -1), 'room.entered');
    expect(await purgeExpiredEvents(repos, today, 1)).toEqual({ days: 1, rows: 1 });
    expect(await purgeExpiredEvents(repos, today)).toEqual({ days: 1, rows: 2 });
    expect(await purgeExpiredEvents(repos, today)).toEqual({ days: 0, rows: 0 });
    const [left] = await repos.events.metrics('2000-01-01', today, 'all');
    expect(left.roomEntries).toBe(2);
  });

  it('serves the admin metrics page zero-filled, to admins only, with today in it', async () => {
    const app: FastifyInstance = await buildApp({ repos, logger: false, demo: false });
    const admin = await repos.users.create({ ...newUserRow({ email: 'admin@example.com', lineSub: null, nickname: 'a', via: 'email', lang: 'ja' }), role: 'admin' });
    const member = await repos.users.create(newUserRow({ email: 'm@example.com', lineSub: null, nickname: 'm', via: 'email', lang: 'ja' }));
    const auth = (id: string) => ({ authorization: `Bearer ${signJwt({ sub: id }, env.JWT_SECRET, 3600)}` });
    expect((await app.inject({ url: '/v1/admin/metrics', headers: auth(member.id) })).statusCode).toBe(403);

    const empty = JSON.parse((await app.inject({ url: '/v1/admin/metrics?grain=week&days=28', headers: auth(admin.id) })).payload) as AdminMetricsResT;
    expect(empty.from).toBe(weekStart(addDays(jstDay(), -27)));
    expect(empty.periods.length).toBeGreaterThanOrEqual(4);
    expect(empty.periods.every((p) => p.roomEntries === 0 && p.newUsers === 0)).toBe(true);
    expect(empty.total).toEqual(zeroCounts());

    await app.recordEvent(member.id, 'room.entered', { star: 'mahiro' });
    const res = JSON.parse((await app.inject({ url: '/v1/admin/metrics?days=7', headers: auth(admin.id) })).payload) as AdminMetricsResT;
    expect(res.periods).toHaveLength(7);
    expect(res.periods.at(-1)).toMatchObject({ period: jstDay(), roomEntries: 1, newUsers: 1, chatOnlyUsers: 1 });
    expect(res.total).toMatchObject({ roomEntries: 1, newUsers: 1 });
    expect((await app.inject({ url: '/v1/admin/metrics?days=999', headers: auth(admin.id) })).statusCode).toBe(400);

    // Account deletion: the event stays counted, but no longer as this user's.
    const h = auth(member.id);
    expect((await app.inject({ method: 'DELETE', url: '/v1/auth/me', headers: h, payload: { confirm: 'DELETE' } })).statusCode).toBe(200);
    const after = JSON.parse((await app.inject({ url: '/v1/admin/metrics?days=7', headers: auth(admin.id) })).payload) as AdminMetricsResT;
    expect(after.total).toMatchObject({ roomEntries: 1, newUsers: 0 });
    await app.close();
  });
});

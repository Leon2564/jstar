import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { LANGS, calendarLine, type Lang } from '@jstar/shared';
import { HER_MESSAGE_LINES } from '@jstar/shared/herMessages';
import { LINES } from '@jstar/shared/lines';
import { signJwt } from '../src/lib/crypto';
import { createMemoryRepos } from '../src/db/memory';
import { createSqlRepos } from '../src/db/sql';
import { SEED_CARDS } from '../src/db/seed';
import type { InboxRow, Repos } from '../src/db/types';
import { newUserRow } from '../src/lib/account';
import { CALENDAR_INBOX_PREFIX, DEMO_DAY_MS, calendarExpiry, greetingRow } from '../src/lib/calendar';
import { newPromise } from '../src/lib/promises';
import { writtenIn } from '../src/lib/inboxLang';
import type { HerRestateInput } from '../src/lib/agent';
import { env } from '../src/env';
import { buildApp } from '../src/app';
import { createSqliteClient } from './sqlite';

/**
 * M16 (her calendar messages lapse at the end of their day) and M18 (her items in his language when he reads them,
 * whatever language he had when they were written), through the inbox routes, on both stores.
 */
const BACKENDS: [string, () => Repos][] = [
  ['memory', () => createMemoryRepos({ cards: SEED_CARDS })],
  ['sql', () => createSqlRepos(createSqliteClient())]
];
const HOUR = 3_600_000;
const json = (res: { payload: string }) => JSON.parse(res.payload);
type Item = { id: string; readAt: string | null; payload: { text?: string; sceneId?: string; texts?: Record<string, string> } };

describe.each(BACKENDS)('her inbox as he reads it (%s store)', (_name, makeRepos) => {
  let app: FastifyInstance;
  let repos: Repos;
  const asked: HerRestateInput[] = [];
  let answer: (i: HerRestateInput) => string | null = (i) => `[${i.lang}] ${i.text}`;

  beforeEach(async () => {
    repos = makeRepos();
    asked.length = 0;
    answer = (i) => (i.lang === 'zh-Hant' ? '下雨了，我泡了茶。' : `[${i.lang}]`);
    app = await buildApp({
      repos, logger: false, demo: false,
      her: { write: async () => null, demo: false, restate: async (i) => { asked.push(i); return answer(i); } }
    });
  });

  async function member(lang: Lang = 'zh-Hant', tz: string | null = null) {
    const user = await repos.users.create({ ...newUserRow({ email: `${Math.random()}@example.com`, lineSub: null, nickname: 'u', via: 'email', lang: 'ja' }), tz });
    if (lang !== 'ja') await repos.users.update(user.id, { lang });
    return { user, h: { authorization: `Bearer ${signJwt({ sub: user.id }, env.JWT_SECRET, 7 * 86_400)}` } };
  }
  const put = async (userId: string, id: string, payload: Record<string, unknown>, patch: Partial<InboxRow> = {}) => {
    const at = new Date(Date.now() - 60_000).toISOString();
    const row: InboxRow = { id, userId, star: 'nana', kind: 'message', payload, dueAt: at, deliveredAt: at, readAt: null, createdAt: at, ...patch };
    await repos.inbox.add(row);
    return row;
  };
  const inbox = async (h: Record<string, string>) => json(await app.inject({ url: '/v1/inbox', headers: h })) as { items: Item[]; unread: number };
  const item = async (h: Record<string, string>, id: string) => (await inbox(h)).items.find((i) => i.id === id)!;

  describe('M16: her calendar message lapses at the end of its day', () => {
    /** 2026-12-24 12:00 JST. */
    const NOON = Date.parse('2026-12-24T12:00:00+09:00');
    afterEach(() => { vi.useRealTimers(); });

    it('lapses at the end of the day it came on, on his clock; a pretend day\'s lasts the pretend day; nothing about the day is stored', () => {
      const row = (id: string, createdAt: string) => ({ id, createdAt });
      expect(calendarExpiry(row('cal_x', '2026-12-24T03:00:00.000Z'), null)).toBe(Date.parse('2026-12-25T00:00:00+09:00'));
      expect(calendarExpiry(row('cal_x', '2026-12-24T03:00:00.000Z'), 'Asia/Taipei')).toBe(Date.parse('2026-12-25T00:00:00+08:00'));
      expect(calendarExpiry(row('cal_demo_x', '2026-12-24T14:30:00.000Z'), null)).toBe(Date.parse('2026-12-24T14:30:00.000Z') + DEMO_DAY_MS);
      expect(calendarExpiry(row('wx_x', '2026-12-24T03:00:00.000Z'), null)).toBeNull();
      const g = { star: 'nana' as const, id: 'cal_x', event: { kind: 'hisBirthday' as const, day: '2026-12-24', key: 'hisBirthday:2026' } };
      const made = greetingRow('u', 'ja', g, '2026-12-24T03:00:00.000Z');
      expect(made.payload.texts).toEqual(Object.fromEntries(LANGS.map((l) => [l, calendarLine(g.event, l, 'cal_x')])));
      expect(JSON.stringify(made.payload)).not.toMatch(/12-24|2026/);
    });

    it('past its day it is read as of then, names no scene, and no badge counts it — old rows too', async () => {
      vi.useFakeTimers({ toFake: ['Date'] });
      vi.setSystemTime(NOON);
      const { user, h } = await member('ja');
      const iso = (ms: number) => new Date(ms).toISOString();
      await put(user.id, `${CALENDAR_INBOX_PREFIX}today`, { text: 'おめでとう', calendar: 'hisBirthday', sceneId: 'his-birthday-nana' },
        { kind: 'event', createdAt: iso(NOON - HOUR), dueAt: iso(NOON - HOUR), deliveredAt: iso(NOON - HOUR) });
      const yesterday = NOON - 20 * HOUR; // 16:00 JST the day before
      await put(user.id, `${CALENDAR_INBOX_PREFIX}yesterday`, { text: 'おめでとう', calendar: 'hisBirthday', sceneId: 'his-birthday-nana' },
        { kind: 'event', createdAt: iso(yesterday), dueAt: iso(yesterday), deliveredAt: iso(yesterday) });
      // Not hers by the calendar: never lapses this way.
      await put(user.id, 'inb_note', { text: 'ふつうの手紙', herMessage: 'note', lang: 'ja' }, { createdAt: iso(yesterday), deliveredAt: iso(yesterday) });

      expect(json(await app.inject({ url: '/v1/auth/me', headers: h })).inboxUnread).toBe(2);
      const { items, unread } = await inbox(h);
      expect(unread).toBe(2);
      const by = Object.fromEntries(items.map((i) => [i.id, i]));
      expect(by[`${CALENDAR_INBOX_PREFIX}today`]).toMatchObject({ readAt: null, payload: { sceneId: 'his-birthday-nana' } });
      expect(by[`${CALENDAR_INBOX_PREFIX}yesterday`].readAt).toBe(new Date('2026-12-24T00:00:00+09:00').toISOString());
      expect(by[`${CALENDAR_INBOX_PREFIX}yesterday`].payload).not.toHaveProperty('sceneId');
      expect(by.inb_note.readAt).toBeNull();
      // His room cannot open a lapsed one's scene either.
      const room = await app.inject({ method: 'POST', url: '/v1/scene/room', headers: h, payload: { star: 'nana', inboxId: `${CALENDAR_INBOX_PREFIX}yesterday` } });
      expect(json(room).offer).toBeNull();
      // The next day today's lapses too.
      vi.setSystemTime(NOON + 13 * HOUR);
      expect((await inbox(h)).unread).toBe(1);
    });
  });

  describe('M18: her items in his language now', () => {
    it('her written lines from before `texts` are found again: calendar, wake-up, weather, a fallback note, a promise due', async () => {
      const { user, h } = await member('zh-Hant');
      const e = { kind: 'hisBirthday' as const };
      await put(user.id, 'cal_legacy', { text: calendarLine(e, 'ja', 'cal_legacy'), calendar: 'hisBirthday' }, { kind: 'event' });
      const wake = LINES.nana.wakeup[0];
      await put(user.id, 'inb_wake', { text: wake.text.ja, lineId: wake.id, day: '2026-10-05' }, { kind: 'wakeup' });
      const snow = LINES.nana.weather.firstSnow[0];
      await put(user.id, 'wx_snow', { text: snow.ja, event: 'firstSnow', sceneId: 'first-snow-nana' }, { kind: 'event' });
      await put(user.id, 'inb_fallback', { text: HER_MESSAGE_LINES.note.ja[1], herMessage: 'note' });
      const p = newPromise({ userId: user.id, star: 'nana', text: '夜9時、朗読を聞かせる', dueAt: new Date(Date.now() - 60_000).toISOString(), kind: 'scene', source: 'chat', lang: 'ja' }, Date.now() - 6 * HOUR);
      await repos.promises.create(p);
      await put(user.id, 'inb_promise', { text: '約束の時間だよ', promiseId: p.id, kind: 'scene' }, { kind: 'promise_due' });

      const text = async (id: string) => (await item(h, id)).payload.text;
      expect(await text('cal_legacy')).toBe(calendarLine(e, 'zh-Hant', 'cal_legacy'));
      expect(await text('inb_wake')).toBe(wake.text['zh-Hant']);
      expect(await text('wx_snow')).toBe(snow['zh-Hant']);
      expect(await text('inb_fallback')).toBe(HER_MESSAGE_LINES.note['zh-Hant'][1]);
      expect(writtenIn((await text('inb_promise'))!)).toBe('zh-Hant');
      // None of these needed the model.
      expect(asked).toEqual([]);
    });

    it('her own words the model wrote are said again in his language once, kept on the row, and as written in theirs', async () => {
      const { user, h } = await member('zh-Hant');
      await repos.bond.setName(user.id, 'ケンタ', new Date().toISOString());
      await put(user.id, 'inb_model', { text: '雨だから、お茶を淹れたよ。', herMessage: 'note', lang: 'ja' });
      await put(user.id, 'inb_legacy', { text: 'It rained, so I made tea.', herMessage: 'note' });
      await put(user.id, 'inb_same', { text: '下雨了。', herMessage: 'note', lang: 'zh-Hant' });
      expect((await item(h, 'inb_model')).payload.text).toBe('下雨了，我泡了茶。');
      expect((await item(h, 'inb_legacy')).payload.text).toBe('下雨了，我泡了茶。');
      expect((await item(h, 'inb_same')).payload.text).toBe('下雨了。');
      expect(asked.map((a) => [a.text, a.lang, a.callName]).sort()).toEqual([['It rained, so I made tea.', 'zh-Hant', 'ケンタ'], ['雨だから、お茶を淹れたよ。', 'zh-Hant', 'ケンタ']]);
      // Kept: read again, no call.
      await inbox(h);
      expect(asked).toHaveLength(2);
      expect((await repos.inbox.mine(user.id, 'inb_model'))!.payload.texts).toEqual({ ja: '雨だから、お茶を淹れたよ。', 'zh-Hant': '下雨了，我泡了茶。' });
      // Back in Japanese: her words as she wrote them, no call for those (the other two are said again in Japanese).
      await repos.users.update(user.id, { lang: 'ja' });
      expect((await item(h, 'inb_model')).payload.text).toBe('雨だから、お茶を淹れたよ。');
      expect(asked.slice(2).map((a) => [a.text, a.lang]).sort()).toEqual([['It rained, so I made tea.', 'ja'], ['下雨了。', 'ja']]);
    });

    it('opened, her message joins the conversation in his language; one that cannot be had is shown as written, not asked again at once', async () => {
      const { user, h } = await member('zh-Hant');
      await put(user.id, 'inb_open', { text: '雨だから、お茶を淹れたよ。', herMessage: 'note', lang: 'ja' });
      const res = await app.inject({ method: 'POST', url: '/v1/inbox/inb_open/read', headers: h });
      expect(json(res).item.payload.text).toBe('下雨了，我泡了茶。');
      expect((await repos.messages.recent(user.id, 'nana', 5)).map((m) => m.text)).toEqual(['下雨了，我泡了茶。']);

      answer = () => null;
      await put(user.id, 'inb_down', { text: 'またあとでね。', herMessage: 'note', lang: 'ja' });
      expect((await item(h, 'inb_down')).payload.text).toBe('またあとでね。');
      const calls = asked.length;
      await inbox(h);
      expect(asked).toHaveLength(calls);
    });

    it('her wake-up as the alarm shows it is in his language too', async () => {
      const { user, h } = await member('en');
      const wake = LINES.nana.wakeup[1];
      await put(user.id, 'inb_wake2', { text: wake.text.ja, lineId: wake.id, day: '2026-10-05' }, { kind: 'wakeup' });
      const res = await app.inject({ method: 'POST', url: '/v1/alarm/wake/open', headers: h, payload: { id: 'inb_wake2' } });
      expect(json(res).item.payload.text).toBe(wake.text.en);
    });
  });
});

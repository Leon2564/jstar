import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { signJwt } from '../src/lib/crypto';
import { createMemoryRepos } from '../src/db/memory';
import { createSqlRepos } from '../src/db/sql';
import { SEED_CARDS } from '../src/db/seed';
import type { InboxRow, Repos } from '../src/db/types';
import { newUserRow } from '../src/lib/account';
import { calendarExpiry, greetingRow } from '../src/lib/calendar';
import { env } from '../src/env';
import { buildApp } from '../src/app';
import { createSqliteClient } from './sqlite';
import { metBefore } from './met';

/**
 * C-room N1 (an answered invitation never leads to a locked scene: into it now, or 「今晚見」, a promise for when it
 * can start), N8 (the same message twice in a day is one: 下次吧 sticks) and N5 (her calendar message in every
 * language), on both stores.
 */
const BACKENDS: [string, () => Repos][] = [
  ['memory', () => createMemoryRepos({ cards: SEED_CARDS })],
  ['sql', () => createSqlRepos(createSqliteClient())]
];
const json = (res: { payload: string }) => JSON.parse(res.payload);
/** 07:34 JST: うんぱい's stream (evening and night, while she streams her walk: 17:00–23:00 JST) cannot start yet. */
const MORNING = Date.parse('2026-10-05T07:34:00+09:00');
const TONIGHT = Date.parse('2026-10-05T20:00:00+09:00');

afterEach(() => { vi.useRealTimers(); });

describe.each(BACKENDS)('her invitation, now or tonight (%s store)', (_name, makeRepos) => {
  let app: FastifyInstance;
  let repos: Repos;
  beforeEach(async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(MORNING);
    repos = makeRepos();
    app = await buildApp({ repos, logger: false, demo: true });
  });

  async function member() {
    const user = await repos.users.create(newUserRow({ email: `${Math.random()}@example.com`, lineSub: null, nickname: 'u', via: 'email', lang: 'zh-Hant' }));
    await metBefore(repos, user.id);
    return { user, h: { authorization: `Bearer ${signJwt({ sub: user.id }, env.JWT_SECRET, 7 * 86_400)}` } };
  }
  const invite = async (userId: string, id: string, sceneId = 'private-stream', agoMs = 60_000, patch: Partial<InboxRow> = {}) => {
    const at = new Date(Date.now() - agoMs).toISOString();
    const row: InboxRow = { id, userId, star: 'unpai', kind: 'message', payload: { text: '晚上要不要和我一起窩著，只對你一個人直播喔。', herMessage: 'invite', sceneId }, dueAt: at, deliveredAt: at, readAt: null, createdAt: at, ...patch };
    await repos.inbox.add(row);
    return row;
  };
  const room = async (h: Record<string, string>, inboxId: string) => {
    const res = await app.inject({ method: 'POST', url: '/v1/scene/room', headers: h, payload: { star: 'unpai', inboxId } });
    expect(res.statusCode, res.payload).toBe(200);
    return json(res) as { offer: { sceneId: string } | null; invite?: { sceneId: string; ready: boolean; dueAt: string | null; tonight: boolean; title: Record<string, string> } };
  };
  const tonight = (h: Record<string, string>, body: object) => app.inject({ method: 'POST', url: '/v1/promises/tonight', headers: h, payload: { star: 'unpai', sceneId: 'private-stream', ...body } });

  it('by day: no link to her evening scene — 「今晚見」, a promise for her evening, kept by her then (N1)', async () => {
    const { user, h } = await member();
    await invite(user.id, 'inb_inv');
    const r = await room(h, 'inb_inv');
    expect(r.offer).toBeNull();
    expect(r.invite).toEqual({ sceneId: 'private-stream', title: expect.objectContaining({ 'zh-Hant': '只給你一個人的直播' }), ready: false, dueAt: new Date(TONIGHT).toISOString(), tonight: true });
    // The scene itself is locked now: what the room never links to.
    expect((await app.inject({ method: 'POST', url: '/v1/scene/start', headers: h, payload: { sceneId: 'private-stream' } })).statusCode).toBe(403);

    const made = await tonight(h, { inboxId: 'inb_inv', lang: 'zh-Hant' });
    expect(made.statusCode, made.payload).toBe(201);
    const { promise } = json(made);
    expect(promise).toMatchObject({ star: 'unpai', kind: 'scene', sceneId: 'private-stream', status: 'open', text: '只給你一個人的直播', dueAt: new Date(TONIGHT).toISOString() });
    // Her invitation is answered: read.
    expect((await repos.inbox.mine(user.id, 'inb_inv'))?.readAt).toBeTruthy();
    // A second tap is the same promise.
    const again = await tonight(h, { inboxId: 'inb_inv' });
    expect(again.statusCode).toBe(200);
    expect(json(again).promise.id).toBe(promise.id);

    // Tonight, in her window, the scene starts.
    vi.setSystemTime(TONIGHT);
    expect((await app.inject({ method: 'POST', url: '/v1/scene/start', headers: h, payload: { sceneId: 'private-stream' } })).statusCode).toBe(200);
  });

  it('in her evening: the invitation is the scene, now', async () => {
    vi.setSystemTime(TONIGHT);
    const { user, h } = await member();
    await invite(user.id, 'inb_now');
    const r = await room(h, 'inb_now');
    // Offered (the moment's offer for the message) — or, when an offer is held back, still ready now.
    expect(r.offer?.sceneId ?? (r.invite?.ready && r.invite.sceneId)).toBe('private-stream');
    const now = await tonight(h, {});
    expect(now.statusCode).toBe(409);
    expect(now.payload).toContain('not_promisable');
  });

  it('a scene no time can be promised for (a card he does not have) is neither offered nor promised', async () => {
    const { user, h } = await member();
    await invite(user.id, 'inb_var', 'variant-unpai-1');
    const r = await room(h, 'inb_var');
    expect(r).toEqual({ offer: null });
    const refused = await tonight(h, { sceneId: 'variant-unpai-1' });
    expect(refused.statusCode).toBe(409);
    expect(refused.payload).toContain('not_promisable');
  });

  it('D-N1: a calendar message whose moment is not open (her birthday, another day) is her words — no scene to enter', async () => {
    const { user, h } = await member();
    const at = new Date(Date.now() - 60_000).toISOString();
    await repos.inbox.add({ id: 'cal_stale', userId: user.id, star: 'mahiro', kind: 'event', payload: { text: '今天啊，是我的生日。', calendar: 'herBirthday', sceneId: 'her-birthday-mahiro' }, dueAt: at, deliveredAt: at, readAt: null, createdAt: at });
    const res = await app.inject({ method: 'POST', url: '/v1/scene/room', headers: h, payload: { star: 'mahiro', inboxId: 'cal_stale' } });
    expect(res.statusCode).toBe(200);
    expect(json(res).offer?.sceneId).not.toBe('her-birthday-mahiro');
    expect(json(res).invite).toBeUndefined();
    expect((await app.inject({ method: 'POST', url: '/v1/scene/start', headers: h, payload: { sceneId: 'her-birthday-mahiro' } })).statusCode).toBe(403);
  });

  it('the same invitation twice in a day is one; answered, its copy goes too, and a copy written later stays (N8)', async () => {
    const { user, h } = await member();
    await invite(user.id, 'inb_a', 'private-stream', 120_000);
    await invite(user.id, 'inb_b', 'private-stream', 60_000);
    const list = async () => json(await app.inject({ url: '/v1/inbox', headers: h })).items as { id: string; readAt: string | null }[];
    let items = await list();
    expect(items.find((i) => i.id === 'inb_a')?.readAt).toBeTruthy();
    expect(items.find((i) => i.id === 'inb_b')?.readAt).toBeNull();
    // A third copy from before his answer, then 下次吧 (read): it is read with it.
    await invite(user.id, 'inb_c', 'private-stream', 90_000);
    expect((await app.inject({ method: 'POST', url: '/v1/inbox/inb_b/read', headers: h })).statusCode).toBe(200);
    items = await list();
    expect(items.filter((i) => i.id.startsWith('inb_') && !i.readAt)).toEqual([]);
    // Asked again afterwards (the test site's pretend day): a new one.
    vi.setSystemTime(MORNING + 5 * 60_000);
    await invite(user.id, 'inb_d', 'private-stream', 0);
    items = await list();
    expect(items.find((i) => i.id === 'inb_d')?.readAt).toBeNull();
  });

  it('C-room R1: answering her invitation (the room, 今晚見) reads that invitation only — her other messages stay unread', async () => {
    const { user, h } = await member();
    const at = new Date(Date.now() - 120_000).toISOString();
    for (const [id, kind] of [['inb_dream', 'dream'], ['inb_note', 'note']] as const) {
      await repos.inbox.add({ id, userId: user.id, star: 'unpai', kind: 'message', payload: { text: '中午好。', herMessage: kind }, dueAt: at, deliveredAt: at, readAt: null, createdAt: at });
    }
    await invite(user.id, 'inb_inv');
    await room(h, 'inb_inv');
    expect((await tonight(h, { inboxId: 'inb_inv', lang: 'zh-Hant' })).statusCode).toBe(201);
    const list = json(await app.inject({ method: 'GET', url: '/v1/inbox', headers: h })) as { items: { id: string; readAt: string | null }[]; unread: number };
    const read = Object.fromEntries(list.items.map((i) => [i.id, !!i.readAt]));
    expect(read).toMatchObject({ inb_inv: true, inb_dream: false, inb_note: false });
    expect(list.unread).toBe(2);
  });
});

describe('her calendar message lapses with its moment (D-N1)', () => {
  it('her day ends at midnight in Japan, his birthday at his own midnight — on the clock its scene uses', () => {
    const createdAt = '2026-03-04T14:30:00.000Z'; // 23:30 JST, 22:30 in Taipei
    expect(calendarExpiry({ id: 'cal_a', createdAt, payload: { calendar: 'herBirthday' } }, 'Asia/Taipei')).toBe(Date.parse('2026-03-05T00:00:00+09:00'));
    expect(calendarExpiry({ id: 'cal_b', createdAt, payload: { calendar: 'hisBirthday' } }, 'Asia/Taipei')).toBe(Date.parse('2026-03-05T00:00:00+08:00'));
  });
});

describe('her calendar message in every language (N5)', () => {
  it('Christmas in ja, zh-Hant, en and ko: the English and Korean rows are not her Japanese', () => {
    const row = greetingRow('u1', 'ja', { star: 'mahiro', id: 'cal_x', event: { kind: 'season', season: 'christmas', day: '2026-12-25', key: 'season:christmas:2026' } as never }, '2026-12-25T00:00:00.000Z');
    const texts = row.payload.texts as Record<string, string>;
    expect(Object.keys(texts).sort()).toEqual(['en', 'ja', 'ko', 'zh-Hant']);
    expect(texts.en).toMatch(/^Merry Christmas/);
    expect(texts.ko).toMatch(/[가-힣]/);
    expect(texts.en).not.toMatch(/[ぁ-ゖァ-ヺ]/);
  });
});

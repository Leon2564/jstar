import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { GIFT_RULES, MemoryExport, jstDay } from '@jstar/shared';
import { signJwt } from '../src/lib/crypto';
import { createMemoryRepos } from '../src/db/memory';
import { createSqlRepos } from '../src/db/sql';
import { SEED_CARDS } from '../src/db/seed';
import type { Repos } from '../src/db/types';
import { newUserRow } from '../src/lib/account';
import { metBefore } from './met';
import { newPromise } from '../src/lib/promises';
import { stillLink } from '../src/modules/memories';
import { env } from '../src/env';
import { buildApp } from '../src/app';
import { createSqliteClient } from './sqlite';

// The judge and the persona follow their contracts by keyword, as in minigames.test.ts: comments are greeted.
vi.mock('../src/lib/minigameJudge', () => ({
  judgeMinigame: async (input: { kind: string; text: string }) => (input.kind === 'ogiri'
    ? { kind: 'ogiri', score: Number(/SCORE(\d+)/.exec(input.text)?.[1] ?? 5), comment: null }
    : { kind: 'danmaku', label: 'greet' })
}));
vi.mock('../src/lib/agent', () => ({
  askPersona: async (input: { text: string }) => ({ reply: `echo:${input.text}`, blocked: false, boundary: null, memory: null, cardTitle: null }),
  streamPersona: async function* () { yield { type: 'error', error: 'unused' }; },
  greetPersona: async () => 'hi',
  giftPersona: async () => { throw new Error('unused'); }
}));

const BACKENDS: [string, () => Repos][] = [
  ['memory', () => createMemoryRepos({ cards: SEED_CARDS })],
  ['sql', () => createSqlRepos(createSqliteClient())]
];
/** 2026-11-02 12:00 JST. */
const NOON = Date.UTC(2026, 10, 2, 3, 0);
const HOUR = 3_600_000;

let app: FastifyInstance;
let repos: Repos;
type Beat = { id: string; type: string; media?: string; live?: boolean; text?: { ja: string } };
type Run = {
  id: string; seq: number; status: string; outcome: string | null; live?: boolean;
  beats: Beat[]; waiting: { id: string } | null; result: Record<string, unknown> | null;
  rewards: { affinity: number; memories: { title: string; still?: string }[]; promises: { text: string; kind?: string }[] }
};

async function member(points = 1000) {
  const user = await repos.users.create({ ...newUserRow({ email: `${Math.random()}@example.com`, lineSub: null, nickname: 'u', via: 'email', lang: 'ja' }) });
  await metBefore(repos, user.id);
  const now = (await repos.users.byId(user.id))!.points;
  await repos.users.adjustWallet(user.id, { points: points - now });
  return { user, h: { authorization: `Bearer ${signJwt({ sub: user.id }, env.JWT_SECRET, 3600)}` } };
}
const json = (res: { payload: string }) => JSON.parse(res.payload);
/** His session, signed at the (fake) time now. */
const auth = (userId: string) => ({ authorization: `Bearer ${signJwt({ sub: userId }, env.JWT_SECRET, 3600)}` });
const post = (url: string, payload: object, headers: Record<string, string>) => app.inject({ method: 'POST', url, headers, payload });
async function preview(h: Record<string, string>, sceneId: string): Promise<Run> {
  const res = await post('/v1/scene/start', { sceneId, preview: true }, h);
  expect(res.statusCode, res.payload).toBe(200);
  return json(res).run;
}
async function step(h: Record<string, string>, run: Run, answer: object): Promise<Run> {
  const res = await post('/v1/scene/step', { runId: run.id, seq: run.seq, ...answer }, h);
  expect(res.statusCode, res.payload).toBe(200);
  return json(res).run;
}
const said = (r: Run) => r.beats.flatMap((b) => (b.type === 'line' && b.text ? [b.text.ja] : []));

/** うんぱい's stream up to her gift question: three comments. */
async function toGift(h: Record<string, string>): Promise<Run> {
  let run = await preview(h, 'private-stream');
  for (const c of ['こんばんは', 'かわいい', '今日なに聴いてた？']) run = await step(h, run, { minigame: { text: c } });
  expect(run.waiting?.id).toBe('gift');
  return run;
}

afterEach(() => { vi.useRealTimers(); });

describe.each(BACKENDS)('scene gameplay (%s store)', (_name, makeRepos) => {
  beforeEach(async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(NOON);
    repos = makeRepos();
    app = await buildApp({ repos, logger: false, demo: true });
  });

  it('#68: her stream is live from the first shot, and off air (下播) before the alley', async () => {
    const { h } = await member();
    let run = await preview(h, 'private-stream');
    expect(run.live).toBe(true);
    expect(run.beats.find((b) => b.id === 'on-air')).toMatchObject({ type: 'effect', live: true });
    run = await toGift(h);
    expect(run.live).toBe(true);
    run = await step(h, await step(h, run, { choice: 'clap' }), { choice: 'listen' });
    const ids = run.beats.map((b) => b.id);
    expect(ids.indexOf('off')).toBeLessThan(ids.indexOf('off-air'));
    expect(ids.indexOf('off-air')).toBeLessThan(ids.indexOf('alley'));
    expect(run.live).toBeUndefined();
  });

  it('#68/#77: a gift in the stream spends points like any gift, once; she thanks him for what he gave', async () => {
    const { user, h } = await member(1000);
    const run = await toGift(h);
    const price = GIFT_RULES.prices.bouquet;
    const given = await step(h, run, { choice: 'gift', gift: 'bouquet' });
    expect(given.result).toMatchObject({ kind: 'gift', giftId: 'bouquet', result: 'win' });
    expect((given.result as { xp: number }).xp).toBeGreaterThan(0);
    expect(given.beats[0]).toMatchObject({ id: 'gift~gift', type: 'line' });
    expect(said(given)[0]).toContain('花束');
    expect(given.waiting?.id).toBe('ask');
    expect((await repos.users.byId(user.id))!.points).toBe(1000 - price);
    expect(await repos.gifts.countOn(user.id, jstDay(NOON))).toBe(1);
    // The same answer again (a retry): nothing more is paid.
    const again = json(await post('/v1/scene/step', { runId: run.id, seq: run.seq, choice: 'gift', gift: 'bouquet' }, h));
    expect(again.replayed).toBe(true);
    expect((await repos.users.byId(user.id))!.points).toBe(1000 - price);
    expect(await repos.gifts.countOn(user.id, jstDay(NOON))).toBe(1);
  });

  it('#68: without the points, or past today\'s gifts, the scene waits at the same step — and applause still works', async () => {
    const { user, h } = await member(0);
    let run = await toGift(h);
    const poor = await post('/v1/scene/step', { runId: run.id, seq: run.seq, choice: 'gift', gift: 'bouquet' }, h);
    expect([poor.statusCode, json(poor).error]).toEqual([402, 'insufficient_points']);
    expect(json(await app.inject({ url: `/v1/scene/runs/${run.id}`, headers: h })).run).toMatchObject({ seq: run.seq, waiting: { id: 'gift' } });
    // Today's gifts used up elsewhere: 409, nothing paid.
    await repos.users.adjustWallet(user.id, { points: 10_000 });
    for (let i = 0; i < GIFT_RULES.perDay; i++) expect((await post('/v1/gift', { star: 'unpai', giftId: 'candle' }, h)).statusCode).toBe(200);
    const points = (await repos.users.byId(user.id))!.points;
    const capped = await post('/v1/scene/step', { runId: run.id, seq: run.seq, choice: 'gift', gift: 'bouquet' }, h);
    expect([capped.statusCode, json(capped).error]).toEqual([409, 'gift_limit']);
    expect((await repos.users.byId(user.id))!.points).toBe(points);
    // A gift option needs a gift; an ordinary option takes none.
    expect((await post('/v1/scene/step', { runId: run.id, seq: run.seq, choice: 'gift' }, h)).statusCode).toBe(400);
    expect((await post('/v1/scene/step', { runId: run.id, seq: run.seq, choice: 'clap', gift: 'bouquet' }, h)).statusCode).toBe(400);
    run = await step(h, run, { choice: 'clap' });
    expect(run.waiting?.id).toBe('ask');
  });

  it('#51: the memory card keeps the shot it was made on — on the account and in his export', async () => {
    const { user, h } = await member();
    let run = await step(h, await toGift(h), { choice: 'clap' });
    run = await step(h, await step(h, run, { choice: 'listen' }), { choice: 'lean' });
    expect(run.status).toBe('ended');
    // #80's shot of the shared earphone, on screen when the card is made.
    expect(run.rewards.memories).toEqual([expect.objectContaining({ title: '片耳ずつのヘッドホン', still: 'unpai-scene-private-stream-share' })]);
    const [stored] = (await repos.memories.forUser(user.id)).filter((m) => m.kind === 'scene');
    expect(stored).toMatchObject({ sceneId: 'private-stream', still: 'unpai-scene-private-stream-share' });
    const me = json(await app.inject({ url: '/v1/auth/me', headers: h }));
    expect(me.memories).toEqual([expect.objectContaining({ still: 'unpai-scene-private-stream-share' })]);
    const out = MemoryExport.parse(json(await app.inject({ url: '/v1/me/export', headers: h })));
    expect(out.memories[0].still).toMatchObject({ type: 'image/jpeg', expiresAt: null });
    // The poster the site serves: a clip made at high quality has poster-hq.jpg, her older loops poster.jpg.
    expect(out.memories[0].still!.url).toMatch(/\/media\/unpai-scene-private-stream-share-9x16\/poster-hq\.jpg$/);
    expect(stillLink('https://x', 'unpai-breath')!.url).toBe('https://x/media/unpai-breath-9x16/poster.jpg');
  });

  it('#70: owning her variant card changes her words and her outfit at the reward (#81\'s footage, the shot as written its fallback)', async () => {
    const plain = await member();
    const owner = await member();
    await repos.owned.grant(owner.user.id, 's1-eimi-30', false);
    const toReward = async (h: Record<string, string>) => {
      let run = await step(h, await preview(h, 'ogiri'), { choice: 'bring-it' });
      run = await step(h, run, { minigame: { text: 'SCORE9' } });
      return step(h, run, { minigame: { text: 'SCORE9' } });
    };
    const a = await toReward(plain.h);
    const b = await toReward(owner.h);
    expect(said(a).join()).not.toContain('カードの');
    expect(said(b).join()).toContain('キミが持ってるカードの、あのドレス');
    // #81's clip exists, so he sees her in her variant card's dress; without the card, the twirl as written (#80's),
    // which is also the owner's fallback should his player lack the clip.
    const twirl = (r: Run) => r.beats.find((x) => x.id === 'twirl') as (Beat & { fallback?: string }) | undefined;
    expect(twirl(a)).toMatchObject({ media: 'eimi-scene-ogiri-twirl' });
    expect(twirl(a)).not.toHaveProperty('fallback');
    expect(twirl(b)).toMatchObject({ media: 'eimi-variant-close', fallback: 'eimi-scene-ogiri-twirl' });
  });

  it('#57/#66: her wake-up keeps her 「明日の朝、起こしてあげる」, whenever his alarm rings that morning', async () => {
    const { user } = await member();
    const made = NOON + 9 * HOUR; // 21:00 JST
    await repos.promises.create(newPromise({ userId: user.id, star: 'mahiro', text: '明日の朝、起こしてあげる', dueAt: new Date(made + 12 * HOUR).toISOString(), kind: 'wakeup', source: 'scene', sceneId: 'welcome-home', lang: 'ja' }, made));
    const rang = made + 9.5 * HOUR; // 06:30 JST, earlier than the script's "+12h"
    vi.setSystemTime(rang);
    const h = auth(user.id);
    await repos.inbox.add({ id: 'inb_wake', userId: user.id, star: 'mahiro', kind: 'wakeup', payload: { text: 'おはよ', lineId: 'greet-morning', day: jstDay(rang) },
      dueAt: new Date(rang).toISOString(), deliveredAt: new Date(rang).toISOString(), readAt: null, createdAt: new Date(rang).toISOString() });
    const open = json(await post('/v1/alarm/wake/open', { id: 'inb_wake' }, h));
    expect(open.keptPromise).toBe('明日の朝、起こしてあげる');
    expect(open).toHaveProperty('voice', null);
    const [p] = await repos.promises.forUser(user.id);
    expect(p).toMatchObject({ status: 'kept', kind: 'wakeup' });
    // Only once.
    expect(json(await post('/v1/alarm/wake/open', { id: 'inb_wake' }, h)).keptPromise).toBeNull();
  });

  it('#67: 奈々\'s morning promise opens her morning, not the evening scene again', async () => {
    const { user } = await member();
    const made = NOON + 9 * HOUR; // 21:00 JST
    await repos.promises.create(newPromise({ userId: user.id, star: 'nana', text: '明日の朝、お茶を淹れて続きを読む', dueAt: new Date(made + 12 * HOUR).toISOString(), kind: 'scene', source: 'scene', sceneId: 'promise-morning-nana', lang: 'ja' }, made));
    vi.setSystemTime(made + 11 * HOUR); // 08:00 JST
    const h = auth(user.id);
    const offer = json(await post('/v1/scene/room', { star: 'nana' }, h)).offer;
    expect(offer).toMatchObject({ sceneId: 'promise-morning-nana', source: 'time' });
    const res = await post('/v1/scene/start', { sceneId: 'promise-morning-nana', offerId: offer.id }, h);
    expect(res.statusCode, res.payload).toBe(200);
    const run = json(res).run as Run;
    expect(run.beats.filter((b) => b.type === 'clip').map((b) => b.media)).toEqual(['nana-morning', 'nana-sys-promise-morning-wide']);
    expect(said(run).join()).toContain('お茶淹れたよ');
    // The evening scene is not what the morning offers: on the test site it exists, but its evening is not now.
    const evening = await post('/v1/scene/start', { sceneId: 'read-aloud' }, h);
    expect([evening.statusCode, json(evening).error]).toEqual([403, 'scene_locked']);
  });
});

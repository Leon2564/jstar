import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { GIFT_RULES, RULES, STAGE_RULES, VARIANT_CARDS, giftReaction, giftXp, type GiftId } from '@jstar/shared';
import { signJwt } from '../src/lib/crypto';
import { createMemoryRepos } from '../src/db/memory';
import { createSqlRepos } from '../src/db/sql';
import { SEED_CARDS } from '../src/db/seed';
import type { Repos } from '../src/db/types';
import { newUserRow } from '../src/lib/account';
import { env } from '../src/env';
import { buildApp } from '../src/app';
import { createSqliteClient } from './sqlite';

// The persona service has its own suite (apps/agent/tests); this fake says what it is told to and records its inputs.
const agent = vi.hoisted(() => ({
  inputs: [] as Record<string, unknown>[],
  gifts: [] as Record<string, unknown>[],
  reply: (text: string) => `echo:${text}`,
  gift: null as null | ((input: Record<string, unknown>) => string)
}));
vi.mock('../src/lib/agent', () => ({
  askPersona: async (input: { text: string }) => {
    agent.inputs.push(input);
    return { reply: agent.reply(input.text), blocked: false, boundary: null, memory: null, cardTitle: null };
  },
  streamPersona: async function* () { yield { type: 'error', error: 'unused' }; },
  greetPersona: async () => 'hi',
  giftPersona: async (input: Record<string, unknown>) => {
    agent.gifts.push(input);
    if (!agent.gift) throw Object.assign(new Error('agent_unavailable'), { statusCode: 503 });
    return agent.gift(input);
  }
}));

const BACKENDS: [string, () => Repos][] = [
  ['memory', () => createMemoryRepos({ cards: SEED_CARDS })],
  ['sql', () => createSqlRepos(createSqliteClient())]
];

let app: FastifyInstance;
let repos: Repos;
let events: { name: string; props: Record<string, unknown> }[];

async function member(patch: Partial<ReturnType<typeof newUserRow>> = {}) {
  const user = await repos.users.create({ ...newUserRow({ email: `${Math.random()}@example.com`, lineSub: null, nickname: 'ken', via: 'email', lang: 'ja' }), freePulls: 0, ...patch });
  return { user, h: { authorization: `Bearer ${signJwt({ sub: user.id }, env.JWT_SECRET, 60 * 86_400)}` } };
}
const json = (res: { payload: string }) => JSON.parse(res.payload);
const give = (h: Record<string, string>, star: string, giftId: string, extra: Record<string, unknown> = {}) =>
  app.inject({ method: 'POST', url: '/v1/gift', headers: h, payload: { star, giftId, ...extra } });
const gave = async (h: Record<string, string>, star: string, giftId: string, extra: Record<string, unknown> = {}) => {
  const res = await give(h, star, giftId, extra);
  expect(res.statusCode, res.payload).toBe(200);
  return json(res);
};
const say = async (h: Record<string, string>, star: string, text = 'hi') => {
  const res = await app.inject({ method: 'POST', url: '/v1/chat/send', headers: h, payload: { star, text } });
  expect(res.statusCode, res.payload).toBe(200);
  return json(res);
};
const catalogue = async (h: Record<string, string>, star: string) => json(await app.inject({ url: `/v1/gift?star=${star}`, headers: h }));
const points = async (id: string) => (await repos.users.byId(id))!.points;

/** Noon JST on day `n` of a fixed week. */
const START = Date.UTC(2026, 10, 2, 3, 0);
const onDay = (n: number) => vi.setSystemTime(START + (n - 1) * 86_400_000);

describe.each(BACKENDS)('gifts (%s store)', (_name, makeRepos) => {
  beforeEach(async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    onDay(1);
    repos = makeRepos();
    app = await buildApp({ repos, logger: false, demo: true });
    events = [];
    const record = app.recordEvent.bind(app);
    app.recordEvent = (async (userId, name, props) => { events.push({ name, props: props as Record<string, unknown> }); return record(userId, name, props); }) as typeof app.recordEvent;
    agent.inputs.length = 0;
    agent.gifts.length = 0;
    agent.reply = (text) => `echo:${text}`;
    agent.gift = null;
  });
  afterEach(() => { vi.useRealTimers(); });

  it('spends the points, adds her XP and records gift.sent in one step', async () => {
    const { user, h } = await member({ points: 500 });
    const r = await gave(h, 'mahiro', 'bouquet');
    expect(r).toMatchObject({ star: 'mahiro', giftId: 'bouquet', taste: 'plain', wished: false, points: 500 - GIFT_RULES.prices.bouquet, sentToday: 1, perDay: GIFT_RULES.perDay });
    expect(r.affinityXp).toBe(giftXp('bouquet', 'plain'));
    expect(await points(user.id)).toBe(500 - GIFT_RULES.prices.bouquet);
    expect(await repos.affinity.get(user.id, 'mahiro')).toBe(giftXp('bouquet', 'plain'));
    expect(events).toContainEqual({ name: 'gift.sent', props: { star: 'mahiro', giftId: 'bouquet' } });
  });

  it('refuses a gift he cannot pay for with 402 and writes nothing', async () => {
    const { user, h } = await member({ points: GIFT_RULES.prices['night-view'] - 1 });
    const res = await give(h, 'eimi', 'night-view');
    expect(res.statusCode).toBe(402);
    expect(json(res).error).toBe('insufficient_points');
    expect(await points(user.id)).toBe(GIFT_RULES.prices['night-view'] - 1);
    expect(await repos.affinity.get(user.id, 'eimi')).toBe(0);
    expect(await repos.gifts.countOn(user.id, '2026-11-02')).toBe(0);
    expect(events.filter((e) => e.name === 'gift.sent')).toEqual([]);
  });

  it('never spends the same points twice when gifts race', async () => {
    const price = GIFT_RULES.prices.macarons;
    const { user, h } = await member({ points: price * 2 + 10 });
    const results = await Promise.all([0, 1, 2, 3].map(() => give(h, 'nana', 'macarons')));
    expect(results.map((r) => r.statusCode).sort()).toEqual([200, 200, 402, 402]);
    expect(await points(user.id)).toBe(10);
    expect(await repos.affinity.get(user.id, 'nana')).toBe(2 * giftXp('macarons', 'plain'));
    expect(await repos.gifts.countOn(user.id, '2026-11-02')).toBe(2);
  });

  it('keeps to the daily cap, all talents together, and opens again the next JST day', async () => {
    const { user, h } = await member({ points: 10_000 });
    const stars = ['mahiro', 'nana', 'unpai', 'alice', 'eimi'];
    for (let i = 0; i < GIFT_RULES.perDay; i++) await gave(h, stars[i % stars.length], 'alarm');
    const before = await points(user.id);
    const res = await give(h, 'nana', 'alarm');
    expect(res.statusCode).toBe(409);
    expect(json(res).error).toBe('gift_limit');
    expect(await points(user.id)).toBe(before);
    expect((await catalogue(h, 'nana')).sentToday).toBe(GIFT_RULES.perDay);
    onDay(2);
    expect((await catalogue(h, 'nana')).sentToday).toBe(0);
    expect((await gave(h, 'nana', 'alarm')).sentToday).toBe(1);
  });

  it('counts a gift she likes exactly twice as much as an ordinary one of the same price', async () => {
    const { user, h } = await member({ points: 10_000 });
    // 焼肉 is 奈々's taste; for まひろ it is just a nice dinner.
    const liked = await gave(h, 'nana', 'yakiniku');
    const plain = await gave(h, 'mahiro', 'yakiniku');
    expect(liked.taste).toBe('liked');
    expect(plain.taste).toBe('plain');
    expect(await repos.affinity.get(user.id, 'nana')).toBe(2 * (await repos.affinity.get(user.id, 'mahiro')));
    expect(liked.affinityXp).toBe(GIFT_RULES.taste.liked * giftXp('yakiniku', 'plain'));
    // One she dislikes still counts, a little.
    expect((await gave(h, 'unpai', 'alarm')).taste).toBe('disliked');
    expect(await repos.affinity.get(user.id, 'unpai')).toBe(giftXp('alarm', 'disliked'));
  });

  it('adds XP within the stage but never skips its days — and counts no day together', async () => {
    const { user, h } = await member({ points: 100_000 });
    await say(h, 'alice');
    // Every stage's XP at once, on the first day together: still new.
    for (let i = 0; i < GIFT_RULES.perDay; i++) await gave(h, 'alice', 'tea-leaves');
    await repos.affinity.add(user.id, 'alice', STAGE_RULES.stages.ambiguous.xp);
    const panel = async () => json(await app.inject({ url: '/v1/relationship', headers: h })).talents.find((t: { star: string }) => t.star === 'alice');
    expect(await panel()).toMatchObject({ stage: 'new', daysTogether: 1 });
    // Day 2 without a word: gifts alone are not a day together.
    onDay(2);
    const r = await gave(h, 'alice', 'bouquet');
    expect(r.relationship).toMatchObject({ stage: 'new', daysTogether: 1 });
    // A message makes it the second day: one stage, not three.
    expect((await say(h, 'alice')).relationship).toMatchObject({ stage: 'familiar', daysTogether: 2 });
  });

  it('moves her on when the days were already met and a gift brings the XP', async () => {
    const { user, h } = await member({ points: 10_000 });
    await say(h, 'nana');
    onDay(2);
    await say(h, 'nana');
    expect(await repos.affinity.get(user.id, 'nana')).toBeLessThan(STAGE_RULES.stages.new.xp);
    const r = await gave(h, 'nana', 'yakiniku');
    expect(r.relationship).toMatchObject({ stage: 'familiar', daysTogether: 2 });
    // Entering familiar pays its free pull, as a message would (#54).
    expect(r.freePulls).toBe(1);
    expect(events).toContainEqual({ name: 'stage.changed', props: { star: 'nana', from: 'new', to: 'familiar' } });
  });

  it('keeps her tastes hidden until she mentions one; then he knows it, and her reaction remembers her words', async () => {
    const { user, h } = await member({ points: 10_000 });
    expect((await catalogue(h, 'nana')).gifts.filter((g: { known: boolean }) => g.known)).toEqual([]);
    // Nothing she says gives a taste away yet.
    await say(h, 'nana', 'おはよう');
    expect((await repos.chatMemory.get(user.id, 'nana'))).toBeNull();
    const line = 'そういえば最近、焼肉行きたいな〜って思ってるんだよね！';
    agent.reply = () => line;
    await say(h, 'nana', '最近どう？');
    agent.reply = (text) => `echo:${text}`;
    const known = (await catalogue(h, 'nana')).gifts.filter((g: { known: boolean }) => g.known).map((g: { id: string }) => g.id);
    expect(known).toEqual(['yakiniku']);
    expect((await repos.chatMemory.get(user.id, 'nana'))!.facts).toEqual({ her_wishes: 'yakiniku' });
    // The persona is told what he knows as her tastes, never as a fact he told her.
    await say(h, 'nana', 'ねえ');
    const input = agent.inputs.at(-1)!;
    expect(input.memory).toEqual({ facts: {}, summary: null });
    expect(input.tastes).toEqual({ known: ['焼肉ディナー'], hint: null });
    // Another talent's memory is untouched.
    expect((await catalogue(h, 'mahiro')).gifts.some((g: { known: boolean }) => g.known)).toBe(false);

    agent.gift = (i) => `model:${(i.gift as { name: string }).name}:${String(i.wishLine)}`;
    const r = await gave(h, 'nana', 'yakiniku', { lang: 'ja' });
    expect(r).toMatchObject({ taste: 'liked', wished: true, known: ['yakiniku'] });
    expect(agent.gifts.at(-1)).toMatchObject({ star: 'nana', taste: 'liked', wished: true, wishLine: line, gift: { id: 'yakiniku', name: '焼肉ディナー' } });
    expect(r.reaction).toBe(`model:焼肉ディナー:${line}`);
    // Her line is part of the conversation now.
    const history = json(await app.inject({ url: '/v1/chat/history?star=nana', headers: h })).messages;
    expect(history.at(-1)).toMatchObject({ role: 'assistant', text: r.reaction });
  });

  it('learns a taste from a liked gift too, and falls back to her written line when the persona service is down', async () => {
    const { user, h } = await member({ points: 10_000 });
    const r = await gave(h, 'mahiro', 'cocoa', { lang: 'en' });
    expect(r.reaction).toBe(giftReaction('mahiro', 'cocoa', 'liked', false, 'en'));
    expect(r.reaction).toContain('Hot cocoa');
    expect(r.known).toEqual(['cocoa']);
    expect((await repos.chatMemory.get(user.id, 'mahiro'))!.facts.her_wishes).toBe('cocoa');
    // Now that he knows, giving it again is a gift she had told him about.
    expect((await gave(h, 'mahiro', 'cocoa', { lang: 'ja' })).reaction).toBe(giftReaction('mahiro', 'cocoa', 'liked', true, 'ja'));
    // A plain gift teaches nothing.
    expect((await gave(h, 'mahiro', 'teddy')).known).toEqual(['cocoa']);
  });

  it('lets her bring one taste up in passing on its turn, and not on the others', async () => {
    const { h } = await member({ passUntil: new Date(START + 30 * 86_400_000).toISOString() });
    for (let i = 1; i <= GIFT_RULES.hintAtTurn + GIFT_RULES.hintEveryTurns; i++) await say(h, 'eimi', `m${i}`);
    const hinted = agent.inputs.flatMap((input, i) => ((input.tastes as { hint?: string } | undefined)?.hint ? [i + 1] : []));
    expect(hinted).toEqual([GIFT_RULES.hintAtTurn, GIFT_RULES.hintAtTurn + GIFT_RULES.hintEveryTurns]);
    expect(agent.inputs[GIFT_RULES.hintAtTurn - 1].tastes).toEqual({ known: [], hint: 'リップ' });
    // Not told on the next hint: she moves on to the next thing she likes.
    expect(agent.inputs.at(-1)!.tastes).toEqual({ known: [], hint: '旅行ガイドブック' });
  });

  it('gives the variant she is wearing its own XP, and only a variant of hers he owns', async () => {
    const { user, h } = await member({ points: 10_000 });
    const card = VARIANT_CARDS.find((id) => id.startsWith('s1-eimi-'))!;
    expect((await give(h, 'eimi', 'lipstick', { cardId: card })).statusCode).toBe(400);
    await repos.owned.grant(user.id, card, false);
    expect((await give(h, 'mahiro', 'lipstick', { cardId: card })).statusCode).toBe(400);
    expect((await give(h, 'eimi', 'lipstick', { cardId: 's1-eimi-01' })).statusCode).toBe(400);
    const r = await gave(h, 'eimi', 'lipstick', { cardId: card });
    const xp = giftXp('lipstick', 'liked');
    expect(r.variant).toMatchObject({ cardId: card, state: { xp: xp * GIFT_RULES.variantMultiplier.liked } });
    // Her main affinity gets the gift's XP once: the variant's share is not added on top.
    expect(await repos.affinity.get(user.id, 'eimi')).toBe(xp);
  });

  it('forgets his gifts and what he learned when the account is deleted', async () => {
    const { user, h } = await member({ points: 10_000 });
    await gave(h, 'alice', 'bouquet');
    expect(await repos.gifts.countOn(user.id, '2026-11-02')).toBe(1);
    const res = await app.inject({ method: 'DELETE', url: '/v1/auth/me', headers: h, payload: { confirm: 'DELETE' } });
    expect(res.statusCode, res.payload).toBe(200);
    expect(await repos.gifts.countOn(user.id, '2026-11-02')).toBe(0);
    expect(await repos.chatMemory.get(user.id, 'alice')).toBeNull();
  });

  it('needs a session and a real gift', async () => {
    expect((await app.inject({ method: 'POST', url: '/v1/gift', payload: { star: 'nana', giftId: 'bouquet' } })).statusCode).toBe(401);
    expect((await app.inject({ url: '/v1/gift?star=nana' })).statusCode).toBe(401);
    const { h } = await member();
    expect((await give(h, 'nana', 'diamond-ring')).statusCode).toBe(400);
    const list = await catalogue(h, 'nana');
    expect(list.gifts).toHaveLength(20);
    expect(list.points).toBe(RULES.welcomePoints);
    // The catalogue never says what she likes: only what he knows.
    expect(Object.keys(list.gifts[0]).sort()).toEqual(['id', 'known', 'price']);
    expect(list.gifts.map((g: { id: GiftId; price: number }) => g.price)).toEqual(list.gifts.map((g: { id: GiftId }) => GIFT_RULES.prices[g.id]));
  });
});

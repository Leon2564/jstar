import { createHash } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { RULES, VARIANT_CARDS, drawPulls, duplicateGain, jstDay, poolCards, seeded, variantGain } from '@jstar/shared';
import { CATALOG } from '@jstar/shared/catalog';
import { signJwt } from '../src/lib/crypto';
import { createMemoryRepos } from '../src/db/memory';
import { createSqlRepos } from '../src/db/sql';
import { SEED_CARDS } from '../src/db/seed';
import type { Repos } from '../src/db/types';
import { newUserRow } from '../src/lib/account';
import { env } from '../src/env';
import { buildApp } from '../src/app';
import { planned } from '../src/modules/gacha';
import { createSqliteClient } from './sqlite';

// The server draws with a random seed; pinning it here makes the drawn card known, and the draw itself is the
// ordinary seeded replay (packages/shared/src/gacha.ts), so this is also the draw an audit would reproduce.
const pin = vi.hoisted(() => ({ seed: null as number | null }));
vi.mock('node:crypto', async (importOriginal) => {
  const orig = await importOriginal<typeof import('node:crypto')>();
  const randomInt = ((...a: Parameters<typeof orig.randomInt>) => (pin.seed ?? (orig.randomInt as (...x: unknown[]) => number)(...a))) as typeof orig.randomInt;
  return { ...orig, default: { ...orig, randomInt }, randomInt };
});

const BACKENDS: [string, () => Repos][] = [
  ['memory', () => createMemoryRepos({ cards: SEED_CARDS })],
  ['sql', () => createSqlRepos(createSqliteClient())]
];
const EIMI = 's1-eimi-30';
const NANA = 's1-nana-30';

let app: FastifyInstance;
let repos: Repos;

async function member(patch: Partial<ReturnType<typeof newUserRow>> = {}) {
  const user = await repos.users.create({ ...newUserRow({ email: `${Math.random()}@example.com`, lineSub: null, nickname: 'u', via: 'email', lang: 'ja' }), ...patch });
  return { user, h: { authorization: `Bearer ${signJwt({ sub: user.id }, env.JWT_SECRET, 3600)}` } };
}
const json = (res: { payload: string }) => JSON.parse(res.payload);
const post = (url: string, payload: object, headers: Record<string, string>) => app.inject({ method: 'POST', url, headers, payload });
const get = (url: string, headers: Record<string, string> = {}) => app.inject({ url, headers });
const me = async (h: Record<string, string>) => json(await get('/v1/auth/me', h));
/** A seed whose single pull from her pool, at this pity, is her variant card. */
const seedFor = (cardId: string, pity: number) => {
  const pool = poolCards('star:eimi', CATALOG);
  for (let s = 0; s < 100_000; s++) if (drawPulls(1, pool, seeded(s), pity).drawn[0].card.id === cardId) return s;
  throw new Error('no seed');
};

describe.each(BACKENDS)('variant cards (%s store)', (_name, makeRepos) => {
  beforeEach(async () => {
    pin.seed = null;
    repos = makeRepos();
    app = await buildApp({ repos, logger: false, demo: true });
  });

  it('drawing a variant counts for the funnel; a duplicate adds a copy and 心意 +100, and levels by the thresholds', async () => {
    const { user, h } = await member({ pity: RULES.pityPulls - 1 });
    await app.recordEvent(user.id, 'variant.prompted', { star: 'eimi', cardId: EIMI });

    pin.seed = seedFor(EIMI, RULES.pityPulls - 1);
    const first = json(await post('/v1/gacha/draw', { pool: 'star:eimi', count: 1 }, h));
    expect(first.cards).toEqual([{ id: EIMI, star: 'eimi', rarity: 'UR', isNew: true }]);
    expect(await repos.cardAffection.get(user.id, EIMI)).toBeNull();
    const drawn = (await me(h)).owned.find((o: { cardId: string }) => o.cardId === EIMI);
    expect(drawn).toMatchObject({ copies: 1, variant: { level: 1, xp: 0, kokoro: 0, layers: [1], nextLayer: 3 } });

    pin.seed = seedFor(EIMI, 0);
    const again = json(await post('/v1/gacha/draw', { pool: 'star:eimi', count: 1 }, h));
    expect(again.cards[0]).toMatchObject({ id: EIMI, isNew: false });
    const after = await me(h);
    expect(after.owned.find((o: { cardId: string }) => o.cardId === EIMI)).toMatchObject({ copies: 2, variant: { level: 3, xp: 100, kokoro: 100, layers: [1, 3] } });
    expect(after.wallet.shards).toBe(RULES.duplicateShards.UR);
    // Half of the variant XP counts for her main relationship, and pays no level-up free pull.
    expect(after.affinity).toEqual({ eimi: 50 });
    expect(after.wallet.freePulls).toBe(RULES.signupFreePulls);
    // Non-variant cards carry no variant state.
    expect(after.owned.filter((o: { variant?: unknown }) => o.variant).map((o: { cardId: string }) => o.cardId)).toEqual([EIMI]);

    const [today] = await repos.events.metrics(jstDay(), jstDay(), 'all');
    expect(today).toMatchObject({ variantPrompted: 1, variantDrawn: 1 });
  });

  it('the rarity-priced shard exchange offers variants; duplicates reach level 10 and open every layer', async () => {
    const { user, h } = await member({ shards: RULES.exchangeShards.UR * 3 });
    expect(json(await get(`/v1/cards/${NANA}/affection`, h))).toMatchObject({ cardId: NANA, star: 'nana', owned: false, variant: { level: 1, layers: [1] } });
    for (let i = 0; i < 3; i++) expect((await post('/v1/gacha/exchange', { cardId: NANA }, h)).statusCode).toBe(200);
    expect(json(await get(`/v1/cards/${NANA}/affection`, h)).variant).toMatchObject({ level: 4, xp: 200, kokoro: 200, layers: [1, 3], nextLayer: 6 });
    // Eight more duplicates (the exchange is rate limited, so straight to the store): 1000 XP is the top level.
    for (let i = 0; i < 8; i++) await repos.cardAffection.add(user.id, NANA, 'nana', duplicateGain());
    const res = json(await get(`/v1/cards/${NANA}/affection`, h));
    expect(res).toEqual({ cardId: NANA, star: 'nana', owned: true, variant: { level: 10, xp: 1000, kokoro: 1000, progress: 1, layers: [1, 3, 6, 10], nextLayer: null, pinned: false } });
    expect(await repos.affinity.all(user.id)).toEqual({ nana: 500 });
    expect((await repos.users.byId(user.id))!.freePulls).toBe(RULES.signupFreePulls);
  });

  it('only a signed-in user reads a variant affection, and only the variants have one', async () => {
    const { h } = await member();
    expect((await get(`/v1/cards/${EIMI}/affection`)).statusCode).toBe(401);
    expect(json(await get('/v1/cards/s1-eimi-29/affection', h))).toEqual({ error: 'not_a_variant' });
    expect(json(await get('/v1/cards/s1-nobody-01/affection', h))).toEqual({ error: 'card_not_found' });
  });

  it('a code duplicate brings 心意 on top of its bond XP, also when a visitor\'s codes are claimed at sign-up', async () => {
    const { user } = await member();
    await repos.serials.createBatch({ id: 'b', label: 'test', quantity: 2, trialDays: 0, draws: 2, createdAt: new Date().toISOString() },
      [{ id: 'b-1', codeHash: 'h1' }, { id: 'b-2', codeHash: 'h2' }]);
    const card = CATALOG.find((c) => c.id === EIMI)!;
    const at = new Date().toISOString();
    const draw = (id: string, ownerId: string) => ({ id, ownerId, poolId: 'lucky-s1', serialId: id, cardIds: [EIMI, EIMI], tiers: ['UR', 'UR'], cost: 0, seed: '1', createdAt: at });
    const redeemed = await repos.lucky.redeem({ serialId: 'b-1', owner: { userId: user.id }, cards: [planned(card), planned(card)], passUntil: null, trialDays: 0, bondXp: 20, draw: draw('b-1', user.id), at });
    expect(redeemed).toEqual({ ok: true, isNew: [true, false] });
    expect((await repos.users.byId(user.id))!.shards).toBe(RULES.duplicateShards.UR);
    expect(await repos.cardAffection.get(user.id, EIMI)).toMatchObject({ xp: 100, level: 3, kokoro: 100 });
    expect(await repos.affinity.get(user.id, 'eimi')).toBe(20 + 50);

    expect((await repos.lucky.redeem({ serialId: 'b-2', owner: { device: 'device-123' }, cards: [planned(card), planned(card)], passUntil: null, trialDays: 0, bondXp: 20, draw: draw('b-2', 'device:device-123'), at })).ok).toBe(true);
    const claimed = await repos.lucky.claim(user, 'device-123', 20, () => null, (id) => (VARIANT_CARDS.includes(id) ? planned(card).variant! : null));
    expect(claimed?.cardIds).toEqual([EIMI, EIMI]);
    expect((await repos.users.byId(user.id))!.shards).toBe(RULES.duplicateShards.UR * 3);
    expect(await repos.cardAffection.get(user.id, EIMI)).toMatchObject({ xp: 300, level: 5, kokoro: 300 });
    expect(await repos.affinity.get(user.id, 'eimi')).toBe(3 * (20 + 50));
  });

  it('a variant scene pays its variant XP to the card with the run, once', async () => {
    const { user } = await member();
    const now = new Date().toISOString();
    const row = { id: 'scn_v', userId: user.id, star: 'alice' as const, sceneId: 'variant-alice-1', step: 'end', seq: 0, state: {} as never, rewarded: true, startedAt: now, updatedAt: now, endedAt: now, outcome: 'complete' };
    expect(await repos.sceneRuns.start(row, { affinity: 5, memories: [], variant: { cardId: 's1-alice-30', gain: variantGain(30) } })).toBe(true);
    expect(await repos.cardAffection.get(user.id, 's1-alice-30')).toMatchObject({ xp: 30, level: 1, kokoro: 0 });
    expect(await repos.affinity.get(user.id, 'alice')).toBe(5 + 15);
    // A change that lost its race writes nothing, the variant XP included.
    expect(await repos.sceneRuns.advance({ ...row, seq: 2 }, 1, { affinity: 0, memories: [], variant: { cardId: 's1-alice-30', gain: variantGain(30) } })).toBe(false);
    expect((await repos.cardAffection.get(user.id, 's1-alice-30'))!.xp).toBe(30);
    // Gains outside a draw or a scene (chat while she wears it, gifts) go through add.
    expect(await repos.cardAffection.add(user.id, 's1-alice-30', 'alice', variantGain(80))).toMatchObject({ xp: 110, level: 3 });
  });

  it('account deletion removes the variant affinity', async () => {
    const { user, h } = await member({ shards: RULES.exchangeShards.UR * 2 });
    for (let i = 0; i < 2; i++) await post('/v1/gacha/exchange', { cardId: EIMI }, h);
    expect(await repos.cardAffection.forUser(user.id)).toHaveLength(1);
    expect((await app.inject({ method: 'DELETE', url: '/v1/auth/me', headers: h, payload: { confirm: 'DELETE' } })).statusCode).toBe(200);
    expect(await repos.cardAffection.forUser(user.id)).toEqual([]);
  });

  it('publishes exactly the rates it published before variants existed (docs/compliance-jp.md §3)', async () => {
    const { pools } = json(await get('/v1/gacha/rates'));
    expect(createHash('sha256').update(JSON.stringify(pools)).digest('hex')).toBe('6469b23cb0c7846c5ab83cf4eb312de0433a7a830438a091828ba4129b099cf0');
  });
});

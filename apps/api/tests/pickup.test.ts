import { createHash } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import {
  GachaRatesRes, PICKUP_RULES, POOL_IDS, RULES, disclosure, drawPickupPulls, drawPulls, jstDay, poolCards, seeded, type PickupRatesT
} from '@jstar/shared';
import { CATALOG } from '@jstar/shared/catalog';
import { LINES } from '@jstar/shared/lines';
import { signJwt } from '../src/lib/crypto';
import { createMemoryRepos } from '../src/db/memory';
import { createSqlRepos } from '../src/db/sql';
import { SEED_CARDS } from '../src/db/seed';
import type { Repos, UserRow } from '../src/db/types';
import { newUserRow } from '../src/lib/account';
import { env } from '../src/env';
import { buildApp } from '../src/app';
import { createSqliteClient } from './sqlite';

/**
 * Pickups (#78): the admin schedules one, 提供割合 publishes it from its config, the draw uses exactly those odds and
 * replays from its seed, the regular pools do not move, and her chat leads to it — only when he asks about her variant
 * or, rarely and never twice in a row, when she brings it up herself.
 */

// The server draws with a random seed; pinning it makes the drawn cards known (the same seeded replay an audit uses).
const pin = vi.hoisted(() => ({ seed: null as number | null }));
vi.mock('node:crypto', async (importOriginal) => {
  const orig = await importOriginal<typeof import('node:crypto')>();
  const randomInt = ((...a: Parameters<typeof orig.randomInt>) => (pin.seed ?? (orig.randomInt as (...x: unknown[]) => number)(...a))) as typeof orig.randomInt;
  return { ...orig, default: { ...orig, randomInt }, randomInt };
});

/**
 * The persona service, faked by its contract (apps/agent tests cover the classifier and her words). What each turn
 * carried in is kept in `seen`; `ASK:<card>` answers as the agent does when he asked about an outfit he lacks,
 * `INVITE:<card>` as when she brought it up herself.
 */
type Outfit = { cardId: string; owned: boolean; pickup: boolean; invite: boolean; line: string | null; sceneId: string | null; title: string };
const seen: { outfits?: Outfit[] }[] = [];
vi.mock('../src/lib/agent', () => {
  const directive = (text: string): unknown => {
    const [kind, arg] = text.split(':');
    if (kind === 'ASK') return { outfit: arg, action: 'pickup' };
    if (kind === 'INVITE') return { outfit: arg, action: 'invite' };
    return undefined;
  };
  const answer = (input: { text: string }) => {
    seen.push(JSON.parse(JSON.stringify(input)));
    return { reply: `echo:${input.text}`, blocked: false, boundary: null, memory: null, cardTitle: null, directive: directive(input.text) };
  };
  return {
    askPersona: async (input: { text: string }) => answer(input),
    streamPersona: async function* (input: { text: string }) {
      const r = answer(input);
      yield { type: 'delta', text: r.reply };
      yield { type: 'done', reply: r.reply, boundary: null, memory: null, cardTitle: null, directive: r.directive };
    },
    greetPersona: async () => 'hi'
  };
});

const BACKENDS: [string, () => Repos][] = [
  ['memory', () => createMemoryRepos({ cards: SEED_CARDS })],
  ['sql', () => createSqlRepos(createSqliteClient())]
];
const EIMI = 's1-eimi-30';
const NOW = Date.UTC(2026, 9, 5, 3); // 2026-10-05 12:00 JST
const START = '2026-10-01T00:00:00+09:00';
const END = '2026-10-15T00:00:00+09:00';
const ID = 'pickup:s1-eimi-30:20261001';
const sha = (v: unknown) => createHash('sha256').update(JSON.stringify(v)).digest('hex');

let app: FastifyInstance;
let repos: Repos;

const auth = (u: UserRow) => ({ authorization: `Bearer ${signJwt({ sub: u.id }, env.JWT_SECRET, 30 * 86_400)}` });
async function member(patch: Partial<UserRow> = {}) {
  const user = await repos.users.create({ ...newUserRow({ email: `${Math.random()}@example.com`, lineSub: null, nickname: 'u', via: 'email', lang: 'ja' }), ...patch });
  return { user, h: auth(user) };
}
const json = (res: { payload: string }) => JSON.parse(res.payload);
const put = (url: string, payload: object, headers: Record<string, string>) => app.inject({ method: 'PUT', url, headers, payload });
const post = (url: string, payload: object, headers: Record<string, string>) => app.inject({ method: 'POST', url, headers, payload });
const get = (url: string, headers: Record<string, string> = {}) => app.inject({ url, headers });
const at = (ms: number) => vi.setSystemTime(ms);
const dice = (v: number) => vi.spyOn(Math, 'random').mockReturnValue(v);
async function schedule(body: object = { cardId: EIMI, startsAt: START, endsAt: END }) {
  const { h } = await member({ role: 'admin' });
  return put('/v1/admin/pickups', body, h);
}
const rates = async () => GachaRatesRes.parse(json(await get('/v1/gacha/rates')));
const send = async (h: Record<string, string>, text: string) => {
  const res = await post('/v1/chat/send', { star: 'eimi', text }, h);
  expect(res.statusCode, res.payload).toBe(200);
  return json(res);
};
const prompted = async (userId: string) => repos.events.ofUser(userId, 'variant.prompted', '2000-01-01');

afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); seen.length = 0; pin.seed = null; });

describe.each(BACKENDS)('Pickup pools (%s store)', (_name, makeRepos) => {
  beforeEach(async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    at(NOW);
    repos = makeRepos();
    app = await buildApp({ repos, logger: false, demo: true });
  });

  describe('the admin schedules it, and it is published from its config', () => {
    it('only admins; only a variant card; a bounded window that has not ended; no overlap; audited', async () => {
      const { h } = await member();
      expect((await put('/v1/admin/pickups', { cardId: EIMI, startsAt: START, endsAt: END }, h)).statusCode).toBe(403);
      expect(json(await schedule({ cardId: 's1-eimi-29', startsAt: START, endsAt: END }))).toEqual({ error: 'not_a_variant' });
      expect(json(await schedule({ cardId: EIMI, startsAt: START, endsAt: '2026-11-15T00:00:00+09:00' }))).toEqual({ error: 'window_too_long' });
      expect(json(await schedule({ cardId: EIMI, startsAt: '2026-09-01T00:00:00+09:00', endsAt: '2026-09-10T00:00:00+09:00' }))).toEqual({ error: 'already_ended' });
      expect(json(await schedule({ cardId: EIMI, startsAt: END, endsAt: START }))).toEqual({ error: 'bad_window' });

      const res = await schedule();
      expect(res.statusCode, res.payload).toBe(200);
      expect(json(res).pickup).toMatchObject({ id: ID, star: 'eimi', cardId: EIMI, live: true, pickup: { cardId: EIMI, share: PICKUP_RULES.share } });
      expect(json(await schedule({ cardId: EIMI, startsAt: '2026-10-10T00:00:00+09:00', endsAt: '2026-10-20T00:00:00+09:00' }))).toEqual({ error: 'pickup_overlap' });
      // Started: its end may move (here: ended early), its start may not.
      expect(json(await schedule({ cardId: EIMI, startsAt: '2026-10-01T09:00:00+09:00', endsAt: END }))).toEqual({ error: 'pickup_started' });
      expect((await schedule({ cardId: EIMI, startsAt: START, endsAt: '2026-10-08T00:00:00+09:00' })).statusCode).toBe(200);
      expect((await repos.pickups.byId(ID))!.endsAt).toBe('2026-10-07T15:00:00.000Z');
      const audit = await repos.audit.recent(10);
      expect(audit.filter((a) => a.action.startsWith('pickup.')).map((a) => a.action).sort()).toEqual(['pickup.create', 'pickup.update']);
      expect(audit.find((a) => a.action === 'pickup.create')!.meta).toMatchObject({ cardId: EIMI, share: PICKUP_RULES.share });
    });

    it('the odds are fixed when it is created: a later change of the ratio does not touch it', async () => {
      await schedule();
      const row = (await repos.pickups.byId(ID))!;
      await repos.pickups.upsert({ ...row, share: 0.4 }); // as if created under an older ratio
      await schedule({ cardId: EIMI, startsAt: START, endsAt: '2026-10-12T00:00:00+09:00' });
      expect((await repos.pickups.byId(ID))!.share).toBe(0.4);
      expect((await rates()).pickups[0].pickup.share).toBeCloseTo(0.4, 12);
    });

    it('提供割合 keeps the regular pools byte for byte and lists live and scheduled Pickups, adding up to exactly 1', async () => {
      const before = await rates();
      expect(before.pickups).toEqual([]);
      expect(sha(before.pools)).toBe('6469b23cb0c7846c5ab83cf4eb312de0433a7a830438a091828ba4129b099cf0');
      await schedule();
      await schedule({ cardId: 's1-nana-30', startsAt: '2026-10-20T00:00:00+09:00', endsAt: '2026-10-27T00:00:00+09:00' });
      const after = await rates();
      expect(sha(after.pools)).toBe(sha(before.pools));
      expect(after.pickups.map((p) => [p.id, p.live])).toEqual([[ID, true], ['pickup:s1-nana-30:20261020', false]]);
      for (const p of after.pickups) expect(Math.abs(p.rows.reduce((n, r) => n + r.rate, 0) - 1)).toBeLessThan(1e-12);
      expect(after.pickups[0].pickup.rate).toBeCloseTo(0.025, 12);
      expect(after.pickups[0].pickup.baseRate).toBeCloseTo(RULES.rates.UR, 12);
      at(Date.parse(END) + 1);
      expect((await rates()).pickups.map((p) => p.id)).toEqual(['pickup:s1-nana-30:20261020']);
    });

    it('matches 100,000 draws made the way the server draws (±0.5 points per tier and for her card)', async () => {
      await schedule();
      const published = (await rates()).pickups[0] as PickupRatesT;
      const row = (await repos.pickups.byId(ID))!;
      const pool = poolCards('star:eimi', await repos.cards.all());
      const rng = seeded(100_000);
      const count: Record<string, number> = {};
      let hers = 0;
      for (let i = 0; i < 100_000; i++) {
        const [d] = drawPickupPulls(1, pool, row, rng, 0, row.rates).drawn;
        count[d.tier] = (count[d.tier] ?? 0) + 1;
        if (d.card.id === EIMI) hers++;
      }
      for (const r of published.rows) expect(Math.abs((count[r.tier] ?? 0) / 100_000 - r.rate), r.tier).toBeLessThan(0.005);
      expect(Math.abs(hers / 100_000 - published.pickup.rate)).toBeLessThan(0.005);
    });
  });

  describe('drawing it', () => {
    it('only while live; the draw log names the Pickup and replays from its seed; a variant counts as drawn in a Pickup', async () => {
      const { user, h } = await member({ points: 5000 });
      expect(json(await post('/v1/gacha/draw', { pool: ID, count: 1 }, h))).toEqual({ error: 'pool_closed' });
      await schedule();
      const row = (await repos.pickups.byId(ID))!;
      const pool = poolCards('star:eimi', CATALOG);
      let seed = 0;
      while (drawPickupPulls(10, pool, row, seeded(seed), 0, row.rates).drawn.every((d) => d.card.id !== EIMI)) seed++;
      pin.seed = seed;
      const res = await post('/v1/gacha/draw', { pool: ID, count: 10 }, h);
      expect(res.statusCode, res.payload).toBe(200);
      const drawn = json(res).cards.map((c: { id: string }) => c.id);
      expect(drawn.every((id: string) => id.startsWith('s1-eimi-'))).toBe(true);
      const [log] = await repos.draws.forOwner(user.id, 5);
      expect(log).toMatchObject({ poolId: ID, seed: String(seed), cost: RULES.tenPullCost });
      expect(drawPickupPulls(10, pool, row, seeded(Number(log.seed)), 0, row.rates).drawn.map((d) => d.card.id)).toEqual(drawn);
      const events = await repos.events.ofUser(user.id, 'variant.drawn', '2000-01-01');
      expect(events.length).toBe(drawn.filter((id: string) => id === EIMI).length);
      expect(events[0].props).toEqual({ star: 'eimi', cardId: EIMI, pickup: true });
      expect(json(await get('/v1/gacha/history', h)).draws[0].pool).toBe(ID);

      at(Date.parse(END));
      expect(json(await post('/v1/gacha/draw', { pool: ID, count: 1 }, h))).toEqual({ error: 'pool_closed' });
      expect(json(await post('/v1/gacha/draw', { pool: 'pickup:s1-eimi-30:20260101', count: 1 }, h))).toEqual({ error: 'pool_closed' });
    });

    it('the regular pools draw exactly as before with a Pickup running', async () => {
      await schedule();
      const { h } = await member({ points: 5000 });
      pin.seed = 4242;
      const res = json(await post('/v1/gacha/draw', { pool: 'star:eimi', count: 10 }, h));
      expect(res.cards.map((c: { id: string }) => c.id)).toEqual(drawPulls(10, poolCards('star:eimi', CATALOG), seeded(4242), 0).drawn.map((d) => d.card.id));
      expect((await rates()).pools.find((p) => p.id === 'star:eimi')).toEqual({ id: 'star:eimi', ...disclosure(poolCards('star:eimi', CATALOG)) });
      expect(POOL_IDS).not.toContain(ID);
    });
  });

  describe('her chat leads to it (#78)', () => {
    it('he asks about her variant he does not have: the Pickup link comes with her line, and it counts as prompted', async () => {
      await schedule();
      const { user, h } = await member();
      dice(0.99); // she would not bring it up herself this turn
      const r = await send(h, `ASK:${EIMI}`);
      expect(r.pickup).toEqual({ poolId: ID, cardId: EIMI, star: 'eimi', via: 'ask' });
      expect(seen[0].outfits).toEqual([expect.objectContaining({ cardId: EIMI, owned: false, pickup: true, invite: false, line: null, sceneId: null })]);
      expect((await prompted(user.id)).map((e) => e.props)).toEqual([{ star: 'eimi', cardId: EIMI, via: 'ask' }]);
      // An ordinary turn carries nothing.
      expect((await send(h, 'hello')).pickup).toBeUndefined();
    });

    it('no link when he has the card, when no Pickup is live, or when she was not allowed to bring it up', async () => {
      const { user, h } = await member();
      dice(0.99);
      expect((await send(h, `ASK:${EIMI}`)).pickup).toBeUndefined(); // nothing scheduled
      expect(seen[0].outfits![0]).toMatchObject({ pickup: false, invite: false });
      await schedule();
      expect((await send(h, `INVITE:${EIMI}`)).pickup).toBeUndefined(); // this turn did not allow an invitation
      expect((await send(h, 'ASK:s1-mahiro-30')).pickup).toBeUndefined(); // not one of hers
      await repos.owned.grant(user.id, EIMI, false);
      expect((await send(h, `ASK:${EIMI}`)).pickup).toBeUndefined();
      expect(seen.at(-1)!.outfits![0]).toMatchObject({ owned: true, invite: false });
      expect(await prompted(user.id)).toEqual([]);
    });

    it('she brings it up herself at most once in the gap, at most PICKUP_RULES.invite.perPickup times per Pickup', async () => {
      await schedule();
      const { user, h } = await member();
      dice(PICKUP_RULES.invite.rate + 0.01);
      await send(h, 'hi');
      expect(seen.at(-1)!.outfits![0].invite).toBe(false); // the roll said no
      dice(0);
      await send(h, 'hi');
      const offered = seen.at(-1)!.outfits![0];
      expect(offered).toMatchObject({ invite: true, pickup: true });
      expect(typeof offered.line).toBe('string');
      // Never the third, time-framed line (no countdown pressure).
      expect(offered.line).not.toMatch(/今だけ|今月|今、/);
      const r = await send(h, `INVITE:${EIMI}`);
      expect(r.pickup).toEqual({ poolId: ID, cardId: EIMI, star: 'eimi', via: 'invite' });
      await send(h, 'hi');
      expect(seen.at(-1)!.outfits![0].invite).toBe(false); // within the gap
      at(NOW + PICKUP_RULES.invite.gapMs + 60_000);
      await send(h, `INVITE:${EIMI}`);
      at(NOW + 2 * PICKUP_RULES.invite.gapMs + 120_000);
      await send(h, 'hi');
      expect(seen.at(-1)!.outfits![0].invite).toBe(false); // perPickup reached
      expect((await prompted(user.id)).map((e) => e.props.via)).toEqual(['invite', 'invite']);
    });

    it('in production while her invitation lines are drafts (#82): she never brings it up, but answers when he asks', async () => {
      // Her lines are reviewed now (#84, owner 2026-09-28); the gate must still hold for a draft, so one is made here
      // (lib/pickup.ts reads LINES directly).
      LINES.eimi.draft = true;
      try {
        const prod = await buildApp({ repos, logger: false, demo: false });
        const { user } = await member({ role: 'admin' });
        expect((await prod.inject({ method: 'PUT', url: '/v1/admin/pickups', headers: auth(user), payload: { cardId: EIMI, startsAt: START, endsAt: END } })).statusCode).toBe(200);
        const { h } = await member();
        dice(0);
        const res = json(await prod.inject({ method: 'POST', url: '/v1/chat/send', headers: h, payload: { star: 'eimi', text: `ASK:${EIMI}` } }));
        expect(seen.at(-1)!.outfits![0]).toMatchObject({ invite: false, pickup: true });
        expect(res.pickup).toMatchObject({ via: 'ask' });
      } finally {
        LINES.eimi.draft = false;
      }
    });

    it('in production with her invitation lines reviewed (#84): she may bring it up herself', async () => {
      expect(LINES.eimi.draft).toBe(false);
      const prod = await buildApp({ repos, logger: false, demo: false });
      const { user } = await member({ role: 'admin' });
      expect((await prod.inject({ method: 'PUT', url: '/v1/admin/pickups', headers: auth(user), payload: { cardId: EIMI, startsAt: START, endsAt: END } })).statusCode).toBe(200);
      const { h } = await member();
      dice(0);
      const res = json(await prod.inject({ method: 'POST', url: '/v1/chat/send', headers: h, payload: { star: 'eimi', text: `INVITE:${EIMI}` } }));
      expect(seen.at(-1)!.outfits![0]).toMatchObject({ invite: true, pickup: true });
      expect(res.pickup).toMatchObject({ via: 'invite' });
    });

    it('the metrics funnel counts the prompt and the draw that follows', async () => {
      await schedule();
      const { h } = await member({ points: 5000 });
      dice(0.99);
      await send(h, `ASK:${EIMI}`);
      const row = (await repos.pickups.byId(ID))!;
      let seed = 0;
      while (drawPickupPulls(1, poolCards('star:eimi', CATALOG), row, seeded(seed), 0, row.rates).drawn[0].card.id !== EIMI) seed++;
      pin.seed = seed;
      expect((await post('/v1/gacha/draw', { pool: ID, count: 1 }, h)).statusCode).toBe(200);
      const [today] = await repos.events.metrics(jstDay(), jstDay(), 'all');
      expect(today).toMatchObject({ variantPrompted: 1, variantDrawn: 1 });
    });
  });
});

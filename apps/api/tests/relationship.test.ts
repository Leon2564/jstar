import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { RULES, STAGE_RULES, STAR_IDS, jstDay, legacyStage, type RelationshipStage } from '@jstar/shared';
import { signJwt } from '../src/lib/crypto';
import { createMemoryRepos } from '../src/db/memory';
import { createSqlRepos } from '../src/db/sql';
import { SEED_CARDS } from '../src/db/seed';
import type { Repos } from '../src/db/types';
import { newUserRow } from '../src/lib/account';
import { relationships } from '../src/lib/relationship';
import { env } from '../src/env';
import { buildApp } from '../src/app';
import { createSqliteClient } from './sqlite';

// The persona service has its own suite (apps/agent/tests); this fake echoes and records what it was given.
const agent = vi.hoisted(() => ({ inputs: [] as Record<string, unknown>[], greetings: [] as Record<string, unknown>[] }));
vi.mock('../src/lib/agent', () => ({
  askPersona: async (input: { text: string }) => { agent.inputs.push(input); return { reply: `echo:${input.text}`, blocked: false, boundary: null, memory: null, cardTitle: null }; },
  streamPersona: async function* () { yield { type: 'error', error: 'unused' }; },
  greetPersona: async (input: Record<string, unknown>) => { agent.greetings.push(input); return 'hi'; }
}));

const BACKENDS: [string, () => Repos][] = [
  ['memory', () => createMemoryRepos({ cards: SEED_CARDS })],
  ['sql', () => createSqlRepos(createSqliteClient())]
];

let app: FastifyInstance;
let repos: Repos;
let events: { name: string; props: Record<string, unknown> }[];

async function member(patch: Partial<ReturnType<typeof newUserRow>> = {}) {
  const user = await repos.users.create({ ...newUserRow({ email: `${Math.random()}@example.com`, lineSub: null, nickname: 'u', via: 'email', lang: 'ja' }), freePulls: 0, ...patch });
  return { user, h: { authorization: `Bearer ${signJwt({ sub: user.id }, env.JWT_SECRET, 60 * 86_400)}` } };
}
const json = (res: { payload: string }) => JSON.parse(res.payload);
const send = async (h: Record<string, string>, star: string, text = 'hi') => {
  const res = await app.inject({ method: 'POST', url: '/v1/chat/send', headers: h, payload: { star, text } });
  expect(res.statusCode, res.payload).toBe(200);
  return json(res);
};
const panel = async (h: Record<string, string>) => json(await app.inject({ url: '/v1/relationship', headers: h })).talents as { star: string; stage: RelationshipStage; daysTogether: number; hint: string; loverLevel: number | null; anniversary: string | null }[];
const of = async (h: Record<string, string>, star: string) => (await panel(h)).find((t) => t.star === star)!;
const freePulls = async (userId: string) => (await repos.users.byId(userId))!.freePulls;

/** Noon JST on day `n` (1-based) of a fixed week; the daily chat allowance resets with each new day too. */
const START = Date.UTC(2026, 10, 2, 3, 0);
const onDay = (n: number) => vi.setSystemTime(START + (n - 1) * 86_400_000);
/** All three stage gates' XP at once: only the days can hold him back. */
const ALL_XP = STAGE_RULES.stages.ambiguous.xp;

describe.each(BACKENDS)('relationship stages (%s store)', (_name, makeRepos) => {
  beforeEach(async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    onDay(1);
    repos = makeRepos();
    app = await buildApp({ repos, logger: false, demo: true });
    events = [];
    const record = app.recordEvent.bind(app);
    app.recordEvent = (async (userId, name, props) => { events.push({ name, props: props as Record<string, unknown> }); return record(userId, name, props); }) as typeof app.recordEvent;
    agent.inputs.length = 0;
  });
  afterEach(() => { vi.useRealTimers(); });

  it('reaches confession_ready on the 7th JST day of one message a day with the XP met — and not a day earlier', async () => {
    const { user, h } = await member();
    await repos.affinity.add(user.id, 'mahiro', ALL_XP);
    const seen: RelationshipStage[] = [];
    for (let day = 1; day <= 7; day++) {
      onDay(day);
      seen.push((await send(h, 'mahiro')).relationship.stage);
    }
    // 2 days new, 2 familiar, 3 ambiguous: the confession is ready on day 7.
    expect(seen).toEqual(['new', 'familiar', 'familiar', 'ambiguous', 'ambiguous', 'ambiguous', 'confession_ready']);
    expect(await of(h, 'mahiro')).toMatchObject({ stage: 'confession_ready', daysTogether: 7, hint: 'ready' });
    expect(events.filter((e) => e.name === 'stage.changed').map((e) => e.props)).toEqual([
      { star: 'mahiro', from: 'new', to: 'familiar' }, { star: 'mahiro', from: 'familiar', to: 'ambiguous' }, { star: 'mahiro', from: 'ambiguous', to: 'confession_ready' }
    ]);
  });

  it('XP cannot buy the days: the same XP in one day stays new, and in three days reaches familiar at most', async () => {
    const { user, h } = await member({ passUntil: new Date(START + 30 * 86_400_000).toISOString() });
    await repos.affinity.add(user.id, 'nana', ALL_XP * 3);
    for (let i = 0; i < 10; i++) await send(h, 'nana', `m${i}`);
    expect(await of(h, 'nana')).toMatchObject({ stage: 'new', daysTogether: 1, hint: 'time' });
    onDay(2);
    await send(h, 'nana');
    onDay(3);
    await send(h, 'nana');
    // Day 2 opens familiar; familiar needs two days of its own, so day 3 is still familiar and nowhere near a confession.
    expect(await of(h, 'nana')).toMatchObject({ stage: 'familiar', daysTogether: 3, hint: 'time' });
  });

  it('keeps the five talents independent: time with one never moves another', async () => {
    const { user, h } = await member();
    for (const star of STAR_IDS) await repos.affinity.add(user.id, star, ALL_XP);
    for (let day = 1; day <= 4; day++) { onDay(day); await send(h, 'unpai'); }
    onDay(5);
    await send(h, 'alice');
    const all = await panel(h);
    expect(all.map((t) => t.star)).toEqual([...STAR_IDS]);
    expect(all.find((t) => t.star === 'unpai')).toMatchObject({ stage: 'ambiguous', daysTogether: 4 });
    expect(all.find((t) => t.star === 'alice')).toMatchObject({ stage: 'new', daysTogether: 1 });
    for (const star of ['mahiro', 'nana', 'eimi']) expect(all.find((t) => t.star === star)).toMatchObject({ stage: 'new', daysTogether: 0, hint: 'time' });
  });

  it('pays one free pull per stage entered and per lover level — never per level of XP, never twice', async () => {
    const { user, h } = await member();
    await repos.affinity.add(user.id, 'eimi', ALL_XP);
    const pulls: number[] = [];
    for (let day = 1; day <= 7; day++) {
      onDay(day);
      // Two messages at once on each day: a stage entered is still paid once.
      const [a, b] = await Promise.all([send(h, 'eimi', 'a'), send(h, 'eimi', 'b')]);
      expect(a.relationship.daysTogether).toBe(day);
      expect(b.relationship.daysTogether).toBe(day);
      pulls.push(await freePulls(user.id));
    }
    // familiar (day 2) and ambiguous (day 4) pay; confession_ready is still "ambiguous" to him and pays nothing.
    expect(pulls).toEqual([0, 1, 1, 2, 2, 2, 2]);

    // Her confession accepted (#55): lovers, today is the anniversary, the lover stage pays one pull.
    const lovers = await relationships(app).becomeLovers(user.id, 'eimi');
    expect(lovers).toMatchObject({ stage: 'lover', anniversary: jstDay(), loverXp: ALL_XP + 14 * RULES.xpPerMessage });
    expect(await relationships(app).becomeLovers(user.id, 'eimi')).toBeNull();
    expect(await freePulls(user.id)).toBe(3);
    expect(await of(h, 'eimi')).toMatchObject({ stage: 'lover', loverLevel: 1, anniversary: jstDay(), hint: 'lover' });

    // Lover levels count from the confession: two levels' XP → level 3 and two more pulls, paid once.
    await repos.affinity.add(user.id, 'eimi', 2 * STAGE_RULES.loverXpPerLevel - RULES.xpPerMessage);
    onDay(8);
    const r = await send(h, 'eimi');
    expect(r.relationship).toMatchObject({ stage: 'lover', loverLevel: 3 });
    expect(r.freePulls).toBe(5);
    await send(h, 'eimi');
    expect(await freePulls(user.id)).toBe(5);
    // The level is capped, and so are the pulls: 12 per talent at most.
    await repos.affinity.add(user.id, 'eimi', 100 * STAGE_RULES.loverXpPerLevel);
    await send(h, 'eimi');
    expect(await of(h, 'eimi')).toMatchObject({ loverLevel: STAGE_RULES.loverMaxLevel });
    expect(await freePulls(user.id)).toBe(3 + STAGE_RULES.loverMaxLevel - 1);
  });

  it('tells the persona where they stand, today included', async () => {
    const { user, h } = await member();
    await repos.affinity.add(user.id, 'alice', ALL_XP);
    await send(h, 'alice');
    expect(agent.inputs.at(-1)).toMatchObject({ stage: 'new', daysTogether: 1, anniversary: null, loverLevel: null });
    onDay(2);
    await send(h, 'alice');
    // The stage moves after the turn, so she learns it on the next one.
    expect(agent.inputs.at(-1)).toMatchObject({ stage: 'new', daysTogether: 2 });
    await send(h, 'alice');
    expect(agent.inputs.at(-1)).toMatchObject({ stage: 'familiar', daysTogether: 2 });
    await app.inject({ url: '/v1/chat/greeting?star=alice', headers: h });
    expect(agent.greetings.at(-1)).toMatchObject({ stage: 'familiar', daysTogether: 2 });
  });

  it('answers her hints as keys, never numbers, and needs a session', async () => {
    const { user, h } = await member();
    expect((await app.inject({ url: '/v1/relationship' })).statusCode).toBe(401);
    expect(await of(h, 'mahiro')).toEqual({ star: 'mahiro', stage: 'new', daysTogether: 0, anniversary: null, loverLevel: null, hint: 'both', progress: 0 });
    onDay(1); await send(h, 'mahiro');
    onDay(2); await send(h, 'mahiro');
    // Days met, XP not: she asks for more talking.
    expect(await of(h, 'mahiro')).toMatchObject({ stage: 'new', hint: 'talk', progress: 0.2 });
    await repos.affinity.add(user.id, 'mahiro', ALL_XP);
    // Both met: his next message moves them on, so she still asks him to talk.
    expect(await of(h, 'mahiro')).toMatchObject({ stage: 'new', hint: 'talk', progress: 1 });
    expect(JSON.stringify(await panel(h))).not.toMatch(new RegExp(`\\b(${STAGE_RULES.stages.new.xp}|${STAGE_RULES.stages.ambiguous.xp})\\b`));
  });

  it('demo mode sets a stage without paying; production refuses', async () => {
    const { user, h } = await member();
    const set = await app.inject({ method: 'POST', url: '/v1/relationship/demo', headers: h, payload: { star: 'nana', stage: 'lover' } });
    expect(json(set)).toMatchObject({ star: 'nana', stage: 'lover', loverLevel: 1, anniversary: jstDay() });
    expect(await freePulls(user.id)).toBe(0);
    await send(h, 'nana');
    expect(await freePulls(user.id)).toBe(0);
    const prod = await buildApp({ repos, logger: false, demo: false });
    expect((await prod.inject({ method: 'POST', url: '/v1/relationship/demo', headers: h, payload: { star: 'nana', stage: 'new' } })).statusCode).toBe(404);
  });

  it('deletes the relationship with the account', async () => {
    const { user, h } = await member();
    await send(h, 'mahiro');
    await repos.users.anonymise(user.id, new Date().toISOString());
    expect(await repos.relationship.forUser(user.id)).toEqual([]);
  });
});

describe('upgrading accounts from before stages (migration 0007)', () => {
  /** Old levels were 40 XP each: Lv.3 = 80 XP, Lv.6 = 200 XP. Messages on three JST days (one crosses midnight JST). */
  const LEGACY = `
    INSERT INTO users (id, nickname, via, lang, age_confirmed_at, created_at, points, free_pulls, role, banned) VALUES ('u1', 'old', 'email', 'ja', '2026-10-01T00:00:00Z', '2026-10-01T00:00:00Z', 0, 7, 'user', 0);
    INSERT INTO affinity (user_id, star, xp) VALUES ('u1', 'mahiro', 256), ('u1', 'nana', 120), ('u1', 'eimi', 40), ('u1', 'alice', 200);
    INSERT INTO messages (id, owner_id, star, role, text, created_at) VALUES
      ('m1', 'u1', 'mahiro', 'user', 'a', '2026-10-01T01:00:00.000Z'), ('m2', 'u1', 'mahiro', 'assistant', 'b', '2026-10-01T01:00:00.000Z'),
      ('m3', 'u1', 'mahiro', 'user', 'c', '2026-10-01T14:59:00.000Z'), ('m4', 'u1', 'mahiro', 'user', 'd', '2026-10-01T15:01:00.000Z'),
      ('m5', 'u1', 'mahiro', 'user', 'e', '2026-10-03T01:00:00.000Z'), ('m6', 'u1', 'nana', 'user', 'f', '2026-10-02T01:00:00.000Z'),
      ('m7', 'device:x', 'mahiro', 'user', 'g', '2026-10-02T01:00:00.000Z');
  `;

  beforeEach(async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    onDay(1);
    repos = createSqlRepos(createSqliteClient({ before: { '0007_relationship.sql': LEGACY } }));
    app = await buildApp({ repos, logger: false, demo: false });
  });
  afterEach(() => { vi.useRealTimers(); });

  it('maps the old level to a stage without taking anything away, rebuilds the days, and pays no pull twice', async () => {
    const rows = await repos.relationship.forUser('u1');
    const byStar = Object.fromEntries(rows.map((r) => [r.star, r]));
    expect(byStar.mahiro).toMatchObject({ stage: 'ambiguous', daysTogether: 3, lastDay: '2026-10-03', stageDay: 3, rewardRank: 2 });
    expect(byStar.nana).toMatchObject({ stage: 'familiar', daysTogether: 1, stageDay: 1, rewardRank: 1 });
    expect(byStar.alice).toMatchObject({ stage: 'ambiguous', daysTogether: 0, rewardRank: 2 });
    expect(byStar.eimi).toMatchObject({ stage: 'new', daysTogether: 0, stageDay: 0, rewardRank: 0 });
    // The SQL mapping is the shared one (which the web and docs describe).
    const oldXp: Record<string, number> = { mahiro: 256, nana: 120, eimi: 40, alice: 200 };
    for (const r of rows) expect(r.stage).toBe(legacyStage(oldXp[r.star]));

    const h = { authorization: `Bearer ${signJwt({ sub: 'u1' }, env.JWT_SECRET, 60 * 86_400)}` };
    // Enough XP for each one's next stage: only their days in it are missing.
    await repos.affinity.add('u1', 'nana', STAGE_RULES.stages.familiar.xp - 120);
    await repos.affinity.add('u1', 'mahiro', STAGE_RULES.stages.ambiguous.xp - 256);
    for (let day = 1; day <= 3; day++) {
      onDay(day);
      await send(h, 'mahiro');
      await send(h, 'nana');
      // Never backwards; a migrated stage still takes its own days (3 for ambiguous) before the next one.
      expect((await of(h, 'mahiro')).stage).toBe(day < 3 ? 'ambiguous' : 'confession_ready');
      expect(['familiar', 'ambiguous']).toContain((await of(h, 'nana')).stage);
    }
    // nana: familiar → ambiguous after two more days (one pull); mahiro's confession_ready pays none.
    expect(await freePulls('u1')).toBe(7 + 1);
    expect(await of(h, 'nana')).toMatchObject({ stage: 'ambiguous' });
  });
});

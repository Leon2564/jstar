import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { BOND_RULES, type RelationshipStage } from '@jstar/shared';
import { LINES } from '@jstar/shared/lines';
import { signJwt } from '../src/lib/crypto';
import { createMemoryRepos } from '../src/db/memory';
import { createSqlRepos } from '../src/db/sql';
import { SEED_CARDS } from '../src/db/seed';
import type { Repos } from '../src/db/types';
import { newUserRow } from '../src/lib/account';
import { env } from '../src/env';
import { buildApp } from '../src/app';
import { createSqliteClient } from './sqlite';

// The persona service has its own suite (apps/agent/tests/test_bond.py); this fake records what it was given and
// reports praise when he says ほめ:<look> — the way the memory model hears it.
const agent = vi.hoisted(() => ({ inputs: [] as Record<string, unknown>[], greetings: [] as Record<string, unknown>[] }));
vi.mock('../src/lib/agent', () => ({
  askPersona: async (input: { text: string }) => {
    agent.inputs.push(input);
    const praised = /ほめ:(\S+)/.exec(input.text)?.[1].split(',');
    return { reply: `echo:${input.text}`, blocked: false, boundary: null, memory: null, cardTitle: null, ...(praised ? { praised } : {}) };
  },
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

/** A member whose account nickname is his e-mail handle (as auth.ts makes it), and `name` the name he set, if any. */
async function member(name: string | null = 'ケンタ') {
  const user = await repos.users.create({ ...newUserRow({ email: 'qanest-r9-ja@example.com', lineSub: null, nickname: 'qanest-r9-ja', via: 'email', lang: 'ja' }) });
  if (name) await repos.bond.setName(user.id, name, new Date().toISOString());
  return { user, h: { authorization: `Bearer ${signJwt({ sub: user.id }, env.JWT_SECRET, 60 * 86_400)}` } };
}
const json = (res: { payload: string }) => JSON.parse(res.payload);
type Bond = { star: string; callName: string | null; callStage: string; ask: { to: string; text: string } | null; praise: Record<string, number> };
const bond = async (h: Record<string, string>, star = 'mahiro', lang = 'ja'): Promise<Bond> => {
  const res = await app.inject({ url: `/v1/bond?star=${star}&lang=${lang}`, headers: h });
  expect(res.statusCode, res.payload).toBe(200);
  return json(res);
};
const stage = async (h: Record<string, string>, to: RelationshipStage, star = 'mahiro') => {
  const res = await app.inject({ method: 'POST', url: '/v1/relationship/demo', headers: h, payload: { star, stage: to } });
  expect(res.statusCode, res.payload).toBe(200);
};
const answer = (h: Record<string, string>, to: string, accept: boolean, star = 'mahiro') =>
  app.inject({ method: 'POST', url: '/v1/bond/call-name', headers: h, payload: { star, to, accept, lang: 'ja' } });
const send = async (h: Record<string, string>, text: string, star = 'mahiro') => {
  const res = await app.inject({ method: 'POST', url: '/v1/chat/send', headers: h, payload: { star, text } });
  expect(res.statusCode, res.payload).toBe(200);
  return agent.inputs[agent.inputs.length - 1] as { callName: string | null; looks: { id: string; what: string; favorite: boolean }[] };
};
const lines = LINES.mahiro.callName;

async function boot(makeRepos: () => Repos, demo = true) {
  repos = makeRepos();
  app = await buildApp({ repos, logger: false, demo });
  events = [];
  agent.inputs.length = 0;
  agent.greetings.length = 0;
  const record = app.recordEvent.bind(app);
  app.recordEvent = (async (userId, name, props) => { events.push({ name, props: props as Record<string, unknown> }); return record(userId, name, props); }) as typeof app.recordEvent;
}

afterEach(async () => { await app?.close(); });

describe.each(BACKENDS)('what she calls him (%s store)', (_name, makeRepos) => {
  beforeEach(async () => { await boot(makeRepos); });

  it('the stage decides the form, and she asks once before it changes', async () => {
    const { h } = await member();
    expect(await bond(h)).toEqual({ star: 'mahiro', callName: 'ケンタさん', callStage: 'new', ask: null, praise: {} });
    expect((await send(h, 'こんにちは')).callName).toBe('ケンタさん');

    await stage(h, 'familiar');
    const asked = await bond(h);
    expect(asked.callName).toBe('ケンタさん');
    expect(asked.ask).toEqual({ to: 'familiar', text: lines.familiar.ask.ja.replace('{name}', 'ケンタ') });
    // M7 (C-room): in en / ko / zh-Hant the new form is the name she already says (no さん / くん there): she does not
    // ask 「可以直接叫你「ケンタ」嗎？」 of ケンタ — only where the way she calls him would change.
    for (const lang of ['en', 'ko', 'zh-Hant']) expect((await bond(h, 'mahiro', lang)).ask, lang).toBeNull();
    // Until he answers she keeps the old form.
    expect((await send(h, 'ただいま')).callName).toBe('ケンタさん');

    const res = await answer(h, 'familiar', true);
    expect(res.statusCode, res.payload).toBe(200);
    expect(json(res).reply).toBe(lines.familiar.accepted.ja.replace('{name}', 'ケンタ'));
    expect(json(res).bond).toMatchObject({ callName: 'ケンタくん', callStage: 'familiar', ask: null });
    // N-09: in another language she calls him by his name as he set it — no Japanese くん around it.
    // F-12 (#10): in en / ko a kana name in their script; in zh-Hant as he stored it.
    expect(Object.fromEntries(await Promise.all(['en', 'ko', 'zh-Hant'].map(async (lang) => [lang, (await bond(h, 'mahiro', lang)).callName]))))
      .toEqual({ en: 'Kenta', ko: '켄타', 'zh-Hant': 'ケンタ' });
    expect(events.filter((e) => e.name === 'call_name.answered')).toEqual([{ name: 'call_name.answered', props: { star: 'mahiro', to: 'familiar', answer: 'accepted' } }]);
    // Her question and her answer are in the conversation, in order; nothing of his was invented.
    const history = json(await app.inject({ url: '/v1/chat/history?star=mahiro', headers: h })).messages as { role: string; text: string }[];
    expect(history.slice(-2)).toEqual([
      expect.objectContaining({ role: 'assistant', text: asked.ask!.text }),
      expect.objectContaining({ role: 'assistant', text: json(res).reply })
    ]);

    // Only once: a second answer (another tab) changes nothing, and she never asks again at this stage.
    expect((await answer(h, 'familiar', false)).statusCode).toBe(409);
    expect((await bond(h)).ask).toBeNull();
    expect((await send(h, 'またね')).callName).toBe('ケンタくん');
    await stage(h, 'ambiguous');
    expect(await bond(h)).toMatchObject({ callName: 'ケンタくん', ask: null });

    await stage(h, 'lover');
    expect((await bond(h)).ask?.to).toBe('lover');
    expect(json(await answer(h, 'lover', true)).bond.callName).toBe('ケンタ');
    expect((await send(h, 'すき')).callName).toBe('ケンタ');
    const greet = await app.inject({ url: '/v1/chat/greeting?star=mahiro', headers: h });
    expect(greet.statusCode, greet.payload).toBe(200);
    expect(agent.greetings.at(-1)).toMatchObject({ callName: 'ケンタ' });
  });

  it('after he says no she keeps the old form, and does not ask about it again', async () => {
    const { h } = await member();
    await stage(h, 'familiar');
    const res = await answer(h, 'familiar', false);
    expect(json(res).reply).toBe(lines.familiar.declined.ja);
    expect(json(res).bond).toMatchObject({ callName: 'ケンタさん', callStage: 'new', ask: null });
    expect(events.find((e) => e.name === 'call_name.answered')?.props).toEqual({ star: 'mahiro', to: 'familiar', answer: 'declined' });
    await stage(h, 'ambiguous');
    expect(await bond(h)).toMatchObject({ callName: 'ケンタさん', ask: null });
    expect((await send(h, 'おはよう')).callName).toBe('ケンタさん');
  });

  it('answers only what she is asking: not before the stage, not a change she skipped', async () => {
    const { h } = await member();
    expect((await answer(h, 'familiar', true)).statusCode).toBe(409);
    await stage(h, 'lover');
    expect((await bond(h)).ask?.to).toBe('lover');
    expect((await answer(h, 'familiar', true)).statusCode).toBe(409);
    expect(json(await answer(h, 'lover', true)).bond.callName).toBe('ケンタ');
  });

  it('each line is independent: her question about him changes nothing with the others', async () => {
    const { h } = await member();
    await stage(h, 'familiar');
    await answer(h, 'familiar', true);
    expect(await bond(h, 'nana')).toMatchObject({ callName: 'ケンタさん', ask: null });
    // えいみ calls him くん from the start.
    expect((await bond(h, 'eimi')).callName).toBe('ケンタくん');
  });

  it('F-12 / M7: in English she asks only for a change he would hear — えいみ\'s pet name, with Kenta in it, never ケンタ', async () => {
    const { h } = await member();
    await stage(h, 'lover', 'eimi');
    const asked = await bond(h, 'eimi', 'en');
    expect(asked.callName).toBe('Kenta');
    expect(asked.ask?.to).toBe('lover');
    expect(asked.ask?.text).toBe(LINES.eimi.callName.lover.ask.en.replace(/\{name\}(さん|くん)?/g, 'Kenta'));
    expect(asked.ask?.text).not.toContain('ケンタ');
  });

  it('M4 (C-room): her greeting is asked for his time of day — his zone to the persona service, her written one by his hour', async () => {
    // Noon in Japan (she is up, so the persona service is asked): 23:00 the evening before in New York.
    vi.useFakeTimers({ toFake: ['Date'], now: new Date('2026-10-05T03:00:00Z') });
    const { h } = await member();
    const greet = async (tz?: string) => {
      const res = await app.inject({ url: `/v1/chat/greeting?star=nana${tz ? `&tz=${encodeURIComponent(tz)}` : ''}`, headers: h });
      expect(res.statusCode, res.payload).toBe(200);
      return agent.greetings.at(-1) as Record<string, unknown> | undefined;
    };
    expect((await greet('America/New_York'))?.tz).toBe('America/New_York');
    // Japan's own clock (or none told): her clock, nothing to add.
    agent.greetings.length = 0;
    const tokyo = await greet('Asia/Tokyo');
    if (tokyo) expect(tokyo.tz).toBeUndefined();
    expect((await app.inject({ url: '/v1/chat/greeting?star=nana&tz=Not%2FAZone', headers: h })).statusCode).toBe(200);
    vi.useRealTimers();
  });

  it('the demo can move her back, so the question can be tried again', async () => {
    const { h } = await member();
    await stage(h, 'familiar');
    await answer(h, 'familiar', true);
    await stage(h, 'new');
    expect(await bond(h)).toMatchObject({ callName: 'ケンタさん', ask: null });
    await stage(h, 'familiar');
    expect((await bond(h)).ask?.to).toBe('familiar');
  });

  it('the name he sets on My page is the name in every form; nonsense is refused', async () => {
    const { h } = await member(null);
    const put = (name: string | null) => app.inject({ method: 'PUT', url: '/v1/bond/name', headers: h, payload: { name } });
    expect(json(await app.inject({ url: '/v1/bond/name', headers: h }))).toEqual({ name: null });
    for (const bad of ['a'.repeat(BOND_RULES.nameMax + 1), 'me@example.com', 'https://x.jp', '09012345678', '<b>']) {
      const res = await put(bad);
      expect(res.statusCode, bad).toBe(400);
      expect(json(res).error).toBe('invalid_name');
    }
    expect(json(await put('  ケン  '))).toEqual({ name: 'ケン' });
    expect((await bond(h)).callName).toBe('ケンさん');
    // A name that already carries its own ending keeps it.
    await put('ケンちゃん');
    expect((await bond(h)).callName).toBe('ケンちゃん');
    await stage(h, 'familiar');
    // M7 (C-room): ケンちゃん is ケンちゃん in both forms — she has nothing to ask.
    expect((await bond(h)).ask).toBeNull();
    await put('ケン');
    expect((await bond(h)).ask?.text).toBe(lines.familiar.ask.ja.replace('{name}', 'ケン'));
    expect(json(await put(null))).toEqual({ name: null });
    // Round 10: no name set, none told: no name at all — never his e-mail handle (the account nickname).
    expect((await bond(h)).callName).toBeNull();
  });

  it('a name he told her in chat is her name for him; the account nickname (his e-mail handle) never is', async () => {
    const { user, h } = await member(null);
    expect((await bond(h)).callName).toBeNull();
    await repos.chatMemory.save(user.id, 'mahiro', { name: 'ケンタ' }, null);
    expect((await bond(h)).callName).toBe('ケンタさん');
    expect((await send(h, 'やあ')).callName).toBe('ケンタさん');
  });
});

describe.each(BACKENDS)('she is changed by him (%s store)', (_name, makeRepos) => {
  beforeEach(async () => { await boot(makeRepos); });

  it('counts what he praises, and a look praised three times is her favorite', async () => {
    const { h } = await member();
    const first = await send(h, 'こんばんは');
    expect(first.looks.map((l) => l.id)).toEqual(['outfit', 'face']);
    expect(first.looks[0].what).toContain('cardigan');
    expect(first.looks.every((l) => !l.favorite)).toBe(true);

    await send(h, 'ほめ:face');
    await send(h, 'ほめ:face,outfit');
    expect((await bond(h)).praise).toEqual({ face: 2, outfit: 1 });
    await send(h, 'ほめ:face');
    expect((await bond(h)).praise).toEqual({ face: 3, outfit: 1 });
    const now = await send(h, 'またね');
    expect(now.looks.find((l) => l.id === 'face')?.favorite).toBe(true);
    expect(now.looks.find((l) => l.id === 'outfit')?.favorite).toBe(false);
  });

  it('only her looks that exist for him count: not unknown ones, not another talent’s, not a variant he does not own', async () => {
    const { user, h } = await member();
    await send(h, 'ほめ:bikini,s1-mahiro-30,s1-nana-30');
    expect((await bond(h)).praise).toEqual({});
    await repos.owned.grant(user.id, 's1-mahiro-30', false);
    const turn = await send(h, 'ほめ:s1-mahiro-30');
    expect(turn.looks.map((l) => l.id)).toEqual(['outfit', 'face', 's1-mahiro-30']);
    expect(turn.looks[2].what).toContain('ふたつのマグカップ');
    expect((await bond(h)).praise).toEqual({ 's1-mahiro-30': 1 });
    expect((await bond(h, 'nana')).praise).toEqual({});
  });

  it('everything goes with the account', async () => {
    const { user, h } = await member();
    await app.inject({ method: 'PUT', url: '/v1/bond/name', headers: h, payload: { name: 'ケン' } });
    await stage(h, 'familiar');
    await answer(h, 'familiar', true);
    await send(h, 'ほめ:outfit');
    expect(await repos.bond.get(user.id, 'mahiro')).not.toBeNull();
    const del = await app.inject({ method: 'DELETE', url: '/v1/auth/me', headers: h, payload: { confirm: 'DELETE' } });
    expect(del.statusCode, del.payload).toBe(200);
    expect(await repos.bond.get(user.id, 'mahiro')).toBeNull();
    expect(await repos.bond.praise(user.id, 'mahiro')).toEqual({});
    expect(await repos.bond.name(user.id)).toBeNull();
  });
});

describe.each(BACKENDS)('in production (%s store)', (_name, makeRepos) => {
  beforeEach(async () => { await boot(makeRepos, false); });
  const familiar = async () => {
    const { user, h } = await member();
    await repos.relationship.touch(user.id, 'mahiro', '2026-11-01', new Date().toISOString());
    const row = (await repos.relationship.get(user.id, 'mahiro'))!;
    await repos.relationship.change(row, { ...row, stage: 'familiar', rev: 'rel_x' }, 0);
    return h;
  };

  it('while her lines are drafts she does not ask, and keeps the form he last said yes to', async () => {
    // Her lines are reviewed now (#84, owner 2026-09-28); the gate must still hold for a draft, so one is made here.
    LINES.mahiro.draft = true;
    try {
      const h = await familiar();
      expect(await bond(h)).toMatchObject({ callName: 'ケンタさん', ask: null });
      expect((await answer(h, 'familiar', true)).statusCode).toBe(409);
      expect(events.filter((e) => e.name === 'call_name.answered')).toEqual([]);
    } finally {
      LINES.mahiro.draft = false;
    }
  });

  it('with her lines reviewed she asks, and his yes changes the form', async () => {
    expect(LINES.mahiro.draft).toBe(false);
    const h = await familiar();
    expect(await bond(h)).toMatchObject({ callName: 'ケンタさん', ask: { to: 'familiar', text: lines.familiar.ask.ja.replace('{name}', 'ケンタ') } });
    const res = await answer(h, 'familiar', true);
    expect(res.statusCode, res.payload).toBe(200);
    expect(json(res).bond).toMatchObject({ callName: 'ケンタくん', callStage: 'familiar', ask: null });
    expect(events.filter((e) => e.name === 'call_name.answered')).toHaveLength(1);
  });
});

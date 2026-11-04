import { beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { DEMO_SERIALS, RARITY_ORDER, RULES, drawLucky, jstDay, isValidSerialFormat, luhnCheckDigit, seeded } from '@jstar/shared';
import { hashSerial, signJwt, signupBlockHash } from '../src/lib/crypto';
import { createMemoryRepos } from '../src/db/memory';
import { createSqlRepos } from '../src/db/sql';
import { SEED_CARDS } from '../src/db/seed';
import type { Repos } from '../src/db/types';
import { newUserRow } from '../src/lib/account';
import { assertProductionSafe, env } from '../src/env';
import { buildApp } from '../src/app';
import { GREETING_LINES } from '../src/lib/greetingLines';
import { createSqliteClient } from './sqlite';

// The persona service is exercised by its own test suite (apps/agent/tests). This fake follows its contract:
// BLOCK is hard-blocked, SELFHARM gets support (never a card), DOWN means the agent is unreachable, BREAK streams a
// few words then fails, "my name is X" is remembered, and card turns get a title the agent wrote. Memory is batched as
// the agent does it (memoryMode "batch"): a turn is taken in with a name in it or on his 5th unsaved message, and
// `memorySaved` says so; a trial ("off") keeps nothing.
const agent = vi.hoisted(() => ({ inputs: [] as Record<string, unknown>[], greetings: [] as Record<string, unknown>[], next: null as string | null, queue: [] as string[], fail: false, slow: null as Promise<void> | null }));
vi.mock('../src/lib/agent', () => {
  const unavailable = () => Object.assign(new Error('agent_unavailable'), { statusCode: 503 });
  const answer = (input: { text: string; suggest?: boolean; wantCard?: boolean; memory?: { facts: Record<string, string>; summary: string | null } | null; memoryMode?: string; unsaved?: { role: string; text: string }[] }) => {
    agent.inputs.push(input);
    const { text } = input;
    if (text === 'DOWN') throw unavailable();
    if (text === 'BLOCK') return { reply: '', blocked: true, reason: 'minor' };
    const due = input.memoryMode !== 'batch' || (input.unsaved ?? []).filter((t) => t.role === 'user').length + 1 >= 5;
    if (text === 'SELFHARM') return { reply: 'support:0570-064-556', blocked: false, boundary: 'self_harm', memory: null, cardTitle: null, memorySaved: due };
    const name = /^my name is (\w+)/.exec(text)?.[1];
    const heard = [...(input.unsaved ?? []).filter((t) => t.role === 'user').map((t) => t.text), text].join(' / ');
    const memory = name ? { facts: { ...(input.memory?.facts ?? {}), name }, summary: `He is ${name}.` }
      : due && input.memoryMode === 'batch' ? { facts: input.memory?.facts ?? {}, summary: `heard: ${heard}` } : null;
    const replies = input.suggest ? [text, 'Tell me more', 'x'.repeat(50), 'Tell me more', 7, 'And you?', 'Fourth'] : undefined;
    return { reply: `echo:${text}`, blocked: false, boundary: null, memory, cardTitle: input.wantCard ? '夜のおしゃべり' : null, memorySaved: due || !!name, ...(replies ? { replies } : {}) };
  };
  return {
    askPersona: async (input: Parameters<typeof answer>[0]) => answer(input),
    streamPersona: async function* (input: Parameters<typeof answer>[0]) {
      if (input.text === 'BREAK') { agent.inputs.push(input); yield { type: 'delta', text: 'half ' }; yield { type: 'delta', text: 'said' }; yield { type: 'error', error: 'model_unavailable' }; return; }
      const r = answer(input);
      if (r.blocked) { yield { type: 'blocked', reason: r.reason }; return; }
      for (const piece of r.reply.match(/.{1,3}/gu) ?? []) yield { type: 'delta', text: piece };
      yield { type: 'done', reply: r.reply, boundary: r.boundary, memory: r.memory, cardTitle: r.cardTitle, memorySaved: r.memorySaved, replies: (r as { replies?: unknown }).replies };
    },
    greetPersona: async (input: Record<string, unknown>) => {
      agent.greetings.push(input);
      if (agent.slow) await agent.slow;
      if (agent.fail) { agent.fail = false; throw Object.assign(new Error('agent_unavailable'), { statusCode: 503 }); }
      const next = agent.queue.shift() ?? agent.next;
      agent.next = null;
      return next ?? `greet:${input.star}:${input.daysSince}:${input.level}`;
    }
  };
});

/** The same behaviour is required of both stores: memory (dev) and SQL (production on D1, here on SQLite). */
const BACKENDS: [string, () => Repos][] = [
  ['memory', () => createMemoryRepos({ cards: SEED_CARDS })],
  ['sql', () => createSqlRepos(createSqliteClient())]
];

let app: FastifyInstance;
let repos: Repos;

async function userWith(patch: Partial<ReturnType<typeof newUserRow>> = {}) {
  const user = await repos.users.create({ ...newUserRow({ email: `${Math.random()}@example.com`, lineSub: null, nickname: 'u', via: 'email', lang: 'ja' }), ...patch });
  return { user, h: { authorization: `Bearer ${signJwt({ sub: user.id }, env.JWT_SECRET, 3600)}` } };
}
const post = (url: string, payload: object, headers: Record<string, string> = {}) => app.inject({ method: 'POST', url, headers, payload });
const json = (res: { payload: string }) => JSON.parse(res.payload);
const me = async (h: Record<string, string>) => json(await app.inject({ url: '/v1/auth/me', headers: h }));
const sumCopies = (owned: { copies: number }[]) => owned.reduce((n, o) => n + o.copies, 0);
/** A well-formed code that was never issued. */
const unissued = (n: number) => { const d = [8, 8, 8, ...String(n).padStart(8, '0').split('').map(Number)]; return d.join('') + luhnCheckDigit(d); };
type Card = { id: string; star: string; rarity: 'N' | 'R' | 'SR' | 'SSR' | 'UR'; isNew: boolean };

describe.each(BACKENDS)('api (%s store)', (_name, makeRepos) => {
beforeEach(async () => {
  repos = makeRepos();
  app = await buildApp({ repos, logger: false, demo: true });
});

  it('serves health, config and the public catalogue', async () => {
    expect(json(await app.inject('/health')).ok).toBe(true);
    expect(json(await app.inject('/v1/config'))).toEqual({ demo: true, turnstile: null, vapidPublicKey: null, asr: false, voice: false, voiceStars: [] });
    expect(json(await app.inject('/v1/cards')).cards).toHaveLength(125);
    // N-58: the web app reads a 429's Retry-After across origins, to wait it out once before a send fails.
    const res = await app.inject({ url: '/health', headers: { origin: env.PUBLIC_WEB_ORIGIN } });
    expect(res.headers['access-control-expose-headers']).toBe('retry-after');
    const loopback = env.PUBLIC_WEB_ORIGIN.replace('localhost', '127.0.0.1');
    const local = await app.inject({ url: '/health', headers: { origin: loopback } });
    expect(local.headers['access-control-allow-origin']).toBe(loopback);
  });

  it('refuses protected endpoints without a session', async () => {
    for (const [method, url] of [['GET', '/v1/auth/me'], ['POST', '/v1/gacha/draw'], ['GET', '/v1/admin/cards'], ['GET', '/v1/chat/history?star=nana']] as const) {
      expect((await app.inject({ method, url, payload: method === 'POST' ? {} : undefined })).statusCode, url).toBe(401);
    }
  });

  it('rejects a wrong one-time code and accepts the demo code', async () => {
    await post('/v1/auth/otp/start', { email: 'a@example.com' });
    expect((await post('/v1/auth/otp/verify', { email: 'a@example.com', code: '000000' })).statusCode).toBe(400);
    await post('/v1/auth/otp/start', { email: 'a@example.com' });
    const ok = await post('/v1/auth/otp/verify', { email: 'a@example.com', code: '123456' });
    expect(ok.statusCode).toBe(200);
    expect(json(ok).token).toBeTruthy();
  });

  it('says when a one-time code expired or was spent by wrong tries (M1)', async () => {
    const start = await post('/v1/auth/otp/start', { email: 'm1@example.com' });
    expect(json(start)).toEqual({ ok: true, ttlMinutes: env.OTP_TTL_MINUTES });
    for (let i = 0; i < 5; i++) expect(json(await post('/v1/auth/otp/verify', { email: 'm1@example.com', code: '000000' })).error).toBe('invalid_code');
    // The sixth try spends the code, even the right one; B-N6: every later try says so too, until a new code is sent.
    const spent = await post('/v1/auth/otp/verify', { email: 'm1@example.com', code: '123456' });
    expect([spent.statusCode, json(spent).error]).toEqual([400, 'code_attempts']);
    for (let i = 0; i < 2; i++) expect(json(await post('/v1/auth/otp/verify', { email: 'm1@example.com', code: '123456' })).error).toBe('code_attempts');
    // A code past its time.
    await repos.otp.put('m1@example.com', '123456', Date.now() - 1000);
    expect(json(await post('/v1/auth/otp/verify', { email: 'm1@example.com', code: '123456' })).error).toBe('code_expired');
    await post('/v1/auth/otp/start', { email: 'm1@example.com' });
    expect((await post('/v1/auth/otp/verify', { email: 'm1@example.com', code: '123456' })).statusCode).toBe(200);
  });

  it('keeps the e-mail stand-in out of his name until he picks a nickname (M4)', async () => {
    await post('/v1/auth/otp/start', { email: 'taro.y@example.com' });
    const { token, user } = json(await post('/v1/auth/otp/verify', { email: 'taro.y@example.com', code: '123456' }));
    expect(user).toMatchObject({ nickname: 'taroy', named: false });
    const h = { authorization: `Bearer ${token}` };
    const put = (nickname: string) => app.inject({ method: 'PUT', url: '/v1/auth/me/nickname', headers: h, payload: { nickname } });
    expect(json(await put('call me at 090-1234-5678')).error).toBe('invalid_name');
    expect(json(await put('   ')).error).toBe('invalid_name');
    const ok = await put('  タロウ ');
    expect(ok.statusCode).toBe(200);
    expect(json(ok).user).toMatchObject({ nickname: 'タロウ', named: true });
    expect((await me(h)).user).toMatchObject({ nickname: 'タロウ', named: true });
    expect((await app.inject({ method: 'PUT', url: '/v1/auth/me/nickname', payload: { nickname: 'x' } })).statusCode).toBe(401);
  });

  it('outside demo mode, e-mails a random code in the visitor\'s language and makes listed addresses admins', async () => {
    const sent: { to: string; code: string; lang: string }[] = [];
    const prod = await buildApp({ repos, logger: false, demo: false, mailer: async (m) => { sent.push(m); } });
    const start = await prod.inject({ method: 'POST', url: '/v1/auth/otp/start', payload: { email: 'Real@Example.com', lang: 'zh-Hant' } });
    expect(start.statusCode).toBe(200);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ to: 'Real@Example.com', lang: 'zh-Hant' });
    expect(sent[0].code).toMatch(/^\d{6}$/);
    expect((await prod.inject({ method: 'POST', url: '/v1/auth/otp/verify', payload: { email: 'real@example.com', code: sent[0].code === '123456' ? '654321' : '123456' } })).statusCode).toBe(400);
    await prod.inject({ method: 'POST', url: '/v1/auth/otp/start', payload: { email: 'real@example.com' } });
    const ok = await prod.inject({ method: 'POST', url: '/v1/auth/otp/verify', payload: { email: 'real@example.com', code: sent[1].code } });
    expect(ok.statusCode).toBe(200);
    expect(JSON.parse(ok.payload).token).toBeTruthy();
    // LINE sign-in is gone (#136): e-mail only, there is no such route.
    expect((await prod.inject({ method: 'POST', url: '/v1/auth/line', payload: { code: 'x', state: 'y' } })).statusCode).toBe(404);
    expect(JSON.parse((await prod.inject('/v1/config')).payload)).toEqual({ demo: false, turnstile: null, vapidPublicKey: null, asr: false, voice: false, voiceStars: [] });

    const prev = env.ADMIN_EMAILS;
    env.ADMIN_EMAILS = 'ops@example.com, other@example.com';
    try {
      await prod.inject({ method: 'POST', url: '/v1/auth/otp/start', payload: { email: 'OPS@example.com' } });
      await prod.inject({ method: 'POST', url: '/v1/auth/otp/verify', payload: { email: 'ops@example.com', code: sent[2].code } });
      expect((await repos.users.byEmail('ops@example.com'))!.role).toBe('admin');
      expect((await repos.users.byEmail('real@example.com'))!.role).toBe('user');
    } finally { env.ADMIN_EMAILS = prev; }

    // A mail failure is reported, not swallowed: the visitor must not wait for a code that never comes.
    const down = await buildApp({ repos, logger: false, demo: false, mailer: async () => { throw Object.assign(new Error('mail_unavailable'), { statusCode: 503 }); } });
    expect((await down.inject({ method: 'POST', url: '/v1/auth/otp/start', payload: { email: 'x@example.com' } })).statusCode).toBe(503);
  });

  it('asks for a Turnstile token before sign-in mail, a device\'s first trial message and after two wrong codes', async () => {
    const checked: (string | undefined)[] = [];
    const bot = await buildApp({ repos, logger: false, demo: true, human: async (token) => { checked.push(token); return token === 'ok'; } });
    const ok = { 'x-turnstile-token': 'ok' };
    const call = (url: string, payload: object, headers: Record<string, string> = {}) => bot.inject({ method: 'POST', url, headers, payload });
    expect(JSON.parse((await bot.inject('/v1/config')).payload)).toHaveProperty('turnstile');

    const noToken = await call('/v1/auth/otp/start', { email: 'h@example.com' });
    expect([noToken.statusCode, JSON.parse(noToken.payload).error]).toEqual([403, 'challenge_required']);
    expect((await call('/v1/auth/otp/start', { email: 'h@example.com' }, { 'x-turnstile-token': 'forged' })).statusCode).toBe(403);
    expect((await call('/v1/auth/otp/start', { email: 'h@example.com' }, ok)).statusCode).toBe(200);

    const dev = { 'x-device-id': 'device-human-1' };
    expect((await call('/v1/chat/trial', { star: 'nana', text: 'hi' }, dev)).statusCode).toBe(403);
    expect((await call('/v1/chat/trial', { star: 'nana', text: 'hi' }, { ...dev, ...ok })).statusCode).toBe(200);
    expect((await call('/v1/chat/trial', { star: 'nana', text: 'again' }, dev)).statusCode).toBe(200); // only the first

    const sdev = { 'x-device-id': 'device-human-2' };
    for (const n of [1, 2]) expect((await call('/v1/serial/redeem', { code: unissued(n) }, sdev)).statusCode).toBe(404);
    expect((await call('/v1/serial/redeem', { code: unissued(3) }, sdev)).statusCode).toBe(403);
    expect((await call('/v1/serial/redeem', { code: DEMO_SERIALS[0] }, { ...sdev, ...ok })).statusCode).toBe(200);
  });

  it('refuses to boot production with development secrets or demo mode, and D1 with the development code key', () => {
    const real = { JWT_SECRET: 'x'.repeat(32), SERIAL_HMAC_KEY: 'ab'.repeat(32), AGENT_API_KEY: 'k'.repeat(16) };
    expect(() => assertProductionSafe({ ...env, NODE_ENV: 'production' })).toThrow(/JWT_SECRET/);
    expect(() => assertProductionSafe({ ...env, NODE_ENV: 'production', ...real, DEMO_MODE: true })).toThrow(/DEMO_MODE/);
    expect(() => assertProductionSafe({ ...env, NODE_ENV: 'production', ...real, DEMO_MODE: false })).toThrow(/MAIL_URL/);
    expect(() => assertProductionSafe({ ...env, NODE_ENV: 'production', ...real, DEMO_MODE: false, MAIL_URL: 'http://mail.internal' })).not.toThrow();
    expect(() => assertProductionSafe({ ...env, NODE_ENV: 'development', DB: 'd1' })).toThrow(/SERIAL_HMAC_KEY/);
    expect(() => assertProductionSafe({ ...env, NODE_ENV: 'development', DB: 'd1', SERIAL_HMAC_KEY: real.SERIAL_HMAC_KEY })).not.toThrow();
  });

  it('hashes codes exactly as tools/luckcards did for the print run', () => {
    // HMAC-SHA256 keyed with the hex-decoded secret over the 12 plain digits (generate.mjs).
    // Reference value from `printf 999000000011 | openssl dgst -sha256 -mac HMAC -macopt hexkey:00…00` (64 zeros).
    expect(hashSerial('999000000011', '00'.repeat(32))).toBe('8982e6c36b2e5915f3352d8a167c3a871a3ce611cc522749965bdd90568ab229');
    expect(hashSerial('999000000011', '00'.repeat(32))).not.toBe(hashSerial('999000000011', '01'.repeat(32)));
  });

  it('a code gives six cards, the first SR or better, plus pass days — exactly once', async () => {
    const { user, h } = await userWith();
    const code = DEMO_SERIALS[0];
    const ok = await post('/v1/serial/redeem', { code: `${code.slice(0, 4)}-${code.slice(4, 8)}-${code.slice(8)}` }, h);
    expect(ok.statusCode).toBe(200);
    const body = json(ok);
    expect(body).toMatchObject({ trialDays: RULES.serialDefaultTrialDays, claimed: true });
    expect(body.cards).toHaveLength(RULES.lucky.drawsPerCode);
    expect(RARITY_ORDER[(body.cards[0] as Card).rarity]).toBeGreaterThanOrEqual(RARITY_ORDER.SR);
    expect(Date.parse(body.passUntil)).toBeGreaterThan(Date.now() + (RULES.serialDefaultTrialDays - 1) * 86_400_000);

    expect(json(await post('/v1/serial/redeem', { code }, h))).toEqual({ error: 'serial_already_used' });
    expect((await post('/v1/serial/redeem', { code: unissued(1) }, h)).statusCode).toBe(404);

    const m = await me(h);
    expect(sumCopies(m.owned)).toBe(RULES.lucky.drawsPerCode);
    expect(m.owned.every((o: { viaSerial: boolean }) => o.viaSerial)).toBe(true);
    expect(m.serialsRedeemed).toBe(1);
    expect(m.chat.left).toBeNull();
    // Duplicates in the six add bond XP to their talent instead of a new card.
    const cards = body.cards as Card[];
    const dupes = cards.filter((c) => !c.isNew).length;
    expect(new Set(cards.map((c) => c.id)).size).toBe(RULES.lucky.drawsPerCode - dupes);
    expect(Object.values(m.affinity as Record<string, number>).reduce((n, x) => n + x, 0)).toBe(dupes * RULES.lucky.duplicateBondXp);

    // The draw is logged with its seed and tiers and replays to the same cards.
    const [log] = await repos.draws.forOwner(user.id, 5);
    expect(log).toMatchObject({ poolId: 'all', serialId: 'demo-0001', cost: 0 });
    expect(log.tiers).toHaveLength(RULES.lucky.drawsPerCode);
    expect(drawLucky(await repos.cards.all(), seeded(Number(log.seed))).map((d) => d.card.id)).toEqual(cards.map((c) => c.id));
    expect(m.wallet.points).toBe(RULES.welcomePoints + RULES.serialPoints);
  });

  it('a code can draw one card from a chosen star pool and grant 100 points', async () => {
    const { h } = await userWith();
    const res = await post('/v1/serial/redeem', { code: DEMO_SERIALS[0], count: 1, pool: 'star:nana' }, h);
    expect(res.statusCode).toBe(200);
    const body = json(res);
    expect(body.cards).toHaveLength(1);
    expect(body.cards[0].star).toBe('nana');
    expect(body.pointsGranted).toBe(100);
    expect((await me(h)).wallet.points).toBe(RULES.welcomePoints + 100);
  });

  it('rejects typos before looking anything up, without counting them as guesses', async () => {
    const dev = { 'x-device-id': 'device-typo-1' };
    for (const code of ['999000000012', '99900000001', 'JSTR-7K2M-94QX-A3PD', '']) {
      const res = await post('/v1/serial/redeem', { code }, dev);
      expect(res.statusCode, code).toBe(400);
    }
    // More typos than the lockout allows (the route's own limit is 10 requests per 10 minutes).
    for (let i = 0; i < RULES.serialMaxFailures; i++) expect((await post('/v1/serial/redeem', { code: '999000000012' }, dev)).statusCode).toBe(400);
    expect((await post('/v1/serial/redeem', { code: DEMO_SERIALS[1] }, dev)).statusCode).toBe(200);
  });

  it('accepts full-width digits from a Japanese keyboard', async () => {
    const { h } = await userWith();
    const wide = DEMO_SERIALS[2].replace(/\d/g, (d) => String.fromCharCode(d.charCodeAt(0) + 0xfee0));
    expect((await post('/v1/serial/redeem', { code: wide }, h)).statusCode).toBe(200);
  });

  it('lets exactly one of two parallel redemptions of the same code through', async () => {
    const a = await userWith();
    const b = await userWith();
    const results = await Promise.all([post('/v1/serial/redeem', { code: DEMO_SERIALS[3] }, a.h), post('/v1/serial/redeem', { code: DEMO_SERIALS[3] }, b.h)]);
    // The loser fails either on points or on the pity counter the winner moved — never both succeed.
    expect(results.filter((r) => r.statusCode === 200)).toHaveLength(1);
    expect([402, 409]).toContain(results.find((r) => r.statusCode !== 200)!.statusCode);
    const loser = results[0].statusCode === 409 ? a.h : b.h;
    const m = await me(loser);
    expect(m.owned).toEqual([]);
    expect(m.chat.passUntil).toBeNull();
  });

  it('lets a visitor redeem and trial-chat, then moves both into the account at sign-up', async () => {
    const dev = { 'x-device-id': 'device-claim-1' };
    const first = json(await post('/v1/serial/redeem', { code: DEMO_SERIALS[0] }, dev));
    const second = json(await post('/v1/serial/redeem', { code: DEMO_SERIALS[1] }, dev));
    expect(first).toMatchObject({ claimed: false, passUntil: null, trialDays: 7 });
    expect(second.cards).toHaveLength(6);
    const device = json(await app.inject({ url: '/v1/device', headers: dev }));
    expect(device.trialLeft).toBe(3);
    expect(device.pendingPassDays).toBe(14);
    expect(sumCopies(device.cards)).toBe(12);
    // Within the device, a card seen in the first code is not new in the second.
    const firstIds = new Set((first.cards as Card[]).map((c) => c.id));
    for (const c of second.cards as Card[]) if (firstIds.has(c.id)) expect(c.isNew).toBe(false);
    expect((await post('/v1/chat/trial', { star: 'alice', text: 'はじめまして' }, dev)).statusCode).toBe(200);

    await post('/v1/auth/otp/start', { email: 'new@example.com' }, dev);
    const { token } = json(await post('/v1/auth/otp/verify', { email: 'new@example.com', code: '123456' }, dev));
    const h = { authorization: `Bearer ${token}` };
    const m = await me(h);
    expect(sumCopies(m.owned)).toBe(12);
    expect(new Set(m.owned.map((o: { cardId: string }) => o.cardId))).toEqual(new Set([...first.cards, ...second.cards].map((c: Card) => c.id)));
    expect(Date.parse(m.chat.passUntil)).toBeGreaterThan(Date.now() + 13 * 86_400_000);
    expect(m.serialsRedeemed).toBe(2);
    expect(m.wallet.points).toBe(RULES.welcomePoints + 2 * RULES.serialPoints);
    const dupes = 12 - m.owned.length;
    expect(Object.values(m.affinity as Record<string, number>).reduce((n, x) => n + x, 0)).toBe(dupes * RULES.lucky.duplicateBondXp);
    const history = json(await app.inject({ url: '/v1/chat/history?star=alice', headers: h }));
    expect(history.messages.map((x: { text: string }) => x.text)).toEqual(['はじめまして', 'echo:はじめまして']);
    expect(json(await app.inject({ url: '/v1/device', headers: dev }))).toMatchObject({ cards: [], pendingPassDays: 0 });
    // The draw logs follow the codes into the account.
    const userId = (await repos.users.byEmail('new@example.com'))!.id;
    expect((await repos.draws.forOwner(userId, 10)).map((d) => d.serialId).sort()).toEqual(['demo-0001', 'demo-0002']);

    // Signing in again from the same device claims nothing twice.
    await post('/v1/auth/otp/start', { email: 'new@example.com' }, dev);
    await post('/v1/auth/otp/verify', { email: 'new@example.com', code: '123456' }, dev);
    expect(sumCopies((await me(h)).owned)).toBe(12);
    expect((await me(h)).wallet.points).toBe(RULES.welcomePoints + 2 * RULES.serialPoints);
  });

  it('lists redeemed codes with their cards, including codes claimed from the device', async () => {
    const dev = { 'x-device-id': 'device-hist-1' };
    await post('/v1/serial/redeem', { code: DEMO_SERIALS[0] }, dev);
    await post('/v1/auth/otp/start', { email: 'hist@example.com' }, dev);
    const { token } = json(await post('/v1/auth/otp/verify', { email: 'hist@example.com', code: '123456' }, dev));
    const h = { authorization: `Bearer ${token}` };
    await post('/v1/serial/redeem', { code: DEMO_SERIALS[1] }, h);
    const { redemptions } = json(await app.inject({ url: '/v1/serial/history', headers: h }));
    expect(redemptions.map((r: { serialId: string }) => r.serialId)).toEqual(['demo-0002', 'demo-0001']);
    expect(redemptions[0].cards).toHaveLength(6);
    expect(RARITY_ORDER[redemptions[1].cards[0].rarity as 'SR']).toBeGreaterThanOrEqual(RARITY_ORDER.SR);
    expect((await app.inject({ url: '/v1/serial/history' })).statusCode).toBe(401);
  });

  it('records the birthday once, closes an under-18 account, and deletes an account on request', async () => {
    const { user, h } = await userWith();
    expect((await me(h)).birthdayConfirmed).toBe(false);
    expect((await post('/v1/auth/me/birthday', { birthday: '2001-02-30' }, h)).statusCode).toBe(400);
    const ok = await post('/v1/auth/me/birthday', { birthday: '1999-04-01' }, h);
    expect(ok.statusCode).toBe(200);
    expect(json(ok).birthdayConfirmed).toBe(true);
    expect((await post('/v1/auth/me/birthday', { birthday: '1990-01-01' }, h)).statusCode).toBe(409);

    const minor = await userWith();
    const young = new Date(Date.now() - 17 * 365.25 * 86_400_000).toISOString().slice(0, 10);
    expect((await post('/v1/auth/me/birthday', { birthday: young }, minor.h)).statusCode).toBe(403);
    expect((await app.inject({ url: '/v1/auth/me', headers: minor.h })).statusCode).toBe(401);
    // M7: the same address cannot sign up again for RULES.underageCooldownDays; only a keyed hash of it is kept.
    const minorEmail = minor.user.email!;
    // B-N5: refused at /otp/start already (no code is sent), with the same 403 /otp/verify gives for a code sent before.
    await repos.otp.put(minorEmail, '123456', Date.now() + 60_000);
    const refused = await post('/v1/auth/otp/start', { email: minorEmail.toUpperCase() });
    expect([refused.statusCode, json(refused).error]).toEqual([403, 'signup_cooldown']);
    const again = await post('/v1/auth/otp/verify', { email: minorEmail, code: '123456' });
    expect([again.statusCode, json(again).error]).toEqual([403, 'signup_cooldown']);
    expect(await repos.users.byEmail(minorEmail)).toBeNull();
    const hash = signupBlockHash(minorEmail, env.JWT_SECRET);
    expect(hash).not.toContain(minorEmail.split('@')[0]);
    const until = await repos.signupBlocks.until(hash, new Date().toISOString());
    expect(Date.parse(until!) - Date.now()).toBeGreaterThan((RULES.underageCooldownDays - 1) * 86_400_000);
    // After the cooldown the address may sign up again; other addresses never wait.
    expect(await repos.signupBlocks.until(hash, new Date(Date.now() + (RULES.underageCooldownDays + 1) * 86_400_000).toISOString())).toBeNull();
    await post('/v1/auth/otp/start', { email: 'other-adult@example.com' });
    expect((await post('/v1/auth/otp/verify', { email: 'other-adult@example.com', code: '123456' })).statusCode).toBe(200);

    expect((await app.inject({ method: 'DELETE', url: '/v1/auth/me', headers: h, payload: { confirm: 'yes' } })).statusCode).toBe(400);
    expect((await app.inject({ method: 'DELETE', url: '/v1/auth/me', headers: h, payload: { confirm: 'DELETE' } })).statusCode).toBe(200);
    expect((await app.inject({ url: '/v1/auth/me', headers: h })).statusCode).toBe(401);
    const gone = (await repos.users.byId(user.id))!;
    expect(gone).toMatchObject({ email: null, nickname: 'deleted', banned: true, birthday: null });
    expect(await repos.users.byEmail(user.email!)).toBeNull();
  });

  it('locks serial entry after repeated wrong codes', async () => {
    const dev = { 'x-device-id': 'device-guess-1' };
    for (let i = 0; i < RULES.serialMaxFailures; i++) expect((await post('/v1/serial/redeem', { code: unissued(i) }, dev)).statusCode).toBe(404);
    const locked = await post('/v1/serial/redeem', { code: DEMO_SERIALS[4] }, dev);
    expect(locked.statusCode).toBe(429);
    expect(json(locked).error).toBe('serial_locked');
  });

  it('keeps used demo codes used and seeds nothing twice across restarts', async () => {
    const { h } = await userWith();
    expect((await post('/v1/serial/redeem', { code: DEMO_SERIALS[0] }, h)).statusCode).toBe(200);
    app = await buildApp({ repos, logger: false, demo: true });
    expect((await post('/v1/serial/redeem', { code: DEMO_SERIALS[0] }, h)).statusCode).toBe(409);
    expect((await repos.cards.all())).toHaveLength(125);
  });

  it('draws only with points, uses free pulls, and never double-spends', async () => {
    const { h } = await userWith({ points: 1000, freePulls: 1 });
    const results = await Promise.all([post('/v1/gacha/draw', { count: 10 }, h), post('/v1/gacha/draw', { count: 10 }, h)]);
    // The loser fails either on points or on the pity counter the winner moved — never both succeed.
    expect(results.filter((r) => r.statusCode === 200)).toHaveLength(1);
    expect([402, 409]).toContain(results.find((r) => r.statusCode !== 200)!.statusCode);
    const ok = json(results.find((r) => r.statusCode === 200)!);
    expect(ok.cards).toHaveLength(10);
    expect(ok.cards.some((c: Card) => RARITY_ORDER[c.rarity] >= RARITY_ORDER.SR)).toBe(true);
    const firstShards = (ok.cards as Card[]).reduce((sum, card) => sum + (card.isNew ? 0 : RULES.duplicateShards[card.rarity]), 0);
    expect(ok.wallet).toMatchObject({ points: 0, freePulls: 1, shards: firstShards });
    expect((await post('/v1/gacha/draw', { count: 10 }, h)).statusCode).toBe(402);

    const free = await post('/v1/gacha/draw', { count: 1, useFreePull: true }, h);
    const freeResult = json(free);
    const freeGain = freeResult.cards[0].isNew ? 0 : RULES.duplicateShards[freeResult.cards[0].rarity as Card['rarity']];
    expect(freeResult.wallet).toMatchObject({ points: 0, freePulls: 0, shards: firstShards + freeGain });
    expect((await post('/v1/gacha/draw', { count: 1, useFreePull: true }, h)).statusCode).toBe(409);
  });

  it('charges the configured per-card cost for a six-card draw', async () => {
    const { h } = await userWith({ points: RULES.pullCost * 6, freePulls: 0 });
    const result = json(await post('/v1/gacha/draw', { count: 6, pool: 'all' }, h));
    expect(result.cards).toHaveLength(6);
    const gained = (result.cards as Card[]).reduce((sum, card) => sum + (card.isNew ? 0 : RULES.duplicateShards[card.rarity]), 0);
    expect(result.wallet).toMatchObject({ points: 0, freePulls: 0, shards: gained });
    expect((await post('/v1/gacha/draw', { count: 1, pool: 'all' }, h)).statusCode).toBe(402);
  });

  it('her room asks for his next words: short, not his own, at most 3; her chat does not (QA #4)', async () => {
    const { h } = await userWith();
    const room = json(await post('/v1/chat/send', { star: 'nana', text: 'Sure', suggest: true }, h));
    expect(room.replies).toEqual(['Tell me more', 'And you?', 'Fourth']);
    expect(agent.inputs.at(-1)).toMatchObject({ suggest: true });
    const chat = json(await post('/v1/chat/send', { star: 'nana', text: 'Sure' }, h));
    expect(chat.replies).toBeUndefined();
    expect(agent.inputs.at(-1)!.suggest).toBeUndefined();
  });

  it('enforces the daily chat allowance and refunds blocked messages', async () => {
    const { h } = await userWith();
    const first = json(await post('/v1/chat/send', { star: 'nana', text: 'hi' }, h));
    expect(first.chatLeft).toBe(RULES.dailyFreeMessages - 1);
    const blocked = await post('/v1/chat/send', { star: 'nana', text: 'BLOCK' }, h);
    expect(blocked.statusCode).toBe(422);
    let last = first;
    for (let i = 1; i < RULES.dailyFreeMessages; i++) last = json(await post('/v1/chat/send', { star: 'nana', text: `m${i}` }, h));
    expect(last.chatLeft).toBe(0);
    const over = await post('/v1/chat/send', { star: 'nana', text: 'one more' }, h);
    expect(over.statusCode).toBe(402);
    expect(json(over).error).toBe('daily_limit');
  });

  it('grants a memory card every third message, and no longer a free pull per level (#54: per stage instead)', async () => {
    const { h } = await userWith({ freePulls: 0 });
    const res = [];
    for (let i = 0; i < 5; i++) res.push(json(await post('/v1/chat/send', { star: 'eimi', text: `hello ${i}` }, h)));
    // The title is the agent's summary of the moment, never the user's own words.
    expect(res[2].memoryCard?.title).toBe('夜のおしゃべり');
    expect(res[0].memoryCard).toBeNull();
    expect(res[4].level).toBe(2); // 5 × 8 xp = 40
    expect(res[4].freePulls).toBe(0);
    expect(res[4].relationship).toMatchObject({ star: 'eimi', stage: 'new', daysTogether: 1, hint: 'both' });
  });

  it('pays login points once a JST day, and check-in rewards on day 7', async () => {
    const { user, h } = await userWith({ points: 0 });
    const me1 = await me(h);
    expect(me1.dailyBonus).toBe(RULES.dailyLoginPoints);
    expect(me1.checkIn).toMatchObject({ days: 1, claimed: [] });
    expect((await me(h)).dailyBonus).toBe(0);
    // Six earlier login days this month: the next visit is day 7 and pays the day-7 reward once.
    await repos.users.update(user.id, {});
    const month = me1.checkIn.month;
    await repos.users.dailyLogin(user.id, '1999-01-01', month, 0);
    for (let d = 2; d <= 6; d++) await repos.users.dailyLogin(user.id, `1999-01-0${d}`, month, 0);
    const before = (await repos.users.byId(user.id))!;
    expect(before.checkDays).toBe(7);
    const me2 = await me(h);
    expect(me2.checkIn.claimed).toEqual([7]);
    expect(me2.wallet.freePulls).toBe(before.freePulls + 1);
    expect((await me(h)).checkIn.claimed).toEqual([7]);
  });

  it('new players start with a ten-pull of points; the demo shop adds a configured pack', async () => {
    const { h } = await userWith();
    expect((await me(h)).wallet.points).toBe(RULES.welcomePoints + RULES.dailyLoginPoints);
    expect((await post('/v1/shop/points', { points: 500 }, h)).statusCode).toBe(200);
    expect((await me(h)).wallet.points).toBe(RULES.welcomePoints + RULES.dailyLoginPoints + 500);
    expect((await post('/v1/shop/pass', {}, h)).statusCode).toBe(404);
  });

  it('a pass from a printed code removes the chat limit', async () => {
    const { h } = await userWith();
    expect((await post('/v1/serial/redeem', { code: DEMO_SERIALS[4] }, h)).statusCode).toBe(200);
    expect((await me(h)).chat.left).toBeNull();
    expect(json(await post('/v1/chat/send', { star: 'nana', text: 'hi' }, h)).chatLeft).toBeNull();
  });

  it('guarantees SSR or better by the pity pull and carries the counter across pools', async () => {
    const { user, h } = await userWith({ points: 100_000, pity: RULES.pityPulls - 1 });
    const res = json(await post('/v1/gacha/draw', { count: 1, pool: 'star:alice' }, h));
    expect(RARITY_ORDER[(res.cards[0] as Card).rarity]).toBeGreaterThanOrEqual(RARITY_ORDER.SSR);
    expect(res.cards[0].star).toBe('alice');
    expect(res.wallet.pity).toBe(0);
    const next = json(await post('/v1/gacha/draw', { count: 10, pool: 'all' }, h));
    expect(next.wallet.pity).toBeLessThanOrEqual(10);
    expect((await repos.users.byId(user.id))!.pity).toBe(next.wallet.pity);
  });

  it('a single-talent pool only gives her cards', async () => {
    const { h } = await userWith({ points: 100_000 });
    for (let i = 0; i < 5; i++) {
      const res = json(await post('/v1/gacha/draw', { count: 10, pool: 'star:eimi' }, h));
      for (const c of res.cards as Card[]) expect(c.star).toBe('eimi');
    }
    expect((await post('/v1/gacha/draw', { count: 1, pool: 'star:nobody' }, h)).statusCode).toBe(400);
  });

  it('exchanges the rarity-specific shard cost and never drops below zero', async () => {
    const card = SEED_CARDS.find((c) => c.rarity === 'R')!;
    const cost = RULES.exchangeShards.R;
    const { h } = await userWith({ shards: cost });
    const both = await Promise.all([post('/v1/gacha/exchange', { cardId: card.id }, h), post('/v1/gacha/exchange', { cardId: card.id }, h)]);
    expect(both.map((r) => r.statusCode).sort()).toEqual([200, 402]);
    const ok = json(both.find((r) => r.statusCode === 200)!);
    expect(ok.card.id).toBe(card.id);
    expect(ok.wallet.shards).toBe(0);
    expect((await me(h)).owned.map((o: { cardId: string }) => o.cardId)).toContain(card.id);
  });

  it('lists the draw history newest first and publishes the rates', async () => {
    const { h } = await userWith({ points: 10_000 });
    await post('/v1/gacha/draw', { count: 1 }, h);
    await post('/v1/gacha/draw', { count: 10, pool: 'star:nana' }, h);
    const hist = json(await app.inject({ url: '/v1/gacha/history', headers: h })).draws;
    expect(hist).toHaveLength(2);
    expect(hist[0].pool).toBe('star:nana');
    expect(hist[0].cards).toHaveLength(10);
    const rates = json(await app.inject({ url: '/v1/gacha/rates' }));
    const all = rates.pools.find((p: { id: string }) => p.id === 'all');
    expect(all.rows.find((r: { tier: string }) => r.tier === 'UR')).toMatchObject({ rate: 0.005, cards: 5 });
    expect(all.effectiveTopRate).toBeGreaterThan(RULES.rates.SSR + RULES.rates.UR);
    expect(rates.pools).toHaveLength(6);
  });

  it('refuses the shared device id browsers without storage used to send', async () => {
    expect((await post('/v1/serial/redeem', { code: DEMO_SERIALS[3] }, { 'x-device-id': 'ephemeral' })).statusCode).toBe(400);
  });

  it('keeps admin endpoints behind the admin role and audits changes', async () => {
    const { h: userH } = await userWith();
    const { h: adminH } = await userWith({ role: 'admin' });
    expect((await app.inject({ method: 'GET', url: '/v1/admin/cards', headers: userH })).statusCode).toBe(403);

    const batch = await post('/v1/admin/serial-batches', { label: 'event', quantity: 3, trialDays: 3, draws: 2 }, adminH);
    expect(batch.statusCode).toBe(200);
    const codes: string[] = json(batch).codes;
    expect(codes).toHaveLength(3);
    for (const c of codes) expect(isValidSerialFormat(c)).toBe(true);
    const redeemed = json(await post('/v1/serial/redeem', { code: codes[0] }, userH));
    expect(redeemed.cards).toHaveLength(2);
    expect(redeemed.trialDays).toBe(3);
    expect((await post('/v1/admin/serial-batches', { label: 'x', quantity: 0 }, adminH)).statusCode).toBe(400);


    const audit = json(await app.inject({ method: 'GET', url: '/v1/admin/audit', headers: adminH }));
    expect(audit.entries.some((e: { action: string }) => e.action === 'serial.batch')).toBe(true);
  });

  it('lets support look up a user and a code, compensate, and void an unused code', async () => {
    const { user, h: userH } = await userWith();
    const { h: adminH } = await userWith({ role: 'admin' });
    const codes: string[] = json(await post('/v1/admin/serial-batches', { label: 'support', quantity: 2, trialDays: 7, draws: 6 }, adminH)).codes;
    await post('/v1/serial/redeem', { code: codes[0] }, userH);

    expect((await app.inject({ url: `/v1/admin/users?email=${user.email}`, headers: userH })).statusCode).toBe(403);
    const found = json(await app.inject({ url: `/v1/admin/users?email=${encodeURIComponent(user.email!.toUpperCase())}`, headers: adminH }));
    expect(found.user.id).toBe(user.id);
    expect(found.codes).toHaveLength(1);
    expect((await app.inject({ url: '/v1/admin/users?email=nobody@example.com', headers: adminH })).statusCode).toBe(404);

    expect((await post(`/v1/admin/users/${user.id}/grant`, { points: 0, reason: 'x x' }, adminH)).statusCode).toBe(400);
    const granted = json(await post(`/v1/admin/users/${user.id}/grant`, { points: 500, freePulls: 1, reason: 'outage 9/25' }, adminH));
    expect(granted).toEqual({ points: user.points + 500, freePulls: user.freePulls + 1 });

    const used = json(await app.inject({ url: `/v1/admin/serials?code=${codes[0]}`, headers: adminH }));
    expect(used).toMatchObject({ status: 'redeemed', redeemedByUserId: user.id });
    const unused = json(await app.inject({ url: `/v1/admin/serials?code=${codes[1]}`, headers: adminH }));
    expect(unused.status).toBe('unused');
    expect((await post(`/v1/admin/serials/${used.id}/void`, { reason: 'test' }, adminH)).statusCode).toBe(409);
    expect((await post(`/v1/admin/serials/${unused.id}/void`, { reason: 'leaked photo' }, adminH)).statusCode).toBe(200);
    expect(json(await app.inject({ url: `/v1/admin/serials?id=${unused.id}`, headers: adminH })).status).toBe('void');
    expect((await post('/v1/serial/redeem', { code: codes[1] }, userH)).statusCode).toBe(409);
    const audit = json(await app.inject({ url: '/v1/admin/audit', headers: adminH })).entries.map((e: { action: string }) => e.action);
    expect(audit).toEqual(expect.arrayContaining(['user.grant', 'serial.void']));
  });

  it('enforces the visitor trial allowance on the server', async () => {
    const headers = { 'x-device-id': 'device-123' };
    for (let i = 0; i < RULES.trialMessages; i++) {
      const res = await post('/v1/chat/trial', { star: 'mahiro', text: 'hi', lang: 'ja' }, headers);
      expect(res.statusCode).toBe(200);
      expect(json(res).trialMessagesLeft).toBe(RULES.trialMessages - 1 - i);
    }
    expect((await post('/v1/chat/trial', { star: 'mahiro', text: 'hi', lang: 'ja' }, headers)).statusCode).toBe(402);
  });

  it('rejects malformed payloads', async () => {
    const res = await post('/v1/chat/trial', { star: 'not-a-star', text: '' }, { 'x-device-id': 'device-d2' });
    expect(res.statusCode).toBe(400);
    expect(json(res).error).toBe('invalid_request');
  });

  // ---------------------------------------------------------------- AI chat (#20)

  /** NDJSON body → events. */
  const events = (res: { payload: string }) => res.payload.trim().split('\n').map((l) => JSON.parse(l) as { type: string; text?: string; result?: Record<string, unknown>; error?: string });

  it('streams a reply as NDJSON and stores the turn exactly like the plain route', async () => {
    const { h } = await userWith();
    const res = await post('/v1/chat/send/stream', { star: 'nana', text: 'こんばんは' }, h);
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('application/x-ndjson');
    const evs = events(res);
    const deltas = evs.filter((e) => e.type === 'delta');
    expect(deltas.length).toBeGreaterThan(1);
    const done = evs.at(-1)!;
    expect(done.type).toBe('done');
    expect(deltas.map((e) => e.text).join('')).toBe(done.result!.reply);
    expect(done.result).toMatchObject({ reply: 'echo:こんばんは', chatLeft: RULES.dailyFreeMessages - 1, affinityXp: RULES.xpPerMessage });
    const history = json(await app.inject({ url: '/v1/chat/history?star=nana', headers: h }));
    expect(history.messages.map((m: { text: string }) => m.text)).toEqual(['こんばんは', 'echo:こんばんは']);
  });

  it('answers a blocked or unreachable streamed turn with a plain error and gives the message back', async () => {
    const { h } = await userWith();
    const blocked = await post('/v1/chat/send/stream', { star: 'nana', text: 'BLOCK' }, h);
    expect(blocked.statusCode).toBe(422);
    expect(json(blocked).error).toBe('minor');
    const down = await post('/v1/chat/send/stream', { star: 'nana', text: 'DOWN' }, h);
    expect(down.statusCode).toBe(503);
    expect((await me(h)).chat.left).toBe(RULES.dailyFreeMessages);
    expect(json(await app.inject({ url: '/v1/chat/history?star=nana', headers: h })).messages).toEqual([]);
  });

  it('records hard-blocked messages for moderation with a short excerpt only', async () => {
    const { user, h } = await userWith();
    await post('/v1/chat/send', { star: 'nana', text: 'BLOCK' }, h);
    await post('/v1/chat/trial/stream', { star: 'alice', text: 'BLOCK' }, { 'x-device-id': 'device-audit-1' });
    const entries = (await repos.audit.recent(10)).filter((a) => a.action === 'chat.blocked');
    expect(entries.map((a) => [a.actorId, a.meta])).toEqual([
      [user.id, { star: 'nana', reason: 'minor', excerpt: 'BLOCK' }],
      ['device:device-audit-1', { star: 'alice', reason: 'minor', excerpt: 'BLOCK' }]
    ]);
    // Ordinary turns leave no trace there.
    await post('/v1/chat/send', { star: 'nana', text: 'hi' }, h);
    expect((await repos.audit.recent(10)).filter((a) => a.action === 'chat.blocked')).toHaveLength(2);
    // Admins read them as the moderation queue, newest first; nobody else can.
    const { h: adminH } = await userWith({ role: 'admin' });
    expect((await app.inject({ url: '/v1/admin/moderation', headers: h })).statusCode).toBe(403);
    const queue = json(await app.inject({ url: '/v1/admin/moderation', headers: adminH })).entries;
    expect(queue.map((e: { meta: { star: string } }) => e.meta.star)).toEqual(['alice', 'nana']);
  });

  it('keeps what she already said when the stream breaks off mid-reply', async () => {
    const { h } = await userWith();
    const evs = events(await post('/v1/chat/send/stream', { star: 'mahiro', text: 'BREAK' }, h));
    expect(evs.at(-1)).toMatchObject({ type: 'done', result: { reply: 'half said' } });
    expect((await me(h)).chat.left).toBe(RULES.dailyFreeMessages - 1);
  });

  it('keeps the turns memory has not taken in, sends them back, and lets them go once it has (batched memory)', async () => {
    const { user, h } = await userWith();
    agent.inputs.length = 0;
    for (const text of ['a', 'b', 'c', 'd']) await post('/v1/chat/send', { star: 'mahiro', text }, h);
    expect(agent.inputs.map((i) => (i.unsaved as unknown[]).length)).toEqual([0, 2, 4, 6]);
    expect(agent.inputs[3]).toMatchObject({ memoryMode: 'batch', unsaved: [{ role: 'user', text: 'a' }, { role: 'assistant', text: 'echo:a' }, { role: 'user', text: 'b' },
      { role: 'assistant', text: 'echo:b' }, { role: 'user', text: 'c' }, { role: 'assistant', text: 'echo:c' }] });
    const waiting = await repos.chatMemory.get(user.id, 'mahiro');
    expect(waiting?.pending.map((t) => t.text)).toEqual(['a', 'echo:a', 'b', 'echo:b', 'c', 'echo:c', 'd', 'echo:d']);
    expect(waiting?.pendingAt).toBeTruthy();
    // His 5th: every one of them goes into memory, and the buffer empties.
    await post('/v1/chat/send/stream', { star: 'mahiro', text: 'e' }, h);
    const saved = await repos.chatMemory.get(user.id, 'mahiro');
    expect(saved).toMatchObject({ summary: 'heard: a / b / c / d / e', pending: [], pendingAt: null });
    // A reply that broke off never reached memory: it waits with the next ones.
    await post('/v1/chat/send/stream', { star: 'mahiro', text: 'BREAK' }, h);
    expect((await repos.chatMemory.get(user.id, 'mahiro'))?.pending.map((t) => [t.role, t.text])).toEqual([['user', 'BREAK'], ['assistant', 'half said']]);
    // A visitor's trial keeps no memory, so it asks for none.
    agent.inputs.length = 0;
    await post('/v1/chat/trial', { star: 'alice', text: 'hi' }, { 'x-device-id': 'device-memory-off' });
    expect(agent.inputs[0]).toMatchObject({ memoryMode: 'off' });
  });

  it('streams the visitor trial and counts the device allowance', async () => {
    const dev = { 'x-device-id': 'device-stream-1' };
    const evs = events(await post('/v1/chat/trial/stream', { star: 'alice', text: 'hi', lang: 'en' }, dev));
    expect(evs.at(-1)).toMatchObject({ type: 'done', result: { reply: 'echo:hi', trialMessagesLeft: RULES.trialMessages - 1 } });
    expect((await post('/v1/chat/trial/stream', { star: 'alice', text: 'BLOCK' }, dev)).statusCode).toBe(422);
    expect(json(await app.inject({ url: '/v1/device', headers: dev })).trialLeft).toBe(RULES.trialMessages - 1);
  });

  it('persists the memory the agent returns and hands it back on the next turn, per talent', async () => {
    const { user, h } = await userWith();
    await post('/v1/chat/send', { star: 'eimi', text: 'my name is Kenta' }, h);
    expect(await repos.chatMemory.get(user.id, 'eimi')).toMatchObject({ facts: { name: 'Kenta' }, summary: 'He is Kenta.' });
    agent.inputs.length = 0;
    await post('/v1/chat/send/stream', { star: 'eimi', text: '覚えてる？' }, h);
    expect(agent.inputs[0]).toMatchObject({ memory: { facts: { name: 'Kenta' }, summary: 'He is Kenta.' }, level: 1 });
    // Round 10: the account nickname (an e-mail account's handle) is never sent to her as his name.
    expect(agent.inputs[0]).not.toHaveProperty('nickname');
    // A turn that changes nothing leaves the memory as it was; another talent starts from nothing.
    expect((await repos.chatMemory.get(user.id, 'eimi'))?.facts).toEqual({ name: 'Kenta' });
    agent.inputs.length = 0;
    await post('/v1/chat/send', { star: 'nana', text: 'hi' }, h);
    expect(agent.inputs[0]).toMatchObject({ memory: null });
    // Account deletion removes what she remembered about him.
    await repos.users.anonymise(user.id, new Date().toISOString());
    expect(await repos.chatMemory.get(user.id, 'eimi')).toBeNull();
  });

  it('never makes a memory card of a self-harm turn', async () => {
    const { h } = await userWith();
    const r1 = json(await post('/v1/chat/send', { star: 'unpai', text: 'a' }, h));
    const r2 = json(await post('/v1/chat/send', { star: 'unpai', text: 'b' }, h));
    const r3 = json(await post('/v1/chat/send', { star: 'unpai', text: 'SELFHARM' }, h));
    expect([r1.memoryCard, r2.memoryCard, r3.memoryCard]).toEqual([null, null, null]);
    expect((await me(h)).memories).toEqual([]);
    for (const t of ['d', 'e']) await post('/v1/chat/send', { star: 'unpai', text: t }, h);
    const r6 = json(await post('/v1/chat/send/stream', { star: 'unpai', text: 'f' }, h).then((r) => ({ payload: JSON.stringify(events(r).at(-1)!.result) })));
    expect(r6.memoryCard?.title).toBe('夜のおしゃべり');
  });

  it('his lines are kept and returned by history, even when her memory bookkeeping fails (N-50)', async () => {
    const { user, h } = await userWith();
    const addPending = repos.chatMemory.addPending;
    const save = repos.chatMemory.save;
    repos.chatMemory.addPending = async () => { throw new Error('d1: json_insert'); };
    repos.chatMemory.save = async () => { throw new Error('d1: busy'); };
    try {
      for (const text of ['ただいま', 'my name is Kenta', 'また明日']) {
        const res = await post('/v1/chat/send/stream', { star: 'nana', text }, h);
        expect(res.statusCode, res.payload).toBe(200);
        expect(events(res).at(-1)).toMatchObject({ type: 'done' });
      }
    } finally { repos.chatMemory.addPending = addPending; repos.chatMemory.save = save; }
    const hist = json(await app.inject({ url: '/v1/chat/history?star=nana', headers: h })).messages as { role: string; text: string }[];
    expect(hist.filter((m) => m.role === 'user').map((m) => m.text)).toEqual(['ただいま', 'my name is Kenta', 'また明日']);
    expect(hist.filter((m) => m.role === 'assistant')).toHaveLength(3);
    expect((await repos.messages.recent(user.id, 'nana', 10)).filter((m) => m.role === 'user')).toHaveLength(3);
  });

  it('greets from time since the last visit and affinity, once per day', async () => {
    // A JST evening: nobody is asleep (#60), so every talent greets with the model's line.
    vi.useFakeTimers({ toFake: ['Date'], now: Date.parse('2026-10-14T11:00:00Z') });
    onTestFinished(() => { vi.useRealTimers(); });
    const { user, h } = await userWith({ lang: 'zh-Hant' });
    agent.greetings.length = 0;
    const first = json(await app.inject({ url: '/v1/chat/greeting?star=alice', headers: h }));
    expect(first).toEqual({ text: 'greet:alice:null:1', cached: false });
    expect(agent.greetings[0]).toMatchObject({ lang: 'zh-Hant', daysSince: null });
    expect(json(await app.inject({ url: '/v1/chat/greeting?star=alice', headers: h }))).toEqual({ text: 'greet:alice:null:1', cached: true });
    expect(agent.greetings).toHaveLength(1);

    const threeDaysAgo = new Date(Date.now() - 3 * 86_400_000).toISOString();
    await repos.messages.add({ id: 'old-1', ownerId: user.id, star: 'mahiro', role: 'user', text: 'x', createdAt: threeDaysAgo });
    await repos.affinity.add(user.id, 'mahiro', RULES.xpPerLevel * 2);
    await repos.chatMemory.save(user.id, 'mahiro', { call_name: 'ケンちゃん' }, null);
    expect(json(await app.inject({ url: '/v1/chat/greeting?star=mahiro&lang=ja', headers: h })).text).toBe('greet:mahiro:3:3');
    expect(agent.greetings[1]).toMatchObject({ memory: { facts: { call_name: 'ケンちゃん' } } });
    // The cached greeting does not disturb the memory, and saving memory keeps the greeting.
    await repos.chatMemory.save(user.id, 'mahiro', { call_name: 'ケンタ' }, 'summary');
    expect(await repos.chatMemory.get(user.id, 'mahiro')).toMatchObject({ facts: { call_name: 'ケンタ' }, summary: 'summary', greeting: { lang: 'ja@evening~sky-unknown', text: 'greet:mahiro:3:3' } });
    expect((await app.inject({ url: '/v1/chat/greeting?star=mahiro' })).statusCode).toBe(401);
  });

  it('the model is off his room\'s hot path: her written line at once, the model\'s cached for next time (N-39)', async () => {
    vi.useFakeTimers({ toFake: ['Date'], now: Date.parse('2026-10-14T11:00:00Z') });
    process.env.GREETING_WAIT_MS = '50';
    onTestFinished(() => { vi.useRealTimers(); delete process.env.GREETING_WAIT_MS; agent.slow = null; });
    const { user, h } = await userWith({ lang: 'en' });
    let release: () => void = () => undefined;
    agent.slow = new Promise<void>((r) => { release = r; });
    agent.next = 'Hi again — I kept the lamp on.';
    const t0 = performance.now();
    const first = json(await app.inject({ url: '/v1/chat/greeting?star=mahiro&lang=en', headers: h }));
    expect(performance.now() - t0).toBeLessThan(1_000);
    expect(first).toEqual({ text: GREETING_LINES.mahiro.en.first, cached: false });
    // The model answers later; its line is kept, and his next visit is served from the cache without asking again.
    release();
    await vi.waitFor(async () => expect((await repos.chatMemory.get(user.id, 'mahiro'))?.greeting?.text).toBe('Hi again — I kept the lamp on.'));
    const asked = agent.greetings.length;
    expect(json(await app.inject({ url: '/v1/chat/greeting?star=mahiro&lang=en', headers: h }))).toEqual({ text: 'Hi again — I kept the lamp on.', cached: true });
    expect(agent.greetings.length).toBe(asked);
  });

  it('her written greeting at the deadline fits their days together — never 「はじめまして」 after three days (N-57)', async () => {
    vi.useFakeTimers({ toFake: ['Date'], now: Date.parse('2026-10-14T11:00:00Z') });
    process.env.GREETING_WAIT_MS = '30';
    onTestFinished(() => { vi.useRealTimers(); delete process.env.GREETING_WAIT_MS; agent.slow = null; });
    const { user, h } = await userWith({ lang: 'ja' });
    // Three days together from scenes and her lines, not one chat message of his.
    for (const day of ['2026-10-12', '2026-10-13', '2026-10-14']) await repos.relationship.touch(user.id, 'mahiro', day, `${day}T03:00:00.000Z`);
    agent.slow = new Promise<void>(() => undefined);
    const res = json(await app.inject({ url: '/v1/chat/greeting?star=mahiro&lang=ja', headers: h }));
    expect(res.cached).toBe(false);
    expect(res.text).not.toMatch(/はじめまして/);
  });

  it('the greeting route\'s deadline leaves room for the client under 3 s (N-39: p95 was 3.15 s at 2.8 s)', async () => {
    const { GREETING_TOTAL_MS } = await import('../src/modules/chat');
    expect(GREETING_TOTAL_MS).toBeLessThanOrEqual(2_300);
  });

  it('answers within its deadline even when her room\'s reads are slow, with her written greeting (N-39)', async () => {
    vi.useFakeTimers({ toFake: ['Date'], now: Date.parse('2026-10-14T11:00:00Z') });
    process.env.GREETING_TOTAL_MS = '300';
    const get = repos.chatMemory.get;
    repos.chatMemory.get = async (...a) => { await new Promise((r) => setTimeout(r, 1_500)); return get.apply(repos.chatMemory, a); };
    onTestFinished(() => { vi.useRealTimers(); delete process.env.GREETING_TOTAL_MS; repos.chatMemory.get = get; });
    const { h } = await userWith({ lang: 'ko' });
    const t0 = performance.now();
    const res = await app.inject({ url: '/v1/chat/greeting?star=mahiro&lang=ko', headers: h });
    expect(performance.now() - t0).toBeLessThan(1_200);
    expect(res.statusCode).toBe(200);
    expect(json(res).text).toMatch(/[\uac00-\ud7a3]/);
  });

  it('never calls him by his e-mail handle: it is not sent, and a greeting with it is asked for again (round 10)', async () => {
    vi.useFakeTimers({ toFake: ['Date'], now: Date.parse('2026-10-14T11:00:00Z') });
    onTestFinished(() => { vi.useRealTimers(); });
    const { h } = await userWith({ lang: 'en', email: 'qa+nest-r9-en@example.com', nickname: 'qanest-r9-en' });
    agent.greetings.length = 0;
    agent.queue = ['Welcome back, qanest-r9-en!', 'Welcome back. I missed you.'];
    expect(json(await app.inject({ url: '/v1/chat/greeting?star=mahiro&lang=en', headers: h })).text).toBe('Welcome back. I missed you.');
    expect(agent.greetings[0]).not.toHaveProperty('nickname');
    expect(agent.greetings[0].callName ?? null).toBeNull();
    agent.queue = ['「qa+nest-r9-enさん」、おかえり。', 'qanest-r9-en、おかえり。'];
    const written = json(await app.inject({ url: '/v1/chat/greeting?star=nana&lang=ja', headers: h })).text as string;
    expect(written).not.toMatch(/qa|nest/);
  });

  it('after they talked or made a promise, her greeting is never 「はじめまして」 — cached or new (round 12)', async () => {
    vi.useFakeTimers({ toFake: ['Date'], now: Date.parse('2026-10-14T11:00:00Z') });
    onTestFinished(() => { vi.useRealTimers(); });
    const { user, h } = await userWith();
    const greet = async () => json(await app.inject({ url: '/v1/chat/greeting?star=mahiro&lang=ja', headers: h }));
    agent.greetings.length = 0;
    agent.next = 'はじめまして、だよね。';
    expect((await greet()).text).toBe('はじめまして、だよね。');
    expect(agent.greetings[0].daysSince).toBeNull();
    // They make a promise (no message of his kept yet): the first-meeting line is not reused, and she is not told it is one.
    await repos.promises.create({ id: 'prm_first', userId: user.id, star: 'mahiro', text: '夜9時、ここで待ってる', dueAt: '2026-10-15T12:00:00.000Z', kind: 'free',
      status: 'open', source: 'chat', madeAt: '2026-10-14T10:59:00.000Z', keptAt: null, sourceMsgId: null, sceneId: null, lang: 'ja', notifiedAt: null,
      missedAt: null, mentionedAt: null });
    agent.next = 'おかえり、また来てくれたね。';
    expect(await greet()).toEqual({ text: 'おかえり、また来てくれたね。', cached: false });
    expect(agent.greetings[1].daysSince).toBe(1);
    // Her written greeting at that point is not her first-meeting one either.
    agent.fail = true;
    await repos.chatMemory.setGreeting(user.id, 'mahiro', { day: '2026-10-13', lang: 'x', text: 'old' });
    expect((await greet()).text).not.toMatch(/はじめまして/);
  });

  it('never shows a greeting that is not in his language, cached or new (N-05)', async () => {
    vi.useFakeTimers({ toFake: ['Date'], now: Date.parse('2026-10-14T11:00:00Z') });
    onTestFinished(() => { vi.useRealTimers(); });
    const { user, h } = await userWith({ lang: 'en' });
    // A greeting cached before the fix, half Japanese: asked again, and the new one is kept.
    await repos.chatMemory.save(user.id, 'mahiro', { call_name: 'ケンタ' }, null);
    await repos.chatMemory.setGreeting(user.id, 'mahiro', { day: jstDay(), lang: 'en@evening', text: 'ふふ、ケンタさん……it\'s raining.' });
    agent.greetings.length = 0;
    expect(json(await app.inject({ url: '/v1/chat/greeting?star=mahiro&lang=en', headers: h }))).toEqual({ text: 'greet:mahiro:null:1', cached: false });
    expect(agent.greetings).toHaveLength(1);
    // N-19: one in Japanese is asked for once more, strictly; right the second time, that one is shown.
    agent.queue = ['おはよう、ケンタ。', 'Good evening. Welcome back.'];
    agent.greetings.length = 0;
    expect(json(await app.inject({ url: '/v1/chat/greeting?star=unpai&lang=en', headers: h })).text).toBe('Good evening. Welcome back.');
    expect(agent.greetings.map((g) => g.strict ?? false)).toEqual([false, true]);
    // Wrong twice: her written greeting in his language, 200, and nothing cached.
    agent.queue = ['おはよう、ケンタ。', 'こんばんは。'];
    const res = await app.inject({ url: '/v1/chat/greeting?star=nana&lang=en', headers: h });
    expect(res.statusCode).toBe(200);
    expect(json(res)).toEqual({ text: GREETING_LINES.nana.en.first, cached: false });
    expect((await repos.chatMemory.get(user.id, 'nana'))?.greeting ?? null).toBeNull();
    // The persona service down: the same, never a 503 (the zh-Hant 503 seen on the test site).
    agent.fail = true;
    const down = await app.inject({ url: '/v1/chat/greeting?star=eimi&lang=zh-Hant', headers: h });
    expect(down.statusCode).toBe(200);
    expect(json(down).text).toBe(GREETING_LINES.eimi['zh-Hant'].first); // round 11: えいみ's own, not まひろ's
    // N-36: in ko too — a timeout from the persona service, and a store that fails before it is even asked.
    agent.fail = true;
    const late = await app.inject({ url: '/v1/chat/greeting?star=unpai&lang=ko', headers: h });
    expect(late.statusCode).toBe(200);
    expect(json(late).text).toMatch(/[\uac00-\ud7a3]/);
    // N-38: 「おはよー！」 at 20:00 JST (the test's clock) is not shown, however many times it is said.
    agent.queue = ['おはよー！今日もがんばろ', 'おはよう、ケンタ。'];
    const morning = json(await app.inject({ url: '/v1/chat/greeting?star=mahiro&lang=ja', headers: h }));
    expect(morning.text).not.toMatch(/おはよ/);
    expect(morning.cached).toBe(false);
    const get = repos.chatMemory.get;
    repos.chatMemory.get = async () => { throw Object.assign(new Error('d1_unavailable'), { statusCode: 503 }); };
    try {
      const broken = await app.inject({ url: '/v1/chat/greeting?star=alice&lang=ko', headers: h });
      expect(broken.statusCode).toBe(200);
      expect(json(broken)).toEqual({ text: expect.stringMatching(/[\uac00-\ud7a3]/), cached: false });
    } finally { repos.chatMemory.get = get; }
    // N-55: in English his kana name is written in Latin letters — the kana one is not let through.
    await repos.chatMemory.save(user.id, 'alice', { call_name: 'ケンタ' }, null);
    agent.queue = ['Hi again, ケンタ.', 'Hi again, ケンタ.'];
    expect(json(await app.inject({ url: '/v1/chat/greeting?star=alice&lang=en', headers: h })).text).not.toMatch(/[\u30a1-\u30fa]/);
    agent.next = 'Hi again, Kenta.';
    expect(json(await app.inject({ url: '/v1/chat/greeting?star=eimi&lang=en', headers: h })).text).toBe('Hi again, Kenta.');
    // U-10: in zh-Hant it is his name as he stored it.
    await repos.chatMemory.save(user.id, 'nana', { call_name: 'ケンタ' }, null);
    agent.next = 'ケンタ，又見面了。';
    expect(json(await app.inject({ url: '/v1/chat/greeting?star=nana&lang=zh-Hant', headers: h })).text).toBe('ケンタ，又見面了。');
  });
});

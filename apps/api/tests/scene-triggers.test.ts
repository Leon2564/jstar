import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { SCENE_RULES, TRIGGER_RULES, jstDay } from '@jstar/shared';
import { MAIN_SCENES, sceneById } from '@jstar/shared/scenes';
import { signJwt } from '../src/lib/crypto';
import { createMemoryRepos } from '../src/db/memory';
import { createSqlRepos } from '../src/db/sql';
import { SEED_CARDS } from '../src/db/seed';
import type { Repos } from '../src/db/types';
import { newUserRow } from '../src/lib/account';
import { metBefore } from './met';
import { env } from '../src/env';
import { buildApp } from '../src/app';
import { createSqliteClient } from './sqlite';

/**
 * The persona service, faked by its contract (apps/agent tests cover the classifier itself). What each turn carried
 * in is kept in `seen`; the directive it answers with comes from the text: `START:<id>`, `OFFER:<id>`, `JUMP:<step>`,
 * `RAW` (a malformed directive).
 */
const seen: { scenes?: { id: string; ready: boolean; problems: string[] }[]; scene?: { id: string; step: string; jumps: { to: string }[] } }[] = [];
vi.mock('../src/lib/agent', () => {
  const directive = (text: string): unknown => {
    const [kind, arg] = text.split(':');
    if (kind === 'START') return { scene: arg, action: 'start' };
    if (kind === 'OFFER') return { scene: arg, action: 'offer' };
    if (kind === 'JUMP') return { jumpTo: arg };
    if (kind === 'RAW') return { scene: 'demo-evening', action: 'start', extra: 'x' };
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
const SCENE = 'demo-evening';
const NOW = Date.UTC(2026, 9, 1, 3); // 12:00 JST

let app: FastifyInstance;
let repos: Repos;

async function member() {
  const user = await repos.users.create({ ...newUserRow({ email: `${Math.random()}@example.com`, lineSub: null, nickname: 'u', via: 'email', lang: 'ja' }) });
  await metBefore(repos, user.id);
  return { user, h: { authorization: `Bearer ${signJwt({ sub: user.id }, env.JWT_SECRET, 7 * 86_400)}` } };
}
const json = (res: { payload: string }) => JSON.parse(res.payload);
const post = (url: string, payload: object, headers: Record<string, string>, on = app) => on.inject({ method: 'POST', url, headers, payload });
const room = async (h: Record<string, string>, extra: object = {}, on = app) => {
  const res = await post('/v1/scene/room', { star: 'mahiro', ...extra }, h, on);
  expect(res.statusCode, res.payload).toBe(200);
  return json(res).offer as { id: string; sceneId: string; source: string; star: string; expiresAt: string } | null;
};
const send = async (h: Record<string, string>, text: string, on = app) => {
  const res = await post('/v1/chat/send', { star: 'mahiro', text }, h, on);
  expect(res.statusCode, res.payload).toBe(200);
  return json(res);
};
const sources = async () => (await repos.events.metrics(jstDay(NOW - 86_400_000), jstDay(Date.now()), 'all'))[0]?.triggerSources ?? { request: 0, proposed: 0, time: 0 };
const at = (ms: number) => vi.setSystemTime(ms);
const dice = (v: number) => vi.spyOn(Math, 'random').mockReturnValue(v);

afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); seen.length = 0; });

describe.each(BACKENDS)('three ways a scene begins (%s store)', (_name, makeRepos) => {
  beforeEach(async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    at(NOW);
    repos = makeRepos();
    app = await buildApp({ repos, logger: false, demo: true });
  });

  describe('he asks (chat intent)', () => {
    it('lists only what may be offered, and starts the scene she agreed to', async () => {
      const { h } = await member();
      const r = await send(h, `START:${SCENE}`);
      // What production cannot play yet (clips pending) is listed on the test site too: her welcome-home (#66), locked
      // by day, and her variant scenes (#76), locked while he has not got her card.
      const all = seen[0].scenes ?? [];
      const [plain, variants] = [all.filter((s) => !s.id.startsWith('variant-')), all.filter((s) => s.id.startsWith('variant-'))];
      expect(plain).toEqual([
        { id: SCENE, title: 'おかえりの夜', ready: true, problems: [] },
        { id: 'welcome-home', title: MAIN_SCENES.find((s) => s.meta.id === 'welcome-home')!.meta.title.ja, ready: false, problems: ['slot'] }
      ]);
      expect(variants.map((s) => s.id)).toEqual(['variant-mahiro-1', 'variant-mahiro-3', 'variant-mahiro-6', 'variant-mahiro-10']);
      for (const s of variants) expect(s).toMatchObject({ ready: false, problems: expect.arrayContaining(['variant_card']) });
      expect(seen[0].scene).toBeUndefined();
      expect(r.scene).toEqual({ sceneId: SCENE, action: 'start', title: sceneById(SCENE)!.meta.title });
      expect(r.scene.title.ja).toBe('おかえりの夜');
      expect(r.reply).toBe(`echo:START:${SCENE}`);
      expect((await send(h, `OFFER:${SCENE}`)).scene).toMatchObject({ sceneId: SCENE, action: 'offer' });
      // The start that follows is his request.
      expect((await post('/v1/scene/start', { sceneId: SCENE }, h)).statusCode).toBe(200);
      expect(await sources()).toEqual({ request: 1, proposed: 0, time: 0 });
    });

    it('drops a directive for anything it did not list as ready, and a malformed one', async () => {
      const { h } = await member();
      for (const text of ['START:welcome-home', 'START:no-such-scene', 'OFFER:night-greenhouse', 'RAW', 'JUMP:sleepy', 'hello']) {
        expect((await send(h, text)).scene, text).toBeUndefined();
      }
    });

    it('in production lists only what production plays — the five (#80) and her variant scenes (#81) — never the demo scene', async () => {
      const { h } = await member();
      const prod = await buildApp({ repos, logger: false, demo: false });
      const r = await send(h, `START:${SCENE}`, prod);
      // Her welcome-home, locked by day, and hers, locked while he has not got her card; not the demo scene.
      expect((seen[0].scenes ?? []).map((s) => s.id)).toEqual(['welcome-home', 'variant-mahiro-1', 'variant-mahiro-3', 'variant-mahiro-6', 'variant-mahiro-10']);
      expect(seen[0].scenes?.[0]).toMatchObject({ ready: false, problems: ['slot'] });
      for (const s of seen[0].scenes!.slice(1)) expect(s).toMatchObject({ ready: false, problems: expect.arrayContaining(['variant_card']) });
      expect(r.scene).toBeUndefined();
      expect((await send(h, 'START:welcome-home', prod)).scene).toBeUndefined();
    });

    it('streams the same answer', async () => {
      const { h } = await member();
      const res = await post('/v1/chat/send/stream', { star: 'mahiro', text: `START:${SCENE}` }, h);
      const done = res.payload.trim().split('\n').map((l) => JSON.parse(l)).find((e) => e.type === 'done');
      expect(done.result.scene).toMatchObject({ sceneId: SCENE, action: 'start' });
    });
  });

  describe('free talk turns where the script allows (directive.jumpTo)', () => {
    async function toTalk(h: Record<string, string>) {
      const run = json(await post('/v1/scene/start', { sceneId: SCENE }, h)).run;
      return json(await post('/v1/scene/step', { runId: run.id, seq: run.seq, choice: 'missed' }, h)).run;
    }

    it('hands the step\'s jumps to the persona service and follows a declared one', async () => {
      const { h } = await member();
      const talk = await toTalk(h);
      const done = json(await post('/v1/scene/step', { runId: talk.id, seq: talk.seq, input: 'JUMP:sleepy' }, h)).run;
      expect(seen.at(-1)?.scene).toMatchObject({ id: SCENE, step: 'talk', jumps: [{ to: 'sleepy' }] });
      expect(seen.at(-1)?.scenes).toBeUndefined();
      expect(done.beats.map((b: { id: string }) => b.id).slice(0, 2)).toEqual(['talk~reply', 'sleepy']);
      expect(done.rewards.affinity).toBeGreaterThan(0);
    });

    it('M4: her free-talk reply in the scene fits three subtitle lines, cut at a sentence end', async () => {
      const { h } = await member();
      const talk = await toTalk(h);
      // The fake persona echoes his words: a long answer is a long reply.
      const long = 'うん、今日はね。' + 'ずっと雨の音を聞いていて、窓の外を見ながらいろんなことを考えていたんだ。'.repeat(3);
      const done = json(await post('/v1/scene/step', { runId: talk.id, seq: talk.seq, input: long }, h)).run;
      const reply = done.beats.find((b: { id: string }) => b.id === 'talk~reply') as { text: Record<string, string> };
      expect(reply.text.ja).toBe('echo:うん、今日はね。ずっと雨の音を聞いていて、窓の外を見ながらいろんなことを考えていたんだ。');
      expect([...reply.text.ja].length).toBeLessThanOrEqual(SCENE_RULES.replyMaxChars.ja);
    });

    it('ignores a jump the step does not declare', async () => {
      const { h } = await member();
      const talk = await toTalk(h);
      const done = json(await post('/v1/scene/step', { runId: talk.id, seq: talk.seq, input: 'JUMP:reward' }, h)).run;
      expect(done.beats.map((b: { id: string }) => b.id).slice(0, 2)).toEqual(['talk~reply', 'thanks']);
    });
  });

  describe('she proposes (entering her room)', () => {
    it('proposes at proposeRate, and the start that accepts it counts as hers — once', async () => {
      const { h } = await member();
      dice(0.9);
      expect(await room(h)).toBeNull();
      dice(0.1);
      const offer = await room(h);
      expect(offer).toMatchObject({ sceneId: SCENE, source: 'proposed', star: 'mahiro', title: { ja: 'おかえりの夜' }, media: ['mahiro-hero', 'mahiro-night', 'mahiro-breath'] });
      expect(Date.parse(offer!.expiresAt) - NOW).toBe(TRIGGER_RULES.offerTtlMs);
      const run = json(await post('/v1/scene/start', { sceneId: SCENE, offerId: offer!.id }, h)).run;
      expect(await sources()).toEqual({ request: 0, proposed: 1, time: 0 });
      // An offer is accepted once; replaying it later is his own request.
      await post('/v1/scene/end', { runId: run.id }, h);
      await post('/v1/scene/start', { sceneId: SCENE, offerId: offer!.id }, h);
      expect(await sources()).toEqual({ request: 1, proposed: 1, time: 0 });
    });

    it('never over a scene he is in, nor one he played today', async () => {
      const { h } = await member();
      dice(0.1);
      const run = json(await post('/v1/scene/start', { sceneId: SCENE }, h)).run;
      expect(await room(h)).toBeNull();
      await post('/v1/scene/end', { runId: run.id }, h);
      // That run was today's rewarded one.
      expect(await room(h)).toBeNull();
      at(NOW + 86_400_000);
      expect(await room(h)).not.toBeNull();
    });

    it('keeps the gap between proposals and the daily cap', async () => {
      const { h } = await member();
      dice(0.1);
      expect(await room(h)).not.toBeNull();
      expect(await room(h)).toBeNull();
      at(NOW + TRIGGER_RULES.minProposalGapMs);
      let made = 1;
      for (let i = 0; i < TRIGGER_RULES.maxProposalsPerDay + 2; i++) {
        if (await room(h)) made++;
        at(Date.now() + TRIGGER_RULES.minProposalGapMs);
      }
      expect(made).toBe(TRIGGER_RULES.maxProposalsPerDay);
    });

    it('lets "not now" rest the scene for the cooldown, and an offer is his alone', async () => {
      const { h } = await member();
      const other = await member();
      dice(0.1);
      const offer = (await room(h))!;
      // Someone else cannot accept or decline it: his start is a plain request.
      expect(json(await post('/v1/scene/offer/decline', { offerId: offer.id }, other.h))).toEqual({ ok: true, declined: false });
      expect(json(await post('/v1/scene/offer/decline', { offerId: offer.id }, h))).toEqual({ ok: true, declined: true });
      expect(json(await post('/v1/scene/offer/decline', { offerId: offer.id }, h))).toEqual({ ok: true, declined: false });
      at(NOW + TRIGGER_RULES.minProposalGapMs);
      expect(await room(h)).toBeNull();
      at(NOW + TRIGGER_RULES.declineCooldownMs + 1);
      expect(await room(h)).not.toBeNull();
    });

    it('an expired offer still starts the scene, as his request', async () => {
      const { h } = await member();
      dice(0.1);
      const offer = (await room(h))!;
      at(NOW + TRIGGER_RULES.offerTtlMs + 1);
      expect((await post('/v1/scene/start', { sceneId: SCENE, offerId: offer.id }, h)).statusCode).toBe(200);
      expect(await sources()).toEqual({ request: 1, proposed: 0, time: 0 });
    });

    it('never offers the demo scene in production; the five, reviewed and with #80\'s clips, when their hour comes', async () => {
      const { h } = await member();
      // Made before the dice are loaded (their e-mail addresses are random).
      const [evening, other] = [await member(), await member()];
      dice(0.01);
      const prod = await buildApp({ repos, logger: false, demo: false });
      for (const star of ['mahiro', 'nana', 'unpai', 'alice', 'eimi']) {
        // By day the five are locked: production has nothing to offer, not even the demo scene.
        expect(await room(h, { star }, prod), star).toBeNull();
        const offer = await room(h, { star });
        // Demo mode by day: the five are evening scenes, so only the demo scene is there to offer, and it is mahiro's.
        expect(offer?.sceneId ?? null, star).toBe(star === 'mahiro' ? SCENE : null);
        at(Date.now() + TRIGGER_RULES.minProposalGapMs);
      }
      expect(MAIN_SCENES.some((s) => s.meta.id === SCENE)).toBe(false);
      // In the evening production offers the five as well as the test site.
      at(Date.UTC(2026, 9, 1, 12)); // 21:00 JST
      expect((await room(evening.h, { star: 'alice' }, prod))?.sceneId).toBe('night-greenhouse');
      expect((await room(other.h, { star: 'alice' }))?.sceneId).toBe('night-greenhouse');
    });

    it('M2: after any scene ends she offers nothing — in any room, nor another in chat — for the cool-down', async () => {
      const { h } = await member();
      dice(0.01);
      at(Date.UTC(2026, 9, 1, 12)); // 21:00 JST: アリス's greenhouse is offered then
      const run = json(await post('/v1/scene/start', { sceneId: SCENE }, h)).run;
      expect((await post('/v1/scene/end', { runId: run.id }, h)).statusCode).toBe(200);
      const ended = Date.now();
      expect(await room(h, { star: 'alice' })).toBeNull();
      at(ended + TRIGGER_RULES.afterSceneCooldownMs - 60_000);
      expect(await room(h, { star: 'alice' })).toBeNull();
      // In chat: the scene he asks for still starts; one she would offer instead waits.
      const chat = (text: string) => post('/v1/chat/send', { star: 'alice', text }, h).then(json);
      expect((await chat('OFFER:night-greenhouse')).scene).toBeUndefined();
      expect((await chat('START:night-greenhouse')).scene).toMatchObject({ sceneId: 'night-greenhouse', action: 'start' });
      at(ended + TRIGGER_RULES.afterSceneCooldownMs + 1);
      expect((await chat('OFFER:night-greenhouse')).scene).toMatchObject({ sceneId: 'night-greenhouse', action: 'offer' });
      expect((await room(h, { star: 'alice' }))?.sceneId).toBe('night-greenhouse');
    });

    it('needs a session', async () => {
      expect((await post('/v1/scene/room', { star: 'mahiro' }, {})).statusCode).toBe(401);
      expect((await post('/v1/scene/offer/decline', { offerId: 'x' }, {})).statusCode).toBe(401);
    });
  });

  describe('the moment (time and events)', () => {
    it('an inbox event that names a scene opens it, without dice, counted as time', async () => {
      const { user, h } = await member();
      dice(0.99);
      const delivered = new Date(NOW - 60_000).toISOString();
      await repos.inbox.add({ id: 'inb_1', userId: user.id, star: 'mahiro', kind: 'message', payload: { sceneId: SCENE }, dueAt: delivered, deliveredAt: null, readAt: null, createdAt: delivered });
      // Not delivered yet: nothing.
      expect(await room(h, { inboxId: 'inb_1' })).toBeNull();
      await repos.inbox.deliverDue(new Date(NOW).toISOString(), 10);
      const offer = (await room(h, { inboxId: 'inb_1' }))!;
      expect(offer).toMatchObject({ sceneId: SCENE, source: 'time' });
      // Another user's item opens nothing.
      const other = await member();
      expect(await room(other.h, { inboxId: 'inb_1' })).toBeNull();
      await post('/v1/scene/start', { sceneId: SCENE, offerId: offer.id }, h);
      expect(await sources()).toEqual({ request: 0, proposed: 0, time: 1 });
    });
  });

  it('forgets his offers with his account', async () => {
    const { user, h } = await member();
    dice(0.1);
    expect(await room(h)).not.toBeNull();
    await repos.users.anonymise(user.id, new Date().toISOString());
    expect(await repos.sceneOffers.since(user.id, '')).toEqual([]);
  });
});

describe.each(BACKENDS)('their first meeting (N-29, %s store)', (_name, makeRepos) => {
  beforeEach(async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    at(NOW);
    repos = makeRepos();
    app = await buildApp({ repos, logger: false, demo: true });
  });
  afterEach(async () => { vi.useRealTimers(); vi.restoreAllMocks(); await app.close(); });

  it('a new account: her first words are a greeting — no offer that day, even after they talk; the next day she may offer', async () => {
    const user = await repos.users.create(newUserRow({ email: `${Math.random()}@example.com`, lineSub: null, nickname: 'u', via: 'email', lang: 'ja' }));
    const h = { authorization: `Bearer ${signJwt({ sub: user.id }, env.JWT_SECRET, 7 * 86_400)}` };
    dice(0.01);
    expect(await room(h)).toBeNull();
    await send(h, 'はじめまして');
    expect(await room(h)).toBeNull();
    at(NOW + 86_400_000);
    expect(await room(h)).toMatchObject({ source: 'proposed', star: 'mahiro' });
  });
});

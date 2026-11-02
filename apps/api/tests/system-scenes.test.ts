import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { SYSTEM_SCENE_RULES, TRIGGER_RULES, WORLD, jstDay, type StarId } from '@jstar/shared';
import { LINES } from '@jstar/shared/lines';
import { SYSTEM_LINES, whisperOfNight } from '@jstar/shared/scenes/system';
import { signJwt } from '../src/lib/crypto';
import { createMemoryRepos } from '../src/db/memory';
import { createSqlRepos } from '../src/db/sql';
import { SEED_CARDS } from '../src/db/seed';
import type { PromiseRow, Repos, UserRow } from '../src/db/types';
import { newUserRow } from '../src/lib/account';
import { metBefore } from './met';
import { recordEvent } from '../src/lib/events';
import { runTick } from '../src/lib/tick';
import { weatherEventsJob } from '../src/jobs/weatherEvents';
import { calendarGreetings } from '../src/jobs/calendarGreetings';
import { deliverInbox } from '../src/jobs/deliverInbox';
import { duePromises, promisedSceneId } from '../src/jobs/duePromises';
import { env } from '../src/env';
import { buildApp } from '../src/app';
import { createSqliteClient } from './sqlite';

/**
 * The system scenes (#71) through the API: each one opens with its moment — late on his clock (「おやすみ」 in chat
 * too), her weather message, a birthday, a promise he came to keep — and only then may it be offered, asked for or
 * started. The persona service is faked by its contract: `START:<id>` in his message is her yes to that scene.
 */
const seen: { scenes?: { id: string; ready: boolean; cue?: { words: string[] } }[] }[] = [];
vi.mock('../src/lib/agent', () => {
  const answer = (input: { text: string }) => {
    seen.push(JSON.parse(JSON.stringify(input)));
    const [kind, arg] = input.text.split(':');
    return { reply: `echo:${input.text}`, blocked: false, boundary: null, memory: null, cardTitle: null, directive: kind === 'START' ? { scene: arg, action: 'start' } : undefined };
  };
  return {
    askPersona: async (input: { text: string }) => answer(input),
    streamPersona: async function* (input: { text: string }) {
      const r = answer(input);
      yield { type: 'done', reply: r.reply, boundary: null, memory: null, cardTitle: null, directive: r.directive };
    },
    greetPersona: async () => 'hi'
  };
});

const BACKENDS: [string, () => Repos][] = [
  ['memory', () => createMemoryRepos({ cards: SEED_CARDS })],
  ['sql', () => createSqlRepos(createSqliteClient())]
];
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
/** A JST wall-clock time; 2026-10-09 is nobody's birthday, and has no season. */
const jst = (hm: string, day = '2026-10-09') => Date.parse(`${day}T${hm}:00+09:00`);
const silent = { info() {}, error() {} };

let app: FastifyInstance;
let repos: Repos;
let seq = 0;

async function member(patch: Partial<UserRow> = {}) {
  const user = await repos.users.create({ ...newUserRow({ email: `system-${++seq}@example.com`, lineSub: null, nickname: 'u', via: 'email', lang: 'ja' }), ...patch });
  await metBefore(repos, user.id);
  return { user, h: { authorization: `Bearer ${signJwt({ sub: user.id }, env.JWT_SECRET, 400 * 86_400)}` } };
}
/** An account on its first day: not a word with her before today (N-29's first meeting). */
async function fresh() {
  const user = await repos.users.create(newUserRow({ email: `fresh-${++seq}@example.com`, lineSub: null, nickname: 'u', via: 'email', lang: 'ja' }));
  return { user, h: { authorization: `Bearer ${signJwt({ sub: user.id }, env.JWT_SECRET, 400 * 86_400)}` } };
}
const json = (res: { payload: string }) => JSON.parse(res.payload);
const post = (url: string, payload: object, headers: Record<string, string>, on = app) => on.inject({ method: 'POST', url, headers, payload });
type Offer = { id: string; sceneId: string; source: string; media: string[] } | null;
const room = async (h: Record<string, string>, extra: { star?: StarId; inboxId?: string } = {}, on = app): Promise<Offer> => {
  const res = await post('/v1/scene/room', { star: 'mahiro', ...extra }, h, on);
  expect(res.statusCode, res.payload).toBe(200);
  return json(res).offer;
};
const start = (h: Record<string, string>, sceneId: string, offerId?: string, on = app) => post('/v1/scene/start', { sceneId, ...(offerId ? { offerId } : {}) }, h, on);
const at = (ms: number) => vi.setSystemTime(ms);
const sources = async () => (await repos.events.metrics(jstDay(Date.now() - 3 * DAY), jstDay(Date.now() + DAY), 'all'))[0]?.triggerSources ?? { request: 0, proposed: 0, time: 0 };
/** Plays a started run to its end by his first answer. */
async function play(h: Record<string, string>, res: { payload: string }, choice?: string) {
  const run = json(res).run;
  const option = choice ?? run.waiting?.options?.[0]?.id;
  return json(await post('/v1/scene/step', { runId: run.id, seq: run.seq, choice: option }, h)).run;
}

afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); seen.length = 0; });

describe.each(BACKENDS)('system scenes (#71, %s store)', (_name, makeRepos) => {
  beforeEach(async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    at(jst('12:00'));
    repos = makeRepos();
    app = await buildApp({ repos, logger: false, demo: true });
    // Her own proposals roll the dice: never here, so every offer below is the moment's.
    vi.spyOn(Math, 'random').mockReturnValue(0.99);
  });

  describe('goodnight', () => {
    it('late on his clock she offers her plain goodnight; by day nothing, and it cannot be started', async () => {
      const { h } = await member();
      expect(await room(h)).toBeNull();
      expect((await start(h, 'goodnight-mahiro')).statusCode).toBe(403);

      at(jst('22:30'));
      const offer = (await room(h))!;
      expect(offer).toMatchObject({ sceneId: 'goodnight-mahiro', source: 'time', media: ['mahiro-sys-goodnight', 'mahiro-sys-lights-out'] });
      // Without the pass there is no whisper.
      expect((await start(h, `whisper-mahiro-${whisperOfNight(Date.now())}`)).statusCode).toBe(403);
      const res = await start(h, 'goodnight-mahiro', offer.id);
      expect(res.statusCode, res.payload).toBe(200);
      expect(json(res).run.beats.flatMap((b: { type: string; text?: { ja: string } }) => (b.type === 'line' ? [b.text!.ja] : []))).toEqual([LINES.mahiro.goodnight.plain.ja]);
      const done = await play(h, res, 'night');
      expect(done).toMatchObject({ status: 'ended', outcome: 'goodnight', rewards: { affinity: SYSTEM_SCENE_RULES.affinity.goodnight } });
      expect(await sources()).toEqual({ request: 0, proposed: 0, time: 1 });
      // Once a night: played, it is not offered again.
      expect(await room(h)).toBeNull();
    });

    it('M2: after goodnight she offers nothing more that night, in any room — the next morning (05:00 his clock) she may', async () => {
      const { h } = await member(); // no zone: JST
      at(jst('22:30'));
      const res = await start(h, 'goodnight-mahiro', (await room(h))!.id);
      expect(await play(h, res, 'night')).toMatchObject({ status: 'ended', outcome: 'goodnight' });
      // Her own proposals would always fire now: still nothing, all night, in hers or another's room.
      vi.spyOn(Math, 'random').mockReturnValue(0.01);
      for (const t of [jst('22:31'), jst('23:30'), jst('02:00', '2026-10-10'), jst('04:59', '2026-10-10')]) {
        at(t);
        expect(await room(h), new Date(t).toISOString()).toBeNull();
        expect(await room(h, { star: 'alice' }), new Date(t).toISOString()).toBeNull();
      }
      at(jst('05:00', '2026-10-10'));
      expect(await room(h)).not.toBeNull();
      // His clock decides: in Taipei (an hour behind) 05:00 JST is still his night.
      const taipei = await member({ tz: 'Asia/Taipei' });
      at(jst('23:30', '2026-10-10'));
      await play(taipei.h, await start(taipei.h, 'goodnight-mahiro', (await room(taipei.h))!.id), 'night');
      at(jst('05:30', '2026-10-11'));
      expect(await room(taipei.h)).toBeNull();
      at(jst('06:00', '2026-10-11'));
      expect(await room(taipei.h)).not.toBeNull();
    });

    it('M2: a goodnight he left midway is only the cool-down after any scene', async () => {
      const { h } = await member();
      at(jst('22:30'));
      const run = json(await start(h, 'goodnight-mahiro', (await room(h))!.id)).run;
      await post('/v1/scene/end', { runId: run.id }, h);
      vi.spyOn(Math, 'random').mockReturnValue(0.01);
      expect(await room(h)).toBeNull();
      at(jst('22:30') + TRIGGER_RULES.afterSceneCooldownMs + 60_000);
      expect(await room(h)).not.toBeNull();
    });

    it('with the monthly pass it is her whisper, tonight\'s of five; the plain one is not his', async () => {
      const { user, h } = await member();
      await repos.users.update(user.id, { passUntil: new Date(jst('12:00') + 7 * DAY).toISOString() });
      at(jst('23:10'));
      const k = whisperOfNight(Date.now());
      const offer = (await room(h))!;
      expect(offer).toMatchObject({ sceneId: `whisper-mahiro-${k}`, source: 'time', media: ['mahiro-sys-whisper', 'mahiro-sys-lights-out'] });
      expect((await start(h, 'goodnight-mahiro')).statusCode).toBe(403);
      const res = await start(h, offer.sceneId, offer.id);
      expect(json(res).run.beats.find((b: { type: string }) => b.type === 'line').text).toEqual(LINES.mahiro.goodnight.whisper[k - 1]);
      const done = await play(h, res, 'stay');
      expect(done.beats.find((b: { type: string }) => b.type === 'line').text).toEqual(LINES.mahiro.goodnight.whisper[k % 5]);
      expect(done.rewards.affinity).toBe(SYSTEM_SCENE_RULES.affinity.whisper);
      // After midnight it is still the same night's whisper, and still his to replay.
      at(jst('01:00', '2026-10-10'));
      expect(whisperOfNight(Date.now())).toBe(k);
      expect((await start(h, offer.sceneId)).statusCode).toBe(200);
    });

    it('「おやすみ」 in chat: listed with its cue only while it is open; her yes starts it, as his request', async () => {
      const { h } = await member();
      const send = async (text: string) => json(await post('/v1/chat/send', { star: 'mahiro', text }, h));
      await send('おやすみ');
      expect(seen.at(-1)!.scenes?.some((s) => s.id.startsWith('goodnight') || s.id.startsWith('whisper'))).toBeFalsy();
      expect((await send('START:goodnight-mahiro')).scene).toBeUndefined();

      at(jst('22:30'));
      const r = await send('START:goodnight-mahiro');
      const listed = seen.at(-1)!.scenes!.find((s) => s.id === 'goodnight-mahiro')!;
      expect(listed).toMatchObject({ ready: true });
      expect(listed.cue?.words).toContain('おやすみ');
      // Her other scenes carry no cue.
      expect(seen.at(-1)!.scenes!.filter((s) => s.cue).map((s) => s.id)).toEqual(['goodnight-mahiro']);
      expect(r.scene).toEqual({ sceneId: 'goodnight-mahiro', action: 'start', title: SYSTEM_LINES.titles.goodnight });
      expect((await start(h, 'goodnight-mahiro')).statusCode).toBe(200);
      expect(await sources()).toEqual({ request: 1, proposed: 0, time: 0 });
    });

    it('"not now" rests it for the cooldown; the next night she offers it again', async () => {
      const { h } = await member();
      at(jst('22:30'));
      const offer = (await room(h))!;
      await post('/v1/scene/offer/decline', { offerId: offer.id }, h);
      expect(await room(h)).toBeNull();
      at(jst('22:30') + TRIGGER_RULES.declineCooldownMs - HOUR);
      expect(await room(h)).toBeNull();
      // Morning: goodnight is over.
      at(jst('07:00', '2026-10-10'));
      expect(await room(h)).toBeNull();
      at(jst('22:30', '2026-10-10'));
      expect(await room(h)).toMatchObject({ sceneId: 'goodnight-mahiro' });
    });

    it('in production they play now that her lines are reviewed (#84, owner 2026-09-28): by day nothing, late her goodnight', async () => {
      // The scripts are built from her lines at load, so a draft cannot be injected here: that gate (a draft word
      // keeps them demo-only) is checked in packages/shared/tests/system-scenes.test.ts. Here: the reviewed words,
      // existing footage only, so production offers and plays them.
      const { h } = await member();
      const prod = await buildApp({ repos, logger: false, demo: false });
      expect(await room(h, {}, prod)).toBeNull();
      expect((await start(h, 'goodnight-mahiro', undefined, prod)).statusCode).toBe(403);
      at(jst('22:30'));
      const offer = (await room(h, {}, prod))!;
      expect(offer).toMatchObject({ sceneId: 'goodnight-mahiro', source: 'time' });
      const res = await start(h, 'goodnight-mahiro', offer.id, prod);
      expect(res.statusCode, res.payload).toBe(200);
      expect(json(res).run.beats.flatMap((b: { type: string; text?: { ja: string } }) => (b.type === 'line' ? [b.text!.ja] : []))).toEqual([LINES.mahiro.goodnight.plain.ja]);
    });
  });

  describe('the weather', () => {
    it('her weather message names its scene; opening it offers the scene, for a day', async () => {
      const { user, h } = await member();
      at(jst('20:00'));
      await recordEvent(repos, user.id, 'room.entered', { star: 'nana' }, new Date(jst('19:00')));
      expect((await app.inject({ method: 'PUT', url: '/v1/world/demo', headers: h, payload: { star: 'nana', weather: 'rain' } })).statusCode).toBe(200);
      // Not before her message: rain alone does not open it (on the test site her rainy reading, read-aloud-rain, is
      // there to offer in the rain now, demo-only while its clips are pending).
      expect((await room(h, { star: 'nana' }))?.sceneId ?? null).not.toBe('rainy-night-nana');
      expect((await start(h, 'rainy-night-nana')).statusCode).toBe(403);

      await runTick(repos, [weatherEventsJob(), deliverInbox], { log: silent, clock: () => Date.now(), demo: true });
      const [item] = (await repos.inbox.forUser(user.id, 10)).filter((i) => i.star === 'nana');
      expect(item.payload).toMatchObject({ event: 'rainyNight', sceneId: 'rainy-night-nana' });
      expect(LINES.nana.weather.rainyNight.map((l) => l.ja)).toContain(item.payload.text);

      const offer = (await room(h, { star: 'nana', inboxId: item.id }))!;
      expect(offer).toMatchObject({ sceneId: 'rainy-night-nana', source: 'time' });
      const done = await play(h, await start(h, offer.sceneId, offer.id));
      expect(done.beats.filter((b: { type: string }) => b.type === 'line').map((b: { text: { ja: string } }) => b.text.ja)).toEqual(LINES.nana.weather.rainyNight.slice(1).map((l) => l.ja));
      expect(done.rewards.affinity).toBe(SYSTEM_SCENE_RULES.affinity.weather);

      // A day later her message no longer opens it.
      at(jst('20:00') + SYSTEM_SCENE_RULES.weatherSceneMs + HOUR);
      expect((await start(h, 'rainy-night-nana')).statusCode).toBe(403);
    });

    it('played to its end, her weather scene closes her message and is not offered again from it (#8, U-29)', async () => {
      const { user, h } = await member({ lang: 'zh-Hant' });
      at(jst('20:00'));
      await recordEvent(repos, user.id, 'room.entered', { star: 'nana' }, new Date(jst('19:00')));
      await app.inject({ method: 'PUT', url: '/v1/world/demo', headers: h, payload: { star: 'nana', weather: 'rain' } });
      await runTick(repos, [weatherEventsJob(), deliverInbox], { log: silent, clock: () => Date.now(), demo: true });
      const [item] = (await repos.inbox.forUser(user.id, 10)).filter((i) => i.star === 'nana');
      // Her line in every language, and in his as he reads it — also after he switches (U-29).
      expect(item.payload.texts).toMatchObject({ ja: expect.any(String), 'zh-Hant': item.payload.text, en: expect.any(String), ko: expect.any(String) });
      await repos.users.update(user.id, { lang: 'en' });
      const shown = json(await app.inject({ url: '/v1/inbox', headers: h })).items.find((i: { id: string }) => i.id === item.id);
      expect(shown.payload.text).toBe((item.payload.texts as Record<string, string>).en);

      const offer = (await room(h, { star: 'nana', inboxId: item.id }))!;
      const done = await play(h, await start(h, offer.sceneId, offer.id));
      expect(done.status).toBe('ended');
      // Her message is read: her room no longer leads with it…
      expect((await repos.inbox.mine(user.id, item.id))!.readAt).toBeTruthy();
      // …and opening it again (an old tab) offers nothing: he has just played it.
      expect((await room(h, { star: 'nana', inboxId: item.id }))?.sceneId ?? null).not.toBe('rainy-night-nana');
    });

    it('leaving her weather scene halfway keeps her message: he may come back to it', async () => {
      const { user, h } = await member();
      at(jst('20:00'));
      await recordEvent(repos, user.id, 'room.entered', { star: 'nana' }, new Date(jst('19:00')));
      await app.inject({ method: 'PUT', url: '/v1/world/demo', headers: h, payload: { star: 'nana', weather: 'rain' } });
      await runTick(repos, [weatherEventsJob(), deliverInbox], { log: silent, clock: () => Date.now(), demo: true });
      const [item] = (await repos.inbox.forUser(user.id, 10)).filter((i) => i.star === 'nana');
      const offer = (await room(h, { star: 'nana', inboxId: item.id }))!;
      const run = json(await start(h, offer.sceneId, offer.id)).run;
      expect((await post('/v1/scene/end', { runId: run.id, reason: 'left' }, h)).statusCode).toBe(200);
      expect((await repos.inbox.mine(user.id, item.id))!.readAt).toBeNull();
    });

    it('the first snow: entering her room offers it without opening the message, and it becomes a memory card', async () => {
      const { user, h } = await member();
      at(jst('09:00'));
      await recordEvent(repos, user.id, 'room.entered', { star: 'alice' }, new Date(jst('08:00')));
      await app.inject({ method: 'PUT', url: '/v1/world/demo', headers: h, payload: { star: 'alice', weather: 'snow', firstSnow: true } });
      await runTick(repos, [weatherEventsJob(), deliverInbox], { log: silent, clock: () => Date.now(), demo: true });
      // N-56: sixty newer messages from the others do not hide her first-snow message from her room.
      const later = new Date(jst('09:00')).toISOString();
      for (let i = 0; i < 60; i++) {
        await repos.inbox.add({ id: `inb_later_${i}`, userId: user.id, star: 'nana', kind: 'message', payload: { text: `${i}` }, dueAt: later, deliveredAt: later, readAt: null, createdAt: later });
      }
      const offer = (await room(h, { star: 'alice' }))!;
      expect(offer).toMatchObject({ sceneId: 'first-snow-alice', source: 'time' });
      const done = await play(h, await start(h, offer.sceneId, offer.id));
      expect(done.rewards.memories.map((m: { title: string }) => m.title)).toEqual([SYSTEM_LINES.memories.firstSnow.ja]);
      expect(json(await app.inject({ url: '/v1/auth/me', headers: h })).memories).toEqual([expect.objectContaining({ star: 'alice', title: SYSTEM_LINES.memories.firstSnow.ja })]);
    });
  });

  describe('birthdays', () => {
    it('her birthday on the test site\'s pretend day: her message opens it, the gift, a memory card', async () => {
      const { h } = await member();
      const demo = json(await post('/v1/calendar/demo', { day: '2026-03-04' }, h));
      expect(demo.sent).toBeGreaterThan(0);
      await runTick(repos, [deliverInbox], { log: silent, clock: () => Date.now() });
      const items = json(await app.inject({ url: '/v1/inbox', headers: h })).items as { id: string; star: string; payload: Record<string, unknown> }[];
      const hers = items.find((i) => i.payload.calendar === 'herBirthday')!;
      expect(hers).toMatchObject({ star: 'mahiro', payload: { sceneId: 'her-birthday-mahiro' } });
      const offer = (await room(h, { inboxId: hers.id }))!;
      expect(offer).toMatchObject({ sceneId: 'her-birthday-mahiro', source: 'time' });
      // Only hers: nobody else's birthday is today.
      expect((await start(h, 'her-birthday-nana')).statusCode).toBe(403);
      const done = await play(h, await start(h, offer.sceneId, offer.id), 'flowers');
      expect(done.rewards).toMatchObject({ affinity: SYSTEM_SCENE_RULES.affinity.birthday, memories: [{ title: SYSTEM_LINES.memories.herBirthday.ja }] });
    });

    it('her birthday never opens in production until the agency confirms it', async () => {
      // The five birthdays are confirmed (owner, 2026-09-28); the gate must still hold for one that is not, so the flag
      // is cleared for the duration (the calendar reads WORLD directly).
      const { h } = await member();
      const prod = await buildApp({ repos, logger: false, demo: false });
      at(jst('20:00', '2027-03-04'));
      WORLD.mahiro.birthday.confirmed = false;
      try {
        expect(await room(h, {}, prod)).toBeNull();
        expect((await start(h, 'her-birthday-mahiro', undefined, prod)).statusCode).toBe(403);
      } finally {
        WORLD.mahiro.birthday.confirmed = true;
      }
      // Confirmed (まひろ 03-04): on her day production opens it; on any other day it stays shut.
      const res = await start(h, 'her-birthday-mahiro', undefined, prod);
      expect(res.statusCode, res.payload).toBe(200);
      at(jst('20:00', '2027-03-05'));
      expect((await start(h, 'her-birthday-nana', undefined, prod)).statusCode).toBe(403);
    });

    it('his birthday: entering her room that day is her birthday scene for him — once', async () => {
      const { h } = await member({ birthday: '1995-10-09' });
      at(jst('10:00'));
      await runTick(repos, [calendarGreetings, deliverInbox], { log: silent, clock: () => Date.now(), demo: true });
      const offer = (await room(h, { star: 'eimi' }))!;
      expect(offer).toMatchObject({ sceneId: 'his-birthday-eimi', source: 'time' });
      const done = await play(h, await start(h, offer.sceneId, offer.id));
      expect(done.rewards.memories.map((m: { title: string }) => m.title)).toEqual([SYSTEM_LINES.memories.hisBirthday.ja]);
      expect(await room(h, { star: 'eimi' })).toBeNull();
      // The next day it is over.
      at(jst('10:00', '2026-10-10'));
      expect((await start(h, 'his-birthday-eimi')).statusCode).toBe(403);
    });

    it('his birthday message names the scene of the talent who writes it', async () => {
      const { user, h } = await member({ birthday: '1995-10-09' });
      await repos.relationship.touch(user.id, 'unpai', '2026-10-08', new Date(jst('12:00', '2026-10-08')).toISOString());
      at(jst('10:00'));
      await runTick(repos, [calendarGreetings, deliverInbox], { log: silent, clock: () => Date.now() });
      const items = json(await app.inject({ url: '/v1/inbox', headers: h })).items as { star: string; payload: Record<string, unknown> }[];
      expect(items).toEqual([expect.objectContaining({ star: 'unpai', payload: expect.objectContaining({ calendar: 'hisBirthday', sceneId: 'his-birthday-unpai' }) })]);
    });
  });

  describe('a promise kept', () => {
    const promise = (userId: string, patch: Partial<PromiseRow> = {}): PromiseRow => ({
      id: `prm_sys${++seq}`, userId, star: 'mahiro', text: '明日の夜、おかえりを言う', dueAt: new Date(Date.now() + 10 * 60_000).toISOString(),
      kind: 'scene', status: 'open', source: 'proposal', madeAt: new Date(Date.now() - DAY).toISOString(), keptAt: null, sourceMsgId: null, sceneId: null,
      lang: 'ja', notifiedAt: null, missedAt: null, mentionedAt: null, ...patch
    });

    it('a promise of an evening together that names no scene opens her promise-kept scene; its line says so', async () => {
      const { user, h } = await member();
      at(jst('20:00'));
      const row = promise(user.id, { dueAt: new Date(Date.now() - 60_000).toISOString() });
      expect(await repos.promises.create(row)).toBe(true);
      expect(promisedSceneId(row)).toBe('promise-kept-mahiro');
      await runTick(repos, [duePromises, deliverInbox], { log: silent, clock: () => Date.now() });
      const [line] = await repos.inbox.forUser(user.id, 10);
      expect(line.payload).toMatchObject({ promiseId: row.id, sceneId: 'promise-kept-mahiro' });
      // Her greeting keeps it as he comes in; the room then offers the scene.
      expect(json(await app.inject({ url: '/v1/chat/greeting?star=mahiro', headers: h })).promise).toMatchObject({ status: 'kept' });
      const offer = (await room(h))!;
      expect(offer).toMatchObject({ sceneId: 'promise-kept-mahiro', source: 'time' });
      const done = await play(h, await start(h, offer.sceneId, offer.id));
      expect(done.rewards).toMatchObject({ affinity: SYSTEM_SCENE_RULES.affinity.promiseKept, promises: [] });
      // The promise's own memory card, and no second one from the scene.
      expect(json(await app.inject({ url: '/v1/auth/me', headers: h })).memories).toHaveLength(1);
    });

    it.each([['08:00'], ['14:00'], ['20:30']])('every due promise — scene-made, chat-made, her suggestion, the demo — is offered on arrival and starts, at %s (N-64)', async (hhmm) => {
      at(jst(hhmm));
      const due = new Date(Date.now() - 60_000).toISOString();
      const origins: { name: string; make: (userId: string, h: Record<string, string>) => Promise<void> }[] = [
        { name: 'scene-made', make: async (id) => { await repos.promises.create(promise(id, { source: 'scene', dueAt: due })); } },
        { name: 'chat-made', make: async (id) => { await repos.promises.create(promise(id, { source: 'chat', kind: 'free', text: '夜9時、ここで待ってる', dueAt: due })); } },
        { name: 'her suggestion (a message kind)', make: async (id) => { await repos.promises.create(promise(id, { kind: 'message', text: '明日のお昼にメッセージを送る', dueAt: due })); } },
        { name: 'the demo', make: async (_id, h) => { expect((await post('/v1/promises/demo', { star: 'mahiro', inMinutes: 0 }, h)).statusCode).toBe(201); } },
        // A fresh account (its first day, not a word with her before today): the promise made today is kept today.
        { name: 'the demo, on a fresh account', make: async (_id, h) => { expect((await post('/v1/promises/demo', { star: 'mahiro', inMinutes: 0 }, h)).statusCode).toBe(201); } }
      ];
      for (const o of origins) {
        const { user, h } = o.name.includes('fresh') ? await fresh() : await member();
        await o.make(user.id, h);
        expect(json(await app.inject({ url: '/v1/chat/greeting?star=mahiro', headers: h })).promise, o.name).toMatchObject({ status: 'kept' });
        const offer = await room(h);
        expect(offer, o.name).toMatchObject({ sceneId: 'promise-kept-mahiro', source: 'time' });
        const res = await start(h, offer!.sceneId, offer!.id);
        expect(res.statusCode, `${o.name}: ${res.payload}`).toBe(200);
      }
    });

    it('a promise made in chat, due now, is offered even when today\'s time offers are used up (N-64)', async () => {
      const { user, h } = await member();
      at(jst('20:00'));
      const row = promise(user.id, { kind: 'free', dueAt: new Date(Date.now() - 60_000).toISOString() });
      expect(await repos.promises.create(row)).toBe(true);
      const now = new Date().toISOString();
      for (let i = 0; i < TRIGGER_RULES.maxTimeOffersPerDay; i++) {
        await repos.sceneOffers.add({ id: `ofr_cap_${i}`, userId: user.id, star: 'nana', sceneId: 'goodnight-nana', source: 'time', status: 'open', createdAt: now, expiresAt: now, answeredAt: null });
      }
      expect(json(await app.inject({ url: '/v1/chat/greeting?star=mahiro', headers: h })).promise).toMatchObject({ status: 'kept' });
      expect(await room(h)).toMatchObject({ sceneId: 'promise-kept-mahiro', source: 'time' });
      // Seen and let lapse, a later visit in its window offers it again.
      expect(await room(h)).toMatchObject({ sceneId: 'promise-kept-mahiro' });
    });

    it('not for a promise that names its own scene, her wake-up, or one not yet due', async () => {
      const { user, h } = await member();
      at(jst('20:00'));
      const named = promise(user.id, { sceneId: 'demo-evening', dueAt: new Date(Date.now() - 60_000).toISOString() });
      expect(promisedSceneId(named)).toBe('demo-evening');
      expect(promisedSceneId(promise(user.id, { kind: 'wakeup' }))).toBeNull();
      expect(promisedSceneId(promise(user.id, { kind: 'message' }))).toBe('promise-kept-mahiro');
      await repos.promises.create(named);
      expect((await start(h, 'promise-kept-mahiro')).statusCode).toBe(403);
      const other = await member();
      await repos.promises.create(promise(other.user.id, { kind: 'wakeup', dueAt: new Date(Date.now() - 60_000).toISOString() }));
      expect((await start(other.h, 'promise-kept-mahiro')).statusCode).toBe(403);
      // N-64: a promise to be together made in chat (kind free: 「明日の夜9時、ここで待ってる」) opens it, as a scene one does.
      const chatPromise = await member();
      await repos.promises.create(promise(chatPromise.user.id, { kind: 'free', dueAt: new Date(Date.now() - 60_000).toISOString() }));
      expect((await start(chatPromise.h, 'promise-kept-mahiro')).statusCode).not.toBe(403);
      const later = await member();
      await repos.promises.create(promise(later.user.id, { dueAt: new Date(Date.now() + 6 * HOUR).toISOString() }));
      expect((await start(later.h, 'promise-kept-mahiro')).statusCode).toBe(403);
    });

    it('the test site\'s demo promise opens it too (POST /v1/promises/demo)', async () => {
      const { h } = await member();
      at(jst('20:00'));
      expect((await post('/v1/promises/demo', { star: 'nana', inMinutes: 1 }, h)).statusCode).toBe(201);
      expect(await room(h, { star: 'nana' })).toMatchObject({ sceneId: 'promise-kept-nana' });
    });
  });

  it('the moment comes first: his birthday before goodnight', async () => {
    const { h } = await member({ birthday: '1995-10-09' });
    at(jst('22:30'));
    expect(await room(h)).toMatchObject({ sceneId: 'his-birthday-mahiro' });
  });

  it('needs a session', async () => {
    expect((await start({}, 'goodnight-mahiro')).statusCode).toBe(401);
  });
});

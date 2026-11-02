import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { STAR_IDS, WORLD, WorldDemoRes, type StarId, type TalentWorld, type WeatherAlert, type WeatherCondition } from '@jstar/shared';
import { LINES, type StarLines } from '@jstar/shared/lines';
import { MAIN_SCENES } from '@jstar/shared/scenes';
import { triggerProblems } from '@jstar/shared/scenes';
import { signJwt } from '../src/lib/crypto';
import { createMemoryRepos } from '../src/db/memory';
import { createSqlRepos } from '../src/db/sql';
import { SEED_CARDS } from '../src/db/seed';
import type { Repos } from '../src/db/types';
import { newUserRow } from '../src/lib/account';
import { env } from '../src/env';
import { buildApp } from '../src/app';
import { runTick } from '../src/lib/tick';
import { JOBS } from '../src/jobs';
import { recordEvent } from '../src/lib/events';
import { agentWorld, demoWeatherData, greetingMood, greetingWeather, herPoint, sceneWeather } from '../src/lib/herWorld';
import { WEATHER_INBOX_PREFIX, eventsNow, weatherEventsJob } from '../src/jobs/weatherEvents';
import { createSqliteClient } from './sqlite';

/**
 * Weather in her world (#63): what the persona service is told, the greeting cache, scene weather triggers, the
 * weather events in her inbox, and the test site's demo weather. The weather rows are written directly (the fetch
 * itself is tests/weather.test.ts); the persona service is faked and records what it was sent.
 */
const agent = vi.hoisted(() => ({ inputs: [] as Record<string, unknown>[], greetings: [] as Record<string, unknown>[], down: false, say: null as string | null }));
vi.mock('../src/lib/agent', () => {
  const answer = (input: Record<string, unknown>) => {
    agent.inputs.push(input);
    return { reply: `echo:${String(input.text)}`, blocked: false, boundary: null, memory: null, cardTitle: null };
  };
  return {
    askPersona: async (input: Record<string, unknown>) => answer(input),
    streamPersona: async function* (input: Record<string, unknown>) {
      const r = answer(input);
      yield { type: 'delta', text: r.reply };
      yield { type: 'done', reply: r.reply, boundary: null, memory: null, cardTitle: null };
    },
    greetPersona: async (input: { world?: { now?: { weather?: string } | null } | null }) => {
      agent.greetings.push(input as Record<string, unknown>);
      if (agent.down) throw new Error('agent_unavailable');
      if (agent.say) return agent.say;
      return `greet:${input.world?.now?.weather ?? 'none'}:${agent.greetings.length}`;
    }
  };
});

const BACKENDS: [string, () => Repos][] = [
  ['memory', () => createMemoryRepos({ cards: SEED_CARDS })],
  ['sql', () => createSqlRepos(createSqliteClient())]
];
const silent = { info() {}, error() {} };
const json = (res: { payload: string }) => JSON.parse(res.payload);
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const TAIPEI = { lat: 25.1, lon: 121.5 };
/** 21:00 JST on an ordinary autumn evening: after sunset, no season running. */
const EVENING = Date.parse('2026-10-14T12:00:00Z');
/**
 * Her hometowns as they were before the owner confirmed them (2026-09-28): the gate still has to hold for a value added
 * later, so the unconfirmed case is injected (agentWorld takes the world).
 */
const UNCONFIRMED = Object.fromEntries(Object.entries(WORLD).map(([id, w]) => [id, { ...w, hometown: { ...w.hometown, confirmed: false } }])) as Record<StarId, TalentWorld>;
/** Her lines, reviewed (#84, owner 2026-09-28), and a draft copy: the gate still has to hold for a line added later. */
const REVIEWED = LINES;
const DRAFTS = Object.fromEntries(Object.entries(LINES).map(([id, l]) => [id, { ...l, draft: true }])) as Record<StarId, StarLines>;

describe.each(BACKENDS)('her world (%s store)', (_name, makeRepos) => {
  let repos: Repos;
  let app: FastifyInstance;

  beforeEach(async () => {
    vi.useFakeTimers({ toFake: ['Date'], now: EVENING });
    repos = makeRepos();
    app = await buildApp({ repos, logger: false, demo: false });
    agent.inputs.length = 0;
    agent.greetings.length = 0;
    agent.down = false;
    agent.say = null;
  });
  afterEach(() => { vi.useRealTimers(); });

  /** Weather at her window (`star`, default まひろ: Tokyo), or at any other `point`. Her five cities are her own now. */
  const setWeather = (weather: WeatherCondition, opts: { alert?: WeatherAlert | null; at?: number; point?: { key: string; lat: number; lon: number }; star?: StarId; tempC?: number } = {}) => {
    const at = new Date(opts.at ?? Date.now());
    const p = opts.point ?? herPoint(opts.star ?? 'mahiro');
    return repos.weather.saved(p.key, p.lat, p.lon, at.toISOString(), demoWeatherData({ weather, alert: opts.alert, tempC: opts.tempC }, at));
  };
  async function member(lang: 'ja' | 'en' | 'zh-Hant' = 'ja') {
    const user = await repos.users.create(newUserRow({ email: `${Math.random()}@example.com`, lineSub: null, nickname: 'u', via: 'email', lang }));
    return { user, h: { authorization: `Bearer ${signJwt({ sub: user.id }, env.JWT_SECRET, 3600)}` } };
  }
  const chat = (h: Record<string, string>, star: StarId, text = 'hi') => app.inject({ method: 'POST', url: '/v1/chat/send', headers: h, payload: { star, text, lang: 'ja' } });

  describe('what she is told', () => {
    it('sends her weather with every turn, naming her confirmed hometown, and his only when he chose a city', async () => {
      const { user, h } = await member();
      // 奈々's hometown is confirmed (長野, owner 2026-09-28): her window is there, and she may name it.
      await setWeather('rain', { tempC: 8, star: 'nana' });
      expect((await chat(h, 'nana')).statusCode).toBe(200);
      expect(agent.inputs[0].world).toEqual({
        city: '長野', sakura: false, user: null,
        now: { weather: 'rain', tempC: 8, isDay: false, phase: 'night', alert: null, firstSnow: false, hot: false }
      });

      await repos.userCities.set({ userId: user.id, name: '台北市', ...TAIPEI, updatedAt: new Date().toISOString() });
      await setWeather('clear', { tempC: 27.6, point: { key: `ll:${TAIPEI.lat.toFixed(1)},${TAIPEI.lon.toFixed(1)}`, ...TAIPEI } });
      await chat(h, 'nana');
      expect(agent.inputs[1].world).toMatchObject({ city: '長野', now: { weather: 'rain' }, user: { name: '台北市', weather: 'clear', tempC: 28, isDay: false } });

      // A visitor's trial chat: her side only.
      await app.inject({ method: 'POST', url: '/v1/chat/trial', headers: { 'x-device-id': 'dev-weather-1' }, payload: { star: 'nana', text: 'hi', lang: 'ja' } });
      expect(agent.inputs[2].world).toMatchObject({ now: { weather: 'rain' }, user: null });
    });

    it('names her city once the hometown is confirmed, in his language', async () => {
      await setWeather('snow', { point: { key: 'nagano', lat: 36.6486, lon: 138.1948 } });
      expect(await agentWorld(repos, 'nana', 'ja', null, new Date())).toMatchObject({ city: '長野', now: { weather: 'snow' } });
      expect(await agentWorld(repos, 'nana', 'en', null, new Date())).toMatchObject({ city: 'Nagano' });
      expect(await agentWorld(repos, 'nana', 'ko', null, new Date())).toMatchObject({ city: '나가노' });
      // Unconfirmed (a value added later): Tokyo's weather (none stored here), and no city.
      expect(await agentWorld(repos, 'nana', 'ja', null, new Date(), UNCONFIRMED)).toBeNull();
      await setWeather('rain');
      expect(await agentWorld(repos, 'nana', 'ja', null, new Date(), UNCONFIRMED)).toMatchObject({ city: null, now: { weather: 'rain' } });
    });

    it('says nothing about weather that is stale, but still knows the cherry-blossom season', async () => {
      await setWeather('rain', { at: Date.now() - 3 * HOUR - 60_000 });
      await chat((await member()).h, 'mahiro');
      expect(agent.inputs[0].world).toBeNull();
      // Tokyo's blossoms run 03-24 – 04-03 (world.ts SEASONS).
      vi.setSystemTime(Date.parse('2027-03-28T11:00:00Z'));
      expect(await agentWorld(repos, 'mahiro', 'ja', null, new Date())).toEqual({ city: '東京', sakura: true, now: null, user: null });
      expect(await agentWorld(repos, 'mahiro', 'ja', null, new Date(), UNCONFIRMED)).toEqual({ city: null, sakura: true, now: null, user: null });
    });

    it('marks a hot afternoon, a warning and today\'s first snow', async () => {
      vi.setSystemTime(Date.parse('2026-08-10T05:00:00Z'));
      await setWeather('clear', { tempC: 33, star: 'alice' });
      expect(await agentWorld(repos, 'alice', 'ja', null, new Date())).toMatchObject({ now: { hot: true, isDay: true, phase: 'day', alert: null } });
      await setWeather('rain', { alert: 'storm', star: 'alice' });
      expect(await agentWorld(repos, 'alice', 'ja', null, new Date())).toMatchObject({ now: { alert: 'storm', hot: false } });
      await repos.weather.markFirstSnow('saitama', 2027, '2026-08-10');
      expect(await agentWorld(repos, 'alice', 'ja', null, new Date())).toMatchObject({ now: { firstSnow: true } });
    });

    it('writes a new greeting when the weather she would open with changes, and keeps the cache otherwise', async () => {
      const { user, h } = await member();
      const greet = async () => json(await app.inject({ url: '/v1/chat/greeting?star=nana&lang=ja', headers: h }));
      await setWeather('clear', { star: 'nana' });
      expect(await greet()).toEqual({ text: 'greet:clear:1', cached: false });
      expect(await greet()).toMatchObject({ cached: true });
      // N-47: the sky kind is in the key, so a clear-sky greeting is not shown once the chip says cloudy.
      expect((await repos.chatMemory.get(user.id, 'nana'))?.greeting?.lang).toBe('ja@evening~clear-night~first'); // round 12: written for their first meeting
      await setWeather('cloudy', { star: 'nana' });
      expect(await greet()).toMatchObject({ cached: false });

      await setWeather('rain', { star: 'nana' });
      expect(await greet()).toEqual({ text: 'greet:rain:3', cached: false });
      expect(agent.greetings[2].world).toMatchObject({ now: { weather: 'rain' } });
      expect(await greet()).toMatchObject({ text: 'greet:rain:3', cached: true });
      expect(greetingMood(null)).toBe('sky-unknown');
    });

    it('her written greeting says it is raining too, in his language (round 9: the rain was left out)', async () => {
      const { h } = await member();
      agent.down = true;
      await setWeather('rain', { star: 'nana' });
      const greet = async (lang: string) => json(await app.inject({ url: `/v1/chat/greeting?star=nana&lang=${lang}`, headers: h })).text as string;
      expect(await greet('ja')).toMatch(/^雨、降ってるね。/);
      expect(await greet('en')).toMatch(/^It's raining here\. /);
      expect(await greet('zh-Hant')).toMatch(/^在下雨呢。/);
      await setWeather('clear', { star: 'nana' });
      expect(await greet('ko')).not.toMatch(/비/);
      expect(greetingWeather(null)).toBeNull();
    });

    it('rain is in every greeting: woken, a missed promise, the model\'s, cached — combined, never replaced (round 11)', async () => {
      const { user, h } = await member();
      const greet = async (lang: string) => json(await app.inject({ url: `/v1/chat/greeting?star=nana&lang=${lang}`, headers: h })).text as string;
      // The model forgot the rain: her weather words first, and the cached line keeps them.
      await setWeather('rain', { star: 'nana' });
      agent.say = 'おかえり、今日もおつかれさま。';
      expect(await greet('ja')).toBe('雨、降ってるね。おかえり、今日もおつかれさま。');
      expect(await greet('ja')).toBe('雨、降ってるね。おかえり、今日もおつかれさま。');
      // A promise she missed, brought up once: her line, then the rain.
      await repos.promises.create({ id: 'prm_rain', userId: user.id, star: 'nana', text: '朝、お茶を淹れて続きを読む', dueAt: new Date(Date.now() - 5 * HOUR).toISOString(),
        kind: 'scene', status: 'missed', source: 'proposal', madeAt: new Date(Date.now() - DAY).toISOString(), keptAt: null, sourceMsgId: null, sceneId: null,
        lang: 'ja', notifiedAt: null, missedAt: new Date(Date.now() - 2 * HOUR).toISOString(), mentionedAt: null });
      const missed = await greet('ja');
      expect(missed).toContain('お茶を淹れて続きを読む');
      expect(missed).toMatch(/雨、降ってるね。$/);
      // Woken at 3:00 (her sleeping hours): her drowsy line, then the rain — in all four languages.
      vi.setSystemTime(Date.parse('2026-10-14T18:00:00Z'));
      await setWeather('rain', { star: 'nana' });
      const late = await member(); // a session of his signed at this hour
      for (const [lang, rain] of [['ja', /雨、降ってるね。$/], ['en', /It's raining here\.$/], ['ko', /비 오네\.$/], ['zh-Hant', /在下雨呢。$/]] as const) {
        expect(json(await app.inject({ url: `/v1/chat/greeting?star=nana&lang=${lang}`, headers: late.h })).text).toMatch(rain);
      }
    });
  });

  describe('scene weather', () => {
    const rainy = MAIN_SCENES.find((s) => s.meta.id === 'read-aloud-rain')!;
    const ctx = (weather: string | null) => ({ slot: 'night' as const, weather, stage: 'lover' as const, owns: () => true, routine: null });

    it('opens the rainy-night reading only while it really rains at her window', async () => {
      expect(rainy.meta.trigger.weather).toEqual(['rain']);
      expect(triggerProblems(rainy.meta, ctx(await sceneWeather(repos, 'nana', new Date())))).toEqual(['weather']);
      await setWeather('thunder', { star: 'nana' });
      expect(await sceneWeather(repos, 'nana', new Date())).toBe('rain');
      expect(triggerProblems(rainy.meta, ctx(await sceneWeather(repos, 'nana', new Date())))).toEqual([]);
      await setWeather('fog', { star: 'nana' });
      expect(await sceneWeather(repos, 'nana', new Date())).toBe('cloudy');
      await setWeather('rain', { at: Date.now() - 4 * HOUR, star: 'nana' });
      expect(await sceneWeather(repos, 'nana', new Date())).toBeNull();
    });

    it('starts only in the rain, in production (reviewed, #80\'s clips made) as on the test site', async () => {
      // The publish rule (owner, 2026-09-28): reviewed lines and every clip, so production has it; her sky decides.
      const demo = await buildApp({ repos, logger: false, demo: true });
      for (const on of [app, demo]) {
        const { h } = await member();
        const start = () => on.inject({ method: 'POST', url: '/v1/scene/start', headers: h, payload: { sceneId: 'read-aloud-rain' } });
        await setWeather('clear', { star: 'nana' });
        expect(json(await start())).toEqual({ error: 'scene_locked' });
        await setWeather('rain', { star: 'nana' });
        expect((await start()).statusCode).toBe(200);
      }
    });
  });

  describe('weather events', () => {
    const tick = (at: number, opts: { lines?: Record<StarId, StarLines>; demo?: boolean } = {}) =>
      runTick(repos, [weatherEventsJob(opts.lines ?? REVIEWED)], { log: silent, clock: () => at, demo: opts.demo });
    const visit = (userId: string, star: StarId, at = Date.now()) => recordEvent(repos, userId, 'room.entered', { star }, new Date(at));
    const weatherRows = async (since = 0) => repos.inbox.withPrefix(WEATHER_INBOX_PREFIX, new Date(since).toISOString());
    const line = (star: StarId, event: 'firstSnow' | 'rainyNight' | 'typhoon', lang: 'ja' | 'en' = 'ja') => LINES[star].weather[event].map((l) => l[lang]);

    it('sends a rainy night once, in her words and his language, to someone who opened her room lately', async () => {
      const { user } = await member('en');
      const away = await member();
      await visit(user.id, 'nana');
      await visit(away.user.id, 'nana', EVENING - 8 * DAY);
      await setWeather('rain', { star: 'nana' });

      const first = await tick(EVENING);
      expect(first.jobs[0]).toMatchObject({ name: 'weather.events', status: 'ok', result: { sent: 1, recipients: 1 } });
      const [row] = await weatherRows();
      expect(row).toMatchObject({ userId: user.id, star: 'nana', kind: 'event', payload: { event: 'rainyNight' }, deliveredAt: null });
      expect(line('nana', 'rainyNight', 'en')).toContain(row.payload.text);

      // Again the same night, and the next nights while it keeps raining: nothing until three days have passed.
      expect((await tick(EVENING + 10 * 60_000)).jobs[0].result).toMatchObject({ sent: 0 });
      await setWeather('rain', { at: EVENING + DAY, star: 'nana' });
      await visit(user.id, 'nana', EVENING + DAY);
      expect((await tick(EVENING + DAY)).jobs[0].result).toMatchObject({ sent: 0 });
      await setWeather('rain', { at: EVENING + 3 * DAY + HOUR, star: 'nana' });
      expect((await tick(EVENING + 3 * DAY + HOUR)).jobs[0].result).toMatchObject({ sent: 1 });
      expect(await weatherRows()).toHaveLength(2);
    });

    it('waits for her waking hours and for night, and says nothing on stale weather', async () => {
      const { user } = await member();
      await visit(user.id, 'mahiro');
      // 14:00 JST: rain, but not night.
      await setWeather('rain', { at: EVENING - 7 * HOUR });
      expect((await tick(EVENING - 7 * HOUR)).jobs[0].result).toMatchObject({ events: 0, sent: 0 });
      // 03:00 JST: night, but she does not write then.
      await setWeather('rain', { at: EVENING + 6 * HOUR });
      expect((await tick(EVENING + 6 * HOUR)).jobs[0].result).toMatchObject({ events: 0 });
      // Stale: the provider has been down for hours.
      await setWeather('rain', { at: EVENING - 4 * HOUR });
      const stale = await weatherEventsJob(REVIEWED).run({ repos, now: new Date(EVENING), signal: new AbortController().signal, log: silent });
      expect(stale).toMatchObject({ events: 0 });
      expect(await weatherRows()).toHaveLength(0);
    });

    it('sends 初雪 once per snow season, even the morning after a night snow', async () => {
      const { user } = await member();
      // It started snowing at 02:00 JST; she writes at 07:00.
      const night = Date.parse('2026-12-02T17:00:00Z');
      await visit(user.id, 'alice', night);
      await repos.weather.markFirstSnow('saitama', 2027, '2026-12-03');
      await setWeather('snow', { at: night, star: 'alice' });
      expect((await tick(night)).jobs[0].result).toMatchObject({ events: 0 });
      const morning = night + 5 * HOUR;
      await setWeather('snow', { at: morning, star: 'alice' });
      expect((await tick(morning)).jobs[0].result).toMatchObject({ sent: 1 });
      const [row] = await weatherRows();
      expect(row.payload.event).toBe('firstSnow');
      expect(line('alice', 'firstSnow')).toContain(row.payload.text);
      // Still snowing the next day: the first snow is not repeated (and snow is no rainy night).
      await setWeather('snow', { at: morning + DAY, star: 'alice' });
      expect((await tick(morning + DAY)).jobs[0].result).toMatchObject({ sent: 0 });
      // Even if the season's first snow were recorded again, the message is once per season per user.
      await repos.weather.forgetFirstSnow('saitama', 2027);
      await repos.weather.markFirstSnow('saitama', 2027, '2026-12-04');
      expect((await tick(morning + DAY + HOUR)).jobs[0].result).toMatchObject({ sent: 0 });
    });

    it('worries about him in a warning with the line for it, and a warning is not held back by last night\'s rain', async () => {
      const { user } = await member();
      await visit(user.id, 'eimi');
      await setWeather('rain', { star: 'eimi' });
      expect((await tick(EVENING)).jobs[0].result).toMatchObject({ sent: 1 });
      await setWeather('rain', { alert: 'storm', at: EVENING + 11 * HOUR, star: 'eimi' });
      expect((await tick(EVENING + 11 * HOUR)).jobs[0].result).toMatchObject({ sent: 1 });
      const storm = (await weatherRows()).find((r) => r.payload.event === 'typhoon')!;
      expect(storm.payload.text).toBe(line('eimi', 'typhoon')[0]);

      // Heavy rain the day after: her heavy-rain line.
      await setWeather('rain', { alert: 'heavy_rain', at: EVENING + 35 * HOUR, star: 'eimi' });
      expect((await tick(EVENING + 35 * HOUR)).jobs[0].result).toMatchObject({ sent: 1 });
      const rows = (await weatherRows()).filter((r) => r.payload.event === 'typhoon');
      expect(rows.map((r) => r.payload.text)).toContain(line('eimi', 'typhoon')[2]);
      // Heat and snow warnings have no line of their own.
      expect(eventsNow({ ...(await agentWorldNow()), alert: 'heat' }, 'tochigi', new Date(EVENING + 35 * HOUR)).map((e) => e.event)).not.toContain('typhoon');
    });

    it('holds each user to two weather messages a day, the talents he visited last first', async () => {
      const { user } = await member();
      const order: StarId[] = ['unpai', 'mahiro', 'alice', 'eimi', 'nana'];
      for (const [i, star] of order.entries()) await visit(user.id, star, EVENING - (5 - i) * DAY);
      // It rains in all five of her cities (each her own now).
      for (const star of STAR_IDS) await setWeather('rain', { star });
      const res = await tick(EVENING);
      expect(res.jobs[0].result).toMatchObject({ sent: 2, capped: 3 });
      expect((await weatherRows()).map((r) => r.star).sort()).toEqual(['eimi', 'nana']);
    });

    it('keeps draft lines out of production and sends them on the test site; a full tick delivers what it wrote', async () => {
      const { user, h } = await member();
      await visit(user.id, 'nana');
      await setWeather('rain', { star: 'nana' });
      const run = (lines: Record<StarId, StarLines>) =>
        weatherEventsJob(lines).run({ repos, now: new Date(), signal: new AbortController().signal, log: silent, demo: false });
      // A draft copy of her lines (a line added later): production sends nothing.
      expect(await run(DRAFTS)).toMatchObject({ events: 0, sent: 0 });

      const demo = await buildApp({ repos, logger: false, demo: true });
      const res = json(await demo.inject({ method: 'POST', url: '/v1/ops/tick' }));
      const job = (name: string) => res.jobs.find((j: { name: string }) => j.name === name);
      expect(job('weather.events')).toMatchObject({ status: 'ok', result: { sent: 1 } });
      expect(job('inbox.deliver')).toMatchObject({ result: { delivered: 1 } });
      const inbox = json(await demo.inject({ url: '/v1/inbox', headers: h }));
      expect(inbox.unread).toBe(1);
      expect(line('nana', 'rainyNight')).toContain(inbox.items[0].payload.text);

      // Her lines are reviewed (#84, owner 2026-09-28): production sends them too.
      expect(LINES.nana.draft).toBe(false);
      const other = await member();
      await visit(other.user.id, 'nana');
      expect(await run(LINES)).toMatchObject({ sent: 1 });
      expect((await weatherRows()).filter((r) => r.userId === other.user.id)).toHaveLength(1);
      expect(JOBS.findIndex((j) => j.name === 'weather.events')).toBeLessThan(JOBS.findIndex((j) => j.name === 'inbox.deliver'));
    });

    async function agentWorldNow() {
      const w = (await repos.weather.get(['tochigi']))[0];
      const { weatherNow } = await import('../src/lib/weather');
      return weatherNow(w, [], new Date())!;
    }
  });

  describe('demo weather (test site)', () => {
    it('exists only in demo mode, for a signed-in user, and changes her window until the next refresh', async () => {
      const { h } = await member();
      const put = (a: FastifyInstance, payload: object, headers: Record<string, string> = h) => a.inject({ method: 'PUT', url: '/v1/world/demo', headers, payload });
      expect((await put(app, { star: 'nana', weather: 'rain' })).statusCode).toBe(404);

      const demo = await buildApp({ repos, logger: false, demo: true });
      expect((await put(demo, { star: 'nana', weather: 'rain' }, {})).statusCode).toBe(401);
      const rain = WorldDemoRes.parse(json(await put(demo, { star: 'nana', weather: 'rain' })));
      expect(rain.talent).toMatchObject({ star: 'nana', cityId: 'nagano', weather: { weather: 'rain', stale: false, isDay: false } });
      expect(await sceneWeather(repos, 'nana', new Date())).toBe('rain');

      const snow = WorldDemoRes.parse(json(await put(demo, { star: 'nana', weather: 'snow', firstSnow: true })));
      expect(snow.talent.weather).toMatchObject({ weather: 'snow', firstSnow: '2026-10-14' });
      const storm = WorldDemoRes.parse(json(await put(demo, { star: 'nana', weather: 'rain', alert: 'storm' })));
      expect(storm.talent.weather?.alert).toBe('storm');
      expect((await put(demo, { star: 'nana', weather: 'hail' })).statusCode).toBe(400);
    });
  });
});

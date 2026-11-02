import { beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { CITIES, CITY_IDS, STAR_IDS, WORLD, WorldRes, type StarId, type TalentWorld } from '@jstar/shared';
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
import { weatherJob } from '../src/jobs/refreshWeather';
import { openMeteo, toWeatherData } from '../src/lib/weather';
import { createSqliteClient } from './sqlite';

/** Weather (#62): the tick job, `/v1/world`, his own city, and a provider outage. Open-Meteo is faked; nothing here reaches the network. */
const BACKENDS: [string, () => Repos][] = [
  ['memory', () => createMemoryRepos({ cards: SEED_CARDS })],
  ['sql', () => createSqlRepos(createSqliteClient())]
];

const silent = { info() {}, error() {} };
const json = (res: { payload: string }) => JSON.parse(res.payload);
const HOUR = 3600_000;
const JST = 9 * 3600;

/** GeoNames records the fake geocoder knows, with the names its index matches per language (as the real one does). */
const PLACES = [
  { id: 1668341, names: { ja: '台北市', zh: '台北市', en: 'Taipei', ko: '타이베이' }, latitude: 25.05306, longitude: 121.52639, feature_code: 'PPLC', country: '台湾', admin1: '台湾', population: 7871900 },
  { id: 1980019, names: { ja: '台北松山空港', zh: '台北松山机场', en: 'Taipei Songshan Airport', ko: '타이베이 쑹산 공항' }, latitude: 25.06405, longitude: 121.55022, feature_code: 'AIRP', country: '台湾', admin1: '台湾' },
  { id: 2643743, names: { ja: 'ロンドン', zh: '伦敦', en: 'London', ko: '런던' }, latitude: 51.50853, longitude: -0.12574, feature_code: 'PPLC', country: 'UK', admin1: 'England', population: 8961989 }
] as const;
type GeoLang = keyof (typeof PLACES)[number]['names'];

/**
 * A stand-in for Open-Meteo answering the three paths the client uses. `code(lat)` sets the weather per point;
 * `down` makes every call a 503. Records every URL asked for.
 */
function fakeOpenMeteo() {
  const s = { down: false, now: () => Date.now(), code: (_lat: number) => 1, temp: 21.5, rain: 0, wind: 2, calls: [] as URL[] };
  const forecastAt = (lat: number, lon: number) => {
    const t = Math.floor(s.now() / 1000);
    const hour = t - (t % 3600);
    const day0 = Math.floor((t + JST) / 86400) * 86400 - JST;
    const hours = [0, 1, 2, 3, 4, 5].map((i) => hour + i * 3600);
    const code = s.code(lat);
    return {
      latitude: lat, longitude: lon, utc_offset_seconds: JST, timezone: 'Asia/Tokyo',
      current: { time: t, interval: 900, temperature_2m: s.temp, weather_code: code, precipitation: s.rain, snowfall: 0, wind_speed_10m: s.wind, wind_gusts_10m: s.wind * 2 },
      hourly: {
        time: hours, temperature_2m: hours.map(() => s.temp), weather_code: hours.map(() => code), precipitation: hours.map(() => s.rain),
        snowfall: hours.map(() => 0), wind_speed_10m: hours.map(() => s.wind), wind_gusts_10m: hours.map(() => s.wind * 2)
      },
      daily: { time: [day0, day0 + 86400], sunrise: [day0 + 5.5 * 3600, day0 + 86400 + 5.5 * 3600], sunset: [day0 + 17.75 * 3600, day0 + 86400 + 17.75 * 3600] }
    };
  };
  const place = (p: (typeof PLACES)[number], lang: GeoLang) => {
    const { names, ...rest } = p;
    return { ...rest, name: names[lang] };
  };
  const f = (async (input: string | URL | Request) => {
    const u = new URL(String(input));
    s.calls.push(u);
    if (s.down) return new Response('unavailable', { status: 503 });
    const q = u.searchParams;
    if (u.pathname === '/v1/forecast') {
      const lats = q.get('latitude')!.split(',').map(Number);
      const lons = q.get('longitude')!.split(',').map(Number);
      const list = lats.map((lat, i) => forecastAt(lat, lons[i]));
      return Response.json(list.length === 1 ? list[0] : list);
    }
    const lang = (q.get('language') ?? 'en') as GeoLang;
    if (u.pathname === '/v1/search') {
      const results = PLACES.filter((p) => p.names[lang] === q.get('name') || (lang === 'en' && p.names.en.startsWith(q.get('name') ?? '-'))).map((p) => place(p, lang));
      return Response.json(results.length ? { results, generationtime_ms: 0.1 } : { generationtime_ms: 0.1 });
    }
    if (u.pathname === '/v1/get') {
      const p = PLACES.find((x) => x.id === Number(q.get('id')));
      return p ? Response.json(place(p, lang)) : Response.json({ error: true, reason: 'not found' }, { status: 400 });
    }
    return new Response('not found', { status: 404 });
  }) as typeof fetch;
  return { s, client: openMeteo('http://weather.internal', f) };
}

/**
 * Every hometown unconfirmed, as they were before the owner confirmed the five (2026-09-28): the gate still has to hold
 * for a value added later, so the job is given this world to check it.
 */
const UNCONFIRMED = Object.fromEntries(Object.entries(WORLD).map(([id, w]) => [id, { ...w, hometown: { ...w.hometown, confirmed: false } }])) as Record<StarId, TalentWorld>;
/** Her five cities (all confirmed), in STAR_IDS order: まひろ 東京, 奈々 長野, うんぱい 仙台, アリス 埼玉, えいみ 栃木. */
const HER_CITIES = STAR_IDS.map((id) => WORLD[id].hometown.value.cityId);

describe.each(BACKENDS)('weather (%s store)', (_name, makeRepos) => {
  let repos: Repos;
  let app: FastifyInstance;
  let om: ReturnType<typeof fakeOpenMeteo>;

  beforeEach(async () => {
    repos = makeRepos();
    om = fakeOpenMeteo();
    app = await buildApp({ repos, logger: false, demo: false, weather: om.client });
  });

  async function newUser(lang: 'ja' | 'en' = 'ja') {
    const user = await repos.users.create(newUserRow({ email: `${Math.random()}@example.com`, lineSub: null, nickname: 'u', via: 'email', lang }));
    return { user, h: { authorization: `Bearer ${signJwt({ sub: user.id }, env.JWT_SECRET, 3600)}` } };
  }
  const world = async (h: Record<string, string> = {}) => {
    const res = await app.inject({ url: '/v1/world', headers: h });
    expect(res.statusCode).toBe(200);
    return WorldRes.parse(json(res));
  };
  const tickAt = (t: number, world: Record<StarId, TalentWorld> = WORLD) => {
    om.s.now = () => t;
    return runTick(repos, [weatherJob(world)], { log: silent, weather: om.client, clock: () => t });
  };

  it('fills her cities from the tick: each her own confirmed hometown, and /v1/world has sunrise, sunset and the sky', async () => {
    expect((await world()).talents.every((t) => t.weather === null)).toBe(true);
    const res = await app.inject({ method: 'POST', url: '/v1/ops/tick', headers: { authorization: `Bearer ${env.AGENT_API_KEY}` } });
    // The five hometowns are confirmed (owner, 2026-09-28): five different cities, in one request.
    expect(json(res).jobs.at(-1)).toMatchObject({ name: 'weather.refresh', status: 'ok', result: { points: 5, due: 5, ok: 5, failed: 0 } });
    // Through the Worker relay, never to Open-Meteo directly.
    expect(om.s.calls.map((u) => `${u.origin}${u.pathname}`)).toEqual(['http://weather.internal/v1/forecast']);
    expect((await repos.weather.all()).map((r) => r.cityKey).sort()).toEqual([...CITY_IDS].sort());

    const w = await world();
    expect(w.user).toBeNull();
    expect(w.talents.map((t) => t.star)).toEqual(['mahiro', 'nana', 'unpai', 'alice', 'eimi']);
    expect(w.talents.map((t) => t.cityId)).toEqual(['tokyo', 'nagano', 'sendai', 'saitama', 'tochigi']);
    expect(w.talents.map((t) => t.city.ja)).toEqual(['東京', '長野', '仙台', '埼玉', '栃木']);
    for (const t of w.talents) {
      expect(CITIES[t.cityId as keyof typeof CITIES].city).toMatchObject(t.city);
      expect(t.weather).toMatchObject({ weather: 'clear', code: 1, tempC: 21.5, alert: null, stale: false, firstSnow: null });
      expect(t.weather!.sunrise < t.weather!.sunset).toBe(true);
      const now = new Date().toISOString();
      expect(t.weather!.isDay).toBe(now >= t.weather!.sunrise && now < t.weather!.sunset);
      expect(t.weather!.next6h).toHaveLength(6);
    }
    expect(res.statusCode).toBe(200);
  });

  it('with the hometowns confirmed, one request fills all five cities, and refreshes them about hourly', async () => {
    const t0 = Date.parse('2026-10-01T03:00:00Z');
    const first = await tickAt(t0);
    expect(first.jobs[0]).toMatchObject({ status: 'ok', result: { points: 5, due: 5, ok: 5 } });
    expect(om.s.calls).toHaveLength(1);
    expect((await repos.weather.all()).map((r) => r.cityKey).sort()).toEqual([...CITY_IDS].sort());
    expect([...new Set(HER_CITIES)].sort()).toEqual([...CITY_IDS].sort());

    expect((await tickAt(t0 + 5 * 60_000)).jobs[0].result).toMatchObject({ due: 0 });
    expect((await tickAt(t0 + 30 * 60_000)).jobs[0].result).toMatchObject({ due: 0 });
    expect((await tickAt(t0 + 55 * 60_000)).jobs[0].result).toMatchObject({ due: 5, ok: 5 });
    expect(om.s.calls).toHaveLength(2);
    // A hometown that goes back to unconfirmed takes its city out of the job (all of them: Tokyo only, never a hint
    // of an unconfirmed city); the rows go with the next tick.
    expect((await tickAt(t0 + 60 * 60_000, UNCONFIRMED)).jobs[0].result).toMatchObject({ points: 1, pruned: 4 });
    expect((await repos.weather.all()).map((r) => r.cityKey)).toEqual(['tokyo']);
  });

  it('keeps the last weather when Open-Meteo is down, flags it stale after 3 hours, and the other jobs still run', async () => {
    // Real time: /v1/world below judges staleness against the clock.
    const t0 = Date.now() - 2 * HOUR;
    await tickAt(t0);
    const before = (await repos.weather.get(['tokyo']))[0];
    om.s.down = true;

    const failed = await runTick(repos, JOBS, { log: silent, weather: om.client, clock: () => t0 + HOUR });
    // The other jobs of the tick still run; the weather is last (JOBS).
    const weatherRun = failed.jobs[failed.jobs.length - 1];
    expect(failed.jobs.every((j) => j === weatherRun || j.status === 'ok')).toBe(true);
    expect([weatherRun.name, weatherRun.status, weatherRun.error]).toEqual(['weather.refresh', 'failed', 'weather_unavailable']);
    const after = (await repos.weather.get(['tokyo']))[0];
    expect(after).toMatchObject({ fetchedAt: before.fetchedAt, data: before.data, error: 'weather_http_503', triedAt: new Date(t0 + HOUR).toISOString() });

    // Not hammered: the next try waits WEATHER_RETRY_MS (15 minutes), not the next tick.
    const calls = om.s.calls.length;
    await tickAt(t0 + HOUR + 5 * 60_000);
    expect(om.s.calls.length).toBe(calls);
    await tickAt(t0 + HOUR + 15 * 60_000);
    expect(om.s.calls.length).toBe(calls + 1);

    // Readers: last data while recent, stale once older than 3 hours.
    const fresh = await world();
    expect(fresh.talents[0].weather?.stale).toBe(false);
    await repos.weather.saved('tokyo', 35.6895, 139.6917, new Date(Date.now() - 3 * HOUR - 60_000).toISOString(), before.data!);
    const stale = await world();
    expect(stale.talents[0].weather).toMatchObject({ stale: true, weather: 'clear', tempC: 21.5 });

    // Back up: fresh again, the error cleared.
    om.s.down = false;
    await tickAt(t0 + 2 * HOUR);
    expect((await repos.weather.get(['tokyo']))[0].error).toBeNull();
    expect((await world()).talents[0].weather?.stale).toBe(false);
  });

  it('records the first snow once per city and snow season (初雪)', async () => {
    // Snow in Nagano only at first: her cities are her own, so it is 奈々's first snow, not the others'.
    const snowIn = new Set([CITIES.nagano.lat]);
    om.s.code = (lat) => (snowIn.has(lat) ? 73 : 1);
    const nov = Date.parse('2026-11-20T01:00:00Z');
    expect((await tickAt(nov)).jobs[0].result).toMatchObject({ firstSnow: ['nagano'] });
    expect((await tickAt(nov + 2 * HOUR)).jobs[0].result).toMatchObject({ ok: 5, firstSnow: [] });
    // Then in Tokyo too: its own first snow; Nagano's is not repeated.
    snowIn.add(CITIES.tokyo.lat);
    expect((await tickAt(nov + 4 * HOUR)).jobs[0].result).toMatchObject({ ok: 5, firstSnow: ['tokyo'] });
    // January is the same season (JMA 寒候年, August–July).
    expect((await tickAt(Date.parse('2027-01-10T01:00:00Z'))).jobs[0].result).toMatchObject({ ok: 5, firstSnow: [] });
    // The next season records again.
    expect((await tickAt(Date.parse('2027-12-01T01:00:00Z'))).jobs[0].result).toMatchObject({ firstSnow: ['tokyo', 'nagano'] });
    expect((await repos.weather.firstSnow(['nagano'])).sort((a, b) => a.winter - b.winter)).toEqual([
      { cityKey: 'nagano', winter: 2027, day: '2026-11-20' },
      { cityKey: 'nagano', winter: 2028, day: '2027-12-01' }
    ]);
    expect(await repos.weather.firstSnow(['sendai', 'saitama', 'tochigi'])).toEqual([]);
  });

  it('lets him choose his city by name (台北), shows its weather to him only, and forgets it when cleared', async () => {
    const { user, h } = await newUser('ja');
    const other = await newUser('en');

    const search = await app.inject({ url: `/v1/world/cities?q=${encodeURIComponent('台北')}`, headers: h });
    expect(search.statusCode).toBe(200);
    // "台北" alone matches nothing in the index; "台北市" does. The airport is not a city.
    expect(json(search).results).toEqual([{ id: 1668341, name: '台北市', region: '台湾', country: '台湾', lat: 25.1, lon: 121.5 }]);
    expect((await app.inject({ url: '/v1/world/cities?q=Taipei', headers: other.h })).json().results.map((r: { name: string }) => r.name)).toEqual(['Taipei']);

    const set = await app.inject({ method: 'PUT', url: '/v1/world/city', headers: h, payload: { id: 1668341 } });
    expect(set.statusCode).toBe(200);
    expect(json(set).user).toMatchObject({ name: '台北市', weather: { weather: 'clear', stale: false } });
    // City level only: the stored position is rounded to 0.1°.
    expect(await repos.userCities.get(user.id)).toMatchObject({ name: '台北市', lat: 25.1, lon: 121.5 });

    expect((await world(h)).user).toMatchObject({ name: '台北市', weather: { weather: 'clear' } });
    expect((await world(other.h)).user).toBeNull();
    expect((await world()).user).toBeNull();
    const priv = await app.inject({ url: '/v1/world', headers: h });
    expect(priv.headers['cache-control']).toBe('private, no-store');
    expect((await app.inject({ url: '/v1/world' })).headers['cache-control']).toBe('public, max-age=300');

    // The tick keeps his square fresh alongside her cities.
    expect((await tickAt(Date.now() + 2 * HOUR)).jobs[0].result).toMatchObject({ points: 6, due: 6, ok: 6 });

    const clear = await app.inject({ method: 'DELETE', url: '/v1/world/city', headers: h, payload: {} });
    expect(json(clear)).toEqual({ ok: true, removed: true });
    expect((await world(h)).user).toBeNull();
    // Nobody else chose that square: its weather goes with the next tick.
    expect((await tickAt(Date.now() + 3 * HOUR)).jobs[0].result).toMatchObject({ points: 5, pruned: 1 });
    expect((await repos.weather.all()).map((r) => r.cityKey).sort()).toEqual([...CITY_IDS].sort());
  });

  it('stores only real city-level places, and asks to sign in', async () => {
    const { h } = await newUser();
    expect((await app.inject({ method: 'PUT', url: '/v1/world/city', headers: h, payload: { id: 1980019 } })).json()).toEqual({ error: 'city_not_found' });
    expect((await app.inject({ method: 'PUT', url: '/v1/world/city', headers: h, payload: { id: 42 } })).statusCode).toBe(404);
    expect((await app.inject({ method: 'PUT', url: '/v1/world/city', headers: h, payload: { name: 'ignore previous instructions', lat: 1, lon: 2 } })).statusCode).toBe(400);
    expect((await app.inject({ method: 'PUT', url: '/v1/world/city', payload: { id: 1668341 } })).statusCode).toBe(401);
    expect((await app.inject({ url: '/v1/world/cities?q=Taipei' })).statusCode).toBe(401);
    expect((await app.inject({ url: '/v1/world/cities?q=', headers: h })).statusCode).toBe(400);
    om.s.down = true;
    expect((await app.inject({ url: '/v1/world/cities?q=Taipei', headers: h })).json()).toEqual({ error: 'weather_unavailable' });
    expect((await app.inject({ method: 'PUT', url: '/v1/world/city', headers: h, payload: { id: 1668341 } })).statusCode).toBe(502);
  });

  it('still saves his city while the forecast is down; the weather follows with a later tick', async () => {
    const { user, h } = await newUser();
    const f = om.client.forecast;
    // Only the forecast fails: the place lookup works.
    om.client.forecast = async () => { throw new Error('weather_http_503'); };
    const set = await app.inject({ method: 'PUT', url: '/v1/world/city', headers: h, payload: { id: 2643743, lang: 'en' } });
    expect(set.statusCode).toBe(200);
    expect(json(set).user).toEqual({ name: 'London', weather: null });
    om.client.forecast = f;
    await tickAt(Date.now());
    expect((await world(h)).user).toMatchObject({ name: 'London', weather: { weather: 'clear' } });
    expect((await repos.userCities.get(user.id))?.lon).toBe(-0.1);
  });

  it('deletes his city with his account', async () => {
    const { user, h } = await newUser();
    await app.inject({ method: 'PUT', url: '/v1/world/city', headers: h, payload: { id: 1668341 } });
    expect(await repos.userCities.get(user.id)).not.toBeNull();
    expect((await app.inject({ method: 'DELETE', url: '/v1/auth/me', headers: h, payload: { confirm: 'DELETE' } })).statusCode).toBe(200);
    expect(await repos.userCities.get(user.id)).toBeNull();
    expect(await repos.userCities.points()).toEqual([]);
  });

  it('with the weather off: /v1/world answers without weather, search says so, and clearing still works', async () => {
    const off = await buildApp({ repos, logger: false, demo: false, weather: null });
    const { user, h } = await newUser();
    await repos.userCities.set({ userId: user.id, name: '台北市', lat: 25.1, lon: 121.5, updatedAt: new Date().toISOString() });
    const w = WorldRes.parse((await off.inject({ url: '/v1/world', headers: h })).json());
    expect(w.talents.every((t) => t.weather === null)).toBe(true);
    expect(w.user).toEqual({ name: '台北市', weather: null });
    expect((await off.inject({ url: '/v1/world/cities?q=Taipei', headers: h })).json()).toEqual({ error: 'weather_disabled' });
    expect((await off.inject({ method: 'DELETE', url: '/v1/world/city', headers: h, payload: {} })).json()).toEqual({ ok: true, removed: true });
  });
});

describe('Open-Meteo client', () => {
  it('reads a real response shape (two points) into what is stored, alert included', () => {
    const raw = {
      latitude: 35.7, longitude: 139.6875, utc_offset_seconds: 32400, timezone: 'Asia/Tokyo',
      current: { time: 1790399700, interval: 900, temperature_2m: 18.6, weather_code: 65, precipitation: 24.1, snowfall: 0, wind_speed_10m: 1.2, wind_gusts_10m: 8.5, is_day: 1 },
      hourly: {
        time: [1790398800, 1790402400, 1790406000, 1790409600, 1790413200, 1790416800],
        temperature_2m: [18.6, 18.6, 18.7, 18.6, 18.3, 18.2], weather_code: [65, 63, 61, 51, 51, null],
        precipitation: [24.1, 8, 3, 0.1, 0.1, null], snowfall: [0, 0, 0, 0, 0, 0], wind_speed_10m: [1.32, 0.8, 1.24, 1, 1.17, 1.12], wind_gusts_10m: [8.5, 8.3, 7.1, 6.4, 5.8, 5.9]
      },
      daily: { time: [1790348400, 1790434800], sunrise: [1790368314, 1790454761], sunset: [1790411581, 1790497893] }
    };
    const d = toWeatherData(raw);
    expect(d).toMatchObject({ code: 65, tempC: 18.6, precipMm: 24.1, utcOffsetSeconds: 32400, alert: 'heavy_rain' });
    expect(d.days).toEqual([
      { date: '2026-09-26', sunrise: '2026-09-25T20:31:54.000Z', sunset: '2026-09-26T08:33:01.000Z' },
      { date: '2026-09-27', sunrise: '2026-09-26T20:32:41.000Z', sunset: '2026-09-27T08:31:33.000Z' }
    ]);
    // A gap in the model's hours reads as zero, not as a crash.
    expect(d.next6h[5]).toMatchObject({ code: 0, precipMm: 0 });
    expect(() => toWeatherData({ ...raw, current: undefined })).toThrow();
  });

  it('goes to Open-Meteo directly without a relay, and fails cleanly on an unexpected answer', async () => {
    const asked: string[] = [];
    const client = openMeteo('', (async (u: string) => { asked.push(String(u)); return Response.json({ nope: true }); }) as typeof fetch);
    await expect(client.forecast([{ lat: 35.6895, lon: 139.6917 }])).rejects.toThrow('weather_bad_response');
    expect(asked[0]).toMatch(/^https:\/\/api\.open-meteo\.com\/v1\/forecast\?latitude=35\.6895&longitude=139\.6917&/);
    await client.search('Taipei', 'en').catch(() => {});
    expect(asked[1]).toMatch(/^https:\/\/geocoding-api\.open-meteo\.com\/v1\/search\?name=Taipei&/);
    expect(await client.forecast([])).toEqual([]);
  });
});

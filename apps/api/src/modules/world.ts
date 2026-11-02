import type { FastifyInstance, FastifyReply } from 'fastify';
import { CITIES, CitySearchQuery, STAR_IDS, SetCityReq, WEATHER_REFRESH_MS, WorldDemoReq, localDate, weatherPoint, userCityKey, winterOf, type WorldDemoResT, type WorldResT, type WorldUserT } from '@jstar/shared';
import { httpError, requireUser } from '../app';
import type { UserCityRow } from '../db/types';
import { weatherNow } from '../lib/weather';
import { demoWeatherData, herPoint } from '../lib/herWorld';

/**
 * Her world (#62): the weather in each talent's city, and in his own city if he chose one.
 *
 * His city is personal data (docs/compliance-jp.md §7.1): optional, city level only (a real place name and a
 * position rounded to 0.1°), used for the weather only, deleted when he clears it and with his account.
 */
export async function registerWorld(app: FastifyInstance) {
  // Sent as they are, not through the error handler: it hides every 5xx code, and the web needs to tell "weather is
  // off here" from "Open-Meteo is down, try later".
  const unavailable = (reply: FastifyReply, error: 'weather_disabled' | 'weather_unavailable') =>
    reply.status(error === 'weather_disabled' ? 503 : 502).send({ error });

  /** His city with its weather: the next tick fetches a new square, or this call does when it can. */
  async function userWorld(city: UserCityRow, now: Date): Promise<WorldUserT> {
    const key = userCityKey(city.lat, city.lon);
    const [rows, snows] = await Promise.all([app.repos.weather.get([key]), app.repos.weather.firstSnow([key])]);
    return { name: city.name, weather: weatherNow(rows[0], snows, now) };
  }

  /**
   * Public: her cities need no account. `user` only for a signed-in user with a city, so that response is private
   * to him; the anonymous one is the same for everyone and may be cached for a few minutes.
   */
  app.get('/', async (req, reply): Promise<WorldResT> => {
    const now = new Date();
    const cities = STAR_IDS.map((star) => ({ star, city: weatherPoint(star) }));
    const keys = [...new Set(cities.map((c) => c.city.cityId))];
    const [rows, snows, mine] = await Promise.all([
      app.repos.weather.get(keys),
      app.repos.weather.firstSnow(keys),
      req.user ? app.repos.userCities.get(req.user.id) : Promise.resolve(null)
    ]);
    const byKey = new Map(rows.map((r) => [r.cityKey, r]));
    reply.header('cache-control', req.user ? 'private, no-store' : 'public, max-age=300');
    reply.header('vary', 'authorization');
    return {
      asOf: now.toISOString(),
      talents: cities.map(({ star, city }) => ({ star, cityId: city.cityId, city: CITIES[city.cityId].city, weather: weatherNow(byKey.get(city.cityId), snows, now) })),
      user: mine ? await userWorld(mine, now) : null
    };
  });

  /** Signed-in only: the search goes to a third party (Open-Meteo), so it is not an open proxy for visitors. */
  app.get('/cities', { config: { rateLimit: { max: 30, timeWindow: '1 minute' } } }, async (req, reply) => {
    const user = requireUser(req);
    const { q, lang } = CitySearchQuery.parse(req.query);
    if (!app.weather) return unavailable(reply, 'weather_disabled');
    try {
      return { results: await app.weather.search(q, lang ?? user.lang) };
    } catch (err) {
      req.log.warn({ err: String(err) }, 'city_search_failed');
      return unavailable(reply, 'weather_unavailable');
    }
  });

  app.put('/city', { config: { rateLimit: { max: 20, timeWindow: '10 minutes' } } }, async (req, reply) => {
    const user = requireUser(req);
    const { id, lang } = SetCityReq.parse(req.body);
    const weather = app.weather;
    if (!weather) return unavailable(reply, 'weather_disabled');
    let place;
    try {
      place = await weather.place(id, lang ?? user.lang);
    } catch (err) {
      req.log.warn({ err: String(err) }, 'city_lookup_failed');
      return unavailable(reply, 'weather_unavailable');
    }
    if (!place) throw httpError('city_not_found', 404);
    const row: UserCityRow = { userId: user.id, name: place.name, lat: place.lat, lon: place.lon, updatedAt: new Date().toISOString() };
    await app.repos.userCities.set(row);

    // A square nobody had before has no weather yet: fetch it now, so My page can show it at once. Best effort —
    // the next tick fetches it anyway.
    const now = new Date();
    const key = userCityKey(row.lat, row.lon);
    const [known] = await app.repos.weather.get([key]);
    if (!known?.fetchedAt || now.getTime() - Date.parse(known.fetchedAt) > WEATHER_REFRESH_MS) {
      try {
        const [data] = await weather.forecast([{ lat: row.lat, lon: row.lon }]);
        await app.repos.weather.saved(key, row.lat, row.lon, now.toISOString(), data);
      } catch (err) {
        req.log.warn({ err: String(err) }, 'weather_fetch_failed');
      }
    }
    return { user: await userWorld(row, now) };
  });

  /**
   * Demo mode only (the test site): made-up weather at her point, so rain, snow, a first snow or a warning can be
   * seen on demand (#63 acceptance). The next hourly refresh puts the real weather back.
   */
  app.put('/demo', { config: { rateLimit: { max: 20, timeWindow: '1 minute' } } }, async (req): Promise<WorldDemoResT> => {
    if (!app.demo) throw httpError('not_found', 404);
    requireUser(req);
    const body = WorldDemoReq.parse(req.body);
    const now = new Date();
    const p = herPoint(body.star);
    const data = demoWeatherData(body, now);
    await app.repos.weather.saved(p.key, p.lat, p.lon, now.toISOString(), data);
    if (body.firstSnow) {
      const day = localDate(now, data.utcOffsetSeconds);
      await app.repos.weather.forgetFirstSnow(p.key, winterOf(day));
      await app.repos.weather.markFirstSnow(p.key, winterOf(day), day);
    }
    const [rows, snows] = await Promise.all([app.repos.weather.get([p.key]), app.repos.weather.firstSnow([p.key])]);
    const city = weatherPoint(body.star);
    return { talent: { star: body.star, cityId: city.cityId, city: CITIES[city.cityId].city, weather: weatherNow(rows[0], snows, now) } };
  });

  /** Works with the weather off too: he can always remove what he stored. */
  app.delete('/city', async (req) => {
    const user = requireUser(req);
    return { ok: true as const, removed: await app.repos.userCities.clear(user.id) };
  });
}

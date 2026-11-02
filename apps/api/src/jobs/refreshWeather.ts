import { WEATHER_REFRESH_MS, WEATHER_RETRY_MS, WORLD, isSnowCode, localDate, userCityKey, winterOf, type StarId, type TalentWorld } from '@jstar/shared';
import type { WeatherRow } from '../db/types';
import type { TickJob } from '../lib/tick';
import { FORECAST_BATCH, herPoints } from '../lib/weather';

/** Refreshed a little before the hour is up: the tick comes every 5 minutes, so "due" is checked with that slack. */
const REFRESH_SLACK_MS = 5 * 60_000;
/** Points per run: keeps one tick's share of the provider's limits (and of the tick's budget) bounded. */
const MAX_POINTS_PER_RUN = 200;

const due = (row: WeatherRow | undefined, now: number) =>
  !row || (row.error ? Date.parse(row.triedAt) <= now - WEATHER_RETRY_MS : !row.fetchedAt || Date.parse(row.fetchedAt) <= now - (WEATHER_REFRESH_MS - REFRESH_SLACK_MS));

/**
 * Keeps the weather of her five cities and of every city users chose about an hour old (#62). Runs every tick
 * but fetches only the points that are due, her cities first, so a user city chosen a minute ago gets its weather
 * on the next tick instead of the next hour.
 *
 * When Open-Meteo fails, the points keep their last data (stale after 3 hours, shown as absent) and are tried again
 * after WEATHER_RETRY_MS. The job then reports a failure, which only marks its own row in `job_runs`: the tick's
 * other jobs run as usual. Last in JOBS, so a slow provider never delays her inbox.
 */
export function weatherJob(world: Record<StarId, TalentWorld> = WORLD): TickJob {
  return {
    name: 'weather.refresh',
    everyMs: 0,
    async run({ repos, now, signal, weather, log }) {
      if (!weather) return { off: true };
      const her = herPoints(world);
      const mine = (await repos.userCities.points()).map((p) => ({ key: userCityKey(p.lat, p.lon), lat: p.lat, lon: p.lon }));
      // A square nobody chose any more (he cleared his city or deleted his account) goes with the next tick.
      const pruned = await repos.weather.prune(her.map((p) => p.key));
      const rows = new Map((await repos.weather.all()).map((r) => [r.cityKey, r]));
      const todo = [...her, ...mine].filter((p) => due(rows.get(p.key), now.getTime())).slice(0, MAX_POINTS_PER_RUN);

      const at = now.toISOString();
      let ok = 0;
      let failed = 0;
      const firstSnow: string[] = [];
      for (let i = 0; i < todo.length && !signal.aborted; i += FORECAST_BATCH) {
        const batch = todo.slice(i, i + FORECAST_BATCH);
        let data;
        try {
          data = await weather.forecast(batch, signal);
        } catch (err) {
          failed += batch.length;
          const error = err instanceof Error ? err.message : String(err);
          log.error({ err: error, points: batch.length }, 'weather_fetch_failed');
          for (const p of batch) await repos.weather.failed(p.key, p.lat, p.lon, at, error.slice(0, 200));
          continue;
        }
        for (const [j, p] of batch.entries()) {
          const d = data[j];
          await repos.weather.saved(p.key, p.lat, p.lon, at, d);
          ok++;
          // 初雪: snowing now, recorded once per point and snow season (#63 sends her message from it).
          if (isSnowCode(d.code)) {
            const day = localDate(now, d.utcOffsetSeconds);
            if (await repos.weather.markFirstSnow(p.key, winterOf(day), day)) firstSnow.push(p.key);
          }
        }
      }
      if (failed && !ok) throw new Error('weather_unavailable');
      return { points: her.length + mine.length, due: todo.length, ok, failed, pruned, firstSnow };
    }
  };
}

export const refreshWeather = weatherJob();

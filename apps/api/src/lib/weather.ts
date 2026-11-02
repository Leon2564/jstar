import { z } from 'zod';
import {
  STAR_IDS, WORLD, alertOf, conditionOf, isStale, localDate, roundCoord, sunNow, weatherPoint, winterOf,
  type CityCandidateT, type Lang, type StarId, type TalentWorld, type WeatherData, type WeatherHour, type WeatherNowT
} from '@jstar/shared';
import type { FirstSnowRow, WeatherRow } from '../db/types';

/**
 * Open-Meteo (#62): forecast and place search, both free and without a key or account. The API container has no
 * internet, so on Cloudflare every request goes through the Worker (WEATHER_URL = http://weather.internal, answered
 * by infra/cloudflare), which only forwards these three GET paths to Open-Meteo. Empty WEATHER_URL = call Open-Meteo
 * directly (local dev). Tests pass their own fetch and never reach the network.
 *
 * Open-Meteo's free tier is for non-commercial use (10,000 calls a day, one per point); commercial use needs its
 * paid plan, which only adds an `apikey` parameter and another host (#84).
 */
export interface WeatherPoint { lat: number; lon: number }
export interface PlaceFound { name: string; lat: number; lon: number }
export interface WeatherClient {
  /** Current weather, today's and tomorrow's sun, and the next 6 hours, for each point in order. Throws when the provider fails. */
  forecast(points: WeatherPoint[], signal?: AbortSignal): Promise<WeatherData[]>;
  /** City-level places matching a name, best known first. */
  search(q: string, lang: Lang, signal?: AbortSignal): Promise<CityCandidateT[]>;
  /** A search result looked up again by id; null when unknown or not a city-level place. */
  place(id: number, lang: Lang, signal?: AbortSignal): Promise<PlaceFound | null>;
}

const FORECAST = 'https://api.open-meteo.com';
const GEOCODING = 'https://geocoding-api.open-meteo.com';
const TIMEOUT_MS = 10_000;
/** Open-Meteo takes many points per request; each still counts as one call against its limits. */
export const FORECAST_BATCH = 50;

const nums = z.array(z.number().nullable());
const Forecast = z.object({
  utc_offset_seconds: z.number(),
  current: z.object({
    time: z.number(), temperature_2m: z.number(), weather_code: z.number(), precipitation: z.number(), snowfall: z.number().nullable().optional(),
    wind_speed_10m: z.number(), wind_gusts_10m: z.number().nullable().optional()
  }),
  hourly: z.object({
    time: z.array(z.number()), temperature_2m: nums, weather_code: nums, precipitation: nums, snowfall: nums, wind_speed_10m: nums, wind_gusts_10m: nums
  }),
  daily: z.object({ time: z.array(z.number()), sunrise: z.array(z.number()), sunset: z.array(z.number()) })
});
const Place = z.object({
  id: z.number(), name: z.string(), latitude: z.number(), longitude: z.number(),
  feature_code: z.string().optional(), country: z.string().optional(), admin1: z.string().optional(), population: z.number().optional()
});
const Search = z.object({ results: z.array(Place).optional() });

/**
 * City level only (#62): populated places (towns, cities, capitals) and administrative areas. Sections of a city
 * (PPLX), airports, stations and the like are left out, and historical or abandoned places too.
 */
const CITY_LEVEL = /^(PPL|PPLA[2-5]?|PPLC|PPLG|PPLS|PPLL|ADM[1-5])$/;

/** Open-Meteo's language codes: its Chinese is one set of names, Traditional characters included. */
const GEO_LANG: Record<Lang, string> = { ja: 'ja', 'zh-Hant': 'zh', en: 'en', ko: 'ko' };

const HAN_OR_KANA = /[぀-ヿ㐀-鿿]/;
const HANGUL = /[가-힯]/;

const iso = (unix: number) => new Date(unix * 1000).toISOString();
const n0 = (v: number | null | undefined) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
const clip = (s: string, n: number) => [...s.trim()].slice(0, n).join('');

export function toWeatherData(raw: unknown): WeatherData {
  const r = Forecast.parse(raw);
  const h = r.hourly;
  const next6h: WeatherHour[] = h.time.slice(0, 6).map((t, i) => ({
    at: iso(t), code: n0(h.weather_code[i]), tempC: n0(h.temperature_2m[i]), precipMm: n0(h.precipitation[i]),
    snowCm: n0(h.snowfall[i]), windMs: n0(h.wind_speed_10m[i]), gustMs: n0(h.wind_gusts_10m[i])
  }));
  const days = r.daily.time.map((t, i) => ({
    date: new Date((t + r.utc_offset_seconds) * 1000).toISOString().slice(0, 10), sunrise: iso(r.daily.sunrise[i]), sunset: iso(r.daily.sunset[i])
  }));
  const c = r.current;
  const base = {
    code: c.weather_code, tempC: c.temperature_2m, precipMm: c.precipitation, snowCm: n0(c.snowfall), windMs: c.wind_speed_10m, gustMs: n0(c.wind_gusts_10m),
    utcOffsetSeconds: r.utc_offset_seconds, days, next6h
  };
  return { ...base, alert: alertOf(base) };
}

const withTimeout = (signal?: AbortSignal) => (signal ? AbortSignal.any([signal, AbortSignal.timeout(TIMEOUT_MS)]) : AbortSignal.timeout(TIMEOUT_MS));

/** `relay`: the Worker (production); empty = Open-Meteo directly. */
export function openMeteo(relay: string, f: typeof fetch = fetch): WeatherClient {
  const base = relay.replace(/\/$/, '');
  const url = (origin: string, path: string, params: Record<string, string>) => `${base || origin}${path}?${new URLSearchParams(params)}`;
  const getJson = async (u: string, signal?: AbortSignal): Promise<unknown> => {
    const res = await f(u, { headers: { accept: 'application/json' }, signal: withTimeout(signal) });
    if (!res.ok) throw new Error(`weather_http_${res.status}`);
    return res.json();
  };

  const searchOnce = async (name: string, language: string, signal?: AbortSignal) => {
    const body = Search.parse(await getJson(url(GEOCODING, '/v1/search', { name, count: '10', language, format: 'json' }), signal));
    return body.results ?? [];
  };

  return {
    async forecast(points, signal) {
      if (!points.length) return [];
      const raw = await getJson(url(FORECAST, '/v1/forecast', {
        latitude: points.map((p) => p.lat.toFixed(4)).join(','),
        longitude: points.map((p) => p.lon.toFixed(4)).join(','),
        current: 'temperature_2m,weather_code,precipitation,snowfall,wind_speed_10m,wind_gusts_10m',
        hourly: 'temperature_2m,weather_code,precipitation,snowfall,wind_speed_10m,wind_gusts_10m',
        daily: 'sunrise,sunset',
        timezone: 'auto', forecast_days: '2', forecast_hours: '6', wind_speed_unit: 'ms', timeformat: 'unixtime'
      }), signal);
      // One point answers an object, several an array in the order asked.
      const list = Array.isArray(raw) ? raw : [raw];
      if (list.length !== points.length) throw new Error('weather_bad_response');
      try { return list.map(toWeatherData); } catch { throw new Error('weather_bad_response'); }
    },

    async search(q, lang, signal) {
      const name = clip(q, 60);
      // The index matches names per language, and Japanese / Chinese names often only with 市 ("台北" finds nothing,
      // "台北市" does), so a few spellings are asked for at once and merged.
      const langs = new Set([GEO_LANG[lang]]);
      const names = new Set([name]);
      if (HAN_OR_KANA.test(name)) {
        langs.add('ja'); langs.add('zh');
        if (!/[市都府県縣]$/.test(name)) names.add(`${name}市`);
      }
      else if (HANGUL.test(name)) langs.add('ko');
      else langs.add('en');
      const asks = [...names].flatMap((n) => [...langs].map((l) => ({ n, l })));
      const settled = await Promise.allSettled(asks.map(({ n, l }) => searchOnce(n, l, signal).then((r) => ({ l, r }))));
      const answers = settled.flatMap((s) => (s.status === 'fulfilled' ? [s.value] : []));
      if (!answers.length) throw (settled[0] as PromiseRejectedResult).reason;
      const byId = new Map<number, z.infer<typeof Place>>();
      // The user's own language first, so the name shown is in it whenever the index has one.
      for (const { r } of [...answers].sort((a, b) => Number(b.l === GEO_LANG[lang]) - Number(a.l === GEO_LANG[lang]))) {
        for (const p of r) if (!byId.has(p.id) && CITY_LEVEL.test(p.feature_code ?? '')) byId.set(p.id, p);
      }
      return [...byId.values()]
        .sort((a, b) => n0(b.population) - n0(a.population))
        .slice(0, 5)
        .map((p) => ({ id: p.id, name: clip(p.name, 60), region: p.admin1 ? clip(p.admin1, 60) : null, country: p.country ? clip(p.country, 60) : null, lat: roundCoord(p.latitude), lon: roundCoord(p.longitude) }));
    },

    async place(id, lang, signal) {
      const res = await f(url(GEOCODING, '/v1/get', { id: String(id), language: GEO_LANG[lang] }), { headers: { accept: 'application/json' }, signal: withTimeout(signal) });
      if (res.status === 400 || res.status === 404) return null;
      if (!res.ok) throw new Error(`weather_http_${res.status}`);
      const p = Place.safeParse(await res.json());
      if (!p.success || !CITY_LEVEL.test(p.data.feature_code ?? '')) return null;
      return { name: clip(p.data.name, 60), lat: roundCoord(p.data.latitude), lon: roundCoord(p.data.longitude) };
    }
  };
}

// ---------------------------------------------------------------- points and what readers get

/** Her weather points: each talent's confirmed hometown or Tokyo (world.ts `weatherPoint`), once per city. */
export function herPoints(world: Record<StarId, TalentWorld> = WORLD): { key: string; lat: number; lon: number }[] {
  const out = new Map<string, { key: string; lat: number; lon: number }>();
  for (const id of STAR_IDS) {
    const h = weatherPoint(id, world);
    out.set(h.cityId, { key: h.cityId, lat: h.lat, lon: h.lon });
  }
  return [...out.values()];
}

/** A stored point as `/v1/world` shows it; null until its first successful fetch. */
export function weatherNow(row: WeatherRow | undefined, snows: FirstSnowRow[], now: Date): WeatherNowT | null {
  const d = row?.data;
  if (!row?.fetchedAt || !d) return null;
  const sun = sunNow(d, now);
  if (!sun) return null;
  const winter = winterOf(localDate(now, d.utcOffsetSeconds));
  return {
    weather: conditionOf(d.code), code: d.code, tempC: d.tempC, precipMm: d.precipMm, windMs: d.windMs,
    sunrise: sun.sunrise, sunset: sun.sunset, isDay: sun.isDay, alert: d.alert,
    next6h: d.next6h.map((h) => ({ at: h.at, weather: conditionOf(h.code), tempC: h.tempC, precipMm: h.precipMm })),
    updatedAt: row.fetchedAt, stale: isStale(row.fetchedAt, now),
    firstSnow: snows.find((s) => s.cityKey === row.cityKey && s.winter === winter)?.day ?? null
  };
}

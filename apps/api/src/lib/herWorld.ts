import {
  WEATHER_EVENT_RULES, WORLD, alertOf, confirmedWorld, isSnowCode, localDate, localText, routineNow, sceneWeatherOf, seasonsOn, sunPhase, userCityKey, weatherPoint,
  type CalendarEventInfo, type Lang, type Presence, type SceneWeather, type StarId, type TalentWorld, type WeatherAlert, type WeatherCondition, type WeatherData, type WeatherNowT
} from '@jstar/shared';
import type { Repos } from '../db/types';
import type { AgentWorld } from './agent';
import { weatherNow } from './weather';

/**
 * Her world as the chat, the scenes and the weather events read it (#63), built from the stored weather (#62).
 * Stale data (the provider has been down for hours) counts as none: she says nothing about the weather rather than
 * something old (#62 降级).
 */

const JST_SECONDS = 9 * 3600;

/** The weather at her window now: her confirmed hometown, else Tokyo (world.ts `weatherPoint`); null when unknown or stale. */
export async function herWeather(repos: Repos, star: StarId, now: Date, world: Record<StarId, TalentWorld> = WORLD): Promise<WeatherNowT | null> {
  const key = weatherPoint(star, world).cityId;
  const [rows, snows] = await Promise.all([repos.weather.get([key]), repos.weather.firstSnow([key])]);
  const w = weatherNow(rows[0], snows, now);
  return w && !w.stale ? w : null;
}

/** His own city's weather now (#62, optional); null when he chose none or it is unknown or stale. */
export async function userWeather(repos: Repos, userId: string, now: Date): Promise<{ name: string; weather: WeatherNowT } | null> {
  const city = await repos.userCities.get(userId);
  if (!city) return null;
  const key = userCityKey(city.lat, city.lon);
  const [rows, snows] = await Promise.all([repos.weather.get([key]), repos.weather.firstSnow([key])]);
  const w = weatherNow(rows[0], snows, now);
  return w && !w.stale ? { name: city.name, weather: w } : null;
}

/** What the scene engine's `trigger.weather` is checked against; null (unmet) when the weather is unknown. */
export async function sceneWeather(repos: Repos, star: StarId, now: Date): Promise<SceneWeather | null> {
  const w = await herWeather(repos, star, now);
  return w ? sceneWeatherOf(w.weather) : null;
}

const hot = (w: Pick<WeatherNowT, 'alert' | 'tempC'>) => w.alert === 'heat' || w.tempC >= WEATHER_EVENT_RULES.hotC;

/**
 * The script variables (#63, scenes/constants SCENE_VARS) of a run starting now: `hot` in a heatwave at her window,
 * the same test as her prompt's `hot` (アリス turns the dance down because of the heat, #69). Unknown or stale
 * weather sets none: she falls back to her ordinary line.
 */
export async function sceneVars(repos: Repos, star: StarId, now: Date): Promise<string[]> {
  const w = await herWeather(repos, star, now);
  return w && hot(w) ? ['hot'] : [];
}
/** Today in Japan, where all her cities are: the calendar day her first snow and seasons are counted in. */
export const herToday = (now: Date) => localDate(now, JST_SECONDS);

/**
 * The persona service's `world` (apps/agent/app/schemas.py World). Her city is named only once her hometown is
 * confirmed (#48, #84); until then she speaks of "here" and the prompt forbids naming it. Her cities are all in Japan,
 * so "today" is the JST day. `userId` null (a visitor's trial chat): her side only.
 */
export async function agentWorld(
  repos: Repos, star: StarId, lang: Lang, userId: string | null, now: Date, world: Record<StarId, TalentWorld> = WORLD, today: CalendarEventInfo[] = []
): Promise<AgentWorld | null> {
  const [her, mine] = await Promise.all([herWeather(repos, star, now, world), userId ? userWeather(repos, userId, now) : Promise.resolve(null)]);
  const hometown = confirmedWorld(star, world).hometown;
  const sakura = seasonsOn(herToday(now).slice(5), star, world).includes('sakura');
  if (!her && !sakura && !today.length) return null;
  const city = hometown ? localText(hometown.city, lang) : null;
  return {
    city,
    sakura,
    now: her && {
      weather: her.weather, tempC: Math.round(her.tempC), isDay: her.isDay, phase: sunPhase(her.sunrise, her.sunset, now),
      alert: her.alert, firstSnow: her.firstSnow === herToday(now), hot: hot(her)
    },
    // Two places are compared only when both are known (#63: 用户填了城市就对比两地，没填不提).
    user: her && mine ? { name: mine.name, weather: mine.weather.weather, tempC: Math.round(mine.weather.tempC), isDay: mine.weather.isDay } : null,
    ...(today.length ? { today } : {})
  };
}

/**
 * What she is doing now (#60, world.ts `routineNow`) for the persona service: at home, out or asleep, and the phrase the
 * home strip shows, in English like her messages' `status` (#58). Asleep, he has just woken her and she answers drowsily.
 */
export function agentRoutine(star: StarId, now: Date, world: Record<StarId, TalentWorld> = WORLD): { presence: Presence; status: string } {
  const r = routineNow(star, now, world);
  return { presence: r.presence, status: r.status.en };
}

/**
 * What the greeting cache is keyed on besides day and language: the weather she would open with. When it starts to
 * rain after today's greeting was written, the next visit gets a new one that mentions the rain (#63 acceptance).
 */
/** What her first words are about when the weather is the news (#63) — the persona service's greeting_weather. */
export type GreetingWeather = 'rain' | 'snow' | 'first_snow' | 'alert';
export function greetingWeather(w: AgentWorld | null): GreetingWeather | null {
  const n = w?.now;
  if (!n) return null;
  if (n.firstSnow) return 'first_snow';
  if (n.alert && n.alert !== 'heat') return 'alert';
  const kind = sceneWeatherOf(n.weather);
  return kind === 'rain' || kind === 'snow' ? kind : null;
}

export function greetingMood(w: AgentWorld | null): string {
  // The day she would open with (#61): a greeting written before his birthday began in his zone is not reused on it.
  const day = w?.today?.[0] ? `cal-${w.today[0].kind}` : '';
  return [weatherMood(w), day].filter(Boolean).join('+');
}

/**
 * The weather in her greeting's cache key (N-47): its sky kind always (clear / cloudy / rain / snow, and day or night),
 * so a greeting written under a clear sky is not shown once the chip beside it says it is cloudy.
 */
function weatherMood(w: AgentWorld | null): string {
  const n = w?.now;
  if (!n) return 'sky-unknown';
  if (n.firstSnow) return 'first-snow';
  if (n.alert) return `alert-${n.alert}`;
  return `${sceneWeatherOf(n.weather)}-${n.isDay ? 'day' : 'night'}`;
}

// ---------------------------------------------------------------- demo weather (test site)

export interface DemoWeather { weather: WeatherCondition; alert?: WeatherAlert | null; tempC?: number; firstSnow?: boolean }
const DEMO_CODE: Record<WeatherCondition, number> = { clear: 0, cloudy: 3, fog: 45, rain: 63, snow: 73, thunder: 95 };

/**
 * A made-up reading at a point, for the test site's acceptance (`PUT /v1/world/demo`, demo mode only) and for tests:
 * today's real-ish sunrise and sunset (05:30 / 17:45 local), the sky asked for, and a warning when asked. The next
 * hourly refresh replaces it with the real weather.
 */
export function demoWeatherData(d: DemoWeather, now: Date, utcOffsetSeconds = JST_SECONDS): WeatherData {
  const code = DEMO_CODE[d.weather];
  const snow = isSnowCode(code);
  const alert = d.alert ?? null;
  const rain = alert === 'heavy_rain' || alert === 'storm' ? 25 : d.weather === 'rain' || d.weather === 'thunder' ? 3 : 0;
  const wind = alert === 'storm' ? 24 : alert === 'strong_wind' ? 17 : 3;
  const tempC = d.tempC ?? (alert === 'heat' ? 36 : snow ? -1 : 18);
  const day = (offset: number) => {
    const date = localDate(new Date(now.getTime() + offset * 86_400_000), utcOffsetSeconds);
    const midnight = Date.parse(`${date}T00:00:00Z`) - utcOffsetSeconds * 1000;
    return { date, sunrise: new Date(midnight + 5.5 * 3600_000).toISOString(), sunset: new Date(midnight + 17.75 * 3600_000).toISOString() };
  };
  const hour = now.getTime() - (now.getTime() % 3600_000);
  const next6h = [0, 1, 2, 3, 4, 5].map((i) => ({
    at: new Date(hour + i * 3600_000).toISOString(), code, tempC, precipMm: rain, snowCm: snow ? (alert === 'heavy_snow' ? 2 : 0.3) : 0, windMs: wind, gustMs: wind * 1.6
  }));
  const base = { code, tempC, precipMm: rain, snowCm: snow ? 0.3 : 0, windMs: wind, gustMs: wind * 1.6, utcOffsetSeconds, days: [day(0), day(1)], next6h };
  // The same approximation the real data goes through, unless a warning was asked for.
  return { ...base, alert: alert ?? alertOf(base) };
}

/** Her point's key and position (the demo route writes there). */
export function herPoint(star: StarId): { key: string; lat: number; lon: number } {
  const c = weatherPoint(star);
  return { key: c.cityId, lat: c.lat, lon: c.lon };
}

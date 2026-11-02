/**
 * Weather in her city (#62): the rules shared by the API (which fetches and stores it) and its readers — the web's
 * room light and rain / snow layers, her prompt and the weather events (#60, #63).
 *
 * Source: Open-Meteo (no key, no account). For Japan its default model blends in the JMA's own 5 km model (MSM),
 * so her cities get the forecast the JMA publishes. Warnings are approximated from rain, snow, wind and heat
 * thresholds below; the JMA's official warnings are a follow-up (#62: JMA 警报接入列为待办).
 */

/** What the web draws and the prompt says; everything the WMO codes distinguish that she would notice. */
export const WEATHER_CONDITIONS = ['clear', 'cloudy', 'fog', 'rain', 'snow', 'thunder'] as const;
export type WeatherCondition = (typeof WEATHER_CONDITIONS)[number];

/** Most severe first: when several apply, the first is the one reported. */
export const WEATHER_ALERTS = ['storm', 'heavy_rain', 'heavy_snow', 'strong_wind', 'heat'] as const;
export type WeatherAlert = (typeof WEATHER_ALERTS)[number];

/** Her five cities (and users' cities) are refreshed about hourly; the tick runs every 5 minutes. */
export const WEATHER_REFRESH_MS = 60 * 60_000;
/** After a failed fetch, the point is tried again after this long, so an outage is not hammered every tick. */
export const WEATHER_RETRY_MS = 15 * 60_000;
/** Older than this, the data is flagged stale and must be treated as absent: no weather shown, none in her prompt (#62). */
export const WEATHER_STALE_MS = 3 * 60 * 60_000;

/**
 * Warning approximations, from the JMA's own descriptive scales (気象庁「雨の強さと降り方」「風の強さと吹き方」)
 * and its 猛暑日 definition. Hourly values over the next 6 hours (and the current one).
 */
export const WEATHER_THRESHOLDS = {
  /** 強い雨 (20–30 mm/h): どしゃ降り. */
  heavyRainMmPerH: 20,
  /** 強い風 (15–20 m/s mean wind): 風に向かって歩けない. */
  strongWindMs: 15,
  /** 非常に強い風 (20 m/s and more) together with rain: typhoon-like, she asks him to stay safe (#63). */
  stormWindMs: 20,
  stormRainMmPerH: 10,
  /** Snow over the next 6 hours; around the 大雪注意報 level of the Kanto plain (5 cm in 12 h). */
  heavySnowCm: 5,
  /** 猛暑日. */
  heatC: 35
} as const;

/** One hour of the forecast. Times are ISO UTC. */
export interface WeatherHour {
  at: string; code: number; tempC: number; precipMm: number; snowCm: number; windMs: number; gustMs: number;
}
/** A local day's sunrise and sunset (ISO UTC); `date` is the local calendar day, YYYY-MM-DD. */
export interface SunDay { date: string; sunrise: string; sunset: string }

/** What is stored per point after a successful fetch (`weather.data`). */
export interface WeatherData {
  /** WMO weather code now. */
  code: number;
  tempC: number;
  precipMm: number;
  snowCm: number;
  windMs: number;
  gustMs: number;
  /** Offset of the point's local time from UTC, for its calendar day. */
  utcOffsetSeconds: number;
  /** Today and tomorrow, local. */
  days: SunDay[];
  /** From the current hour on. */
  next6h: WeatherHour[];
  alert: WeatherAlert | null;
}

const SNOW_CODES = new Set([71, 73, 75, 77, 85, 86]);
export const isSnowCode = (code: number) => SNOW_CODES.has(code);

/** WMO 4677 codes as Open-Meteo reports them. Unknown codes read as cloudy: the least surprising sky. */
export function conditionOf(code: number): WeatherCondition {
  if (code === 0 || code === 1) return 'clear';
  if (code === 2 || code === 3) return 'cloudy';
  if (code === 45 || code === 48) return 'fog';
  if ((code >= 51 && code <= 67) || (code >= 80 && code <= 82)) return 'rain';
  if (SNOW_CODES.has(code)) return 'snow';
  if (code >= 95 && code <= 99) return 'thunder';
  return 'cloudy';
}

export function alertOf(d: Pick<WeatherData, 'tempC' | 'precipMm' | 'windMs'> & { next6h: Pick<WeatherHour, 'tempC' | 'precipMm' | 'snowCm' | 'windMs'>[] }): WeatherAlert | null {
  const T = WEATHER_THRESHOLDS;
  const rain = Math.max(d.precipMm, ...d.next6h.map((h) => h.precipMm));
  const wind = Math.max(d.windMs, ...d.next6h.map((h) => h.windMs));
  const heat = Math.max(d.tempC, ...d.next6h.map((h) => h.tempC));
  const snow = d.next6h.reduce((s, h) => s + h.snowCm, 0);
  if (wind >= T.stormWindMs && rain >= T.stormRainMmPerH) return 'storm';
  if (rain >= T.heavyRainMmPerH) return 'heavy_rain';
  if (snow >= T.heavySnowCm) return 'heavy_snow';
  if (wind >= T.strongWindMs) return 'strong_wind';
  if (heat >= T.heatC) return 'heat';
  return null;
}

/** The local calendar day (YYYY-MM-DD) at a point `utcOffsetSeconds` from UTC. */
export function localDate(at: Date, utcOffsetSeconds: number): string {
  return new Date(at.getTime() + utcOffsetSeconds * 1000).toISOString().slice(0, 10);
}

/**
 * The snow season a day belongs to, as the JMA counts 初雪: the 寒候年 runs August to July and is named after the
 * year it ends in, so a first snow in November 2026 and one in January 2027 are the same season, 2027.
 */
export function winterOf(date: string): number {
  const year = Number(date.slice(0, 4));
  return Number(date.slice(5, 7)) >= 8 ? year + 1 : year;
}

/** Today's sunrise and sunset at the point, and whether the sun is up now (not when it was fetched). */
export function sunNow(d: Pick<WeatherData, 'days' | 'utcOffsetSeconds'>, now: Date): { sunrise: string; sunset: string; isDay: boolean } | null {
  const today = localDate(now, d.utcOffsetSeconds);
  const day = d.days.find((x) => x.date === today) ?? d.days[0];
  if (!day) return null;
  const t = now.toISOString();
  return { sunrise: day.sunrise, sunset: day.sunset, isDay: t >= day.sunrise && t < day.sunset };
}

/** Whether data fetched at `fetchedAt` may still be shown and told to her. */
export const isStale = (fetchedAt: string, now: Date) => now.getTime() - Date.parse(fetchedAt) > WEATHER_STALE_MS;

/**
 * A user's own city is kept at city level only (#62: 只到城市级别): a name and a position rounded to 0.1°
 * (about 11 km), never an address or the device's location.
 */
export const roundCoord = (v: number) => Math.round(v * 10) / 10;
/** The weather point of a user's city. Users in the same 0.1° square share one point (and one fetch). */
export const userCityKey = (lat: number, lon: number) => `ll:${roundCoord(lat).toFixed(1)},${roundCoord(lon).toFixed(1)}`;

// ---------------------------------------------------------------- her world (#63)

/**
 * The scene scripts' smaller weather vocabulary (scenes/constants WEATHERS): a thunderstorm is rain to her, fog is
 * a grey sky. Scene `trigger.weather` and wake-up lines (#57) are matched against this.
 */
export type SceneWeather = 'clear' | 'cloudy' | 'rain' | 'snow';
export function sceneWeatherOf(c: WeatherCondition): SceneWeather {
  return c === 'thunder' ? 'rain' : c === 'fog' ? 'cloudy' : c;
}

/** Where the sun is at her window: the room's light follows her city's real sunrise and sunset, not the viewer's clock. */
export type SunPhase = 'dawn' | 'day' | 'dusk' | 'night';
const MIN = 60_000;
export function sunPhase(sunrise: string, sunset: string, now: Date): SunPhase {
  const t = now.getTime();
  const up = Date.parse(sunrise);
  const down = Date.parse(sunset);
  if (t < up - 30 * MIN || t >= down + 40 * MIN) return 'night';
  if (t < up + 90 * MIN) return 'dawn';
  if (t >= down - 90 * MIN) return 'dusk';
  return 'day';
}

/**
 * Moments only weather makes (#63), each a message in her inbox with her own line (#82 `lines.<star>.weather`):
 * the season's first snow, a warning that makes her worry about him, a rainy night.
 */
export const WEATHER_EVENTS = ['firstSnow', 'typhoon', 'rainyNight'] as const;
export type WeatherEvent = (typeof WEATHER_EVENTS)[number];

/**
 * Warnings she sends the `typhoon` lines for, and which of her three: every talent's set goes typhoon, wind,
 * heavy rain, in that order (packages/shared/tests/weather.test.ts holds the lines to it). Snow and heat warnings
 * have no line of their own, so they only reach her prompt.
 */
export const CONCERN_LINE: Partial<Record<WeatherAlert, 0 | 1 | 2>> = { storm: 0, strong_wind: 1, heavy_rain: 2 };

/**
 * How often the weather may speak for her (#63). She is not a forecast: at most one weather message per talent per
 * day and two per user per day across talents, a rainy night only every few days, and only to users who opened her
 * room lately, so nobody who left comes back to a pile of weather.
 */
export const WEATHER_EVENT_RULES = {
  /** He opened her room (event `room.entered`) within this many JST days. */
  activeDays: 7,
  /** Rolling 24 hours, across all five. */
  perUserPerDay: 2,
  /** Rainy nights come in runs (梅雨): one such message per talent in this many days. */
  rainyNightEveryDays: 3,
  /** Local hours she may write in, [from, to): a first snow at 03:00 waits for the morning. */
  hours: [7, 23] as const,
  /** Hot enough to reach her words and the room's light (afternoon glare; アリス's heat refusal, #69). */
  hotC: 32
} as const;

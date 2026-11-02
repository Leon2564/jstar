import { describe, expect, it } from 'vitest';
import { LINES } from '../src/lines';
import { WEATHERS } from '../src/scenes/constants';
import {
  CONCERN_LINE, WEATHER_ALERTS, WEATHER_CONDITIONS, WEATHER_STALE_MS, alertOf, sceneWeatherOf, sunPhase, conditionOf, isSnowCode, isStale, localDate, roundCoord, sunNow, userCityKey, winterOf
} from '../src/weather';

const calm = { tempC: 20, precipMm: 0, windMs: 2, next6h: [] as { tempC: number; precipMm: number; snowCm: number; windMs: number }[] };
const hour = (h: Partial<(typeof calm.next6h)[number]>) => ({ tempC: 20, precipMm: 0, snowCm: 0, windMs: 2, ...h });

describe('weather rules (#62)', () => {
  it('reads every WMO code Open-Meteo reports as one of the skies the web draws', () => {
    expect([0, 1].map(conditionOf)).toEqual(['clear', 'clear']);
    expect([2, 3].map(conditionOf)).toEqual(['cloudy', 'cloudy']);
    expect([45, 48].map(conditionOf)).toEqual(['fog', 'fog']);
    expect([51, 53, 55, 56, 57, 61, 63, 65, 66, 67, 80, 81, 82].every((c) => conditionOf(c) === 'rain')).toBe(true);
    expect([71, 73, 75, 77, 85, 86].every((c) => conditionOf(c) === 'snow' && isSnowCode(c))).toBe(true);
    expect([95, 96, 99].every((c) => conditionOf(c) === 'thunder')).toBe(true);
    expect(conditionOf(42)).toBe('cloudy');
    for (let c = 0; c < 100; c++) expect(WEATHER_CONDITIONS).toContain(conditionOf(c));
    expect(isSnowCode(61)).toBe(false);
  });

  it('approximates warnings from rain, snow, wind and heat, the most severe first', () => {
    expect(alertOf(calm)).toBeNull();
    expect(alertOf({ ...calm, precipMm: 20 })).toBe('heavy_rain');
    expect(alertOf({ ...calm, next6h: [hour({ precipMm: 19.9 })] })).toBeNull();
    expect(alertOf({ ...calm, next6h: [hour({ precipMm: 25 })] })).toBe('heavy_rain');
    expect(alertOf({ ...calm, next6h: [hour({ windMs: 16 })] })).toBe('strong_wind');
    // Typhoon-like: very strong wind with rain.
    expect(alertOf({ ...calm, windMs: 22, next6h: [hour({ precipMm: 12 })] })).toBe('storm');
    expect(alertOf({ ...calm, windMs: 22 })).toBe('strong_wind');
    expect(alertOf({ ...calm, next6h: [hour({ snowCm: 2 }), hour({ snowCm: 3 })] })).toBe('heavy_snow');
    expect(alertOf({ ...calm, next6h: [hour({ snowCm: 2 })] })).toBeNull();
    expect(alertOf({ ...calm, next6h: [hour({ tempC: 35.2 })] })).toBe('heat');
    expect(alertOf({ ...calm, tempC: 36, precipMm: 30 })).toBe('heavy_rain');
  });

  it('counts first snow by the JMA snow season (August–July), so one first snow per city per year', () => {
    expect(winterOf('2026-08-01')).toBe(2027);
    expect(winterOf('2026-11-20')).toBe(2027);
    expect(winterOf('2027-01-10')).toBe(2027);
    expect(winterOf('2027-07-31')).toBe(2027);
    expect(winterOf('2027-08-01')).toBe(2028);
  });

  it('takes the local day, and today\'s sun, at the point', () => {
    const at = new Date('2026-09-26T16:30:00Z');
    expect(localDate(at, 9 * 3600)).toBe('2026-09-27');
    expect(localDate(at, 0)).toBe('2026-09-26');
    const d = {
      utcOffsetSeconds: 9 * 3600,
      days: [
        { date: '2026-09-26', sunrise: '2026-09-25T20:31:54.000Z', sunset: '2026-09-26T08:33:01.000Z' },
        { date: '2026-09-27', sunrise: '2026-09-26T20:32:41.000Z', sunset: '2026-09-27T08:31:33.000Z' }
      ]
    };
    // 01:30 JST on the 27th: the 27th's sun, before sunrise.
    expect(sunNow(d, at)).toEqual({ sunrise: d.days[1].sunrise, sunset: d.days[1].sunset, isDay: false });
    expect(sunNow(d, new Date('2026-09-26T03:00:00Z'))).toMatchObject({ sunrise: d.days[0].sunrise, isDay: true });
    expect(sunNow(d, new Date('2026-09-26T09:00:00Z'))).toMatchObject({ sunset: d.days[0].sunset, isDay: false });
    expect(sunNow({ ...d, days: [] }, at)).toBeNull();
  });

  it('flags data older than 3 hours as stale', () => {
    const now = new Date('2026-09-26T12:00:00Z');
    expect(isStale(new Date(now.getTime() - WEATHER_STALE_MS).toISOString(), now)).toBe(false);
    expect(isStale(new Date(now.getTime() - WEATHER_STALE_MS - 1000).toISOString(), now)).toBe(true);
  });

  it('keeps a user city at 0.1°, and users in one square share its point', () => {
    expect(roundCoord(25.05306)).toBe(25.1);
    expect(roundCoord(121.52639)).toBe(121.5);
    expect(roundCoord(-0.12574)).toBe(-0.1);
    expect(userCityKey(25.05306, 121.52639)).toBe('ll:25.1,121.5');
    expect(userCityKey(25.1, 121.5)).toBe(userCityKey(25.08, 121.46));
    expect(userCityKey(-0.04, 0)).toBe('ll:0.0,0.0');
  });
});

describe('her world (#63)', () => {
  it('reads every sky in the scene scripts\' vocabulary: a thunderstorm is rain, fog is a grey sky', () => {
    for (const c of WEATHER_CONDITIONS) expect(WEATHERS).toContain(sceneWeatherOf(c));
    expect(sceneWeatherOf('thunder')).toBe('rain');
    expect(sceneWeatherOf('fog')).toBe('cloudy');
    expect(sceneWeatherOf('snow')).toBe('snow');
  });

  it('lights her room by her real sunrise and sunset', () => {
    const rise = '2026-09-25T20:30:00Z';
    const set = '2026-09-26T08:45:00Z';
    const at = (iso: string) => sunPhase(rise, set, new Date(iso));
    expect(at('2026-09-25T19:00:00Z')).toBe('night');
    expect(at('2026-09-25T20:10:00Z')).toBe('dawn');
    expect(at('2026-09-25T21:59:00Z')).toBe('dawn');
    expect(at('2026-09-26T03:00:00Z')).toBe('day');
    expect(at('2026-09-26T07:30:00Z')).toBe('dusk');
    expect(at('2026-09-26T09:20:00Z')).toBe('dusk');
    expect(at('2026-09-26T09:30:00Z')).toBe('night');
  });

  it('has a worried line for every warning it names, in the order every talent\'s set is written (typhoon, wind, heavy rain)', () => {
    for (const a of Object.keys(CONCERN_LINE)) expect(WEATHER_ALERTS).toContain(a);
    for (const l of Object.values(LINES)) {
      const [typhoon, wind, rain] = l.weather.typhoon.map((x) => x.ja);
      expect(typhoon).toMatch(/台風/);
      expect(wind).toMatch(/風/);
      expect(rain).toMatch(/大雨/);
    }
    expect(CONCERN_LINE).toEqual({ storm: 0, strong_wind: 1, heavy_rain: 2 });
  });
});

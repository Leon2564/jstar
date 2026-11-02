/**
 * Her window (#63): what the companion home draws from the weather in her city (`GET /v1/world`, #62). The room's
 * clip is never re-shot: the light follows her real sunrise and sunset, and rain, snow, blossoms or a storm are
 * CSS layers (components/weatherRoom.tsx, loaded only when there is something to draw).
 */
import { useEffect, useState } from 'react';
import type { WorldTalentT } from '@jstar/shared/contracts';
import { WEATHER_EVENT_RULES, sunPhase, type SunPhase, type WeatherCondition } from '@jstar/shared/weather';
import { seasonsOn } from '@jstar/shared/world';
import type { StarId } from '@jstar/shared/domain';
import { http, serverMode } from '../services/http';

export type Sky = 'clear' | 'cloudy' | 'fog' | 'rain' | 'snow' | 'storm';
export interface Room {
  sky: Sky;
  phase: SunPhase;
  /** Afternoon glare. */
  hot: boolean;
  /** Petals in her city's cherry-blossom days (world.ts SEASONS), when nothing is falling from the sky. */
  sakura: boolean;
  /** What the chip says; null for a room drawn without data (a demo override). */
  condition: WeatherCondition | null;
  tempC: number | null;
}

/** The home's grading classes (immersive.css `tod-*`) for her sun, instead of the viewer's clock. */
export const TOD_OF_PHASE: Record<SunPhase, 'morning' | 'day' | 'evening' | 'night'> = { dawn: 'morning', day: 'day', dusk: 'evening', night: 'night' };

const JST_MS = 9 * 3600_000;
const md = (now: Date) => new Date(now.getTime() + JST_MS).toISOString().slice(5, 10);

/** Her room from her city's weather; null when there is none or it is stale (#62 降级: shown as absent). */
export function roomOf(t: WorldTalentT | undefined, now: Date = new Date()): Room | null {
  const w = t?.weather;
  if (!t || !w || w.stale) return null;
  const wet = w.weather === 'rain' || w.weather === 'thunder';
  // A typhoon-like storm, or strong wind with rain: slanted, heavier rain. Wind alone draws no rain.
  const storm = w.alert === 'storm' || (wet && (w.alert === 'strong_wind' || w.alert === 'heavy_rain'));
  const sky: Sky = storm ? 'storm' : w.weather === 'rain' || w.weather === 'thunder' ? 'rain' : w.weather;
  const phase = sunPhase(w.sunrise, w.sunset, now);
  return {
    sky, phase,
    hot: (w.alert === 'heat' || w.tempC >= WEATHER_EVENT_RULES.hotC) && phase === 'day',
    sakura: seasonsOn(md(now), t.star as StarId).includes('sakura') && sky !== 'rain' && sky !== 'snow' && sky !== 'storm',
    condition: w.weather, tempC: Math.round(w.tempC)
  };
}

const DEMO_SKIES: readonly string[] = ['clear', 'cloudy', 'fog', 'rain', 'snow', 'storm', 'sakura', 'hot'];
/**
 * `?wx=rain` (also snow, storm, sakura, hot, …): the prototype and the test site draw that room without the data,
 * for screenshots and review. Never in production, where the room only ever shows the real weather.
 */
export function demoRoom(q: string | null, phase: SunPhase = 'night'): Room | null {
  if (!q || !DEMO_SKIES.includes(q)) return null;
  const sky: Sky = q === 'sakura' || q === 'hot' ? 'clear' : (q as Sky);
  return { sky, phase: q === 'hot' ? 'day' : phase, hot: q === 'hot', sakura: q === 'sakura', condition: null, tempC: null };
}

/** Whether a room needs the effect chunk at all: a clear day with nothing falling needs only the light. */
export const needsLayer = (r: Room | null): r is Room => !!r && (r.sky !== 'clear' || r.hot || r.sakura || r.phase === 'night');

let cache: { at: number; talents: WorldTalentT[] } | null = null;
const FRESH_MS = 5 * 60_000;

/** The five cities and their weather from `/v1/world` (server mode only; fetched at most every five minutes across visits). */
export function useWorld(): WorldTalentT[] | null {
  const [talents, setTalents] = useState<WorldTalentT[] | null>(() => (cache && Date.now() - cache.at < FRESH_MS ? cache.talents : null));
  useEffect(() => {
    if (!serverMode() || (cache && Date.now() - cache.at < FRESH_MS)) return;
    let live = true;
    // A weather outage must never break her room: no data simply means no weather.
    http.world().then((w) => { cache = { at: Date.now(), talents: w.talents }; if (live) setTalents(w.talents); }).catch(() => undefined);
    return () => { live = false; };
  }, []);
  return talents;
}

/** Her room now, from `/v1/world`. */
export function useHerRoom(star: string): Room | null {
  const talents = useWorld();
  return roomOf(talents?.find((t) => t.star === star));
}

/** Tests only. */
export function resetHerRoom() { cache = null; }

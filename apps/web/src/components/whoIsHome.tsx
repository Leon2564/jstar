import { useEffect, useState } from 'react';
import type { WorldTalentT } from '@jstar/shared/contracts';
import { localText } from '@jstar/shared/domain';
import { confirmedWorld, nextRoutineChange, routinesNow, type RoutineNow } from '@jstar/shared/world';
import type { StarId } from '@jstar/shared/domain';
import type { Key } from '../i18n';
import { useT } from '../lib/store';
import '../styles/now.css';

/**
 * Who's home now (#60): the five on their own clocks, under the faces of the companion home. Their routines come from
 * world.ts `routineNow` (JST, all five live in Japan) and change only at its slot boundaries, so the home re-renders
 * four times a day for them; only the clock line ticks, once a minute, on its own. Weather is each city's from
 * `/v1/world` (#62) and is left out when missing or stale; the city is named only once her hometown is confirmed (#48).
 */

/** All five routines now, re-read at the next slot boundary (never on a frame or a second timer). */
export function useRoutines(): Record<StarId, RoutineNow> {
  const read = () => Object.fromEntries(routinesNow().map((r) => [r.star, r])) as Record<StarId, RoutineNow>;
  const [routines, setRoutines] = useState(read);
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout>;
    const arm = () => {
      // A second past the boundary, so the new slot is the one read.
      timer = setTimeout(() => { setRoutines(read()); arm(); }, Math.max(1000, nextRoutineChange().getTime() - Date.now() + 1000));
    };
    arm();
    return () => clearTimeout(timer);
  }, []);
  return routines;
}

type Weather = NonNullable<WorldTalentT['weather']>;
/** Her city's weather, only while it is fresh (#62 降级: stale or missing is shown as absent). */
export const freshWeather = (talents: WorldTalentT[] | null, star: string): Weather | null => {
  const w = talents?.find((x) => x.star === star)?.weather;
  return w && !w.stale ? w : null;
};

// Text-style symbols (VS15), not colour emoji: small enough to sit beside a word under her face.
const SKY: Record<Weather['weather'], string> = { clear: '☀︎', cloudy: '☁︎', fog: '≈', rain: '☂︎', snow: '❄︎', thunder: '⚡︎' };
const skyIcon = (w: Weather) => (w.weather === 'clear' && !w.isDay ? '☾' : SKY[w.weather]);

/** Under her face: at home / out / asleep, her city's sky, and (for screen readers) what she is doing. */
export function PresenceTag({ r, weather }: { r: RoutineNow; weather: Weather | null }) {
  const t = useT();
  const sky = weather ? `${t(`wx.${weather.weather}` as Key)} ${Math.round(weather.tempC)}°C` : '';
  return (
    <span id={`now-${r.star}`} className={`presence presence-${r.presence}`} data-testid={`presence-${r.star}`} data-presence={r.presence}>
      {weather && <i className="presence-sky" data-testid={`sky-${r.star}`} data-sky={weather.weather} aria-hidden="true">{skyIcon(weather)}</i>}
      <span className="presence-label">{t(`now.${r.presence}` as Key)}</span>
      <span className="sr-only">{`: ${localText(r.status, t.lang)}${sky ? `, ${sky}` : ''}`}</span>
    </span>
  );
}

const hhmm = (h: number, m: number) => `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
/** Her time (JST) and, when his clock differs, his. */
export function clockLine(now: Date, t: (k: Key, v?: Record<string, string | number>) => string): string {
  const jst = new Date(now.getTime() + 9 * 3600_000);
  const hers = t('now.jst', { time: hhmm(jst.getUTCHours(), jst.getUTCMinutes()) });
  return now.getTimezoneOffset() === -540 ? hers : `${hers} · ${t('now.local', { time: hhmm(now.getHours(), now.getMinutes()) })}`;
}

/** The selected talent's line: what she is doing, in her city once confirmed, on her clock. Ticks once a minute. */
export function NowLine({ r, credit }: { r: RoutineNow; credit: boolean }) {
  const t = useT();
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout>;
    const arm = () => { timer = setTimeout(() => { setNow(new Date()); arm(); }, 60_000 - (Date.now() % 60_000) + 50); };
    arm();
    return () => clearTimeout(timer);
  }, []);
  const city = confirmedWorld(r.star).hometown?.city;
  return (
    <p className={`now-line presence-${r.presence}`} data-testid="now-line">
      <span className="now-status">{city && `${localText(city, t.lang)} · `}{localText(r.status, t.lang)}</span>
      <span className="now-clock">{clockLine(now, t)}</span>
      {/* The faces show each city's weather; its credit (Open-Meteo, CC BY 4.0) goes wherever it is shown. */}
      {credit && <a className="wx-credit" href="https://open-meteo.com/" target="_blank" rel="noopener noreferrer">{t('wx.credit')}</a>}
    </p>
  );
}

/**
 * The wake-up alarm's clock (#57): when "07:30 on weekdays" rings, in the user's own time zone. Shared by the API
 * (the tick's ring job and the alarm routes) and the web (the next ring shown under the settings).
 *
 * Everything works on the wall clock of an IANA zone through Intl, never on fixed offsets, so daylight saving and
 * zones like Asia/Kathmandu (+05:45) need no special cases: the tick asks "did the wall clock pass 07:30 since a
 * moment ago", which is also true on the morning a DST jump skips 07:30 altogether.
 */
import type { LocalText } from './domain';
import { WAKEUP_RULES } from './rules';
import type { WeatherCondition } from './weather';

/** Days of the week as JavaScript counts them: 0 = Sunday … 6 = Saturday. */
export const WEEKDAYS = [0, 1, 2, 3, 4, 5, 6] as const;
/** "HH:MM", 24-hour, in the user's clock. */
export const ALARM_TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

export interface AlarmClock { time: string; days: readonly number[] }
/** A wall-clock reading in one zone: its calendar day, minutes after midnight and day of the week. */
export interface LocalClock { date: string; minutes: number; weekday: number }

export const alarmMinutes = (time: string): number => Number(time.slice(0, 2)) * 60 + Number(time.slice(3, 5));
/** Day of the week of a calendar day (YYYY-MM-DD), which is the same in every zone. */
export const weekdayOf = (date: string): number => new Date(`${date}T00:00:00Z`).getUTCDay();

/** A zone name the runtime knows ('Asia/Taipei'), in its canonical spelling; null for anything else. */
export function validTimeZone(tz: string | null | undefined): string | null {
  if (!tz || tz.length > 64) return null;
  try { return new Intl.DateTimeFormat('en-US', { timeZone: tz }).resolvedOptions().timeZone; } catch { return null; }
}

// One formatter per zone: building one is the expensive part, and the tick reads hundreds of clocks.
const formatters = new Map<string, Intl.DateTimeFormat>();
function formatter(tz: string): Intl.DateTimeFormat {
  let f = formatters.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
    formatters.set(tz, f);
  }
  return f;
}

/** The wall clock in `tz` at a moment. */
export function localClock(at: Date | number, tz: string): LocalClock {
  const parts: Record<string, string> = {};
  for (const p of formatter(tz).formatToParts(typeof at === 'number' ? at : at.getTime())) parts[p.type] = p.value;
  const date = `${parts.year}-${parts.month}-${parts.day}`;
  // Some engines still print midnight as hour 24 despite h23.
  return { date, minutes: (Number(parts.hour) % 24) * 60 + Number(parts.minute), weekday: weekdayOf(date) };
}

/**
 * The local day this tick should ring for, or null. It rings when the wall clock passed the alarm time some time in
 * the last `windowMs` of real time — so a tick a few minutes late still rings, one long after (downtime) does not,
 * the 23:55 alarm rings on a tick just after midnight, and the morning a DST jump skips 02:30 an alarm at 02:30
 * rings at 03:00. Whether that day was already rung is the caller's (the per-day claim in `repos.alarms.ring`); in
 * the hour a clock falls back and repeats, only the first pass rings for the same reason.
 */
export function ringDay(alarm: AlarmClock, tz: string, now: Date | number, windowMs: number = WAKEUP_RULES.ringWindowMs): string | null {
  const t = alarmMinutes(alarm.time);
  const at = typeof now === 'number' ? now : now.getTime();
  const cur = localClock(at, tz);
  const prev = localClock(at - windowMs, tz);
  let day: string | null = null;
  if (cur.minutes >= t && (prev.date < cur.date || prev.minutes < t)) day = cur.date;
  else if (prev.date < cur.date && prev.minutes < t) day = prev.date;
  return day && alarm.days.includes(weekdayOf(day)) ? day : null;
}

/** The UTC moment the wall clock of `tz` reads `minutes` on `date` (in a DST gap: an instant next to it). */
export function zonedInstant(date: string, minutes: number, tz: string): number {
  const wall = Date.parse(`${date}T00:00:00Z`) + minutes * 60_000;
  const offset = (t: number) => {
    const c = localClock(t, tz);
    return Date.parse(`${c.date}T00:00:00Z`) + c.minutes * 60_000 - Math.floor(t / 60_000) * 60_000;
  };
  // Two passes: the first guess can sit on the other side of a transition; the second lands on the right offset.
  return wall - offset(wall - offset(wall));
}

/** When the alarm rings next after `now` (ISO), for the settings screen; null when it never will. */
export function nextRing(alarm: AlarmClock & { enabled: boolean }, tz: string, now: Date | number, lastDay: string | null = null): string | null {
  if (!alarm.enabled || !alarm.days.length) return null;
  const at = typeof now === 'number' ? now : now.getTime();
  const today = localClock(at, tz).date;
  const t = alarmMinutes(alarm.time);
  for (let i = 0; i <= 7; i++) {
    const date = new Date(Date.parse(`${today}T00:00:00Z`) + i * 86_400_000).toISOString().slice(0, 10);
    if (!alarm.days.includes(weekdayOf(date)) || (lastDay && date <= lastDay)) continue;
    const ms = zonedInstant(date, t, tz);
    if (ms > at) return new Date(ms).toISOString();
  }
  return null;
}

// ---------------------------------------------------------------- which of her eight lines wakes him

/** The weather her wake-up lines know (packages/shared/src/lines/schema.ts `zWakeLine`). */
export type WakeWeather = 'clear' | 'cloudy' | 'rain' | 'snow';
/** A wake-up line as #82 writes it; structural, so this module needs neither the lines nor zod. */
export type WakeHour = 'dawn' | 'early' | 'morning' | 'day' | 'evening';
export interface WakeLineDef { id: string; when: { days?: 'weekday' | 'weekend'; weather?: WakeWeather; hours?: readonly WakeHour[] }; text: LocalText }

/** The part of his day an alarm rings in, by his local hour: before dawn 0–4, early 5–7, morning 8–10, day 11–17, evening 18–23. */
export function wakeHourOf(hour: number): WakeHour {
  return hour < 5 ? 'dawn' : hour < 8 ? 'early' : hour < 11 ? 'morning' : hour < 18 ? 'day' : 'evening';
}
/** A line without `hours` greets the morning: early or morning. */
const MORNING_HOURS: readonly WakeHour[] = ['early', 'morning'];

export function wakeWeatherOf(c: WeatherCondition): WakeWeather {
  return c === 'rain' || c === 'thunder' ? 'rain' : c === 'fog' ? 'cloudy' : c;
}

/**
 * Her line for a morning (#57: 按星期 / 天气轮换). Rain and snow change his morning, so their line comes first;
 * otherwise the lines that fit the day (weekday / weekend, clear sky, any) take turns by date, so consecutive
 * mornings differ. `skip`: the line she already said this morning (the snooze call says another). `hour`: his local
 * hour as she calls (wakeHourOf); a line fits only its part of his day.
 */
export function pickWakeLine<L extends WakeLineDef>(lines: readonly L[], day: string, weather: WakeWeather | null, skip?: string, hour = 8): L {
  const kind = weekdayOf(day) % 6 === 0 ? 'weekend' : 'weekday';
  // His hour first: before dawn, by day or in the evening a line greeting the morning (「天亮了喔」) never fits.
  const part = wakeHourOf(hour);
  const inHour = (l: L) => (l.when.hours ?? MORNING_HOURS).includes(part);
  const fits = (l: L) => l.id !== skip && inHour(l) && (!l.when.days || l.when.days === kind) && (!l.when.weather || l.when.weather === weather);
  if (weather === 'rain' || weather === 'snow') {
    const topical = lines.find((l) => l.when.weather === weather && fits(l));
    if (topical) return topical;
  }
  const pool = lines.filter(fits);
  if (!pool.length) return lines.find((l) => l.id !== skip && inHour(l) && !l.when.days && !l.when.weather) ?? lines.find(inHour) ?? lines[0];
  return pool[Math.floor(Date.parse(`${day}T00:00:00Z`) / 86_400_000) % pool.length];
}

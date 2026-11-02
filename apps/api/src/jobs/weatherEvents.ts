import { createHash } from 'node:crypto';
import {
  localText, CONCERN_LINE, STAR_IDS, WEATHER_EVENTS, WEATHER_EVENT_RULES, jstDay, sceneWeatherOf, weatherPoint, winterOf,
  type StarId, type WeatherEvent, type WeatherNowT
} from '@jstar/shared';
import { LINES, type StarLines } from '@jstar/shared/lines';
import { textsOf } from '../lib/inboxText';
import { weatherSceneId } from '@jstar/shared/scenes/systemIds';
import type { InboxRow } from '../db/types';
import { herToday, herWeather } from '../lib/herWorld';
import type { TickJob } from '../lib/tick';

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
/** Weather rows are found by this id prefix (inbox.withPrefix): the id itself says what the message was about. */
export const WEATHER_INBOX_PREFIX = 'wx_';
/** "Once per talent per day" is rolling, a little under a day, so an evening message does not block the next evening's. */
const PER_STAR_GAP_MS = 20 * HOUR;

/** One moment the weather makes for her now, in priority order; `key` names it for "once per event per user". */
export interface HerEvent { event: WeatherEvent; key: string; line: number | null }

/**
 * What the weather at her window makes of this moment (#63), most important first. Her cities are in Japan, so her
 * hours are JST; nothing is sent outside WEATHER_EVENT_RULES.hours (a first snow at night waits for the morning, so
 * yesterday's first snow still counts).
 */
export function eventsNow(w: WeatherNowT, cityKey: string, now: Date): HerEvent[] {
  const hour = (now.getUTCHours() + 9) % 24;
  const [from, to] = WEATHER_EVENT_RULES.hours;
  if (hour < from || hour >= to) return [];
  const today = herToday(now);
  const out: HerEvent[] = [];
  if (w.firstSnow && (w.firstSnow === today || w.firstSnow === herToday(new Date(now.getTime() - DAY)))) {
    out.push({ event: 'firstSnow', key: `snow:${cityKey}:${winterOf(w.firstSnow)}`, line: null });
  }
  const concern = w.alert ? CONCERN_LINE[w.alert] : undefined;
  if (concern !== undefined) out.push({ event: 'typhoon', key: `alert:${cityKey}:${today}`, line: concern });
  if (sceneWeatherOf(w.weather) === 'rain' && !w.isDay) out.push({ event: 'rainyNight', key: `rain:${cityKey}:${today}`, line: null });
  return out;
}

const digest = (s: string) => createHash('sha256').update(s).digest();
/** The same user, talent and event always make the same id, so the insert itself refuses a second one. */
export const weatherInboxId = (userId: string, star: StarId, key: string) =>
  `${WEATHER_INBOX_PREFIX}${digest(`${userId}|${star}|${key}`).toString('base64url').slice(0, 22)}`;

/**
 * Her weather messages (#63): the season's first snow (「初雪だよ」), a warning that makes her worry about him
 * (typhoon, strong wind, heavy rain), a rainy night — each in her own words (#82 lines), in his language, once per
 * event per user, and only for users who opened her room in the last WEATHER_EVENT_RULES.activeDays.
 *
 * Before `inbox.deliver` in JOBS, so a message written here is delivered (and pushed) in the same tick. It reads the
 * weather the previous tick's `weather.refresh` stored; stale weather says nothing. The lines are drafts until
 * native review (#84): in production a talent whose lines are still `draft` sends nothing; the test site
 * (demo mode) sends them.
 */
export function weatherEventsJob(lines: Record<StarId, StarLines> = LINES): TickJob {
  return {
    name: 'weather.events',
    // Every other tick is plenty for events that happen once a day at most.
    everyMs: 10 * 60_000 - 30_000,
    async run({ repos, now, signal, demo }) {
      const byStar = new Map<StarId, HerEvent[]>();
      for (const star of STAR_IDS) {
        if (lines[star].draft && !demo) continue;
        const w = await herWeather(repos, star, now);
        const events = w ? eventsNow(w, weatherPoint(star).cityId, now) : [];
        if (events.length) byStar.set(star, events);
      }
      if (!byStar.size) return { events: 0, sent: 0 };

      const R = WEATHER_EVENT_RULES;
      const pairs = (await repos.events.activeRooms(jstDay(new Date(now.getTime() - (R.activeDays - 1) * DAY))))
        .filter((p) => byStar.has(p.star))
        // The talent he visited last speaks first when the daily cap leaves room for only some.
        .sort((a, b) => (a.lastDay < b.lastDay ? 1 : a.lastDay > b.lastDay ? -1 : 0));
      const lookback = new Date(now.getTime() - Math.max(R.rainyNightEveryDays, 1) * DAY).toISOString();
      const recent = await repos.inbox.withPrefix(WEATHER_INBOX_PREFIX, lookback);
      const ids = new Set(recent.map((r) => r.id));
      const since = (ms: number) => new Date(now.getTime() - ms).toISOString();
      const lastDay = since(DAY);
      // Rolling 24 hours across talents.
      const perUser = new Map<string, number>();
      for (const r of recent) if (r.createdAt >= lastDay) perUser.set(r.userId, (perUser.get(r.userId) ?? 0) + 1);
      const sentTo = (userId: string, star: StarId, after: string, events: readonly WeatherEvent[]) =>
        recent.some((r) => r.userId === userId && r.star === star && r.createdAt >= after && events.includes(r.payload.event as WeatherEvent));
      // A rainy night waits for any weather message of hers from the last day, and for her last rainy night by a few
      // days; a first snow or a warning only for another first snow or warning, so the rain never hides a warning.
      const blocked = (userId: string, star: StarId, e: HerEvent) =>
        ids.has(weatherInboxId(userId, star, e.key)) || (e.event === 'rainyNight'
          ? sentTo(userId, star, since(PER_STAR_GAP_MS), WEATHER_EVENTS) || sentTo(userId, star, since(R.rainyNightEveryDays * DAY), ['rainyNight'])
          : sentTo(userId, star, since(PER_STAR_GAP_MS), ['firstSnow', 'typhoon']));

      const at = now.toISOString();
      let sent = 0;
      let capped = 0;
      for (const { userId, star } of pairs) {
        if (signal.aborted) break;
        const pick = byStar.get(star)!.find((e) => !blocked(userId, star, e));
        if (!pick) continue;
        if ((perUser.get(userId) ?? 0) >= R.perUserPerDay) { capped++; continue; }
        const user = await repos.users.byId(userId);
        if (!user) continue;
        const id = weatherInboxId(userId, star, pick.key);
        const set = lines[star].weather[pick.event];
        const line = set[pick.line ?? digest(id)[0] % set.length];
        const text = localText(line, user.lang);
        // Opening it offers her scene for the event (#71), shared with this message: her three lines, and his answer.
        const row: InboxRow = { id, userId, star, kind: 'event', payload: { text, texts: textsOf(line), event: pick.event, sceneId: weatherSceneId(pick.event, star) }, dueAt: at, deliveredAt: null, readAt: null, createdAt: at };
        if (!(await repos.inbox.addOnce(row))) continue;
        ids.add(id);
        recent.push(row);
        perUser.set(userId, (perUser.get(userId) ?? 0) + 1);
        sent++;
      }
      return { events: [...byStar.values()].reduce((n, e) => n + e.length, 0), recipients: pairs.length, sent, capped };
    }
  };
}

export const weatherEvents = weatherEventsJob();

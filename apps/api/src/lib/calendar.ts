import { createHash } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import {
  CALENDAR_EVENT_KINDS, CALENDAR_GREETED, HIS_BIRTHDAY_PUSH, LANGS, STAR_IDS, addDays, calendarLine, eventsOn,
  type CalendarEvent, type Lang, type StarId
} from '@jstar/shared';
import { herLocalClock, herZonedInstant } from '@jstar/shared/herMessages';
import { systemSceneId } from '@jstar/shared/scenes/systemIds';
import type { CalendarCandidate, InboxRow, Repos, UserRow } from '../db/types';

/**
 * Her year with him (#61, docs/requirements.md §11.5) on the server: today's events for one user and talent
 * (packages/shared/src/calendar.ts), what she writes him on the day, and the test site's "pretend it is that day".
 *
 * His birthday is personal data (docs/compliance-jp.md §7.5): what leaves here is the event's kind, never the date or
 * the year — not in her line, not in the push (HIS_BIRTHDAY_PUSH keeps the lock screen neutral), not in events.
 */

/** Her message rows for the day are found by this id prefix (inbox.withPrefix); the rest of the id says what it was for. */
export const CALENDAR_INBOX_PREFIX = 'cal_';
/** About him or the season, not her: said once (by the talent he was with last), not by each of the five. */
const ONCE_PER_USER: ReadonlySet<CalendarEvent['kind']> = new Set(['hisBirthday', 'season']);

const digest = (s: string) => createHash('sha256').update(s).digest('base64url').slice(0, 22);
/** The same user, talent (or none, for his own events) and occurrence always make the same id: the insert refuses a second. */
export const calendarInboxId = (userId: string, star: StarId | null, key: string) => `${CALENDAR_INBOX_PREFIX}${digest(`${userId}|${star ?? '*'}|${key}`)}`;

export interface Greeting { star: StarId; event: CalendarEvent; id: string }

/**
 * What she would write him today, most important first: his birthday and a season's first day once (from the talent
 * he spent time with last), her birthday and their anniversaries from her. Seasons after their first day are only
 * conversation and the home's line.
 */
export function greetingsFor(c: Pick<CalendarCandidate, 'userId' | 'tz' | 'birthday' | 'stars'>, now: Date, demo: boolean): Greeting[] {
  const stars = [...c.stars].sort((a, b) => (a.lastDay < b.lastDay ? 1 : a.lastDay > b.lastDay ? -1 : STAR_IDS.indexOf(a.star) - STAR_IDS.indexOf(b.star)));
  const out: Greeting[] = [];
  const said = new Set<string>();
  for (const s of stars) {
    for (const e of eventsOn({ star: s.star, now, tz: c.tz, birthday: c.birthday, anniversary: s.anniversary, stage: s.stage, demo })) {
      if (!CALENDAR_GREETED.includes(e.kind) || (e.kind === 'season' && !e.opening)) continue;
      const once = ONCE_PER_USER.has(e.kind);
      if (once && said.has(e.key)) continue;
      said.add(e.key);
      out.push({ star: s.star, event: e, id: calendarInboxId(c.userId, once ? null : s.star, e.key) });
    }
  }
  const rank = (g: Greeting) => CALENDAR_EVENT_KINDS.indexOf(g.event.kind);
  // Stable: within a kind, the talent he was with last goes first.
  return out.map((g, i) => ({ g, i })).sort((a, b) => rank(a.g) - rank(b.g) || a.i - b.i).map(({ g }) => g);
}

/** The test site's calendar messages ("pretend today is …"): their ids say so (modules/calendar.ts `/demo`). */
export const DEMO_CALENDAR_PREFIX = `${CALENDAR_INBOX_PREFIX}demo_`;

/**
 * M16: the instant her calendar message lapses — the end of the day it came on, on his clock (users.tz, JST when
 * unknown): every event is one day long, so on another day her room never leads with it nor offers its scene. Read
 * from when it was written, for every row old or new: nothing about the day is stored on it (his birthday's date
 * never is, docs/compliance-jp.md §7.5). A pretend day's message on the test site lasts as long as the pretend day.
 */
export function calendarExpiry(row: Pick<InboxRow, 'id' | 'createdAt'> & { payload?: InboxRow['payload'] }, tz: string | null | undefined): number | null {
  if (!row.id.startsWith(CALENDAR_INBOX_PREFIX)) return null;
  const at = Date.parse(row.createdAt);
  // D-N1: her days (her birthday, theirs, the season) are Japan's days (shared calendar.ts eventsOn), his birthday is
  // his: the message lapses when its day ends on that same clock — the moment its scene closes, never an hour apart.
  const end = endOfLocalDay(at, row.payload && row.payload.calendar !== 'hisBirthday' ? 'Asia/Tokyo' : tz);
  return row.id.startsWith(DEMO_CALENDAR_PREFIX) ? Math.max(end, at + DEMO_DAY_MS) : end;
}

/** The end of the day `at` falls on, on his clock. */
const endOfLocalDay = (at: number, tz: string | null | undefined): number => herZonedInstant(addDays(herLocalClock(at, tz).day, 1), 0, tz);

/**
 * Her inbox row for a greeting, due now. `payload.push` replaces her line on the lock screen (his birthday);
 * `payload.sceneId`: a birthday's message opens its scene (#71). `texts`: her line in every language (M18: shown in
 * his language when he reads it). It lapses at the end of his day (M16, `calendarExpiry`).
 */
export function greetingRow(userId: string, lang: Lang, g: Greeting, at: string, id = g.id): InboxRow {
  const e = g.event;
  const text = calendarLine(e, lang, id) ?? '';
  const texts = Object.fromEntries(LANGS.map((l) => [l, calendarLine(e, l, id) ?? text]));
  const scene = e.kind === 'hisBirthday' || e.kind === 'herBirthday' ? systemSceneId(e.kind, g.star) : null;
  const payload: Record<string, unknown> = {
    text, texts, calendar: e.kind, ...(e.season ? { season: e.season } : {}), ...(e.count !== undefined ? { count: e.count } : {}),
    ...(e.kind === 'hisBirthday' ? { push: HIS_BIRTHDAY_PUSH[lang] ?? HIS_BIRTHDAY_PUSH.ja } : {}),
    ...(scene ? { sceneId: scene } : {})
  };
  return { id, userId, star: g.star, kind: 'event', payload, dueAt: at, deliveredAt: null, readAt: null, createdAt: at };
}

// ---------------------------------------------------------------- the test site's day

/** How long "pretend today is …" lasts once set (demo mode only): long enough to walk through it, never for good. */
export const DEMO_DAY_MS = 2 * 3600_000;
/**
 * Per user, in this process only. Keyed on the repos, which every Fastify plugin shares (plugins get their own
 * instance, so the app itself would not be one key). A restart forgets it — the real day comes back, as it should.
 */
const demoDays = new WeakMap<Repos, Map<string, { day: string; until: number }>>();

export function setDemoDay(app: FastifyInstance, userId: string, day: string | null, now = Date.now()): void {
  let days = demoDays.get(app.repos);
  if (!days) demoDays.set(app.repos, (days = new Map()));
  if (day) days.set(userId, { day, until: now + DEMO_DAY_MS }); else days.delete(userId);
}

/**
 * The moment the calendar reads for him: now, or — demo mode only, while he set one — the same JST time of day on
 * his demo day. Production never has a demo day (the route that sets one is 404 there).
 */
export function calendarNow(app: FastifyInstance, userId: string | null | undefined, now = new Date()): Date {
  if (!app.demo || !userId) return now;
  const d = demoDays.get(app.repos)?.get(userId);
  if (!d || d.until <= now.getTime()) return now;
  const jstTime = new Date(now.getTime() + 9 * 3600_000).toISOString().slice(11, 23);
  return new Date(`${d.day}T${jstTime}+09:00`);
}

/** Today's events with her for him (a visitor: hers and the season's only). */
export async function todayWith(app: FastifyInstance, user: Pick<UserRow, 'id' | 'tz' | 'birthday'> | null, star: StarId, now = new Date()): Promise<CalendarEvent[]> {
  const rel = user ? await app.repos.relationship.get(user.id, star) : null;
  return eventsOn({
    star, now: calendarNow(app, user?.id, now), tz: user?.tz, birthday: user?.birthday, anniversary: rel?.anniversary, stage: rel?.stage, demo: app.demo
  });
}

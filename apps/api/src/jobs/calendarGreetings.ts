import { CALENDAR_RULES, addDays, jstDay } from '@jstar/shared';
import { herLocalClock, herZonedInstant, inQuietHours } from '@jstar/shared/herMessages';
import type { InboxRow } from '../db/types';
import { CALENDAR_INBOX_PREFIX, greetingRow, greetingsFor } from '../lib/calendar';
import type { TickJob } from '../lib/tick';

const DAY = 86_400_000;
const PAGE = 300;
const iso = (ms: number) => new Date(ms).toISOString();

/**
 * Her message for the day (#61): his birthday, hers (agency-confirmed only; the test site shows all), their
 * anniversary every month and every year, a season's first day — written in her words (shared CALENDAR_LINES, in his
 * language), once per user per event per year: the row's id is the event's key (lib/calendar.ts), so a second insert
 * is refused however many ticks overlap.
 *
 * Who and when: users who spent a day with her within CALENDAR_RULES.activeDays, whose her-messages setting is not
 * off (「少なめ」 = one a day), inside CALENDAR_RULES.hours of his own clock and outside his quiet hours; at most
 * CALENDAR_RULES.perDay of these a day, the most important first. What does not fit today is not sent later: every
 * event is one day long.
 *
 * Before `inbox.deliver` in JOBS, so what it writes is delivered (badge and push) by the same tick. No product event is
 * recorded: an event on his birthday would tell the events table (kept 180 days, read by admins) when he was born.
 */
export const calendarGreetings: TickJob = {
  name: 'calendar.greet',
  // Four times an hour: the first run inside his hours finds him, the rest find nothing new.
  everyMs: 15 * 60_000 - 60_000,
  async run({ repos, now, signal, demo }) {
    const R = CALENDAR_RULES;
    const t = now.getTime();
    const since = addDays(jstDay(now), -(R.activeDays - 1));
    // Two days back covers "today" in every zone, for the daily count and for events already written.
    const recent = await repos.inbox.withPrefix(CALENDAR_INBOX_PREFIX, iso(t - 2 * DAY));
    const ids = new Set(recent.map((r) => r.id));
    const byUser = new Map<string, InboxRow[]>();
    for (const r of recent) byUser.set(r.userId, [...(byUser.get(r.userId) ?? []), r]);

    const at = now.toISOString();
    const out = { users: 0, outside: 0, sent: 0, capped: 0 };
    let after = '';
    while (!signal.aborted) {
      const page = await repos.calendar.candidates(since, after, PAGE);
      for (const c of page) {
        if (signal.aborted) break;
        out.users++;
        const clock = herLocalClock(t, c.tz);
        if (clock.minutes < R.hours[0] * 60 || clock.minutes >= R.hours[1] * 60 || inQuietHours(clock.minutes)) { out.outside++; continue; }
        const todo = greetingsFor(c, now, !!demo).filter((g) => !ids.has(g.id));
        if (!todo.length) continue;
        const dayStart = iso(herZonedInstant(clock.day, 0, c.tz));
        let count = (byUser.get(c.userId) ?? []).filter((r) => r.createdAt >= dayStart).length;
        const cap = c.mode === 'less' ? R.lessPerDay : R.perDay;
        for (const g of todo) {
          if (count >= cap) { out.capped++; break; }
          const row = greetingRow(c.userId, c.lang, g, at);
          if (!(await repos.inbox.addOnce(row))) continue;
          ids.add(row.id);
          byUser.set(c.userId, [...(byUser.get(c.userId) ?? []), row]);
          count++;
          out.sent++;
        }
      }
      if (page.length < PAGE) break;
      after = page[page.length - 1].userId;
    }
    return out;
  }
};

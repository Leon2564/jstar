import type { FastifyInstance } from 'fastify';
import { CalendarDemoReq, STAR_IDS, eventsOn, viewOfEvent, type CalendarDemoResT, type CalendarResT } from '@jstar/shared';
import { httpError, requireUser } from '../app';
import type { UserRow } from '../db/types';
import { CALENDAR_INBOX_PREFIX, calendarNow, greetingRow, greetingsFor, setDemoDay } from '../lib/calendar';
import { newId } from '../lib/crypto';

/**
 * Her year with him (#61): what today is with each of the five, for her home's line. Private to him — his birthday is
 * in it — so it is never cached; only the event's kind leaves the server, never a date or a year.
 */
export async function registerCalendar(app: FastifyInstance) {
  const today = async (user: UserRow, now: Date): Promise<CalendarResT> => {
    const rows = await app.repos.relationship.forUser(user.id);
    const at = calendarNow(app, user.id, now);
    return {
      talents: STAR_IDS.map((star) => {
        const rel = rows.find((r) => r.star === star);
        const events = eventsOn({ star, now: at, tz: user.tz, birthday: user.birthday, anniversary: rel?.anniversary, stage: rel?.stage, demo: app.demo });
        return { star, events: events.map(viewOfEvent) };
      })
    };
  };

  app.get('/', async (req, reply): Promise<CalendarResT> => {
    const user = requireUser(req);
    reply.header('cache-control', 'private, no-store');
    return today(user, new Date());
  });

  /**
   * Demo mode only (the test site): for DEMO_DAY_MS his calendar, her greeting and the prompt read `day` as today, and
   * her messages for that day go into his inbox now (the next tick delivers them) — outside his hours and caps, and
   * again on every call, so it can be tried as often as needed. Each of the five counts, even before a first day
   * together, so a new test account sees her birthday too.
   */
  app.post('/demo', { config: { rateLimit: { max: 20, timeWindow: '1 minute' } } }, async (req, reply): Promise<CalendarDemoResT> => {
    if (!app.demo) throw httpError('not_found', 404);
    const user = requireUser(req);
    const { day } = CalendarDemoReq.parse(req.body);
    const now = new Date();
    setDemoDay(app, user.id, day, now.getTime());
    let sent = 0;
    if (day) {
      const rows = await app.repos.relationship.forUser(user.id);
      const stars = STAR_IDS.map((star) => {
        const r = rows.find((x) => x.star === star);
        return { star, lastDay: r?.lastDay ?? '', stage: r?.stage ?? 'new' as const, anniversary: r?.anniversary ?? null };
      });
      const at = now.toISOString();
      for (const g of greetingsFor({ userId: user.id, tz: user.tz, birthday: user.birthday, stars }, calendarNow(app, user.id, now), true)) {
        // M16: its id (cal_demo_…) marks it a pretend day's, which lasts as long as the pretend day (lib/calendar.ts calendarExpiry).
        await app.repos.inbox.add(greetingRow(user.id, user.lang, g, at, `${CALENDAR_INBOX_PREFIX}${newId('demo')}`));
        sent++;
      }
    }
    reply.header('cache-control', 'private, no-store');
    return { day, sent, ...(await today(user, now)) };
  });
}

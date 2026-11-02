import { EVENT_PROPS, EVENT_RETENTION_DAYS, addDays, jstDay, type EventName, type EventProps } from '@jstar/shared';
import type { Repos } from '../db/types';

/**
 * Records a product event for the admin metrics (#52). Server-side only: call it from the flow that made the
 * thing happen, never from a client report. Props are checked against EVENT_PROPS, so an unknown key or a free
 * text value throws here — in tests, before it could reach the table.
 */
export async function recordEvent<N extends EventName>(repos: Repos, userId: string, name: N, props: EventProps<N>, at: Date = new Date()): Promise<void> {
  const checked = EVENT_PROPS[name].parse(props) as Record<string, unknown>;
  await repos.events.add({ userId, name, props: checked, day: jstDay(at), createdAt: at.toISOString() });
}

/**
 * Retention (#52): deletes events older than EVENT_RETENTION_DAYS (today counts as day 1), one JST day per
 * statement so each delete stays small on D1. Meant for the scheduled tick (#49); `maxDays` bounds one run, and a
 * backlog is simply finished by the next ticks.
 */
export async function purgeExpiredEvents(repos: Repos, today: string = jstDay(), maxDays = 31): Promise<{ days: number; rows: number }> {
  const cutoff = addDays(today, -(EVENT_RETENTION_DAYS - 1));
  let days = 0;
  let rows = 0;
  while (days < maxDays) {
    const deleted = await repos.events.purgeOldestDay(cutoff);
    if (!deleted) break;
    days++;
    rows += deleted;
  }
  return { days, rows };
}

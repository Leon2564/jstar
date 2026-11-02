import { purgeExpiredEvents } from '../lib/events';
import type { TickJob } from '../lib/tick';

/**
 * Keeps product events to EVENT_RETENTION_DAYS (#52). A few times a day is plenty: each run deletes whole JST
 * days, oldest first, so a backlog after downtime is cleared over the next runs.
 */
export const purgeEvents: TickJob = {
  name: 'events.purge',
  everyMs: 6 * 60 * 60_000 - 60_000,
  async run({ repos }) {
    return purgeExpiredEvents(repos);
  }
};

import { localClock, localText, ringDay, type WakePayloadT } from '@jstar/shared';
import type { InboxRow } from '../db/types';
import { newId } from '../lib/crypto';
import type { TickJob } from '../lib/tick';
import { chooseWakeLine, clockOf, morningWeather, ringVoice } from '../lib/wakeup';

/**
 * Rings the wake-up alarms whose time has come in their owner's clock (#57): each becomes a `wakeup` inbox row due
 * now, which `inbox.deliver` (after this job in JOBS) delivers and pushes in the same tick — so he gets her line on
 * the lock screen within one tick (5 minutes) of the time he set.
 *
 * Idempotent: a morning is claimed by one conditional write together with its inbox row (`repos.alarms.ring`), so
 * a repeated, overlapping or half-finished tick never wakes him twice. A tick that finds an alarm well past its
 * time (downtime) lets that morning go (WAKEUP_RULES.ringWindowMs, see `ringDay`).
 */
export const ringAlarms: TickJob = {
  name: 'alarm.ring',
  everyMs: 0,
  async run({ repos, now, signal, log, demo = false }) {
    // Every enabled alarm is looked at: which ones are due depends on each owner's zone, so SQL cannot pick them.
    const alarms = await repos.alarms.enabled();
    let rung = 0;
    for (const a of alarms) {
      if (signal.aborted) break;
      const tz = clockOf(a.userTz, a);
      const day = ringDay(a, tz, now);
      // Cheap pre-check; the claim inside `ring` is what decides.
      if (!day || (a.lastDay !== null && a.lastDay >= day)) continue;
      try {
        const weather = await morningWeather(repos, a.userId, a.star, now).catch(() => null);
        // His hour as she calls: before dawn she never says it is light out (wakeup.ts).
        const line = chooseWakeLine(a.star, day, weather, demo, undefined, Math.floor(localClock(now, tz).minutes / 60));
        const payload: WakePayloadT = { text: localText(line.text, a.lang), lineId: line.id, day, ...ringVoice(a.star, line.id, demo) };
        const at = now.toISOString();
        const row: InboxRow = { id: newId('inb'), userId: a.userId, star: a.star, kind: 'wakeup', payload, dueAt: at, deliveredAt: null, readAt: null, createdAt: at };
        if (await repos.alarms.ring(a.userId, day, row)) rung++;
      } catch (err) {
        // One user's failure must not keep the others asleep; the next tick retries within the ring window.
        log.error({ err: err instanceof Error ? err.message : String(err), user: a.userId }, 'alarm_ring_failed');
      }
    }
    return { alarms: alarms.length, rung };
  }
};

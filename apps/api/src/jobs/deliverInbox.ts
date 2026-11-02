import { WAKEUP_RULES } from '@jstar/shared';
import type { InboxRow } from '../db/types';
import { herPush } from '../lib/push';
import type { JobContext, TickJob } from '../lib/tick';

/** Rows per statement: keeps each D1 round trip small; the tick's budget bounds the whole run. */
const BATCH = 200;

/**
 * Delivers her inbox rows whose time has come (#49). The row's `deliveredAt` is written by one conditional
 * statement (`WHERE delivered_at IS NULL`), so a second or overlapping tick never delivers a row again.
 */
export const deliverInbox: TickJob = {
  name: 'inbox.deliver',
  everyMs: 0,
  async run(ctx) {
    const { repos, now, signal } = ctx;
    let delivered = 0;
    let pushed = 0;
    while (!signal.aborted) {
      const rows = await repos.inbox.deliverDue(now.toISOString(), BATCH);
      delivered += rows.length;
      for (const row of rows) if (!signal.aborted && (await notify(ctx, row))) pushed++;
      if (rows.length < BATCH) break;
    }
    return { delivered, pushed };
  }
};

/**
 * Her line on his lock screen (#50). The row is already delivered, and a push that fails must not undo that or
 * stop the batch: the badge in the app still shows it, so a push error is logged and the next row goes on.
 */
async function notify({ repos, sendPush, log }: JobContext, row: InboxRow): Promise<boolean> {
  if (!sendPush) return false;
  // `push`: a lock-screen line of its own, when her line says something personal (his birthday, #61).
  const text = typeof row.payload.push === 'string' ? row.payload.push : typeof row.payload.text === 'string' ? row.payload.text : '';
  if (!text) return false;
  try {
    const user = await repos.users.byId(row.userId);
    if (!user) return false;
    // A wake-up (#57) opens her morning moment, replaces the one before it (the snooze call), wakes a phone in
    // battery saver, and is dropped if it cannot arrive within the morning.
    const res = row.kind === 'wakeup'
      ? await sendPush(row.userId, herPush(row.star, user.lang, text, { inbox: row.id, tag: `wake-${row.star}` }), { ttl: WAKEUP_RULES.pushTtlSeconds, urgency: 'high' })
      : await sendPush(row.userId, herPush(row.star, user.lang, text, { tag: `inbox-${row.id}` }));
    return res.sent > 0;
  } catch (err) {
    log.error({ err: String(err), inbox: row.id }, 'inbox_push_failed');
    return false;
  }
}

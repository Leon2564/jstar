import { PROMISE_RULES, inPromiseWindow, keepLineKind, promiseLine, timelessPromise } from '@jstar/shared';
import { promiseTextIn } from '@jstar/shared/memoryText';
import { systemSceneId } from '@jstar/shared/scenes/systemIds';
import { promiseInboxId, type InboxRow, type PromiseRow } from '../db/types';
import { recordEvent } from '../lib/events';
import { promiseDueTexts } from '../lib/inboxText';
import type { JobContext, TickJob } from '../lib/tick';

/** Promises per statement: keeps each D1 round trip small; the tick's budget bounds the whole run. */
const BATCH = 100;

/**
 * Promises falling due (#59, docs/requirements.md §11.4). Runs before `inbox.deliver`, so her line written here is
 * delivered — badge and push — by the same tick.
 *
 * 1. An open promise whose time has come becomes her `promise_due` inbox line (「昨日の約束、覚えてる？」), due now.
 *    The line and the promise's `notified_at` are written together by one conditional batch, and the line's id is
 *    the promise's, so a repeated or overlapping tick never writes it twice. A promise first seen after its window
 *    already closed (the tick was down) gets no line: a push for something already missed would only reproach him.
 * 2. An open promise whose window has closed is missed; its unread line is marked read (she stopped waiting), and
 *    she brings it up once, gently, the next time he comes (lib/promises.ts `promiseOpening`).
 * Both record `promise.due` (#52) once per promise, so the revisit rate's denominator counts every promise that came due.
 */
export const duePromises: TickJob = {
  name: 'promises.due',
  everyMs: 0,
  async run(ctx) {
    const { repos, now, signal } = ctx;
    const at = now.toISOString();
    let notified = 0;
    let missed = 0;
    while (!signal.aborted) {
      const rows = await repos.promises.dueUnnotified(at, BATCH);
      let moved = 0;
      for (const row of rows) {
        if (signal.aborted) break;
        if (await repos.promises.notify(row.id, at, inPromiseWindow(row.dueAt, now.getTime()) ? await line(ctx, row) : null)) {
          moved++;
          await due(ctx, row);
        }
      }
      notified += moved;
      // A full batch that moved nothing would only be read again: leave it to the next tick.
      if (rows.length < BATCH || !moved) break;
    }
    while (!signal.aborted) {
      const rows = await repos.promises.expire(new Date(now.getTime() - PROMISE_RULES.windowMs).toISOString(), at, BATCH);
      missed += rows.length;
      // Cut off before notifying it (a tick out of time), a promise still came due.
      for (const row of rows) if (!row.notifiedAt) await due(ctx, row);
      if (rows.length < BATCH) break;
    }
    return { notified, missed };
  }
};

/**
 * The scene her promise line opens: the one the promise names, or — a promise of an evening together that names
 * none (kind `scene`) — her promise-kept opening (#71).
 */
export const promisedSceneId = (row: Pick<PromiseRow, 'kind' | 'sceneId' | 'star'>): string | null =>
  // N-64: every promise but her wake-up is kept in her room (promisePayoff), so its due line leads there too.
  row.sceneId ?? (row.kind !== 'wakeup' ? systemSceneId('promiseKept', row.star) : null);

/** Her line in his language, as the push and the inbox item carry it. */
async function line({ repos, now }: JobContext, row: PromiseRow): Promise<InboxRow> {
  const user = await repos.users.byId(row.userId);
  const at = now.toISOString();
  const sceneId = promisedSceneId(row);
  return {
    id: promiseInboxId(row.id), userId: row.userId, star: row.star, kind: 'promise_due',
    // M18: in every language, so it reads in his even after he switches (lib/inboxText.ts payloadIn).
    payload: {
      text: promiseLine(keepLineKind(row, now.getTime()), user?.lang ?? row.lang, timelessPromise(promiseTextIn(row.star, row.text, user?.lang ?? row.lang)), { star: row.star, dueAt: row.dueAt, tz: user?.tz }),
      texts: promiseDueTexts(row, now.getTime(), user?.tz), promiseId: row.id, kind: row.kind, ...(sceneId ? { sceneId } : {})
    },
    dueAt: at, deliveredAt: null, readAt: null, createdAt: at
  };
}

async function due({ repos, now, log }: JobContext, row: PromiseRow): Promise<void> {
  // A metric must never stop the job: logged and dropped, as app.recordEvent does.
  await recordEvent(repos, row.userId, 'promise.due', { star: row.star, promiseId: row.id }, now)
    .catch((err) => log.error({ err: String(err), promise: row.id }, 'promise_due_event_failed'));
}

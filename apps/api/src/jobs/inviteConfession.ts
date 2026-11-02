import { CONFESSION_RULES, STAR_IDS, confessionOffered, confessionStatus, jstDay, localText } from '@jstar/shared';
import { LINES } from '@jstar/shared/lines';
import type { InboxRow } from '../db/types';
import { newId } from '../lib/crypto';
import { textsOf } from '../lib/inboxText';
import type { TickJob } from '../lib/tick';

/** Relationships per run; the rest wait for the next tick (five minutes later). */
const BATCH = 200;

/**
 * Her confession day (#55): the relationship reached `confession_ready` (or the days after his "not yet" have
 * passed), so she writes to him — "tonight, there's something I want to tell you" — once per round. Runs before
 * `deliverInbox`, so the message and its push go out in the same tick. Opening it leads to her confession scene
 * (`payload.scene`); the room itself opens on it from 17:00 JST.
 *
 * Her lines are drafts until native review (#84): until then only the test site and demos send it.
 */
export const inviteConfession: TickJob = {
  name: 'confession.invite',
  everyMs: 0,
  async run({ repos, now, signal, demo }) {
    const offered = STAR_IDS.filter((s) => confessionOffered(LINES[s].draft, !!demo));
    if (!offered.length) return { off: true };
    const due = await repos.confessions.uninvited(BATCH, { retryDays: CONFESSION_RULES.retryDays, maxAsks: CONFESSION_RULES.maxAsks, today: jstDay(now) });
    let sent = 0;
    for (const c of due) {
      if (signal.aborted) break;
      if (!offered.includes(c.star)) continue;
      const status = confessionStatus(c.star, { stage: 'confession_ready', daysTogether: c.daysTogether }, c.confession, now);
      if (status?.phase !== 'due') continue;
      const lines = LINES[c.star].confession;
      const at = now.toISOString();
      const row: InboxRow = {
        id: newId('inb'), userId: c.userId, star: c.star, kind: 'message',
        payload: { text: localText(c.confession.tries > 0 ? lines.retry : lines.inbox, c.lang), texts: textsOf(c.confession.tries > 0 ? lines.retry : lines.inbox), scene: status.sceneId },
        dueAt: at, deliveredAt: null, readAt: null, createdAt: at
      };
      if (await repos.confessions.invite(c.userId, c.star, c.confession.tries, row)) sent++;
    }
    return { candidates: due.length, sent };
  }
};

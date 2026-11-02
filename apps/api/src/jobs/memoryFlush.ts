import type { TickJob } from '../lib/tick';
import { QUIET_MS, flushMemory } from '../lib/memoryFlush';

/** Conversations per run: one model call each, so the run stays well inside the tick's budget. */
const BATCH = 10;

const message = (e: unknown) => (e instanceof Error ? e.message : String(e)).slice(0, 200);

/**
 * A conversation gone quiet (batched memory, lib/memoryFlush.ts): no new turn for QUIET_MS and turns still pending —
 * he closed the tab without the leave call reaching us, or the call failed. Its pending turns go into memory now.
 * A failed update leaves them pending; the next run tries again. Off without the persona service (`flushMemory`).
 */
export const memoryFlush: TickJob = {
  name: 'memory.flush',
  everyMs: 5 * 60_000 - 20_000,
  async run({ repos, now, signal, log, flushMemory: persona }) {
    if (!persona) return { off: true };
    let saved = 0, failed = 0, empty = 0;
    for (const { ownerId, star } of await repos.chatMemory.quiet(new Date(now.getTime() - QUIET_MS).toISOString(), BATCH)) {
      if (signal.aborted) break;
      try {
        const user = await repos.users.byId(ownerId);
        const out = await flushMemory(repos, persona, ownerId, star, user?.lang ?? 'ja');
        if (out === 'saved') saved++; else if (out === 'failed') failed++; else empty++;
      } catch (e) {
        failed++;
        log.error({ err: message(e) }, 'memory_flush_failed');
      }
    }
    return { saved, failed, empty };
  }
};

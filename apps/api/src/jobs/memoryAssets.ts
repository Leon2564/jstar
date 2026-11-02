import { addDays, jstDay } from '@jstar/shared';
import { MEMORY_RULES } from '@jstar/shared/memories';
import { memoryFiles } from '../lib/memoryAssets';
import type { TickJob } from '../lib/tick';

/** Rows per step per run: an hourly job, so even a large backlog clears within a day without holding the tick. */
const BATCH = 25;
/** His export days are remembered this long (only the daily limit needs them). */
const EXPORT_DAYS_KEPT = 7;

const message = (e: unknown) => (e instanceof Error ? e.message : String(e)).slice(0, 200);

/**
 * His memory files over time (#51, docs/compliance-jp.md §7.6), each step bounded and safe to cut off:
 * 1. accounts deleted whose files the deletion could not erase at once: erased now (everything under `<userId>/`);
 * 2. recordings still base64 in D1 (#55, or kept before a bucket was bound): handed to the memory store;
 * 3. retention: recordings kept longer than MEMORY_RULES.retentionDays are deleted, his words stay — only when that
 *    is set (待确认, #84); by default nothing is deleted on a timer;
 * 4. export days older than a week are forgotten.
 */
export function memoryAssetsJob(rules: Pick<typeof MEMORY_RULES, 'retentionDays'> = MEMORY_RULES): TickJob {
  return {
    name: 'memories.assets',
    everyMs: 60 * 60_000 - 60_000,
    async run({ repos, now, signal, log, memoryStore }) {
      const files = memoryFiles({ repos, store: memoryStore ?? null, log: { warn: (obj, msg) => log.error(obj, msg) } });
      const at = now.toISOString();
      let purged = 0, purgeLeft = 0, moved = 0, expired = 0, failed = 0;

      for (const userId of await repos.memoryAssets.purgesPending(BATCH)) {
        if (signal.aborted) return { purged, purgeLeft, moved, expired, failed };
        try {
          if (await files.purge(userId)) { await repos.memoryAssets.purgeDone(userId); purged++; continue; }
        } catch (e) {
          log.error({ err: message(e) }, 'memory_purge_failed');
        }
        await repos.memoryAssets.purgeTried(userId, at);
        purgeLeft++;
      }

      if (files.stored) {
        for (const r of await repos.confessions.legacyAudio(BATCH)) {
          if (signal.aborted) return { purged, purgeLeft, moved, expired, failed };
          try { if (await files.moveConfessionAudio(r.userId, r.memoryId)) moved++; } catch (e) { failed++; log.error({ err: message(e) }, 'memory_move_failed'); }
        }
      }

      if (rules.retentionDays !== null) {
        const before = new Date(now.getTime() - rules.retentionDays * 86_400_000).toISOString();
        for (const v of await repos.confessions.keptBefore(before, BATCH)) {
          if (signal.aborted) return { purged, purgeLeft, moved, expired, failed };
          try { if (await files.forgetConfessionAudio(v.userId, v.memoryId)) expired++; } catch (e) { failed++; log.error({ err: message(e) }, 'memory_retention_failed'); }
        }
      }

      const pruned = await repos.memoryAssets.pruneExports(addDays(jstDay(now), -EXPORT_DAYS_KEPT));
      return { purged, purgeLeft, moved, expired, failed, pruned, retentionDays: rules.retentionDays, store: files.stored };
    }
  };
}
export const memoryAssets = memoryAssetsJob();

import type { TickResT } from '@jstar/shared';
import type { Repos } from '../db/types';
import type { SendPush } from './push';
import type { WeatherClient } from './weather';
import type { HerMessages } from './herMessages';
import type { MemoryStore } from './memoryAssets';
import type { FlushPersona } from './memoryFlush';

/**
 * The scheduled tick (#49). A Cron Trigger fires the Worker every 5 minutes, and the Worker calls
 * `POST /v1/ops/tick` on this container (infra/cloudflare/src/index.ts). Everything she does on her own — weather,
 * promises falling due, wake-up calls, her messages, calendar events — is a job run from here.
 *
 * Rules every job can rely on:
 * - jobs run one after another, in the order of JOBS (src/jobs/index.ts), so a job can deliver what an earlier
 *   one just wrote;
 * - a job starts only after `repos.jobs.claim` succeeded, so overlapping ticks (a slow tick, a manual one) never
 *   run the same job twice at once, and a job runs no more often than its `everyMs`;
 * - the whole tick stays under TICK_BUDGET_MS: a job past the budget is abandoned (its `signal` aborts), jobs
 *   left over wait for the next tick;
 * - a job that throws is logged and recorded in `job_runs`; the jobs after it still run.
 * A job must itself be idempotent: it can be cut off half-way and started again on the next tick.
 */
export interface JobContext {
  repos: Repos;
  /** The tick's start time: use it (not Date.now()) for "what is due", so one tick sees one instant. */
  now: Date;
  /** Aborted when the tick's time budget runs out: stop between steps and return. */
  signal: AbortSignal;
  log: TickLog;
  /** Web Push (#50); absent in tests that do not exercise it. */
  sendPush?: SendPush;
  /** Open-Meteo (#62, lib/weather.ts); absent = weather off (tests without a fake, a build without the relay). */
  weather?: WeatherClient;
  /** Demo mode (the test site, `npm run demo`): content still in draft (lines awaiting review, #84) may be used. */
  demo?: boolean;
  /** Her messages (#58, lib/herMessages.ts): the persona service writes them; absent = off (tests that do not exercise them). */
  her?: HerMessages;
  /** His memory files (#51, lib/memoryAssets.ts); absent = no store bound (recordings stay base64 in D1). */
  memoryStore?: MemoryStore;
  /** Batched chat memory (lib/memoryFlush.ts): folds a quiet conversation's pending turns in; absent = off. */
  flushMemory?: FlushPersona;
}
export interface TickJob {
  /** Stable key in `job_runs`; renaming a job resets its schedule. */
  name: string;
  /** Minimum time between two starts; 0 = every tick. Cron fires can drift a few seconds, so ask for a little less than the period meant. */
  everyMs: number;
  /** Returns a few counts for the logs and the tick response. */
  run(ctx: JobContext): Promise<Record<string, unknown> | void>;
}
export interface TickLog {
  info(obj: object, msg?: string): void;
  error(obj: object, msg?: string): void;
}

/** Far inside the 5-minute cadence, so one slow job can never make ticks pile up behind each other. */
export const TICK_BUDGET_MS = 25_000;
/** A run that never recorded its end (the container died mid-job) holds the job this long before it may run again. */
export const JOB_LEASE_MS = 10 * 60_000;

class TickTimeout extends Error { constructor() { super('timeout'); } }

const iso = (ms: number) => new Date(ms).toISOString();
const message = (e: unknown) => (e instanceof Error ? e.message : String(e)).slice(0, 500);

export async function runTick(repos: Repos, jobs: readonly TickJob[], opts: { log: TickLog; clock?: () => number; budgetMs?: number; sendPush?: SendPush; weather?: WeatherClient; demo?: boolean; her?: HerMessages; memoryStore?: MemoryStore; flushMemory?: FlushPersona }): Promise<TickResT> {
  const clock = opts.clock ?? Date.now;
  const started = clock();
  const deadline = started + (opts.budgetMs ?? TICK_BUDGET_MS);
  const out: TickResT['jobs'] = [];
  // Set when a job hits the deadline. Timers can fire a millisecond before the clock reads the deadline, so the
  // clock alone could let the next job start on a budget that is already spent.
  let outOfTime = false;
  for (const job of jobs) {
    const t0 = clock();
    const entry = (status: TickResT['jobs'][number]['status'], result: Record<string, unknown> | null = null, error: string | null = null) =>
      out.push({ name: job.name, status, ms: Math.max(0, Math.round(clock() - t0)), result, error });
    if (outOfTime || t0 >= deadline) { entry('skipped'); continue; }

    let claimed: boolean;
    try {
      claimed = await repos.jobs.claim(job.name, iso(t0), iso(t0 - job.everyMs), iso(t0 - JOB_LEASE_MS));
    } catch (e) {
      opts.log.error({ job: job.name, err: message(e) }, 'tick_claim_failed');
      entry('failed', null, message(e));
      continue;
    }
    if (!claimed) {
      const prev = await repos.jobs.get(job.name).catch(() => null);
      entry(prev && !prev.finishedAt ? 'busy' : 'not_due');
      continue;
    }

    const ctrl = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => { timer = setTimeout(() => { reject(new TickTimeout()); ctrl.abort(); }, deadline - t0); });
    let ok = false;
    let result: Record<string, unknown> | null = null;
    let error: string | null = null;
    try {
      result = (await Promise.race([job.run({ repos, now: new Date(t0), signal: ctrl.signal, log: opts.log, sendPush: opts.sendPush, weather: opts.weather, demo: opts.demo, her: opts.her, memoryStore: opts.memoryStore, flushMemory: opts.flushMemory }), timeout])) ?? null;
      // A job that returned because it was aborted did not finish its work.
      if (ctrl.signal.aborted) throw new TickTimeout();
      ok = true;
    } catch (e) {
      error = e instanceof TickTimeout ? 'timeout' : message(e);
      if (error === 'timeout') outOfTime = true;
      opts.log.error({ job: job.name, err: error }, 'tick_job_failed');
    } finally {
      clearTimeout(timer);
    }
    // Recording the end must not stop the next job either; an unrecorded run just holds the job for the lease.
    await repos.jobs.finish(job.name, iso(clock()), { ok, error, result }).catch((e) => opts.log.error({ job: job.name, err: message(e) }, 'tick_finish_failed'));
    entry(ok ? 'ok' : error === 'timeout' ? 'timeout' : 'failed', result, error);
  }
  return { startedAt: iso(started), tookMs: Math.round(clock() - started), jobs: out };
}

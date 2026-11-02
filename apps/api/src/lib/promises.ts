import { z } from 'zod';
import {
  localText, PROMISE_KINDS, PROMISE_RULES, dueFrom, jstDay, keepLineKind, promiseLine, timelessPromise,
  type Lang, type PromiseItemT, type PromiseProposalT, type StarId
} from '@jstar/shared';
import { LINES } from '@jstar/shared/lines';
import { promiseTextIn } from '@jstar/shared/memoryText';
import type { PromiseRow, Repos, UserRow } from '../db/types';
import type { AgentPromise } from './agent';
import { newId } from './crypto';
import { recordEvent } from './events';

/**
 * Promises (#59, docs/requirements.md §11.4): how one is made, kept and missed. Routes (modules/promises.ts, chat.ts,
 * inbox.ts, scene.ts) and the tick (jobs/duePromises.ts) all go through here, so "kept" means the same everywhere.
 */

const iso = (ms: number) => new Date(ms).toISOString();
const clip = (text: string) => [...text.trim()].slice(0, PROMISE_RULES.textMax).join('');

export const toPromiseItem = (r: PromiseRow, lang: Lang = r.lang): PromiseItemT => ({
  id: r.id, star: r.star, text: timelessPromise(promiseTextIn(r.star, r.text, lang)), kind: r.kind, status: r.status, source: r.source,
  dueAt: r.dueAt, madeAt: r.madeAt, keptAt: r.keptAt, sceneId: r.sceneId
});

/** A new open promise; the caller writes it (`repos.promises.create`, or a scene's grant). */
export function newPromise(p: Pick<PromiseRow, 'userId' | 'star' | 'text' | 'dueAt' | 'kind' | 'source' | 'lang'> & Partial<Pick<PromiseRow, 'sourceMsgId' | 'sceneId'>>, now: number): PromiseRow {
  return {
    id: newId('prm'), userId: p.userId, star: p.star, text: clip(p.text), dueAt: p.dueAt, kind: p.kind, status: 'open', source: p.source,
    madeAt: iso(now), keptAt: null, sourceMsgId: p.sourceMsgId ?? null, sceneId: p.sceneId ?? null, lang: p.lang,
    notifiedAt: null, missedAt: null, mentionedAt: null
  };
}

/**
 * Keeps a promise if he came within its window: status kept, its inbox line read, a memory card of it (#51 思い出),
 * and `promise.kept` (#52). A promise kept before the tick reached it also records its `promise.due`, so the
 * revisit rate (kept / due) counts it. Null when it was not open or not in the window.
 */
export async function keepPromise(repos: Repos, row: PromiseRow, now: number, windowMs: number = PROMISE_RULES.windowMs): Promise<PromiseRow | null> {
  // The window around its time (inPromiseWindow's, unless a wider one is given: her wake-up, below).
  if (row.status !== 'open' || Math.abs(Date.parse(row.dueAt) - now) > windowMs) return null;
  const at = iso(now);
  const memory = { id: newId('mem'), userId: row.userId, star: row.star, title: [...row.text].slice(0, 40).join(''), createdAt: at, kind: 'promise' as const, sceneId: row.sceneId };
  const kept = await repos.promises.keep(row.id, at, iso(now - windowMs), iso(now + windowMs), memory);
  if (!kept) return null;
  // A metric never undoes the keeping: a storage error here is dropped (as app.recordEvent does).
  const record = async (name: 'promise.due' | 'promise.kept') =>
    recordEvent(repos, row.userId, name, { star: row.star, promiseId: row.id }, new Date(now)).catch(() => undefined);
  if (!row.notifiedAt) await record('promise.due');
  await record('promise.kept');
  return kept;
}

/**
 * Her wake-up keeps her wake-up promise (#57, #66): 「明日の朝、起こしてあげる」 is kept the morning she wakes him — by
 * the alarm he set when she proposed it, at his own time — within PROMISE_RULES.wakeKeepMs of when it was due. Only a
 * promise made before this wake-up (never one made after it rang). Null when there is none to keep.
 */
export async function keepWakePromise(repos: Repos, userId: string, star: StarId, now: number, rangAt: number = now): Promise<PromiseRow | null> {
  const row = (await repos.promises.open(userId, star)).find((p) => p.kind === 'wakeup' && Date.parse(p.madeAt) < rangAt);
  return row ? keepPromise(repos, row, now, PROMISE_RULES.wakeKeepMs) : null;
}

/**
 * Her opening when he comes to her (#59): the promise she keeps now, or — once — the missed one she brings up
 * gently. Null when there is neither, and her usual greeting stands.
 */
export async function promiseOpening(repos: Repos, user: UserRow, star: StarId, lang: Lang, now: number): Promise<{ text: string; promise: PromiseRow } | null> {
  const [open] = await repos.promises.open(user.id, star);
  if (open) {
    const kept = await keepPromise(repos, open, now);
    if (kept) return { text: promiseLine(keepLineKind(kept, now), lang, timelessPromise(promiseTextIn(star, kept.text, lang)), { star, dueAt: kept.dueAt, tz: user.tz }), promise: kept };
  }
  const missed = await repos.promises.toMention(user.id, star);
  if (missed && (await repos.promises.mention(missed.id, iso(now)))) {
    return { text: promiseLine('missed', lang, timelessPromise(promiseTextIn(star, missed.text, lang)), { star, dueAt: missed.dueAt, tz: user.tz }), promise: { ...missed, mentionedAt: iso(now) } };
  }
  return null;
}

/**
 * What the persona service is told about a promise with her (#59 "written to memory"): the open one, or the one she
 * kept within the last window (she is keeping it right now). Null otherwise.
 */
export function agentPromise(row: PromiseRow | null, now: number): AgentPromise | null {
  if (!row) return null;
  if (row.status === 'open') return { text: timelessPromise(row.text), dueAt: row.dueAt, kind: row.kind, status: 'open' };
  if (row.status === 'kept' && row.keptAt && now - Date.parse(row.keptAt) <= PROMISE_RULES.windowMs) return { text: timelessPromise(row.text), dueAt: row.dueAt, kind: row.kind, status: 'kept' };
  return null;
}

/**
 * The promise the memory model heard in a chat turn. Untrusted model output: only a short text, a real absolute time
 * between PROMISE_RULES.chatMinAheadMs and chatMaxAheadMs from now, and a known kind pass.
 */
const zHeard = z.object({
  text: z.string().trim().min(1).max(200),
  dueAt: z.string().max(40).refine((v) => /(?:[zZ]|[+-]\d{2}:?\d{2})$/.test(v) && !Number.isNaN(Date.parse(v)), 'absolute_time'),
  kind: z.enum(PROMISE_KINDS).catch('free')
});
export function heardPromise(raw: unknown, now: number): { text: string; dueAt: string; kind: PromiseRow['kind'] } | null {
  const p = zHeard.safeParse(raw);
  if (!p.success) return null;
  const due = Date.parse(p.data.dueAt);
  if (due < now + PROMISE_RULES.chatMinAheadMs || due > now + PROMISE_RULES.chatMaxAheadMs) return null;
  // Round 12: stored without a relative day (明晚 / 내일 / tomorrow): the day is shown from dueAt.
  return { text: timelessPromise(p.data.text), dueAt: iso(due), kind: p.data.kind };
}

/**
 * Her proposal for the next time (#82 lines, five per talent), one a day in turn. Her lines are drafts until native
 * review (#84): they reach users only in demo mode (the test site, local demos) until `draft` is false.
 */
export function proposalFor(star: StarId, lang: Lang, now: number, demo: boolean): PromiseProposalT | null {
  const lines = LINES[star];
  if (lines.draft && !demo) return null;
  const n = Math.floor(Date.parse(`${jstDay(now)}T00:00:00Z`) / 86_400_000);
  const line = lines.promises[n % lines.promises.length];
  return proposalLine(star, line.id, lang, now, demo);
}

export function proposalLine(star: StarId, lineId: string, lang: Lang, now: number, demo: boolean): PromiseProposalT | null {
  const lines = LINES[star];
  if (lines.draft && !demo) return null;
  const line = lines.promises.find((l) => l.id === lineId);
  const dueAt = line && dueFrom(line.due, now);
  if (!line || !dueAt) return null;
  return { star, lineId: line.id, kind: line.kind, propose: localText(line.propose, lang), text: clip(localText(line.promise, lang)), dueAt };
}

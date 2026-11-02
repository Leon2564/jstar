import type { Lang, StarId } from '@jstar/shared';
import type { ChatMemoryRow, PendingTurn, Repos } from '../db/types';
import type { AgentTurn, MemoryFlushInput, MemoryFlushResult } from './agent';
import { factsForAgent, saveMemory } from './wishes';

/**
 * Batched memory (cost work, 2026-09-29; apps/agent/app/memory.py `memory_due`). The persona service updates chat
 * memory when an update is due rather than on every turn; the turns it has not taken in yet wait in
 * chat_memory.pending (D1), go back to it with every turn as `unsaved`, and all go into the next update — on his 5th
 * message, sooner when a turn needs the model now, when he leaves the chat (POST /v1/chat/memory/flush) or when the
 * conversation has been quiet for QUIET_MS (tick job `memory.flush`). Nothing he says is dropped on a restart: the
 * buffer is in the database, and a turn leaves it only once an update took it in.
 */

/** Pending turns kept (his and hers): 20 of his messages, reached only if memory keeps failing. */
export const PENDING_MAX = 40;
/** No new turn for this long and the conversation is quiet: what is pending goes into memory. */
export const QUIET_MS = 10 * 60_000;

export type FlushPersona = (input: MemoryFlushInput) => Promise<MemoryFlushResult>;

/** The pending turns as the persona service reads them. */
export const unsavedFor = (memory: Pick<ChatMemoryRow, 'pending'> | null): AgentTurn[] =>
  (memory?.pending ?? []).slice(-PENDING_MAX).map(({ role, text }) => ({ role, text }));

/**
 * After a delivered turn: taken into memory (`memorySaved` not false) → the turns that were pending when it started
 * leave the buffer; not taken in → this turn joins it. `id` is his message's id.
 */
export async function keepTurn(
  repos: Repos, userId: string, star: StarId, before: Pick<ChatMemoryRow, 'pending'> | null, memorySaved: boolean | undefined,
  turn: { id: string; text: string; reply: string }, at = new Date().toISOString()
): Promise<void> {
  if (memorySaved === false) {
    const turns: PendingTurn[] = [{ id: turn.id, role: 'user', text: turn.text }, { id: turn.id, role: 'assistant', text: turn.reply }];
    await repos.chatMemory.addPending(userId, star, turns, at, PENDING_MAX);
  } else if (before?.pending.length) {
    await repos.chatMemory.dropPending(userId, star, before.pending.map((t) => t.id));
  }
}

/** Folds his pending turns with one talent into memory. `failed`: the model did not answer; they stay for next time. */
export async function flushMemory(repos: Repos, persona: FlushPersona, userId: string, star: StarId, lang: Lang): Promise<'empty' | 'saved' | 'failed'> {
  const row = await repos.chatMemory.get(userId, star);
  if (!row?.pending.length) return 'empty';
  const out = await persona({ star, lang, userId, memory: { facts: factsForAgent(row.facts), summary: row.summary }, unsaved: unsavedFor(row) });
  if (!out.saved) return 'failed';
  if (out.memory) await saveMemory(repos, userId, star, row, out.memory, []);
  await repos.chatMemory.dropPending(userId, star, row.pending.map((t) => t.id));
  return 'saved';
}

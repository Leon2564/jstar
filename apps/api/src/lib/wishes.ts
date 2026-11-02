import { WISHES_FACT, formatWishes, giftById, localText, parseWishes, wishToHint, wishesIn, type GiftId, type Lang, type StarId } from '@jstar/shared';
import type { ChatMemoryRow, Repos } from '../db/types';
import type { AgentMemory, AgentTastes } from './agent';

/**
 * Her tastes in everyday conversation (#77, docs/requirements.md §14.3). What he has learned she likes is chat memory:
 * facts `her_wishes` (gift ids). Only the API writes that fact — from her own words or her reaction to a gift — so
 * the persona service's memory model can neither invent nor drop it; it is kept out of the "facts he told you" the
 * persona reads and handed over as `tastes` instead.
 */
export const wishesOf = (memory: Pick<ChatMemoryRow, 'facts'> | null | undefined): GiftId[] => parseWishes(memory?.facts[WISHES_FACT]);

/** His facts as the persona reads them: without her tastes, which are not something he told her. */
export function factsForAgent(facts: Record<string, string>): Record<string, string> {
  const { [WISHES_FACT]: _wishes, ...rest } = facts;
  return rest;
}

export const giftName = (id: GiftId, lang: Lang): string => localText(giftById(id)?.name, lang);

/** What the persona gets for a chat turn: the tastes he knows, and on its turn one she may mention (docs: GIFT_RULES). */
export function tastesForAgent(star: StarId, lang: Lang, sent: number, known: GiftId[]): AgentTastes | null {
  const hint = wishToHint(star, sent, known);
  if (!known.length && !hint) return null;
  return { known: known.map((id) => giftName(id, lang)), hint: hint ? giftName(hint, lang) : null };
}

/**
 * Saves chat memory after a turn or a gift: the persona's update (if any) with her tastes merged back in. `learned`
 * are liked gifts he has just learned about; nothing is written when neither changed.
 */
export async function saveMemory(
  repos: Repos, userId: string, star: StarId, before: ChatMemoryRow | null, update: AgentMemory | null | undefined, learned: GiftId[]
): Promise<GiftId[]> {
  const known = wishesOf(before);
  const next = [...known, ...learned.filter((id) => !known.includes(id))];
  if (!update && next.length === known.length) return known;
  const facts = factsForAgent(update ? update.facts ?? {} : before?.facts ?? {});
  const summary = update ? update.summary ?? null : before?.summary ?? null;
  await repos.chatMemory.save(userId, star, next.length ? { ...facts, [WISHES_FACT]: formatWishes(next) } : facts, summary);
  return next;
}

/** Her liked gifts her reply just mentioned. */
export const heardWishes = (star: StarId, reply: string): GiftId[] => wishesIn(star, reply);

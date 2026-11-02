import { STAR_IDS, WORLD, levelFromXp, loverLevel, routineNow, weatherPoint, type Lang, type StarId } from '@jstar/shared';
import { fitHerMessage, type HerMessageKind } from '@jstar/shared/herMessages';
import { SCENES, scenePlayable } from '@jstar/shared/scenes';
import type { HerMessageDue, HerPlanCandidate, InboxRow, Repos, WeatherRow } from '../db/types';
import type { HerMessageInput, HerRestateInput } from './agent';
import { agentPromise } from './promises';
import { resolveCallName } from './bond';
import { weatherNow } from './weather';
import { factsForAgent } from './wishes';

/**
 * Her messages (#58, docs/requirements.md §11.3): what the tick jobs (src/jobs/herMessages.ts) need to write one —
 * who she is to him, what she is doing, the weather where she is — and what opening one does.
 */

/** Writes her message through the persona service; null when the model failed or the safety pass threw it away. */
export type HerWriter = (input: HerMessageInput) => Promise<string | null>;
/**
 * The tick's handle on her messages. Absent = off (tests that do not exercise them, like `weather`); `demo` decides
 * which scenes an invitation may point to (the publish rule, scenePlayable).
 */
export interface HerMessages {
  write: HerWriter; demo: boolean;
  /** M18: her message re-rendered in another language when he reads it (lib/inboxLang.ts); absent = shown as written. */
  restate?: HerRestater;
}
/** Her written message in `lang`, or null (no model, it failed, or the safety pass threw it away). */
export type HerRestater = (input: HerRestateInput) => Promise<string | null>;

/** The talent he is closest to now: the one he was with last, then the one he has spent the most days with. */
export function favouriteOf(stars: HerPlanCandidate['stars']): StarId {
  return [...stars].sort((a, b) => b.lastDay.localeCompare(a.lastDay) || b.daysTogether - a.daysTogether || STAR_IDS.indexOf(a.star) - STAR_IDS.indexOf(b.star))[0].star;
}

/**
 * The scene her invitation points to: hers, startable in this mode, meant for the evening, and open to anyone (no
 * variant card, no cost). Her signature scene first; null when none is, and she simply invites him to her room.
 */
export function inviteScene(star: StarId, demo: boolean): string | null {
  const mine = SCENES.filter((s) => s.meta.star === star && scenePlayable(s, demo) && !s.meta.cost && !s.meta.trigger.variantCard
    && s.meta.trigger.slots.some((x) => x === 'evening' || x === 'night'));
  return (mine.find((s) => s.meta.id === WORLD[star].signatureScene.id) ?? mine[0])?.meta.id ?? null;
}

/** Her weather in a few words for the prompt ("rain, 18°C"); null when missing or stale. Never the city's name. */
export function weatherWords(row: WeatherRow | undefined, now: Date): string | null {
  const w = weatherNow(row, [], now);
  if (!w || w.stale) return null;
  return [w.weather, `${Math.round(w.tempC)}°C`, w.alert ? `warning: ${w.alert.replace('_', ' ')}` : null].filter(Boolean).join(', ');
}

/** Everything the persona service is told for one message: memory, where they stand, her day, her weather, the scene. */
export async function herMessageInput(repos: Repos, due: HerMessageDue, now: Date, weather: Map<string, WeatherRow>): Promise<HerMessageInput> {
  const { userId, star, kind } = due;
  const [memory, xp, bond, promise] = await Promise.all([
    repos.chatMemory.get(userId, star), repos.affinity.get(userId, star), repos.relationship.get(userId, star), repos.promises.latest(userId, star)
  ]);
  const { callName } = await resolveCallName(repos, { id: userId, nickname: due.user.nickname }, star, bond?.stage ?? 'new', memory?.facts ?? null, due.user.lang);
  return {
    callName,
    star, kind, lang: due.user.lang, userId, level: levelFromXp(xp),
    // Her tastes (#77) are not something he told her: they stay out of his facts, as in chat (lib/wishes.ts).
    memory: memory ? { facts: factsForAgent(memory.facts), summary: memory.summary } : null,
    ...(bond ? { stage: bond.stage, daysTogether: bond.daysTogether, anniversary: bond.anniversary, loverLevel: loverLevel(bond, xp) } : { stage: 'new' as const, daysTogether: 0 }),
    promise: agentPromise(promise, now.getTime()),
    status: routineNow(star, now).status.en,
    weather: weatherWords(weather.get(weatherPoint(star).cityId), now),
    scene: kind === 'invite' ? WORLD[star].signatureScene.title.en : null
  };
}

/** Asks the model once; anything but a fitting line (a failure, a timeout, nothing, too long) is null. */
export async function writeHerMessage(write: HerWriter, input: HerMessageInput): Promise<string | null> {
  try {
    const text = await write(input);
    return text ? fitHerMessage(text, input.lang) : null;
  } catch {
    return null;
  }
}

/**
 * Her inbox line for a message: the text, which kind it is, and for an invitation the scene it points to. M18: the
 * language it was written in (`lang`; her words the model wrote are re-rendered into his on read, lib/inboxLang.ts),
 * or — her fallback line — the line in every language (`texts`).
 */
export function herMessageLine(
  due: Pick<HerMessageDue, 'userId' | 'star' | 'kind' | 'inboxId'>, text: string, sceneId: string | null, at: string,
  written: { lang: Lang } | { texts: Record<Lang, string> }
): InboxRow {
  return {
    id: due.inboxId, userId: due.userId, star: due.star, kind: 'message',
    payload: { text, herMessage: due.kind, ...written, ...(due.kind === 'invite' && sceneId ? { sceneId } : {}) },
    dueAt: at, deliveredAt: null, readAt: null, createdAt: at
  };
}

const isKind = (v: unknown): v is HerMessageKind => v === 'dream' || v === 'note' || v === 'invite';

/**
 * He opened her message for the first time: it becomes her line in the conversation (#58), so his reply is a reply to
 * it and she remembers what she wrote. Opening it again changes nothing (the first read time is kept, and the id is
 * the item's, which the messages table holds once). Not a message of his: no allowance is used, no day together.
 */
export async function herMessageOpened(repos: Repos, row: InboxRow, at: string): Promise<void> {
  if (row.kind !== 'message' || !isKind(row.payload.herMessage) || row.readAt !== at) return;
  const text = typeof row.payload.text === 'string' ? row.payload.text.trim() : '';
  if (!text) return;
  // Two opens in the same millisecond both look like the first: the id settles it (UNIQUE in SQL, checked here too).
  const id = `msg_${row.id}`;
  if ((await repos.messages.recent(row.userId, row.star, 20)).some((m) => m.id === id)) return;
  await repos.messages.add({ id, ownerId: row.userId, star: row.star, role: 'assistant', text, createdAt: at }).catch(() => undefined);
}

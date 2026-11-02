/**
 * When a scene may be played (#65): her slot of the day on Japan's clock, and why a scene cannot start now. C-room N1:
 * when it can — now, or the next stretch her hour and routine allow — so an invitation is entered or promised, never
 * locked. Its own module so her room (prototype mode) loads it without the player's engine (scenes/invite.ts).
 */
import { PROMISE_RULES } from '../rules';
import { stageAtLeast, type RelationshipStage } from '../relationship';
import { routineMatches, routineNow, type RoutineNow } from '../world';
import type { SceneMeta, Slot } from './schema';

const HOUR = 3_600_000;

/** Morning 5–11, day 11–17, evening 17–21, otherwise night, in Japan time (the business runs on JST). */
export function jstSlot(now: number): Slot {
  const h = new Date(now + 9 * HOUR).getUTCHours();
  return h >= 5 && h < 11 ? 'morning' : h >= 11 && h < 17 ? 'day' : h >= 17 && h < 21 ? 'evening' : 'night';
}

export interface TriggerContext {
  slot: Slot;
  /** The sky at her window (weather.ts `sceneWeatherOf`, #63); null when unknown or stale, and a scene that needs weather stays locked. */
  weather: string | null;
  /** His relationship stage with her (#54). */
  stage: RelationshipStage;
  owns: (cardId: string) => boolean;
  /** His variant card's own level (#75, 1–10); absent = 1 everywhere, so a variant layer above 1 stays locked. */
  variantLevel?: (cardId: string) => number;
  /** Where she is in her day now (world.ts `routineNow`, #60); null = unknown, and a scene that needs a routine stays locked. */
  routine: Pick<RoutineNow, 'presence' | 'activity'> | null;
}

/** Why a scene cannot start now; empty when it can. */
export function triggerProblems(meta: SceneMeta, ctx: TriggerContext): string[] {
  const t = meta.trigger;
  const out: string[] = [];
  if (!t.slots.includes(ctx.slot)) out.push('slot');
  if (t.weather && !(ctx.weather && (t.weather as string[]).includes(ctx.weather))) out.push('weather');
  if (t.stage && !stageAtLeast(ctx.stage, t.stage)) out.push('stage');
  if (t.variantLayer && !t.variantCard) out.push('variant_card');
  if (t.variantCard && !ctx.owns(t.variantCard)) out.push('variant_card');
  // #76: her variant scenes open by her variant card's level (1 / 3 / 6 / 10), never by the main relationship.
  if (t.variantLayer && t.variantLayer > 1 && (t.variantCard && ctx.variantLevel ? ctx.variantLevel(t.variantCard) : 1) < t.variantLayer) out.push('variant_level');
  if (t.routine && !(ctx.routine && routineMatches(t.routine, ctx.routine))) out.push('routine');
  return out;
}

/** What the hour decides (her slot, her routine): everything else in the way is not a matter of time. */
const TIMED = new Set(['slot', 'routine']);
const QUARTER = 15 * 60_000;
/**
 * C-room N1: when the scene he is invited to can be played — now (`from` ≤ `now`), or the next stretch of time her
 * hour and her routine allow, within a day and a half — so an invitation never leads to a locked scene: it is
 * entered now, or promised for then (「今晚見」). Null when something other than the time stands in the way (his stage,
 * a card, her weather): no time can be promised for it.
 */
export function sceneWindow(meta: SceneMeta, ctx: TriggerContext, now: number): { from: number; to: number } | null {
  if (triggerProblems(meta, ctx).some((p) => !TIMED.has(p))) return null;
  const ok = (at: number) => !triggerProblems(meta, { ...ctx, slot: jstSlot(at), routine: routineNow(meta.star, new Date(at)) }).length;
  const end = now + 36 * HOUR;
  let from: number | null = ok(now) ? now : null;
  // Her slots and routine turn on the hour: quarter hours find each stretch's start and end exactly.
  for (let at = Math.ceil((now + 1) / QUARTER) * QUARTER; at <= end; at += QUARTER) {
    if (from === null) { if (ok(at)) from = at; } else if (!ok(at)) return { from, to: at };
  }
  return from === null ? null : { from, to: end };
}

/**
 * The time a promise for a later window is due (N1): well inside it — the promise is kept within PROMISE_RULES.windowMs
 * of its time either way, so coming early or late in that window still finds the scene open.
 */
export const windowDue = (w: { from: number; to: number }): number => w.from + Math.min(PROMISE_RULES.windowMs, Math.floor((w.to - w.from) / 2));

/**
 * N1: her invitation's scene as the room offers it — `ready` now, or due later (`tonight`: between 17:00 and 05:00 on
 * her clock, within the day); null when no time can be promised (sceneWindow).
 */
export function inviteTiming(meta: SceneMeta, ctx: TriggerContext, now: number): { ready: boolean; dueAt: number | null; tonight: boolean } | null {
  const w = sceneWindow(meta, ctx, now);
  if (!w) return null;
  if (w.from <= now) return { ready: true, dueAt: null, tonight: false };
  const due = windowDue(w);
  const h = new Date(due + 9 * HOUR).getUTCHours();
  return { ready: false, dueAt: due, tonight: due - now < 24 * HOUR && (h >= 17 || h < 5) };
}


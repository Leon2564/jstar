import type { FastifyInstance } from 'fastify';
import {
  TRIGGER_RULES, jstDay, localText, routineNow, variantState,
  type Lang, type RelationshipStage, type SceneInviteT, type StarId
} from '@jstar/shared';
import {
  SCENES, inviteTiming, jstSlot, offersPausedUntil, previewScript, runEndsAt, scenePlayable, triggerProblems, type OfferHistory, type SceneScript, type TriggerContext
} from '@jstar/shared/scenes';
import { parseScene } from '@jstar/shared/scenes/schema';
import type { UserRow } from '../db/types';
import type { AgentSceneOption, AgentSceneTalk } from './agent';
import { relationships } from './relationship';
import { sceneWeather } from './herWorld';
import { SYSTEM_SCENES, cueOf, isSystemScene, openSystemFor } from './systemScenes';

/**
 * What the three ways a scene begins (#65) need from storage and the clock: the scripts, his situation for their
 * trigger conditions, the scenes he could ask for in chat, and the history her proposals are limited by.
 */

/**
 * Every script is checked once at boot: a broken scene must never reach a player. The system scenes (#71) are built
 * from her lines here rather than bundled with the web's SCENES; they are offered only while open for him (below).
 */
const CHECKED = [...SCENES, ...SYSTEM_SCENES].map((s) => parseScene(s));

/**
 * The publish rule (@jstar/shared/scenes `scenePlayable`, owner 2026-09-28): production plays a scene once its script
 * is reviewed and every clip it uses exists. Decided here from the scripts as written, once.
 */
const PRODUCTION = new Set(CHECKED.filter((s) => scenePlayable(s, false)).map((s) => s.meta.id));

/**
 * The scripts as they are played. A script whose clips are still pending (#80, #81) is demo-only, and there her
 * existing clips stand in for them (previewScript); production never reaches it (`playableHere`).
 */
export const SCRIPTS = new Map<string, SceneScript>(CHECKED.map((p) => [p.meta.id, previewScript(p)]));

/** Whether this mode may play the scene: production only the published ones, demo mode everything. */
export const playableHere = (app: FastifyInstance, id: string): boolean => SCRIPTS.has(id) && (app.demo || PRODUCTION.has(id));

/**
 * The scenes the owner reviews on the test site's preview (`/me/preview`): the five (#66–#70) and her variant scenes
 * (#76) — every bundled scene but the demo one and the system scenes — whether production plays them yet or not.
 */
export const PREVIEWABLE: SceneScript[] = CHECKED.filter((s) => !isSystemScene(s.meta.id) && !s.meta.demo);

/** Start of the JST day `now` falls on, as an ISO instant. */
export const jstDayStart = (now: number) => new Date(`${jstDay(now)}T00:00:00+09:00`).toISOString();

/** The relationship stage (#54) a scene's `trigger.stage` is compared with. */
export const sceneStage = (app: FastifyInstance, userId: string, star: StarId): Promise<RelationshipStage> =>
  relationships(app).stageOf(userId, star);

/** His situation with her now: the hour, the weather in her city (#62), the stage, his cards, her routine (#48), his points. */
export async function triggerContext(app: FastifyInstance, user: UserRow, star: StarId, now: number): Promise<TriggerContext & { points: number }> {
  // Her city's real sky in the scripts' words (#63, sceneWeatherOf: fog reads as cloudy, thunder as rain). Stale or
  // unknown weather is no weather (#62 降级): a scene that needs rain stays locked rather than trusting old data.
  const [stage, owned, weather, variants] = await Promise.all([
    sceneStage(app, user.id, star), app.repos.owned.forUser(user.id), sceneWeather(app.repos, star, new Date(now)).catch(() => null),
    app.repos.cardAffection.forUser(user.id)
  ]);
  return {
    slot: jstSlot(now),
    weather,
    stage,
    owns: (id) => owned.some((o) => o.cardId === id),
    // #76: her variant scenes open by the variant card's own level (the highest reached, never lower).
    variantLevel: (id) => variantState(variants.find((v) => v.cardId === id) ?? null).level,
    routine: routineNow(star, new Date(now)),
    points: user.points
  };
}

/** Why a scene cannot start for him now (triggerProblems, plus points for one with a cost); empty = ready. */
export function problemsFor(script: SceneScript, ctx: TriggerContext & { points: number }): string[] {
  const cost = script.meta.cost?.points ?? 0;
  return [...triggerProblems(script.meta, ctx), ...(cost > ctx.points ? ['points'] : [])];
}

/**
 * Her scenes that may be offered in this mode at all (the publish rule, `playableHere`). A system scene (#71) belongs
 * to a moment: only those in `open` (openSystemFor: his birthday, her weather message, late at night…) are among them.
 */
export const offerableFor = (app: FastifyInstance, star: StarId, open: ReadonlySet<string> = new Set()): SceneScript[] =>
  [...SCRIPTS.values()].filter((s) => s.meta.star === star && playableHere(app, s.meta.id) && (!isSystemScene(s.meta.id) || open.has(s.meta.id)));

/**
 * C-room N1 / D-N1: the scene her invitation names, as her room may offer it — ready now, or when it can be (a promise
 * for then: 「今晚見」). A moment's scene (#71: her birthday, his, her weather message) is offered only while that moment
 * is open for him (`openSystemFor`, the gate the start uses) — a stale calendar message is her words, never a locked
 * scene. Null for a scene that is not hers or not playable here, her confession (its own gate), a moment that is not
 * open, or a scene no time can be promised for. Points are not asked: a scene's cost is paid when it starts.
 */
export async function inviteFor(app: FastifyInstance, user: UserRow, star: StarId, sceneId: string, now: number): Promise<SceneInviteT | null> {
  const moment = isSystemScene(sceneId);
  const script = playableHere(app, sceneId) ? SCRIPTS.get(sceneId) : undefined;
  if (!script || script.meta.star !== star) return null;
  const ctx = await triggerContext(app, user, star, now);
  if (moment) {
    const open = (await openSystemFor(app, user, star, now)).includes(sceneId) && !problemsFor(script, { ...ctx, points: Number.MAX_SAFE_INTEGER }).length;
    return open ? { sceneId, title: script.meta.title, ready: true, dueAt: null, tonight: false } : null;
  }
  const timing = inviteTiming(script.meta, ctx, now);
  return timing && { sceneId, title: script.meta.title, ready: timing.ready, dueAt: timing.dueAt === null ? null : new Date(timing.dueAt).toISOString(), tonight: timing.tonight };
}

/** The scenes he could ask for in this chat turn, for the persona service's intent pass. */
export async function sceneOptions(app: FastifyInstance, user: UserRow, star: StarId, lang: Lang, now = Date.now()): Promise<AgentSceneOption[]> {
  const scripts = offerableFor(app, star, new Set(await openSystemFor(app, user, star, now)));
  if (!scripts.length) return [];
  const ctx = await triggerContext(app, user, star, now);
  return scripts.flatMap((s) => {
    const problems = problemsFor(s, ctx);
    // A moment is there or it is not: a system scene is never something to bargain for, so it is listed only when ready.
    if (isSystemScene(s.meta.id) && problems.length) return [];
    const cue = cueOf(s.meta.id);
    return [{ id: s.meta.id, title: localText(s.meta.title, lang), ready: problems.length === 0, problems, ...(cue ? { cue } : {}) }];
  });
}

/** Free talk inside a scene, for the persona service: where this step may turn. */
export function sceneTalk(script: SceneScript, stepId: string): AgentSceneTalk | undefined {
  const step = script.steps.find((s) => s.id === stepId);
  if (!step || step.type !== 'input' || step.mode !== 'free') return undefined;
  return { id: script.meta.id, step: step.id, jumps: (step.jumps ?? []).map((j) => ({ to: j.to, hint: j.hint, words: j.words ?? [] })) };
}

/** Runs that can still pause her offers: a goodnight's night is the longest pause, well under a day. */
const PAUSE_LOOKBACK_MS = 24 * 3_600_000;

/**
 * M2: until when she offers nothing after the scenes he has ended (shared `offersPausedUntil`: a cool-down after any
 * run, goodnight's night); null when nothing pauses her. His clock is `tz` (users.tz, JST when unknown).
 */
export async function offersPausedFor(app: FastifyInstance, userId: string, tz: string | null | undefined, now: number): Promise<number | null> {
  const ended = await app.repos.sceneRuns.endedSince(userId, new Date(now - PAUSE_LOOKBACK_MS).toISOString());
  return offersPausedUntil(ended.map((r) => ({ sceneId: r.sceneId, endedAt: Date.parse(r.endedAt), outcome: r.outcome })), tz);
}

/** What her proposals are limited by (TRIGGER_RULES), read from his offers and runs. `sceneIds`: the candidates. */
export async function offerHistory(app: FastifyInstance, userId: string, sceneIds: string[], now: number, tz?: string | null): Promise<OfferHistory> {
  const dayStart = jstDayStart(now);
  const windowStart = new Date(Math.min(Date.parse(dayStart), now - TRIGGER_RULES.declineCooldownMs, now - TRIGGER_RULES.minProposalGapMs)).toISOString();
  const [offers, active, open, played, pausedUntil] = await Promise.all([
    app.repos.sceneOffers.since(userId, windowStart),
    app.repos.sceneRuns.active(userId),
    app.repos.promises.open(userId),
    Promise.all(sceneIds.map(async (id) => ({
      id,
      today: (await app.repos.sceneRuns.rewardedSince(userId, id, dayStart)) > 0,
      ever: (await app.repos.sceneRuns.rewardedSince(userId, id, '')) > 0
    }))),
    offersPausedFor(app, userId, tz, now)
  ]);
  const today = offers.filter((o) => o.createdAt >= dayStart);
  const proposals = offers.filter((o) => o.source === 'proposed');
  const cooldownStart = new Date(now - TRIGGER_RULES.declineCooldownMs).toISOString();
  return {
    // A run past its cap (30 minutes, or its date's countdown, #69) is over even before a read settles it.
    inScene: !!active && now < runEndsAt(Date.parse(active.startedAt), active.state.timerEndsAt),
    proposalsToday: today.filter((o) => o.source === 'proposed').length,
    lastProposalAt: proposals.length ? Math.max(...proposals.map((o) => Date.parse(o.createdAt))) : null,
    timeOffersToday: today.filter((o) => o.source === 'time').length,
    timeOfferedToday: new Set(today.filter((o) => o.source === 'time').map((o) => o.sceneId)),
    declined: new Set(offers.filter((o) => o.status === 'declined' && (o.answeredAt ?? '') >= cooldownStart).map((o) => o.sceneId)),
    playedToday: new Set(played.filter((p) => p.today).map((p) => p.id)),
    playedEver: new Set(played.filter((p) => p.ever).map((p) => p.id)),
    // A promise of hers that names a scene (#59) comes first when she proposes.
    promised: new Set(open.flatMap((p) => (p.sceneId ? [p.sceneId] : []))),
    pausedUntil
  };
}

export const offerExpiry = (now: number) => new Date(now + TRIGGER_RULES.offerTtlMs).toISOString();

/**
 * Their first meeting (N-29): he has not talked with her before today (JST) — his account's first day, or the day he
 * first comes to her. Her first words to him are a greeting, never a scene proposal; she offers one on a later visit.
 */
export async function firstMeeting(app: FastifyInstance, user: UserRow, star: StarId, now: number): Promise<boolean> {
  // Her latest words with him: one from before today means they have met. A full page of today's alone is a long
  // talk today, not a first meeting.
  const PAGE = 200;
  const recent = await app.repos.messages.recent(user.id, star, PAGE);
  return recent.length < PAGE && !recent.some((m) => m.createdAt < jstDayStart(now));
}

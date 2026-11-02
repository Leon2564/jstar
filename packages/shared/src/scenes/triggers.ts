/**
 * How a scene begins (#65): he asks for it (the chat path, see apps/agent intent), she proposes it when he enters her
 * room or sits there quietly, or the moment calls for it (a time window, the weather, a newly reached stage, an inbox
 * event). Pure, like the engine: the API runs it against storage and the clock, and tests run it against fixtures.
 *
 * Nothing unplayable is ever offered: the publish rule below decides what each mode may play, and the web drops an
 * offer whose clips it cannot find (apps/web/src/scene/offer.ts), which its catalogue test also checks for every
 * script in SCENES.
 */
import { herLocalClock, herZonedInstant } from '../herMessages';
import { TRIGGER_RULES } from '../rules';
import { mediaReady } from './media';
import type { SceneMeta, SceneScript } from './schema';
import { systemSceneOf } from './systemIds';

/**
 * The script half of the publish rule: in production a scene needs reviewed lines (no `meta.draft`, #84) and must not
 * be a demo scene; demo mode (the test site, local demos, the prototype) may start anything.
 */
export const sceneOffered = (meta: Pick<SceneMeta, 'demo' | 'draft'>, demoMode: boolean): boolean =>
  demoMode || (!meta.draft && !meta.demo);

/**
 * The publish rule (owner, 2026-09-28): **a scene is playable in production when its script is reviewed AND all its
 * media exist; otherwise it stays demo-only.** In demo mode every scene plays, pending clips replaced by her existing
 * ones (./media.ts `previewScript`). The API, the invite jobs and the prototype player all ask here.
 */
export const scenePlayable = (script: SceneScript, demoMode: boolean): boolean =>
  sceneOffered(script.meta, demoMode) && (demoMode || mediaReady(script));

/** The scripts that may be started or offered in this mode. */
export const offerableScenes = (scripts: readonly SceneScript[], demoMode: boolean): SceneScript[] =>
  scripts.filter((s) => scenePlayable(s, demoMode));

/** Every clip a script plays, and its idle loop: what must exist before it may be offered. */
export function sceneMedia(script: SceneScript): string[] {
  const ids = script.steps.flatMap((s) => (s.type === 'clip' ? [s.media] : []));
  return [...new Set([...(script.meta.idle ? [script.meta.idle] : []), ...ids])];
}

/** An offer's origin, as `scene.trigger` records it (#52 TRIGGER_SOURCES, minus `request`, which needs no offer). */
export type OfferSource = 'proposed' | 'time';

/** What the API knows about him that the choice depends on. Sets hold scene ids. */
export interface OfferHistory {
  /** He is in a scene now: nothing is offered over it. */
  inScene: boolean;
  /** Her proposals today (JST), all talents. */
  proposalsToday: number;
  lastProposalAt: number | null;
  /** Time and event offers today, all talents. */
  timeOffersToday: number;
  /** Scenes already offered as a time event today. */
  timeOfferedToday: ReadonlySet<string>;
  /** Scenes he said "not now" to within TRIGGER_RULES.declineCooldownMs. */
  declined: ReadonlySet<string>;
  /** Scenes with a rewarded run today, and ever. */
  playedToday: ReadonlySet<string>;
  playedEver: ReadonlySet<string>;
  /** Scenes a promise of hers points to (#59); empty until promises carry a scene. */
  promised: ReadonlySet<string>;
  /** M2: until when she offers nothing after his last scene (`offersPausedUntil`); null or absent = no pause. */
  pausedUntil?: number | null;
}

export const emptyOfferHistory = (): OfferHistory => ({
  inScene: false, proposalsToday: 0, lastProposalAt: null, timeOffersToday: 0, timeOfferedToday: new Set(),
  declined: new Set(), playedToday: new Set(), playedEver: new Set(), promised: new Set(), pausedUntil: null
});

/** One of his runs that has ended: what the pause after a scene is read from. */
export interface EndedRun { sceneId: string; endedAt: number; outcome: string | null }

/** Ways a run ends that are not the scene played out: he left, went quiet, ran out of time, or started another. */
const UNFINISHED = new Set(['left', 'idle', 'timeout', 'replaced']);

/**
 * M2 (D-scenes 47b0fcb: she offered another scene right after goodnight, and after the confession): until when she
 * offers nothing after the runs he has ended — TRIGGER_RULES.afterSceneCooldownMs after any run's end, and after a
 * goodnight or her whisper played to its end, until TRIGGER_RULES.afterGoodnightUntilHour on his clock (that night's
 * end, or the next one's when it ended in the evening). Null when nothing pauses her. Any talent's run counts: his
 * evening with one of them is not followed at once by another's scene.
 */
export function offersPausedUntil(runs: readonly EndedRun[], tz?: string | null): number | null {
  let until: number | null = null;
  const later = (t: number) => { until = until === null ? t : Math.max(until, t); };
  for (const r of runs) {
    later(r.endedAt + TRIGGER_RULES.afterSceneCooldownMs);
    const kind = systemSceneOf(r.sceneId)?.kind;
    if ((kind === 'goodnight' || kind === 'whisper') && !UNFINISHED.has(r.outcome ?? 'left')) {
      const { day, minutes } = herLocalClock(r.endedAt, tz);
      const morning = TRIGGER_RULES.afterGoodnightUntilHour * 60;
      const next = minutes < morning ? day : new Date(Date.parse(`${day}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10);
      later(herZonedInstant(next, morning, tz));
    }
  }
  return until;
}

/** Whether she is holding her offers back now (M2, `offersPausedUntil`). */
export const offersPaused = (h: Pick<OfferHistory, 'pausedUntil'>, now: number): boolean =>
  h.pausedUntil !== null && h.pausedUntil !== undefined && now < h.pausedUntil;

/** Her order of preference when she proposes (#65): a promise, an unseen variant scene, the weather's, her signature, the rest. */
export const PROPOSAL_KINDS = ['promise', 'variant', 'weather', 'signature', 'other'] as const;
export type ProposalKind = (typeof PROPOSAL_KINDS)[number];

export function proposalKind(meta: SceneMeta, h: Pick<OfferHistory, 'promised' | 'playedEver'>, signatureId?: string): ProposalKind {
  if (h.promised.has(meta.id)) return 'promise';
  if (meta.trigger.variantCard && !h.playedEver.has(meta.id)) return 'variant';
  if (meta.trigger.weather) return 'weather';
  if (signatureId && meta.id === signatureId) return 'signature';
  return 'other';
}

/**
 * A scene that belongs to this moment rather than to any moment: its trigger names the weather, her routine or a
 * single part of the day — or a stage he has just reached (never played yet). Ready scenes only, so the window is on.
 */
export function isTimeEvent(meta: SceneMeta, h: Pick<OfferHistory, 'playedEver'>): boolean {
  const t = meta.trigger;
  return !!t.weather || !!t.routine || t.slots.length === 1 || (!!t.stage && !h.playedEver.has(meta.id));
}

export interface OfferChoice { sceneId: string; source: OfferSource; kind: ProposalKind | 'time' }

/**
 * What she offers as he enters (or idles in) her room, or null. `ready` = scenes of this talent that may be offered
 * and whose conditions he meets now. A time event comes first and is not left to chance; otherwise she proposes with
 * probability TRIGGER_RULES.proposeRate, within the daily cap and the gap, never a scene he declined lately or
 * already played today.
 */
export function chooseOffer(input: {
  ready: readonly SceneMeta[]; history: OfferHistory; now: number; signatureId?: string; rng?: () => number;
}): OfferChoice | null {
  const { history: h, now } = input;
  if (h.inScene || offersPaused(h, now)) return null;
  const fresh = input.ready.filter((m) => !h.declined.has(m.id) && !h.playedToday.has(m.id));
  if (!fresh.length) return null;

  const timed = fresh.find((m) => isTimeEvent(m, h) && !h.timeOfferedToday.has(m.id));
  if (timed && h.timeOffersToday < TRIGGER_RULES.maxTimeOffersPerDay) return { sceneId: timed.id, source: 'time', kind: 'time' };

  if (h.proposalsToday >= TRIGGER_RULES.maxProposalsPerDay) return null;
  if (h.lastProposalAt !== null && now - h.lastProposalAt < TRIGGER_RULES.minProposalGapMs) return null;
  const rng = input.rng ?? Math.random;
  if (rng() >= TRIGGER_RULES.proposeRate) return null;
  const ranked = fresh.map((m) => ({ m, kind: proposalKind(m, h, input.signatureId) }));
  const best = Math.min(...ranked.map((r) => PROPOSAL_KINDS.indexOf(r.kind)));
  const top = ranked.filter((r) => PROPOSAL_KINDS.indexOf(r.kind) === best);
  const pick = top[Math.min(top.length - 1, Math.floor(rng() * top.length))];
  return { sceneId: pick.m.id, source: 'proposed', kind: pick.kind };
}

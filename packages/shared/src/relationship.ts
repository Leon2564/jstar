import type { StarId } from './domain';
import { STAGE_RULES, jstDay } from './rules';

/**
 * The relationship stage machine (#54, docs/requirements.md §10.1), shared by the API (which applies it with
 * conditional writes), the web's prototype mode and the scene triggers. Pure and free of zod, so the web can
 * import it without the validator.
 *
 * `confession_ready` is the moment #55 waits for: she confesses in a scene of her own. To him it still reads as
 * `ambiguous` until she has — the web shows it that way and it pays no free pull of its own.
 */
export const RELATIONSHIP_STAGES = ['new', 'familiar', 'ambiguous', 'confession_ready', 'lover'] as const;
export type RelationshipStage = (typeof RELATIONSHIP_STAGES)[number];
export const isRelationshipStage = (v: unknown): v is RelationshipStage => typeof v === 'string' && (RELATIONSHIP_STAGES as readonly string[]).includes(v);

/** What the machine keeps per (user, talent); mirrors the `relationship` table (migrations/0007_relationship.sql). */
export interface RelationshipState {
  stage: RelationshipStage;
  /** When the current stage began (ISO). */
  stageSince: string;
  /**
   * `daysTogether` when the current stage began. A stage's days are the days together counted after that, so the
   * day he enters a stage never counts twice. `new` begins at 0, before their first day.
   */
  stageDay: number;
  /** JST days with at least one message or scene with her (not calendar days since sign-up). */
  daysTogether: number;
  /** The last JST day counted in `daysTogether`. */
  lastDay: string | null;
  confessedAt: string | null;
  /** The JST day she confessed and he accepted (YYYY-MM-DD): their anniversary. */
  anniversary: string | null;
  /** Her affinity XP when they became lovers; lover levels count from here, not from zero. */
  loverXp: number | null;
  /**
   * Free pulls already paid for this relationship, as a rank (`rewardRankOf`). A pull is paid only when the rank
   * rises above this, so a retry, a parallel request or an account migrated into a stage never pays twice.
   */
  rewardRank: number;
}

/** Hints are keys: the web says them in her words (i18n `rel.hint.*`), never as numbers or thresholds. */
export const RELATIONSHIP_HINTS = ['time', 'talk', 'both', 'ready', 'lover'] as const;
export type RelationshipHint = (typeof RELATIONSHIP_HINTS)[number];

/** One talent's relationship as the web shows it (GET /v1/relationship). */
export interface RelationshipInfo {
  star: StarId;
  stage: RelationshipStage;
  daysTogether: number;
  anniversary: string | null;
  loverLevel: number | null;
  hint: RelationshipHint;
  /** 0–1 toward the next stage (or lover level), by XP only: the bar under her name. */
  progress: number;
}

const ORDER: Record<RelationshipStage, number> = { new: 0, familiar: 1, ambiguous: 2, confession_ready: 3, lover: 4 };
const NEXT: Partial<Record<RelationshipStage, RelationshipStage>> = { new: 'familiar', familiar: 'ambiguous', ambiguous: 'confession_ready' };
const GATES: Partial<Record<RelationshipStage, { minDays: number; xp: number }>> = STAGE_RULES.stages;
/** XP where each gated stage's progress bar starts: the previous gate. */
const FLOOR: Partial<Record<RelationshipStage, number>> = { new: 0, familiar: STAGE_RULES.stages.new.xp, ambiguous: STAGE_RULES.stages.familiar.xp };

export const stageAtLeast = (stage: RelationshipStage, min: RelationshipStage): boolean => ORDER[stage] >= ORDER[min];

export const freshRelationship = (at: string): RelationshipState => ({
  stage: 'new', stageSince: at, stageDay: 0, daysTogether: 0, lastDay: null, confessedAt: null, anniversary: null, loverXp: null, rewardRank: 0
});

export function loverLevel(s: Pick<RelationshipState, 'stage' | 'loverXp'>, xp: number): number | null {
  if (s.stage !== 'lover') return null;
  const since = Math.max(0, xp - (s.loverXp ?? xp));
  return Math.min(STAGE_RULES.loverMaxLevel, Math.floor(since / STAGE_RULES.loverXpPerLevel) + 1);
}

/** familiar 1, ambiguous (and confession_ready) 2, lover 3 + each level after the first: one free pull per step. */
export function rewardRankOf(stage: RelationshipStage, level: number | null): number {
  return stage === 'lover' ? 3 + Math.max(1, level ?? 1) - 1 : Math.min(ORDER[stage], 2);
}

/** Counts `day` as a day together, once. A day earlier than the last one counted (clock skew) is ignored. */
export function countDay(s: RelationshipState, day: string): RelationshipState {
  return s.lastDay !== null && day <= s.lastDay ? s : { ...s, daysTogether: s.daysTogether + 1, lastDay: day };
}

/**
 * The one change due now, or null: the next stage when its days and XP are both met, otherwise free pulls owed
 * for lover levels. Stages move one at a time — each needs days in it — so a flood of XP never skips one.
 */
export function nextChange(s: RelationshipState, xp: number, at: string): { next: RelationshipState; pulls: number } | null {
  const to = NEXT[s.stage];
  const gate = GATES[s.stage];
  if (to && gate && s.daysTogether - s.stageDay >= gate.minDays && xp >= gate.xp) {
    const rank = Math.max(s.rewardRank, rewardRankOf(to, null));
    return { next: { ...s, stage: to, stageSince: at, stageDay: s.daysTogether, rewardRank: rank }, pulls: rank - s.rewardRank };
  }
  const rank = rewardRankOf(s.stage, loverLevel(s, xp));
  return rank > s.rewardRank ? { next: { ...s, rewardRank: rank }, pulls: rank - s.rewardRank } : null;
}

/** Every change due now, applied in order: the prototype mode's version of what the API does with conditional writes. */
export function settle(s: RelationshipState, xp: number, at: string): { state: RelationshipState; pulls: number; moves: [RelationshipStage, RelationshipStage][] } {
  let state = s;
  let pulls = 0;
  const moves: [RelationshipStage, RelationshipStage][] = [];
  for (let change = nextChange(state, xp, at); change; change = nextChange(state, xp, at)) {
    if (change.next.stage !== state.stage) moves.push([state.stage, change.next.stage]);
    pulls += change.pulls;
    state = change.next;
  }
  return { state, pulls, moves };
}

/**
 * He accepted her confession (#55): they are lovers from today, which becomes their anniversary. Only from
 * `confession_ready`; null otherwise. The lover stage's free pull is paid by the next `nextChange`.
 */
export function confess(s: RelationshipState, xp: number, at: number | Date = Date.now()): RelationshipState | null {
  if (s.stage !== 'confession_ready') return null;
  const iso = new Date(at).toISOString();
  return { ...s, stage: 'lover', stageSince: iso, stageDay: s.daysTogether, confessedAt: iso, anniversary: jstDay(at), loverXp: xp };
}

/**
 * What she hints at next: more days together (`time`), more talking (`talk` — also when both are met, since his next
 * message moves them on), both, her confession, or nothing more to reach for.
 */
export function hintOf(s: RelationshipState, xp: number): RelationshipHint {
  if (s.stage === 'lover') return 'lover';
  if (s.stage === 'confession_ready') return 'ready';
  const gate = GATES[s.stage]!;
  const days = s.daysTogether - s.stageDay >= gate.minDays;
  const talk = xp >= gate.xp;
  return talk && !days ? 'time' : days ? 'talk' : 'both';
}

export function stageProgress(s: RelationshipState, xp: number): number {
  const clamp = (n: number) => Math.max(0, Math.min(1, n));
  if (s.stage === 'confession_ready') return 1;
  if (s.stage === 'lover') {
    const level = loverLevel(s, xp)!;
    if (level >= STAGE_RULES.loverMaxLevel) return 1;
    return clamp((Math.max(0, xp - (s.loverXp ?? xp)) % STAGE_RULES.loverXpPerLevel) / STAGE_RULES.loverXpPerLevel);
  }
  const gate = GATES[s.stage]!;
  const floor = FLOOR[s.stage] ?? 0;
  return clamp((xp - floor) / (gate.xp - floor));
}

export function viewOf(star: StarId, s: RelationshipState, xp: number): RelationshipInfo {
  return {
    star, stage: s.stage, daysTogether: s.daysTogether, anniversary: s.anniversary, loverLevel: loverLevel(s, xp),
    hint: hintOf(s, xp), progress: Math.round(stageProgress(s, xp) * 100) / 100
  };
}

/**
 * Accounts that existed before stages (migration 0007): the stage their old affinity level stood for. Lv.3 (80 XP)
 * opened story episode 2 and her "closer" persona notes, Lv.6 (200 XP) the "special" ones, so nothing he had is
 * taken away. These are the old levels (40 XP each), fixed here even if STAGE_RULES changes; the migration SQL
 * uses the same numbers. Never `confession_ready` or `lover`: those are events, not arithmetic.
 */
export const LEGACY_STAGE_XP = { familiar: 80, ambiguous: 200 } as const;
export function legacyStage(xp: number): 'new' | 'familiar' | 'ambiguous' {
  return xp >= LEGACY_STAGE_XP.ambiguous ? 'ambiguous' : xp >= LEGACY_STAGE_XP.familiar ? 'familiar' : 'new';
}

import type { Rarity, StarId } from './domain';
import { RULES, VARIANT_CARDS, VARIANT_RULES } from './rules';

/**
 * Variant cards (#75, docs/requirements.md §14.1): five of the 150 are also "another her", with an affinity of her own
 * (level 1–10), layers of scenes it opens, and 心意 (kokoro) from duplicates. None of this touches a draw: a variant
 * is drawn exactly like any other card of its tier (docs/compliance-jp.md §3).
 */
export const isVariantCard = (cardId: string): boolean => VARIANT_CARDS.includes(cardId);

/**
 * Her variant card, or null when none of hers is selected. Card ids are `s1-<star>-NN` (docs/catalog-spec.md; the
 * shared tests check this against the catalogue), so no catalogue is loaded for it.
 */
export const variantCardOf = (star: StarId): string | null => VARIANT_CARDS.find((id) => id.split('-')[1] === star) ?? null;

export const VARIANT_MAX_LEVEL = VARIANT_RULES.levelXp.length;

/** The level (1–10) this much variant XP reaches. */
export function variantLevel(xp: number): number {
  let level = 1;
  VARIANT_RULES.levelXp.forEach((min, i) => { if (xp >= min) level = i + 1; });
  return level;
}

/**
 * The level to show: the stored level is the highest he ever reached, so raising a threshold later (待确认) never
 * closes a layer he already opened.
 */
export const variantLevelOf = (xp: number, reached = 1): number => Math.max(reached, variantLevel(xp));

/** Share of the way to the next level, 0–1 (1 at the top). The card detail shows a bar, never the thresholds (#76). */
export function variantProgress(xp: number, level: number = variantLevel(xp)): number {
  if (level >= VARIANT_MAX_LEVEL) return 1;
  const from = VARIANT_RULES.levelXp[level - 1];
  const to = VARIANT_RULES.levelXp[level];
  return Math.min(1, Math.max(0, (xp - from) / (to - from)));
}

/** Layers of her variant scenes open at this level, and the level of the next one (null when all are open). */
export const unlockedLayers = (level: number): number[] => VARIANT_RULES.layerLevels.filter((l) => l <= level);
export const nextLayer = (level: number): number | null => VARIANT_RULES.layerLevels.find((l) => l > level) ?? null;

/** One gain of variant XP: her variant XP, the 心意 behind it (duplicates only), and the share for the main relationship. */
export interface VariantGain { xp: number; kokoro: number; mainXp: number }

export function variantGain(xp: number, kokoro = 0): VariantGain {
  const whole = Math.max(0, Math.floor(xp));
  return { xp: whole, kokoro, mainXp: Math.floor(whole * VARIANT_RULES.mainLinkRatio) };
}

/** A duplicate of a variant card: the copy still counts (awakening), and its 心意 becomes her variant XP. */
export const duplicateGain = (): VariantGain => variantGain(VARIANT_RULES.kokoroPerDuplicate, VARIANT_RULES.kokoroPerDuplicate);

/** Every catalogue rarity is available in the Star Shard exchange; the cost is rarity-based. */
export const isExchangeable = (card: { id: string; rarity: Rarity }): boolean =>
  card.rarity in RULES.exchangeShards;

/** Whether her variant look may be pinned to her home at this level (#76: from level 10). */
export const canPinHome = (level: number): boolean => level >= VARIANT_RULES.homePinLevel;

/** How much her variant look weighs in her home's rotation at this level (#76), before his praise (bond.ts lookWeight). */
export const variantHomeWeight = (level: number): number =>
  1 + (Math.min(VARIANT_MAX_LEVEL, Math.max(1, Math.floor(level))) - 1) * VARIANT_RULES.homeWeightPerLevel;

const HOUR = 3_600_000;
const jstHour = (ms: number) => new Date(ms + 9 * HOUR).getUTCHours();
const jstDate = (ms: number) => new Date(ms + 9 * HOUR).toISOString().slice(0, 10);

/**
 * The night `now` belongs to for her draw-night invite (#76), in JST: `open` from VARIANT_RULES.invite.fromHour until
 * `nightEndsHour` the next morning. `since`: the start of the day that ends in this night (that morning's
 * `nightEndsHour`) — a variant first owned at or after it is invited tonight; one owned earlier had its own night.
 */
export function inviteNight(now: number): { day: string; since: string; open: boolean } {
  const { fromHour, nightEndsHour } = VARIANT_RULES.invite;
  const day = jstDate(now - nightEndsHour * HOUR);
  const hour = jstHour(now);
  const since = new Date(`${day}T${String(nightEndsHour).padStart(2, '0')}:00:00+09:00`).toISOString();
  return { day, since, open: hour >= fromHour || hour < nightEndsHour };
}

/** Her variant state as the API returns it (VariantState in contracts.ts). `pinned`: her home keeps this look (#76). */
export function variantState(row: { xp: number; level: number; kokoro: number; homePinned?: boolean } | null) {
  const xp = row?.xp ?? 0;
  const level = variantLevelOf(xp, row?.level ?? 1);
  return {
    level, xp, kokoro: row?.kokoro ?? 0, progress: variantProgress(xp, level), layers: unlockedLayers(level), nextLayer: nextLayer(level),
    pinned: !!row?.homePinned && canPinHome(level)
  };
}

/**
 * Which decoration her home gets today (#61; drawn by components/seasonDecor.tsx, a lazy chunk). Pure and tiny, so
 * the home decides without loading the art.
 */
import type { CalendarEventViewT } from '@jstar/shared/contracts';

export const DECOR_KINDS = ['hisBirthday', 'herBirthday', 'anniversary', 'hatsumode', 'fireworks', 'halloween', 'christmas'] as const;
export type DecorKind = (typeof DECOR_KINDS)[number];

/** Halloween week in Japan time (a decoration only: not one of her calendar's seasons, so she does not bring it up). */
const HALLOWEEN = { from: '10-25', to: '10-31' };

/**
 * Which decoration today gets, most personal first: his birthday, hers, their anniversary (yearly or monthly), then
 * the season (New Year, fireworks, Christmas), then Halloween week. `day`: today in Japan, "YYYY-MM-DD".
 */
export function decorFor(events: readonly Pick<CalendarEventViewT, 'kind' | 'season'>[] | undefined, day: string): DecorKind | null {
  const has = (k: CalendarEventViewT['kind']) => (events ?? []).some((e) => e.kind === k);
  if (has('hisBirthday')) return 'hisBirthday';
  if (has('herBirthday')) return 'herBirthday';
  if (has('anniversary') || has('monthiversary')) return 'anniversary';
  const season = (events ?? []).find((e) => e.kind === 'season')?.season;
  if (season === 'hatsumode' || season === 'fireworks' || season === 'christmas') return season;
  const md = day.slice(5);
  return md >= HALLOWEEN.from && md <= HALLOWEEN.to ? 'halloween' : null;
}

/**
 * Her system lines, by talent (#82; format and placeholders in ./schema). Every file passes `zStarLines`
 * (packages/shared/tests/lines.test.ts) and the persona service's safety filter (apps/agent/tests/test_scene_lines.py).
 *
 * Reviewed (#84, owner 2026-09-28): `draft` is false, so the features that read them — confession #55, wake-up #57,
 * promises #59, call names #56, weather #63, the system scene pack #71, the variant invites #76 — use them in
 * production too. A set flipped back to `draft: true` reaches users in demo mode only.
 *
 * Kept free of zod at runtime, like ../scenes/index.ts.
 */
import type { StarId } from '../domain';
import type { StarLines } from './schema';
import mahiro from './mahiro.json';
import nana from './nana.json';
import unpai from './unpai.json';
import alice from './alice.json';
import eimi from './eimi.json';

export const LINES: Record<StarId, StarLines> = {
  mahiro: mahiro as unknown as StarLines,
  nana: nana as unknown as StarLines,
  unpai: unpai as unknown as StarLines,
  alice: alice as unknown as StarLines,
  eimi: eimi as unknown as StarLines
};

export type * from './schema';

/** A woken line that says he (his voice, his alarm) woke her. */
export const WOKEN_BY_HIM = /声(?:で|を?(?:きい|聞い)たら)[^。]*?(?:起き|目が)|アラーム|目覚まし|電話で/;

/** #60: her line when he wakes her (her routine says `asleep`), for a JST day "YYYY-MM-DD": one a day, in rotation. */
export function wokenLine(star: StarId, day: string, heardHim = false): StarLines['woken'][number] {
  // N-66: opening her room is not calling her — a line that says his voice (or an alarm) woke her is only for when one did.
  const all = LINES[star].woken;
  const quiet = all.filter((l) => !WOKEN_BY_HIM.test(l.ja));
  const woken = heardHim || !quiet.length ? all : quiet;
  const n = Math.floor(Date.parse(`${day}T00:00:00Z`) / 86_400_000);
  return woken[((n % woken.length) + woken.length) % woken.length];
}

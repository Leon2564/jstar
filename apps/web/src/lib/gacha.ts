/**
 * Draw logic lives in @jstar/shared. In production the server draws and the client only renders the result;
 * this module stays for the offline prototype mode.
 */
import { drawLucky, drawPickupPulls, drawPulls, isPickupPoolId, isPoolId, pickupLive, poolCards, seeded, type Rng } from '@jstar/shared/gacha';
import { CARDS } from '../data/cards';
import { localPickupDefs } from './pickups';

export { drawLucky, seeded };
export type { Rng };

const livePickup = (pool: string) => localPickupDefs().find((d) => d.id === pool && pickupLive(d)) ?? null;

/** Whether a pool can be drawn now: always for the regular ones; a Pickup (#78) only while it is live, as on the server. */
export const poolOpen = (pool: string) => !isPickupPoolId(pool) || !!livePickup(pool);

export function pull(n: 1 | 6 | 10, pity: number, pool: string = 'all', rng: Rng = Math.random) {
  const p = isPickupPoolId(pool) ? livePickup(pool) : null;
  if (p) return drawPickupPulls(n, poolCards(`star:${p.star}`, CARDS), p, rng, pity, p.rates);
  return drawPulls(n, poolCards(isPoolId(pool) ? pool : 'all', CARDS), rng, pity);
}

import { describe, expect, it } from 'vitest';
import { RULES } from '@jstar/shared/rules';
import { buyPoints, drawCards } from '../../src/services/api';
import type { AppState } from '../../src/lib/state';

describe('local demo top-up', () => {
  it('adds every configured Star Stone pack immediately', async () => {
    const state = { points: 25 } as AppState;
    const balances = await Promise.all(RULES.pointPacks.map((pack) => buyPoints(state, pack.points)));
    expect(balances).toEqual(RULES.pointPacks.map((pack) => 25 + pack.points));
  });

  it('uses a topped-up local wallet for an immediate six-card draw', async () => {
    const pack = RULES.pointPacks.find((item) => item.points >= 6 * RULES.pullCost)!;
    const charged = await buyPoints({ points: 0 } as AppState, pack.points);
    const state = { points: charged, freePulls: 0, pity: 0, shards: 0, owned: {}, gachaPool: 'star:mahiro' } as AppState;
    const result = await drawCards(state, 6, false, state.gachaPool);
    expect(result.cards).toHaveLength(6);
    expect(result.cards.every((card) => card.star === 'mahiro')).toBe(true);
    expect(result.wallet.points).toBe(charged - 6 * RULES.pullCost);
  });
});

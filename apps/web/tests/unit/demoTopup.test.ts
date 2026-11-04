import { beforeAll, describe, expect, it } from 'vitest';
import { RULES } from '@jstar/shared/rules';
import { buyPoints, chat, drawCards } from '../../src/services/api';
import { initialState, type AppState } from '../../src/lib/state';

beforeAll(() => { (window as unknown as { __E2E__: boolean }).__E2E__ = true; });

describe('commercial chat credits', () => {
  it('offers the $9.99 / 1,000-credit pack and credits it immediately', async () => {
    expect(RULES.pointPacks).toEqual([{ points: 1000, usd: 9.99 }]);
    const state = { points: 25 } as AppState;
    const balances = await Promise.all(RULES.pointPacks.map((pack) => buyPoints(state, pack.points)));
    expect(balances).toEqual(RULES.pointPacks.map((pack) => 25 + pack.points));
  });

  it('draws with tickets and leaves chat credits untouched', async () => {
    const state = { points: 1000, freePulls: 6, pity: 0, shards: 0, owned: {}, gachaPool: 'star:mahiro' } as AppState;
    const result = await drawCards(state, 6, true, state.gachaPool);
    expect(result.cards).toHaveLength(6);
    expect(result.cards.every((card) => card.star === 'mahiro')).toBe(true);
    expect(result.wallet.points).toBe(1000);
    expect(result.wallet.freePulls).toBe(0);
  });

  it('charges one credit for a text turn but not a video-room message', async () => {
    const state = { ...initialState(), points: 2 };
    const text = await chat(state, 'mahiro', 'hello', 'en');
    const video = await chat(state, 'mahiro', 'hello', 'ja', undefined, true, 'video');
    expect(text.points).toBe(1);
    expect(video.points).toBe(2);
  });
});

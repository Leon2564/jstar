import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { StoreProvider } from '../../src/lib/store';
import { AppRoutes } from '../../src/App';
import { initialState, type AppState } from '../../src/lib/state';

// N-64: her greeting keeps a promise to be together as he comes in; her room's first offer was asked before that, so
// the room asks again and the promised moment is offered.
const room = vi.hoisted(() => ({ calls: 0 }));
vi.mock('../../src/lib/companion', async (orig) => ({
  ...(await orig<typeof import('../../src/lib/companion')>()),
  fetchGreeting: async () => ({ text: 'おかえり。約束、覚えてた？', promise: { id: 'prm_1', star: 'alice', text: '夜9時、ここで待ってる', kind: 'free', status: 'kept', source: 'chat', dueAt: new Date().toISOString(), madeAt: new Date().toISOString(), keptAt: new Date().toISOString(), sceneId: null } })
}));
vi.mock('../../src/scene/offer', async (orig) => ({
  ...(await orig<typeof import('../../src/scene/offer')>()),
  roomOffer: async () => (++room.calls === 1 ? null : { id: 'ofr_1', star: 'alice', sceneId: 'promise-kept-alice', source: 'time', title: { ja: '約束の時間', 'zh-Hant': '約定的時間', en: 'Our Promised Time', ko: '약속한 시간' }, media: [], expiresAt: new Date(Date.now() + 3_600_000).toISOString() })
}));

afterEach(cleanup);
beforeAll(() => { (window as unknown as { __E2E__: boolean }).__E2E__ = true; Element.prototype.scrollIntoView = () => {}; window.scrollTo = () => {}; });

describe('a promise kept as he comes in (N-64)', () => {
  it('her room asks again after her greeting kept it, and offers the promised moment', async () => {
    render(
      <StoreProvider initial={{ ...initialState(), ageOk: true, user: { via: 'email', nickname: 'k' }, star: 'alice' } as AppState}>
        <MemoryRouter initialEntries={['/me/home']}><AppRoutes /></MemoryRouter>
      </StoreProvider>
    );
    expect(await screen.findByTestId('scene-offer', {}, { timeout: 8000 })).toBeTruthy();
    expect(room.calls).toBeGreaterThanOrEqual(2);
  });
});

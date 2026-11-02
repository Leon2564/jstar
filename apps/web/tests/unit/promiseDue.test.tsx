import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import type { PromiseItemT } from '@jstar/shared/contracts';
import { StoreProvider } from '../../src/lib/store';
import { AppRoutes } from '../../src/App';
import { initialState } from '../../src/lib/state';
import * as api from '../../src/services/api';

const greet = vi.hoisted(() => vi.fn());
vi.mock('../../src/lib/companion', async (importOriginal) => ({ ...(await importOriginal<typeof import('../../src/lib/companion')>()), fetchGreeting: greet }));

beforeAll(() => { (window as unknown as { __E2E__: boolean }).__E2E__ = true; Element.prototype.scrollIntoView = () => {}; window.scrollTo = () => {}; });
afterEach(() => { cleanup(); vi.restoreAllMocks(); greet.mockReset(); vi.useRealTimers(); });

const promise = (patch: Partial<PromiseItemT> = {}): PromiseItemT => ({
  id: 'prm_1', star: 'mahiro', text: '夜、一緒に過ごす', kind: 'scene', status: 'open', source: 'chat',
  dueAt: new Date(Date.now() + 1200).toISOString(), madeAt: '2026-09-26T11:00:00.000Z', keptAt: null, sceneId: null, ...patch
});

/**
 * Pinned to his clock at several hours (her opening replies, her routine and her greeting slot follow the hour), with
 * the clock running (shouldAdvanceTime), so the due timer still fires. `lateMs`: the promise is already due by that
 * much when its plan reaches her room (a slow or busy device) — it was skipped then, and this test failed whenever
 * the room took more than ~2 s to open.
 */
const HOURS = ['07:30', '17:30', '23:00'];
describe('a promise that comes due while he is in her room (R12)', { timeout: 20_000 }, () => {
  it.each(HOURS.flatMap((hm) => [[hm, 'due while he talks', 0], [hm, 'already due when her room has its plan', 3000]] as const))('at %s, %s: kept and offered then — her line with ✦, even mid-conversation', async (hm, _when, lateMs) => {
    vi.useFakeTimers({ toFake: ['Date'], now: new Date(`2026-10-03T${hm}:00+09:00`), shouldAdvanceTime: true });
    const due = promise(lateMs ? { dueAt: new Date(Date.now() - lateMs).toISOString() } : {});
    greet.mockResolvedValueOnce({ text: 'おかえり。', promise: null })
      .mockResolvedValue({ text: 'おかえり。', promise: { ...due, status: 'kept', keptAt: new Date().toISOString(), sceneId: 'demo-evening' } });
    // Due 1.2 s after her room asks (not after the test starts: a cold first render must not make it already past).
    vi.spyOn(api, 'promises').mockImplementationOnce(async () => ({ promises: [promise()], proposal: null })).mockResolvedValue({ promises: [], proposal: null });
    render(
      <StoreProvider initial={{ ...initialState(), ageOk: true, user: { via: 'email', nickname: 'kenta' }, star: 'mahiro' }}>
        <MemoryRouter initialEntries={['/me/home']}><AppRoutes /></MemoryRouter>
      </StoreProvider>
    );
    if (!lateMs) {
      // Mid-conversation: he answered her, she answered him; nothing is offered before its moment.
      fireEvent.click((await screen.findByTestId('room-replies', {}, { timeout: 8000 })).querySelector('button')!);
      await screen.findByTestId('room-her', {}, { timeout: 8000 });
      expect(screen.queryByTestId('promise-scene')).toBeNull();
    }
    // The moment it is due, her room asks again (her greeting keeps it) and she brings it up.
    const yes = await screen.findByTestId('promise-scene', {}, { timeout: 5000 });
    expect(yes.getAttribute('href')).toContain('/me/scene/demo-evening');
    expect(yes.textContent).toContain('✦');
    expect(greet).toHaveBeenCalledTimes(2);
    expect(screen.queryByTestId('room-replies')).toBeNull();
  });
});

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { StoreProvider } from '../../src/lib/store';
import { AppRoutes } from '../../src/App';
import { initialState, type AppState } from '../../src/lib/state';
import { ja } from '../../src/i18n/ja';

// N-08: her room in server mode, before the API has answered for her greeting.
const greet = vi.hoisted(() => ({ resolve: null as null | ((g: { text: string; promise: null } | null) => void) }));
vi.mock('../../src/lib/companion', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/lib/companion')>()),
  fetchGreeting: () => new Promise((res) => { greet.resolve = res; })
}));
vi.mock('../../src/services/api', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../src/services/api')>();
  const none = async () => null;
  return {
    ...real, serverMode: () => true, isDemo: () => false, inbox: none, relationships: none, calendarToday: none, promises: none, bondOf: none
  };
});
vi.mock('../../src/services/http', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../src/services/http')>();
  return { ...real, serverMode: () => false };
});

beforeAll(() => { (window as unknown as { __E2E__: boolean }).__E2E__ = true; Element.prototype.scrollIntoView = () => {}; window.scrollTo = () => {}; });
beforeEach(() => { localStorage.clear(); sessionStorage.clear(); greet.resolve = null; });
afterEach(() => { cleanup(); vi.useRealTimers(); });

const jst = (hhmm: string) => Date.parse(`2026-10-14T${hhmm}:00+09:00`);
const home = (star: AppState['star']) => render(
  <StoreProvider initial={{ ...initialState(), ageOk: true, user: { via: 'email', nickname: 'kenta' }, star } as AppState}>
    <MemoryRouter initialEntries={['/me/home']}><AppRoutes /></MemoryRouter>
  </StoreProvider>
);

describe('her greeting while it loads (N-08)', { timeout: 20_000 }, () => {
  it('up: she is typing, never the stock morning line; then her own line', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(jst('08:20'));
    home('mahiro');
    const wait = await screen.findByTestId('greeting-wait', {}, { timeout: 8000 });
    expect(wait.querySelector('.typing')).toBeTruthy();
    expect(document.body.textContent).not.toContain(ja['home.greet.morning'].split('\n')[0]);
    expect(screen.queryByTestId('greeting')).toBeNull();
    // The request may start a moment after the wait shows: resolve it once it is in flight.
    await waitFor(() => expect(greet.resolve).toBeTypeOf('function'));
    await act(async () => { greet.resolve!({ text: 'おはよう、ケンタ。', promise: null }); });
    expect((await screen.findByTestId('greeting')).textContent).toBe('おはよう、ケンタ。');
  });

  it('asleep: a sleepy line until her woken words arrive', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(jst('03:00'));
    home('nana');
    expect((await screen.findByTestId('greeting-wait', {}, { timeout: 8000 })).textContent).toBe(`「${ja['home.greet.sleepy']}」`);
    // The request may start a moment after the wait shows: resolve it once it is in flight.
    await waitFor(() => expect(greet.resolve).toBeTypeOf('function'));
    await act(async () => { greet.resolve!(null); });
    // No answer from the API: her own written line for being woken.
    expect((await screen.findByTestId('greeting')).textContent).toBe(ja['home.greet.asleep']);
  });
});

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import type { WeatherNowT, WorldResT } from '@jstar/shared/contracts';
import { StoreProvider } from '../../src/lib/store';
import { AppRoutes } from '../../src/App';
import { initialState, type AppState } from '../../src/lib/state';
import { resetHerRoom } from '../../src/lib/herWeather';
import * as api from '../../src/services/api';

// The companion home against the API (#63): her room follows /v1/world, and a weather outage never breaks it.
const world = vi.hoisted(() => ({ get: vi.fn() }));
vi.mock('../../src/services/http', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../src/services/http')>();
  return { ...real, serverMode: () => true, http: { ...real.http, world: world.get } };
});

beforeAll(() => { (window as unknown as { __E2E__: boolean }).__E2E__ = true; Element.prototype.scrollIntoView = () => {}; window.scrollTo = () => {}; });
beforeEach(() => { resetHerRoom(); vi.spyOn(api, 'inbox').mockResolvedValue(null); });
afterEach(() => { cleanup(); vi.restoreAllMocks(); world.get.mockReset(); });

const hours = (h: number) => new Date(Date.now() + h * 3600_000).toISOString();
const weather = (patch: Partial<WeatherNowT> = {}): WeatherNowT => ({
  // The sun set two hours ago wherever the test runs.
  weather: 'rain', code: 63, tempC: 7.6, precipMm: 3, windMs: 3, sunrise: hours(-14), sunset: hours(-2), isDay: false,
  alert: null, next6h: [], updatedAt: hours(-0.5), stale: false, firstSnow: null, ...patch
});
const res = (w: WeatherNowT | null): WorldResT => ({
  asOf: new Date().toISOString(), user: null,
  talents: (['mahiro', 'nana', 'unpai', 'alice', 'eimi'] as const).map((star) => ({ star, cityId: 'tokyo', city: { ja: '東京', 'zh-Hant': '東京', en: 'Tokyo' }, weather: w }))
});
/** Her room's 目錄 (A2, #163) holds the secondary things: the bond, the gift, the chips, the demo menu. */
const openIndex = async () => fireEvent.click(await screen.findByTestId('room-index-open', {}, { timeout: 8000 }));
const home = () => render(
  <StoreProvider initial={{ ...initialState(), ageOk: true, user: { via: 'email', nickname: 'kenta' }, star: 'nana' } as AppState}>
    <MemoryRouter initialEntries={['/me/home?wx=snow']}><AppRoutes /></MemoryRouter>
  </StoreProvider>
);

// The companion home is a lazy route: its first load in a busy test run can take seconds.
describe('her room with the real weather (#63)', { timeout: 20_000 }, () => {
  it('rains in her room when it rains in her city, with the sky, the temperature and the credit', async () => {
    world.get.mockResolvedValue(res(weather()));
    home();
    // `?wx=` is ignored off the test site: only the real sky is drawn.
    expect((await screen.findByTestId('wx-layer', {}, { timeout: 8000 })).dataset.sky).toBe('rain');
    await openIndex();
    expect((await screen.findByTestId('wx-chip', {}, { timeout: 8000 })).textContent).toContain('雨 8°C');
    expect(screen.getByTestId('wx-chip').textContent).toContain('Open-Meteo.com');
    expect(document.querySelector('.home.tod-night')).not.toBeNull();
  });

  it('shows no weather when it is stale or the API fails, and her room is unchanged', async () => {
    world.get.mockResolvedValue(res(weather({ stale: true })));
    home();
    await screen.findByTestId('greeting', {}, { timeout: 8000 });
    await waitFor(() => expect(world.get).toHaveBeenCalled());
    expect(screen.queryByTestId('wx-layer')).toBeNull();
    await openIndex();
    expect(screen.queryByTestId('wx-chip')).toBeNull();
    cleanup();

    resetHerRoom();
    world.get.mockRejectedValue(new Error('weather_unavailable'));
    home();
    await screen.findByTestId('greeting', {}, { timeout: 8000 });
    await waitFor(() => expect(world.get).toHaveBeenCalled());
    await openIndex();
    expect(screen.queryByTestId('wx-chip')).toBeNull();
  });
});

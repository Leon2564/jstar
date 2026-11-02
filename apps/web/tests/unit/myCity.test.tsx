import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { StoreProvider } from '../../src/lib/store';
import { initialState } from '../../src/lib/state';
import { MyCity } from '../../src/components/myCity';

const api = vi.hoisted(() => ({ server: true, world: vi.fn(), citySearch: vi.fn(), citySet: vi.fn(), cityClear: vi.fn() }));
vi.mock('../../src/services/http', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/services/http')>()),
  serverMode: () => api.server,
  http: { world: api.world, citySearch: api.citySearch, citySet: api.citySet, cityClear: api.cityClear }
}));

afterEach(() => { cleanup(); vi.clearAllMocks(); api.server = true; });

const TAIPEI = { id: 1668341, name: '台北市', region: '台湾', country: '台湾', lat: 25.1, lon: 121.5 };
const renderIt = () => render(<StoreProvider initial={{ ...initialState(), ageOk: true, birthdayOk: true, user: { via: 'email', nickname: 'kenta' } }}><MyCity /></StoreProvider>);

describe('his own city on My page (#62)', () => {
  it('is not offered in prototype mode (no account to keep it on)', async () => {
    api.server = false;
    renderIt();
    await new Promise((r) => setTimeout(r, 20));
    expect(screen.queryByTestId('my-city')).toBeNull();
    expect(api.world).not.toHaveBeenCalled();
  });

  it('finds 台北 by name, saves the chosen city, and clears it', async () => {
    api.world.mockResolvedValue({ asOf: '', talents: [], user: null });
    api.citySearch.mockResolvedValue({ results: [TAIPEI] });
    api.citySet.mockResolvedValue({ user: { name: '台北市', weather: null } });
    api.cityClear.mockResolvedValue({ ok: true, removed: true });
    renderIt();
    expect((await screen.findByTestId('city-current')).textContent).toBe('未設定');
    expect(screen.queryByTestId('city-clear')).toBeNull();

    fireEvent.change(screen.getByTestId('city-q'), { target: { value: '台北' } });
    fireEvent.submit(screen.getByRole('search'));
    const results = await screen.findByTestId('city-results');
    expect(api.citySearch).toHaveBeenCalledWith('台北', 'ja');
    // Region and country are the same here: shown once.
    expect(results.textContent).toBe('台北市台湾');

    fireEvent.click(screen.getByRole('button', { name: /台北市/ }));
    await waitFor(() => expect(screen.getByTestId('city-current').textContent).toBe('台北市'));
    expect(api.citySet).toHaveBeenCalledWith(1668341, 'ja');
    expect(screen.queryByTestId('city-results')).toBeNull();

    fireEvent.click(screen.getByTestId('city-clear'));
    await waitFor(() => expect(screen.getByTestId('city-current').textContent).toBe('未設定'));
    expect(api.cityClear).toHaveBeenCalledOnce();
  });

  it('says so when nothing matches or the weather service is down, without losing the city', async () => {
    api.world.mockResolvedValue({ asOf: '', talents: [], user: { name: 'London', weather: null } });
    api.citySearch.mockResolvedValueOnce({ results: [] }).mockRejectedValueOnce(new Error('weather_unavailable'));
    renderIt();
    expect((await screen.findByTestId('city-current')).textContent).toBe('London');
    fireEvent.change(screen.getByTestId('city-q'), { target: { value: 'zzz' } });
    fireEvent.submit(screen.getByRole('search'));
    expect((await screen.findByRole('status')).textContent).toContain('見つかりませんでした');
    fireEvent.submit(screen.getByRole('search'));
    expect((await screen.findByRole('alert')).textContent).toContain('うまくいきませんでした');
    expect(screen.getByTestId('city-current').textContent).toBe('London');
  });
});

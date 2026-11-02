import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import type { WeatherNowT, WorldTalentT } from '@jstar/shared/contracts';
import { StoreProvider } from '../../src/lib/store';
import { AppRoutes } from '../../src/App';
import { initialState, type AppState } from '../../src/lib/state';
import { demoRoom, needsLayer, roomOf, type Room } from '../../src/lib/herWeather';
import { WeatherChip, WeatherLayer } from '../../src/components/weatherRoom';

const sound = vi.hoisted(() => ({ ambience: vi.fn() }));
vi.mock('../../src/lib/sound', async (importOriginal) => ({ ...(await importOriginal<typeof import('../../src/lib/sound')>()), ambience: sound.ambience }));

afterEach(() => { cleanup(); vi.restoreAllMocks(); sound.ambience.mockReset(); });
beforeAll(() => { (window as unknown as { __E2E__: boolean }).__E2E__ = true; Element.prototype.scrollIntoView = () => {}; window.scrollTo = () => {}; });

/** 21:00 JST on 14 October: after sunset in Tokyo, no season running. */
const NIGHT = new Date('2026-10-14T12:00:00Z');
const now = (patch: Partial<WeatherNowT> = {}): WeatherNowT => ({
  weather: 'rain', code: 63, tempC: 8.4, precipMm: 3, windMs: 3, sunrise: '2026-10-13T20:48:00Z', sunset: '2026-10-14T08:07:00Z', isDay: false,
  alert: null, next6h: [], updatedAt: '2026-10-14T11:30:00Z', stale: false, firstSnow: null, ...patch
});
const talent = (patch: Partial<WeatherNowT> = {}, star: WorldTalentT['star'] = 'nana'): WorldTalentT =>
  ({ star, cityId: 'tokyo', city: { ja: '東京', 'zh-Hant': '東京', en: 'Tokyo' }, weather: now(patch) });

function reducedMotion(on: boolean) {
  window.matchMedia = ((q: string) => ({ matches: on && q.includes('reduce'), media: q, addEventListener() {}, removeEventListener() {} })) as unknown as typeof window.matchMedia;
}

describe('her window (#63)', () => {
  it('reads her sky and her sun from /v1/world, and nothing from stale data', () => {
    expect(roomOf(talent(), NIGHT)).toEqual({ sky: 'rain', phase: 'night', hot: false, sakura: false, condition: 'rain', tempC: 8 });
    expect(roomOf(talent({ weather: 'thunder' }), NIGHT)?.sky).toBe('rain');
    expect(roomOf(talent({ alert: 'storm' }), NIGHT)?.sky).toBe('storm');
    // Wind without rain is no storm to draw.
    expect(roomOf(talent({ weather: 'clear', alert: 'strong_wind' }), NIGHT)?.sky).toBe('clear');
    expect(roomOf(talent({ stale: true }), NIGHT)).toBeNull();
    expect(roomOf({ ...talent(), weather: null }, NIGHT)).toBeNull();
    // Around her sunset (17:07 JST): dusk light, whatever the viewer's clock says.
    expect(roomOf(talent({ weather: 'clear' }), new Date('2026-10-14T07:30:00Z'))?.phase).toBe('dusk');
    // A hot afternoon glares; the same heat after dark does not.
    const hot = talent({ weather: 'clear', tempC: 34, sunrise: '2026-08-09T20:00:00Z', sunset: '2026-08-10T09:40:00Z' });
    expect(roomOf(hot, new Date('2026-08-10T05:00:00Z'))).toMatchObject({ hot: true, phase: 'day' });
    expect(roomOf(hot, new Date('2026-08-10T12:00:00Z'))?.hot).toBe(false);
    // Her city's blossoms (world.ts SEASONS: まひろ's Tokyo), unless something falls from the sky; 奈々's Nagano
    // blooms about three weeks later.
    const spring = { sunrise: '2027-03-27T20:40:00Z', sunset: '2027-03-28T09:00:00Z' };
    expect(roomOf(talent({ weather: 'clear', ...spring }, 'mahiro'), new Date('2027-03-28T03:00:00Z'))?.sakura).toBe(true);
    expect(roomOf(talent({ weather: 'rain', ...spring }, 'mahiro'), new Date('2027-03-28T03:00:00Z'))?.sakura).toBe(false);
    expect(roomOf(talent({ weather: 'clear', ...spring }), new Date('2027-03-28T03:00:00Z'))?.sakura).toBe(false);
  });

  it('loads the effect only when there is something to draw', () => {
    expect(needsLayer(null)).toBe(false);
    expect(needsLayer(roomOf(talent({ weather: 'clear', isDay: true }), new Date('2026-10-14T03:00:00Z')))).toBe(false);
    expect(needsLayer(roomOf(talent({ weather: 'clear' }), NIGHT))).toBe(true);
    expect(needsLayer(roomOf(talent(), NIGHT))).toBe(true);
    expect(demoRoom('hail')).toBeNull();
    expect(demoRoom('sakura')).toMatchObject({ sky: 'clear', sakura: true, condition: null });
  });

  it('draws falling rain, drops on the glass and the rain you hear', () => {
    reducedMotion(false);
    const room = roomOf(talent(), NIGHT)!;
    render(<WeatherLayer room={room} />);
    const layer = screen.getByTestId('wx-layer');
    expect(layer.dataset).toMatchObject({ sky: 'rain', phase: 'night', motion: 'on' });
    expect(layer.querySelectorAll('.wx-fall')).toHaveLength(2);
    // Each layer moves by exactly one tile of its texture, so the loop is seamless.
    expect(layer.querySelector<HTMLElement>('.wx-fall')!.style.getPropertyValue('--h')).toBe('220px');
    expect(layer.querySelector('.wx-still')).not.toBeNull();
    expect(sound.ambience).toHaveBeenLastCalledWith('rain');
    cleanup();
    expect(sound.ambience).toHaveBeenLastCalledWith(null);
  });

  it('the weather you hear: rain, the snowy night and the storm, quiet skies silent (#82)', () => {
    for (const sky of ['rain', 'snow', 'storm', 'cloudy', 'clear'] as const) {
      render(<WeatherLayer room={{ sky, phase: 'night', hot: false, sakura: false, condition: null, tempC: null }} />);
      expect(sound.ambience, sky).toHaveBeenLastCalledWith(sky === 'cloudy' || sky === 'clear' ? null : sky);
      cleanup();
      expect(sound.ambience).toHaveBeenLastCalledWith(null);
    }
  });

  it('with reduced motion nothing moves, and the picture is still there', () => {
    reducedMotion(true);
    for (const sky of ['rain', 'snow', 'storm'] as const) {
      const room: Room = { sky, phase: 'night', hot: false, sakura: false, condition: null, tempC: null };
      render(<WeatherLayer room={room} />);
      const layer = screen.getByTestId('wx-layer');
      expect(layer.dataset.motion).toBe('off');
      expect(layer.querySelector('.wx-fall, .wx-sway')).toBeNull();
      expect(layer.querySelector('.wx-grade')).not.toBeNull();
      expect(layer.querySelector('.wx-still')).not.toBeNull();
      cleanup();
    }
    reducedMotion(false);
  });

  it('shows her sky with the Open-Meteo credit, never her city', () => {
    render(<StoreProvider initial={{ ...initialState(), ageOk: true }}><WeatherChip room={roomOf(talent(), NIGHT)!} /></StoreProvider>);
    const chip = screen.getByTestId('wx-chip');
    expect(chip.textContent).toBe('雨 8°C天気データ：Open-Meteo.com（CC BY 4.0）');
    expect(chip.querySelector('a')!.getAttribute('href')).toBe('https://open-meteo.com/');
    expect(chip.textContent).not.toMatch(/東京|Tokyo/);
  });

  it('on the companion home: ?wx=rain draws a rainy night in the prototype', async () => {
    reducedMotion(false);
    render(
      <StoreProvider initial={{ ...initialState(), ageOk: true, user: { via: 'email', nickname: 'kenta' }, star: 'nana' } as AppState}>
        <MemoryRouter initialEntries={['/me/home?wx=rain']}><AppRoutes /></MemoryRouter>
      </StoreProvider>
    );
    const layer = await screen.findByTestId('wx-layer', {}, { timeout: 8000 });
    expect(layer.dataset.sky).toBe('rain');
    await waitFor(() => expect(document.querySelector('.home.tod-night')).not.toBeNull());
    // No data, no chip: the chip only ever shows real weather.
    expect(screen.queryByTestId('wx-chip')).toBeNull();
  }, 20_000);
});

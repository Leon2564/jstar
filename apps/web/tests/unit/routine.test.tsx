import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import type { WeatherNowT, WorldResT } from '@jstar/shared/contracts';
import { WORLD } from '@jstar/shared/world';
import { StoreProvider } from '../../src/lib/store';
import { AppRoutes } from '../../src/App';
import { initialState, type AppState } from '../../src/lib/state';
import { resetHerRoom } from '../../src/lib/herWeather';
import { clockLine } from '../../src/components/whoIsHome';
import { ja } from '../../src/i18n/ja';
import * as api from '../../src/services/api';

// Who's home now (#60) on the companion home: the five on JST, weather per city from /v1/world when there is any.
const server = vi.hoisted(() => ({ on: false, world: vi.fn() }));
vi.mock('../../src/services/http', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../src/services/http')>();
  return { ...real, serverMode: () => server.on, http: { ...real.http, world: server.world } };
});

beforeAll(() => { (window as unknown as { __E2E__: boolean }).__E2E__ = true; Element.prototype.scrollIntoView = () => {}; window.scrollTo = () => {}; });
beforeEach(() => { localStorage.clear(); sessionStorage.clear(); resetHerRoom(); server.on = false; vi.spyOn(api, 'inbox').mockResolvedValue(null); });
afterEach(() => { cleanup(); vi.useRealTimers(); vi.restoreAllMocks(); server.world.mockReset(); });

/** A JST wall-clock moment, whatever zone the test runs in. */
const jst = (hhmm: string) => Date.parse(`2026-10-14T${hhmm}:00+09:00`);
const at = (ms: number) => { vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(ms); };
const home = (star: AppState['star'] = 'nana') => render(
  <StoreProvider initial={{ ...initialState(), ageOk: true, user: { via: 'email', nickname: 'kenta' }, star } as AppState}>
    <MemoryRouter initialEntries={['/me/home']}><AppRoutes /></MemoryRouter>
  </StoreProvider>
);
const presence = (star: string) => screen.getByTestId(`presence-${star}`);
// Who's home lives in her room's 目錄 (A2, #163): under each name in the star switcher.
const openIndex = async () => fireEvent.click(await screen.findByTestId('room-index-open', {}, { timeout: 8000 }));

const weather = (patch: Partial<WeatherNowT> = {}): WeatherNowT => ({
  weather: 'rain', code: 63, tempC: 7.6, precipMm: 3, windMs: 3, sunrise: new Date(jst('05:40')).toISOString(), sunset: new Date(jst('17:10')).toISOString(),
  isDay: false, alert: null, next6h: [], updatedAt: new Date(jst('02:30')).toISOString(), stale: false, firstSnow: null, ...patch
});
const world = (w: (star: string) => WeatherNowT | null): WorldResT => ({
  asOf: new Date(jst('03:00')).toISOString(), user: null,
  talents: (['mahiro', 'nana', 'unpai', 'alice', 'eimi'] as const).map((star) => ({ star, cityId: 'tokyo', city: { ja: '東京', 'zh-Hant': '東京', en: 'Tokyo' }, weather: w(star) }))
});

// The companion home is a lazy route: its first load in a busy run can take seconds.
describe("who's home now (#60)", { timeout: 20_000 }, () => {
  it('at 03:00 JST: all five have a status, 奈々 is asleep (dimmed, still tappable) and wakes up sleepily', async () => {
    at(jst('03:00'));
    home('nana');
    const greeting = await screen.findByTestId('greeting', {}, { timeout: 8000 });
    // The acceptance snapshot: her room opens on being woken.
    expect(greeting.textContent).toMatchInlineSnapshot(`"……ん……寝てた……。
でも、来てくれたなら、ちょっとだけお話ししよ。"`);
    await openIndex();
    expect(['mahiro', 'nana', 'unpai', 'alice', 'eimi'].map((s) => presence(s).dataset.presence)).toEqual(['home', 'asleep', 'home', 'home', 'home']);
    expect(presence('nana').textContent).toContain('おやすみ');
    expect(presence('nana').textContent).toContain('もう寝てる');
    expect(presence('mahiro').textContent).toContain('おうち');
    expect(screen.getByTestId('star-rule-nana').classList.contains('dim')).toBe(true);
    expect(screen.getByTestId('star-rule-mahiro').classList.contains('dim')).toBe(false);
    // Her line: what she is doing, on her clock.
    const line = screen.getByTestId('now-line');
    expect(line.textContent).toContain('もう寝てる');
    expect(line.textContent).toContain('日本 03:00');
    // No weather data in prototype mode: status only, no sky and no credit.
    expect(screen.queryByTestId('sky-nana')).toBeNull();
    expect(line.querySelector('.wx-credit')).toBeNull();

    // A dimmed name is still a button: she opens, and the page does not change for the others.
    const alice = screen.getByRole('button', { name: /アリス/ });
    expect(alice.getAttribute('aria-describedby')).toBe('now-alice');
    fireEvent.click(alice);
    // Picking her opens her room (the 目錄 closes); open it again to see her line.
    await openIndex();
    await waitFor(() => expect(screen.getByTestId('star-rule-alice').getAttribute('aria-pressed')).toBe('true'));
    expect(screen.getByTestId('now-line').textContent).toContain(WORLD.alice.routine.lateNight.status.ja);
  });

  it('by day the ones out are out, and nobody is asleep in the evening', async () => {
    at(jst('14:00'));
    home('eimi');
    expect((await screen.findByTestId('greeting', {}, { timeout: 8000 })).textContent).not.toContain('寝てた');
    await openIndex();
    expect(['mahiro', 'nana', 'unpai', 'alice', 'eimi'].map((s) => presence(s).dataset.presence)).toEqual(['out', 'out', 'out', 'home', 'out']);
    expect(screen.getByTestId('now-line').textContent).toContain('お仕事中');
    cleanup();
    at(jst('20:00'));
    home('unpai');
    await screen.findByTestId('greeting', {}, { timeout: 8000 });
    await openIndex();
    expect(screen.getByTestId('now-line').textContent).toContain('夜さんぽ配信中');
    expect(document.querySelectorAll('.js-star.dim')).toHaveLength(0);
  });

  it('shows each city’s sky from /v1/world with the credit, and only the status when the data is missing or stale', async () => {
    at(jst('03:00'));
    server.on = true;
    vi.spyOn(api, 'relationships').mockResolvedValue(null);
    server.world.mockResolvedValue(world((s) => (s === 'eimi' ? weather({ stale: true }) : s === 'unpai' ? null : weather())));
    home('nana');
    await openIndex();
    const sky = await screen.findByTestId('sky-nana', {}, { timeout: 8000 });
    expect(sky.dataset.sky).toBe('rain');
    expect(presence('nana').textContent).toContain('雨 8°C');
    expect(screen.getByTestId('sky-mahiro')).toBeTruthy();
    // Missing or stale: status only.
    expect(screen.queryByTestId('sky-unpai')).toBeNull();
    expect(screen.queryByTestId('sky-eimi')).toBeNull();
    expect(presence('eimi').textContent).toContain('おうち');
    // Credited once: by her weather chip (rain in her room).
    expect(await screen.findByTestId('wx-chip', {}, { timeout: 8000 })).toBeTruthy();
    expect(document.body.textContent!.split('Open-Meteo.com').length - 1).toBe(1);
    // Never the city while her hometown is unconfirmed (#48).
    expect(document.querySelector('.room2')!.textContent).not.toContain('東京');
  });

  it('gives her time and, when his clock is elsewhere, his', () => {
    const t = ((k: string, v?: Record<string, string>) => (ja as Record<string, string>)[k].replace('{time}', v?.time ?? '')) as never;
    const now = new Date(jst('21:05'));
    const line = clockLine(now, t);
    expect(line.startsWith('日本 21:05')).toBe(true);
    if (now.getTimezoneOffset() === -540) expect(line).toBe('日本 21:05');
    else expect(line).toContain('あなたの時間');
  });
});

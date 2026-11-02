import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import type { CalendarEventViewT, CalendarResT } from '@jstar/shared/contracts';
import { StoreProvider } from '../../src/lib/store';
import { AppRoutes } from '../../src/App';
import { initialState, type AppState } from '../../src/lib/state';
import { ensureLang, translate, type Key, type Lang } from '../../src/i18n';
import { calendarLabel } from '../../src/pages/me';
import * as api from '../../src/services/api';

// Her home's line for the day (#61), against the API: GET /v1/calendar decides, the home only says it.
const cal = vi.hoisted(() => ({ get: vi.fn(), demo: vi.fn() }));
vi.mock('../../src/services/http', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../src/services/http')>();
  return { ...real, serverMode: () => true, http: { ...real.http, calendar: cal.get, calendarDemo: cal.demo } };
});

beforeAll(() => { (window as unknown as { __E2E__: boolean }).__E2E__ = true; Element.prototype.scrollIntoView = () => {}; window.scrollTo = () => {}; });
beforeEach(() => { vi.spyOn(api, 'inbox').mockResolvedValue(null); });
afterEach(() => { cleanup(); vi.restoreAllMocks(); cal.get.mockReset(); cal.demo.mockReset(); });

const STARS = ['mahiro', 'nana', 'unpai', 'alice', 'eimi'] as const;
const res = (events: Partial<Record<(typeof STARS)[number], CalendarEventViewT[]>>): CalendarResT =>
  ({ talents: STARS.map((star) => ({ star, events: events[star] ?? [] })) });
/** Her room's 目錄 (A2, #163) holds the secondary things: the bond, the gift, the chips, the demo menu. */
const openIndex = async () => fireEvent.click(await screen.findByTestId('room-index-open', {}, { timeout: 8000 }));
const home = (star: AppState['star'], at = '/me/home') => render(
  <StoreProvider initial={{ ...initialState(), ageOk: true, user: { via: 'email', nickname: 'kenta' }, star } as AppState}>
    <MemoryRouter initialEntries={[at]}><AppRoutes /></MemoryRouter>
  </StoreProvider>
);

describe('the day on her home (#61)', { timeout: 20_000 }, () => {
  it('says every kind of day in every language, without a date or a year', async () => {
    const all: CalendarEventViewT[] = [
      { kind: 'hisBirthday' }, { kind: 'herBirthday' }, { kind: 'herBirthdaySoon', count: 2 }, { kind: 'anniversary', count: 1 }, { kind: 'monthiversary', count: 3 },
      ...(['hatsumode', 'sakura', 'fireworks', 'christmas'] as const).map((season) => ({ kind: 'season' as const, season }))
    ];
    for (const lang of ['ja', 'zh-Hant', 'en', 'ko'] as Lang[]) {
      await ensureLang(lang);
      const t = (k: Key, v?: Record<string, string | number>) => translate(lang, k, v);
      for (const e of all) {
        const label = calendarLabel(e, 'まひろ', t);
        expect(label, `${lang}/${e.kind}`).toBeTruthy();
        expect(label).not.toMatch(/cal\.|\{/);
      }
    }
    const ja = (k: Key, v?: Record<string, string | number>) => translate('ja', k, v);
    expect(calendarLabel({ kind: 'herBirthday' }, 'まひろ', ja)).toBe('今日はまひろの誕生日');
    expect(calendarLabel({ kind: 'monthiversary', count: 3 }, 'まひろ', ja)).toBe('付き合って3か月の記念日');
    expect(calendarLabel({ kind: 'herBirthdaySoon', count: 2 }, 'まひろ', ja)).toBe('まひろの誕生日まで、あと2日');
  });

  it('shows the most important thing today with her, and nothing on an ordinary day', async () => {
    cal.get.mockResolvedValue(res({ nana: [{ kind: 'hisBirthday' }, { kind: 'season', season: 'christmas' }], mahiro: [{ kind: 'herBirthday' }] }));
    home('nana');
    await openIndex();
    expect((await screen.findByTestId('calendar-day', {}, { timeout: 8000 })).textContent).toBe('今日はあなたの誕生日');
    expect(screen.getByTestId('calendar-day').getAttribute('aria-label')).toBe('今日');
    cleanup();

    cal.get.mockResolvedValue(res({ mahiro: [{ kind: 'herBirthday' }] }));
    home('nana');
    await screen.findByTestId('greeting', {}, { timeout: 8000 });
    await waitFor(() => expect(cal.get).toHaveBeenCalledTimes(2));
    await openIndex();
    expect(screen.queryByTestId('calendar-day')).toBeNull();
    cleanup();

    home('mahiro');
    await openIndex();
    expect((await screen.findByTestId('calendar-day', {}, { timeout: 8000 })).textContent).toBe('今日はまひろの誕生日');
  });

  it('stays quiet when the calendar cannot be read', async () => {
    cal.get.mockRejectedValue(new Error('http_500'));
    home('nana');
    await screen.findByTestId('greeting', {}, { timeout: 8000 });
    await waitFor(() => expect(cal.get).toHaveBeenCalled());
    await openIndex();
    expect(screen.queryByTestId('calendar-day')).toBeNull();
  });

  it('asks the test site to pretend `?day=`, and only there', async () => {
    cal.get.mockResolvedValue(res({}));
    home('mahiro', '/me/home?day=2027-03-04');
    await screen.findByTestId('greeting', {}, { timeout: 8000 });
    await waitFor(() => expect(cal.get).toHaveBeenCalled());
    expect(cal.demo).not.toHaveBeenCalled();
    cleanup();

    vi.spyOn(api, 'isDemo').mockReturnValue(true);
    const demo = vi.spyOn(api, 'demoCalendarDay').mockResolvedValue(res({ mahiro: [{ kind: 'herBirthday' }] }));
    home('mahiro', '/me/home?day=2027-03-04');
    await openIndex();
    expect((await screen.findByTestId('calendar-day', {}, { timeout: 8000 })).textContent).toBe('今日はまひろの誕生日');
    expect(demo).toHaveBeenCalledWith('2027-03-04');
  });
});

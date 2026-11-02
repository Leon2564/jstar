import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import type { CalendarEventViewT, CalendarResT } from '@jstar/shared/contracts';
import { StoreProvider } from '../../src/lib/store';
import { AppRoutes } from '../../src/App';
import { initialState, type AppState } from '../../src/lib/state';
import { DECOR_KINDS, decorFor } from '../../src/lib/decor';
import { SeasonDecor } from '../../src/components/seasonDecor';
import * as api from '../../src/services/api';

// The day's decoration over her home (#61): the calendar decides the day, the home only draws it, behind everything.
const cal = vi.hoisted(() => ({ get: vi.fn() }));
vi.mock('../../src/services/http', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../src/services/http')>();
  return { ...real, serverMode: () => true, http: { ...real.http, calendar: cal.get } };
});

beforeAll(() => { (window as unknown as { __E2E__: boolean }).__E2E__ = true; Element.prototype.scrollIntoView = () => {}; window.scrollTo = () => {}; });
beforeEach(() => { vi.spyOn(api, 'inbox').mockResolvedValue(null); });
afterEach(() => { cleanup(); vi.restoreAllMocks(); cal.get.mockReset(); });

const STARS = ['mahiro', 'nana', 'unpai', 'alice', 'eimi'] as const;
const res = (events: Partial<Record<(typeof STARS)[number], CalendarEventViewT[]>>): CalendarResT =>
  ({ talents: STARS.map((star) => ({ star, events: events[star] ?? [] })) });
const home = (star: AppState['star']) => render(
  <StoreProvider initial={{ ...initialState(), ageOk: true, user: { via: 'email', nickname: 'kenta' }, star } as AppState}>
    <MemoryRouter initialEntries={['/me/home']}><AppRoutes /></MemoryRouter>
  </StoreProvider>
);

describe('the day\'s decoration (#61)', { timeout: 30_000 }, () => {
  it('picks the most personal day first, then the season; Halloween week by the date; sakura is the weather\'s', () => {
    const season = (s: CalendarEventViewT['season']) => ({ kind: 'season' as const, season: s });
    expect(decorFor([season('christmas'), { kind: 'hisBirthday' }], '2026-12-24')).toBe('hisBirthday');
    expect(decorFor([{ kind: 'herBirthday' }, { kind: 'anniversary', count: 1 }], '2027-03-04')).toBe('herBirthday');
    expect(decorFor([{ kind: 'monthiversary', count: 2 }], '2026-11-02')).toBe('anniversary');
    expect(decorFor([season('hatsumode')], '2027-01-01')).toBe('hatsumode');
    expect(decorFor([season('fireworks')], '2027-08-01')).toBe('fireworks');
    expect(decorFor([season('christmas')], '2026-12-25')).toBe('christmas');
    expect(decorFor([], '2026-10-31')).toBe('halloween');
    expect(decorFor(undefined, '2026-10-25')).toBe('halloween');
    expect(decorFor([], '2026-11-01')).toBeNull();
    expect(decorFor([season('sakura')], '2027-04-01')).toBeNull();
    expect(decorFor([{ kind: 'herBirthdaySoon', count: 2 }], '2027-03-02')).toBeNull();
  });

  it('every decoration draws: two corners, hidden from screen readers, never catching a tap', () => {
    for (const kind of DECOR_KINDS) {
      const { container, unmount } = render(<SeasonDecor kind={kind} accent="#f2a7b6" />);
      const d = container.querySelector('[data-testid="season-decor"]')!;
      expect(d.getAttribute('data-kind')).toBe(kind);
      expect(d.getAttribute('aria-hidden')).toBe('true');
      expect(d.querySelectorAll('svg.sd-corner')).toHaveLength(2);
      expect(d.querySelector('svg.sd-left')!.children.length, kind).toBeGreaterThan(0);
      unmount();
    }
  });

  it('on her home it sits inside the stage, behind the page — the layout itself is unchanged', async () => {
    cal.get.mockResolvedValue(res({ nana: [{ kind: 'season', season: 'christmas' }] }));
    const { container } = home('nana');
    const decor = await screen.findByTestId('season-decor', {}, { timeout: 15_000 });
    expect(decor.dataset.kind).toBe('christmas');
    expect(decor.closest('.home-stage')).toBeTruthy();
    expect(container.querySelector('.home-content [data-testid="season-decor"]')).toBeNull();
    cleanup();
    cal.get.mockResolvedValue(res({}));
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(Date.UTC(2026, 10, 12, 3));
    home('nana');
    await screen.findByTestId('greeting', {}, { timeout: 15_000 });
    expect(screen.queryByTestId('season-decor')).toBeNull();
    vi.useRealTimers();
  });
});

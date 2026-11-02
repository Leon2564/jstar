import { cleanup, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { eventStatus } from '../../src/data/events';
import { upcomingEvents } from '../../src/data/eventsCalendar';
import { Events } from '../../src/pages/siteMore';
import { StoreProvider } from '../../src/lib/store';

const at = (iso: string) => new Date(iso);
const ev = { startsAt: '2026-10-01T00:00:00+09:00', endsAt: '2026-10-31T23:59:59+09:00' };

describe('event status from its dates (N-11)', () => {
  afterEach(() => { cleanup(); vi.useRealTimers(); });

  it('is 予告 before the start, 開催中 from the start to the end, and 終了 after it (JST boundaries)', () => {
    expect(eventStatus(ev, at('2026-09-30T23:59:59+09:00'))).toBe('soon');
    expect(eventStatus(ev, at('2026-10-01T00:00:00+09:00'))).toBe('live');
    expect(eventStatus(ev, at('2026-10-31T23:59:59+09:00'))).toBe('live');
    expect(eventStatus(ev, at('2026-11-01T00:00:00+09:00'))).toBe('ended');
  });

  it('no event is marked live in the data: the events page reads the status from the dates', () => {
    for (const e of upcomingEvents(at('2026-09-28T09:00:00+09:00'))) expect(e).not.toHaveProperty('status');
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(at('2026-12-24T09:00:00+09:00'));
    render(<StoreProvider><MemoryRouter><Events /></MemoryRouter></StoreProvider>);
    expect(screen.getByTestId('event-status-season-christmas').dataset.status).toBe('live');
    expect(screen.getByTestId('event-status-season-christmas').textContent).toBe('開催中');
    expect(screen.getByTestId('event-status-birthday-eimi').dataset.status).toBe('soon');
  });
});

/** #61: the activity page was hard-coded demo data (its `bday` entry was Halloween); it is the shared calendar now. */
describe('the events come from the calendar (#61)', () => {
  afterEach(() => { cleanup(); vi.useRealTimers(); });

  it('her five confirmed birthdays and the seasons, at their real next dates, soonest first, in four languages', () => {
    const list = upcomingEvents(at('2026-10-01T12:00:00+09:00'));
    const by = Object.fromEntries(list.map((e) => [e.id, e]));
    expect(by['birthday-mahiro'].startsAt).toBe('2027-03-04T00:00:00+09:00');
    expect(by['birthday-nana'].startsAt).toBe('2027-09-03T00:00:00+09:00');
    expect(by['birthday-eimi'].startsAt).toBe('2027-03-18T00:00:00+09:00');
    expect(by['season-christmas']).toMatchObject({ startsAt: '2026-12-24T00:00:00+09:00', endsAt: '2026-12-25T23:59:59+09:00' });
    expect(by['season-hatsumode'].startsAt).toBe('2027-01-01T00:00:00+09:00');
    // Sakura over all her cities: Tokyo's first bloom to Nagano's last.
    expect(by['season-sakura']).toMatchObject({ startsAt: '2027-03-24T00:00:00+09:00', endsAt: '2027-04-21T23:59:59+09:00' });
    expect(list.map((e) => e.startsAt)).toEqual([...list.map((e) => e.startsAt)].sort());
    expect(list.some((e) => /Halloween|ハロウィン/.test(e.title.en + e.title.ja))).toBe(false);
    for (const e of list) for (const lang of ['ja', 'zh-Hant', 'en', 'ko'] as const) expect(e.title[lang], `${e.id} ${lang}`).toBeTruthy();
    // On the day itself it is live; a running season stays this year's.
    expect(upcomingEvents(at('2026-12-25T20:00:00+09:00')).find((e) => e.id === 'season-christmas')?.startsAt).toBe('2026-12-24T00:00:00+09:00');
  });

  it('their anniversary and his birthday when known; on his own clock when his zone is given', () => {
    const list = upcomingEvents(at('2026-10-01T12:00:00+09:00'), { anniversaries: { nana: '2026-05-10', alice: null }, hisBirthday: '1995-11-02' });
    expect(list.find((e) => e.id === 'anniversary-nana')?.startsAt).toBe('2027-05-10T00:00:00+09:00');
    expect(list.find((e) => e.id === 'anniversary-alice')).toBeUndefined();
    expect(list.find((e) => e.id === 'birthday-you')?.startsAt).toBe('2026-11-02T00:00:00+09:00');
    // 23:30 on 9/2 in Honolulu is already 9/3 in Japan: on his clock 奈々's birthday is tomorrow, not over.
    expect(upcomingEvents(at('2026-09-03T09:30:00Z'), { tz: 'Pacific/Honolulu' }).find((e) => e.id === 'birthday-nana')?.startsAt).toBe('2026-09-03T00:00:00+09:00');
  });
});

import { describe, expect, it } from 'vitest';
import {
  CALENDAR_EVENT_KINDS, CALENDAR_LINES, HIS_BIRTHDAY_PUSH, birthMonthDay, calendarLine, eventsOn, herBirthday, monthDayIn, monthsOn, viewOfEvent,
  yearlyOn, type CalendarInput
} from '../src/calendar';
import { LANGS, type StarId } from '../src/domain';
import { HER_MESSAGE_RULES } from '../src/rules';
import { WORLD, type TalentWorld } from '../src/world';

/** Noon in Japan on a JST day. */
const jstNoon = (day: string) => new Date(`${day}T12:00:00+09:00`);
const kinds = (input: CalendarInput) => eventsOn(input).map((e) => e.kind);
/** WORLD with one talent's birthday replaced. */
const withBirthday = (star: StarId, value: string, confirmed: boolean): Record<StarId, TalentWorld> =>
  ({ ...WORLD, [star]: { ...WORLD[star], birthday: { value, confirmed } } });

describe('calendar math (#61)', () => {
  it('keeps a 02-29 birthday on 02-28 in a common year, and on 02-29 in a leap year', () => {
    expect(monthDayIn('02-29', 2027)).toBe('02-28');
    expect(monthDayIn('02-29', 2028)).toBe('02-29');
    expect(monthDayIn('02-29', 2100)).toBe('02-28');
    expect(monthDayIn('02-29', 2000)).toBe('02-29');
    expect(yearlyOn('02-29', '2027-02-28')).toBe(true);
    expect(yearlyOn('02-29', '2027-03-01')).toBe(false);
    expect(yearlyOn('02-29', '2028-02-28')).toBe(false);
    expect(yearlyOn('02-29', '2028-02-29')).toBe(true);
    expect(yearlyOn('02-28', '2028-02-28')).toBe(true);
    expect(kinds({ star: 'mahiro', now: jstNoon('2027-02-28'), birthday: '2004-02-29' })).toContain('hisBirthday');
    expect(kinds({ star: 'mahiro', now: jstNoon('2027-03-01'), birthday: '2004-02-29' })).not.toContain('hisBirthday');
  });

  it('reads only the month and day of his birthday, and nothing that is not a real date', () => {
    expect(birthMonthDay('1990-03-04')).toBe('03-04');
    expect(birthMonthDay('03-04')).toBe('03-04');
    expect(birthMonthDay('1990-02-30')).toBeNull();
    expect(birthMonthDay('')).toBeNull();
    expect(birthMonthDay(null)).toBeNull();
    const [e] = eventsOn({ star: 'nana', now: jstNoon('2027-06-10'), birthday: '1990-06-10' });
    expect(e).toEqual({ kind: 'hisBirthday', day: '2027-06-10', key: 'hisBirthday:2027' });
    // What leaves the server: no day, no key — and nothing that could carry the year.
    expect(viewOfEvent(e)).toEqual({ kind: 'hisBirthday' });
    expect(JSON.stringify(eventsOn({ star: 'nana', now: jstNoon('2027-06-10'), birthday: '1990-06-10' }))).not.toContain('1990');
  });

  it('counts his birthday in his own zone, and hers, the seasons and anniversaries in Japan', () => {
    const b = '1995-03-10';
    // 01:00 UTC on 03-10 is 10:00 in Tokyo but still 03-09 evening in Los Angeles.
    const early = new Date('2027-03-10T01:00:00Z');
    expect(kinds({ star: 'mahiro', now: early, birthday: b, tz: 'Asia/Tokyo' })).toEqual(['hisBirthday']);
    expect(kinds({ star: 'mahiro', now: early, birthday: b, tz: 'America/Los_Angeles' })).toEqual([]);
    // 10:00 UTC: 03-10 02:00 in Los Angeles — his day has come; in Tokyo it is still 03-10.
    expect(kinds({ star: 'mahiro', now: new Date('2027-03-10T10:00:00Z'), birthday: b, tz: 'America/Los_Angeles' })).toEqual(['hisBirthday']);
    // An unknown zone is read as JST.
    expect(kinds({ star: 'mahiro', now: early, birthday: b, tz: 'Mars/Olympus' })).toEqual(['hisBirthday']);
    // Christmas is Japan's: 23:30 UTC on 12-23 is already 12-24 in Tokyo, whatever his zone.
    const eve = new Date('2026-12-23T15:30:00Z');
    expect(eventsOn({ star: 'nana', now: eve, tz: 'America/New_York' }).map((e) => e.key)).toEqual(['season:christmas:2026']);
  });

  it('crosses the year boundary: his birthday on the new year, New Year visits, her birthday coming up in January', () => {
    // 10:00 UTC on 12-31 is already 01-01 on Kiritimati (UTC+14): his birthday belongs to the new year.
    const [his] = eventsOn({ star: 'mahiro', now: new Date('2026-12-31T10:00:00Z'), birthday: '1990-01-01', tz: 'Pacific/Kiritimati' });
    expect(his).toMatchObject({ kind: 'hisBirthday', day: '2027-01-01', key: 'hisBirthday:2027' });
    expect(eventsOn({ star: 'mahiro', now: jstNoon('2027-01-01') })).toEqual([{ kind: 'season', day: '2027-01-01', season: 'hatsumode', opening: true, key: 'season:hatsumode:2027' }]);
    expect(eventsOn({ star: 'mahiro', now: jstNoon('2027-01-03') })).toEqual([{ kind: 'season', day: '2027-01-03', season: 'hatsumode', key: 'season:hatsumode:2027' }]);
    expect(eventsOn({ star: 'mahiro', now: jstNoon('2027-01-04') })).toEqual([]);
    const world = withBirthday('mahiro', '01-02', true);
    expect(eventsOn({ star: 'mahiro', now: jstNoon('2026-12-30'), world })).toEqual([{ kind: 'herBirthdaySoon', day: '2026-12-30', count: 3, key: 'herBirthdaySoon:2027-01-02' }]);
    expect(eventsOn({ star: 'mahiro', now: jstNoon('2026-12-31'), world })[0]).toMatchObject({ kind: 'herBirthdaySoon', count: 2 });
    expect(eventsOn({ star: 'mahiro', now: jstNoon('2026-12-29'), world })).toEqual([]);
    expect(kinds({ star: 'mahiro', now: jstNoon('2027-01-02'), world })).toEqual(['herBirthday', 'season']);
  });

  it('keeps a season that crosses the new year under the year it began in', () => {
    const seasons = [{ id: 'christmas' as const, name: { ja: '冬', 'zh-Hant': '冬', en: 'Winter' }, window: { from: '12-20', to: '01-05' } }];
    expect(eventsOn({ star: 'mahiro', now: jstNoon('2026-12-25'), seasons }).map((e) => e.key)).toEqual(['season:christmas:2026']);
    expect(eventsOn({ star: 'mahiro', now: jstNoon('2027-01-05'), seasons }).map((e) => e.key)).toEqual(['season:christmas:2026']);
    expect(eventsOn({ star: 'mahiro', now: jstNoon('2027-01-06'), seasons })).toEqual([]);
  });

  it('counts anniversaries for lovers: every month on the day (the month\'s last day when it has none), and the years', () => {
    expect(monthsOn('2027-01-31', '2027-01-31')).toBe(0);
    expect(monthsOn('2027-01-31', '2027-02-28')).toBe(1);
    expect(monthsOn('2027-01-31', '2027-03-31')).toBe(2);
    expect(monthsOn('2027-01-31', '2027-03-28')).toBeNull();
    expect(monthsOn('2027-01-31', '2027-04-30')).toBe(3);
    expect(monthsOn('2027-01-31', '2026-12-31')).toBeNull();
    expect(monthsOn('2028-01-31', '2028-02-29')).toBe(1);
    expect(monthsOn('2028-01-31', '2028-02-28')).toBeNull();
    const lover = { star: 'eimi' as const, anniversary: '2027-01-31', stage: 'lover' as const };
    // The day itself is the confession: no anniversary yet.
    expect(kinds({ ...lover, now: jstNoon('2027-01-31') })).toEqual([]);
    expect(eventsOn({ ...lover, now: jstNoon('2027-02-28') })).toEqual([{ kind: 'monthiversary', day: '2027-02-28', count: 1, key: 'monthiversary:2027-02-28' }]);
    expect(eventsOn({ ...lover, now: jstNoon('2028-01-31') })).toEqual([{ kind: 'anniversary', day: '2028-01-31', count: 1, key: 'anniversary:2028-01-31' }]);
    expect(eventsOn({ ...lover, now: jstNoon('2029-01-31') })[0]).toMatchObject({ kind: 'anniversary', count: 2 });
    // A 02-29 anniversary is kept on 02-28 in a common year.
    expect(eventsOn({ ...lover, anniversary: '2028-02-29', now: jstNoon('2029-02-28') })[0]).toMatchObject({ kind: 'anniversary', count: 1 });
    // Not lovers (a stale row): nothing.
    expect(kinds({ ...lover, stage: 'familiar', now: jstNoon('2027-02-28') })).toEqual([]);
  });

  it('never has an unconfirmed birthday of hers — the test site (demo) excepted', () => {
    // The five are confirmed (owner, 2026-09-28): her day is an event everywhere.
    expect(WORLD.mahiro.birthday).toEqual({ value: '03-04', confirmed: true });
    expect(kinds({ star: 'mahiro', now: jstNoon('2027-03-04') })).toEqual(['herBirthday']);
    // Only hers: the others' days stay ordinary.
    expect(kinds({ star: 'nana', now: jstNoon('2027-03-04') })).toEqual([]);
    // An unconfirmed one (a value added later) stays out, except on the test site.
    const unconfirmed = withBirthday('mahiro', '03-04', false);
    expect(herBirthday('mahiro', { world: unconfirmed })).toBeNull();
    expect(kinds({ star: 'mahiro', now: jstNoon('2027-03-04'), world: unconfirmed })).toEqual([]);
    expect(kinds({ star: 'mahiro', now: jstNoon('2027-03-02'), world: unconfirmed })).toEqual([]);
    expect(kinds({ star: 'mahiro', now: jstNoon('2027-03-04'), world: unconfirmed, demo: true })).toEqual(['herBirthday']);
    expect(eventsOn({ star: 'mahiro', now: jstNoon('2027-03-01'), world: unconfirmed, demo: true })[0]).toMatchObject({ kind: 'herBirthdaySoon', count: 3 });
  });

  it('puts the most important first, and each season in her city', () => {
    const world = withBirthday('mahiro', '12-24', true);
    expect(kinds({ star: 'mahiro', now: jstNoon('2027-12-24'), world, birthday: '1990-12-24', anniversary: '2027-01-24', stage: 'lover' }))
      .toEqual(['hisBirthday', 'herBirthday', 'monthiversary', 'season']);
    expect([...CALENDAR_EVENT_KINDS]).toEqual(['hisBirthday', 'herBirthday', 'anniversary', 'monthiversary', 'season', 'herBirthdaySoon']);
    // Her confirmed Nagano blooms about three weeks after Tokyo; an unconfirmed hometown would fall back to Tokyo (#48).
    expect(eventsOn({ star: 'nana', now: jstNoon('2027-03-24') })).toEqual([]);
    expect(kinds({ star: 'nana', now: jstNoon('2027-04-15') })).toEqual(['season']);
    const tokyo = { ...WORLD, nana: { ...WORLD.nana, hometown: { ...WORLD.nana.hometown, confirmed: false } } };
    expect(eventsOn({ star: 'nana', now: jstNoon('2027-03-24'), world: tokyo }).map((e) => e.key)).toEqual(['season:sakura:2027']);
  });
});

describe('her words for the day (#61)', () => {
  it('has a line for every event in every language, short enough for the push and free of anything outside the app', () => {
    for (const [key, byLang] of Object.entries(CALENDAR_LINES)) {
      for (const lang of LANGS) {
        const lines = byLang[lang];
        expect(lines.length, `${key}/${lang}`).toBeGreaterThanOrEqual(2);
        for (const line of lines) {
          const filled = line.replace('{n}', '12');
          expect([...filled].length, filled).toBeLessThanOrEqual(HER_MESSAGE_RULES.maxChars[lang]);
          expect(filled).not.toMatch(/https?:|@|\d{3,}|LINE|電話|歳|才|years old|살/);
        }
      }
    }
    for (const lang of LANGS) expect([...HIS_BIRTHDAY_PUSH[lang]].length).toBeLessThanOrEqual(HER_MESSAGE_RULES.maxChars[lang]);
    // The push on his lock screen does not say it is his birthday.
    expect(Object.values(HIS_BIRTHDAY_PUSH).join()).not.toMatch(/誕生|生日|birthday|생일/i);
  });

  it('fills in the count, picks stably, and writes nothing for a kind she does not send', () => {
    expect(calendarLine({ kind: 'monthiversary', count: 3 }, 'ja', 's')).toMatch(/3か月/);
    expect(calendarLine({ kind: 'anniversary', count: 1 }, 'en', 'x')).toMatch(/1 year(?!s)/);
    expect(calendarLine({ kind: 'anniversary', count: 2 }, 'en', 'x')).toMatch(/2 years/);
    expect(calendarLine({ kind: 'season', season: 'christmas' }, 'fr', 'x')).toMatch(/メリークリスマス/);
    expect(calendarLine({ kind: 'hisBirthday' }, 'en', 'a')).toBe(calendarLine({ kind: 'hisBirthday' }, 'en', 'a'));
    expect(calendarLine({ kind: 'herBirthdaySoon', count: 2 }, 'ja', 'a')).toBeNull();
  });
});

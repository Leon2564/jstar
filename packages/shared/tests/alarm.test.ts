import { describe, expect, it } from 'vitest';
import { localClock, nextRing, pickWakeLine, ringDay, validTimeZone, wakeHourOf, wakeWeatherOf, weekdayOf, zonedInstant } from '../src/alarm';
import { LINES } from '../src/lines';
import { STAR_IDS } from '../src/domain';

const EVERY_DAY = [0, 1, 2, 3, 4, 5, 6];
const at = (iso: string) => Date.parse(iso);

describe('wake-up clock (#57)', () => {
  it('reads the wall clock of the zone, not the server’s', () => {
    expect(localClock(at('2026-10-04T23:30:00Z'), 'Asia/Taipei')).toEqual({ date: '2026-10-05', minutes: 7 * 60 + 30, weekday: 1 });
    expect(localClock(at('2026-10-04T23:30:00Z'), 'America/Los_Angeles')).toEqual({ date: '2026-10-04', minutes: 16 * 60 + 30, weekday: 0 });
    // Midnight is minute 0 of the new day, never "24:00" of the old one.
    expect(localClock(at('2026-10-04T16:00:00Z'), 'Asia/Taipei')).toMatchObject({ date: '2026-10-05', minutes: 0 });
  });

  it('accepts only zones the runtime knows', () => {
    expect(validTimeZone('Asia/Taipei')).toBe('Asia/Taipei');
    expect(validTimeZone('Mars/Olympus')).toBeNull();
    expect(validTimeZone('')).toBeNull();
    expect(validTimeZone(undefined)).toBeNull();
  });

  it('rings 07:30 Asia/Taipei on the first tick at or after it, and not before', () => {
    const alarm = { time: '07:30', days: EVERY_DAY };
    expect(ringDay(alarm, 'Asia/Taipei', at('2026-10-04T23:25:00Z'))).toBeNull();
    expect(ringDay(alarm, 'Asia/Taipei', at('2026-10-04T23:30:02Z'))).toBe('2026-10-05');
    // A tick or two late (the cron drifted, one fire was skipped) still rings the same morning.
    expect(ringDay(alarm, 'Asia/Taipei', at('2026-10-04T23:40:00Z'))).toBe('2026-10-05');
    // Long after (the service was down) the morning is let go: a 08:15 call for 07:30 is worse than none.
    expect(ringDay(alarm, 'Asia/Taipei', at('2026-10-05T00:15:00Z'))).toBeNull();
    // The same instant is afternoon in Los Angeles: nothing rings there.
    expect(ringDay(alarm, 'America/Los_Angeles', at('2026-10-04T23:30:02Z'))).toBeNull();
    expect(ringDay(alarm, 'America/Los_Angeles', at('2026-10-05T14:30:00Z'))).toBe('2026-10-05');
  });

  it('rings only on the chosen days, by the local day', () => {
    const weekdays = { time: '07:30', days: [1, 2, 3, 4, 5] };
    // 2026-10-10 is a Saturday in Taipei (still Friday in UTC).
    expect(weekdayOf('2026-10-10')).toBe(6);
    expect(ringDay(weekdays, 'Asia/Taipei', at('2026-10-09T23:30:00Z'))).toBeNull();
    expect(ringDay(weekdays, 'Asia/Taipei', at('2026-10-08T23:30:00Z'))).toBe('2026-10-09');
  });

  it('rings a late-night alarm on a tick just after midnight', () => {
    const alarm = { time: '23:55', days: EVERY_DAY };
    // The 23:55 tick was missed; the 00:00 tick of the next day rings the evening before's alarm.
    expect(ringDay(alarm, 'Asia/Tokyo', at('2026-10-05T15:00:10Z'))).toBe('2026-10-05');
    expect(ringDay({ time: '00:00', days: EVERY_DAY }, 'Asia/Tokyo', at('2026-10-05T15:00:10Z'))).toBe('2026-10-06');
  });

  it('works in zones with a quarter-hour offset', () => {
    // Asia/Kathmandu is +05:45: 07:30 there is 01:45 UTC, which the 5-minute cron hits exactly.
    expect(ringDay({ time: '07:30', days: EVERY_DAY }, 'Asia/Kathmandu', at('2026-10-05T01:45:03Z'))).toBe('2026-10-05');
    expect(ringDay({ time: '07:30', days: EVERY_DAY }, 'Asia/Kathmandu', at('2026-10-05T01:40:03Z'))).toBeNull();
    expect(new Date(zonedInstant('2026-10-05', 7 * 60 + 30, 'Asia/Kathmandu')).toISOString()).toBe('2026-10-05T01:45:00.000Z');
  });

  it('still rings the morning daylight saving skips its time, and on the repeated hour reports the same day (claimed once)', () => {
    // 2027-03-14, New York: 01:59 EST is followed by 03:00 EDT, so 02:30 never shows on the clock.
    const gap = { time: '02:30', days: EVERY_DAY };
    expect(ringDay(gap, 'America/New_York', at('2027-03-14T06:55:00Z'))).toBeNull();
    expect(ringDay(gap, 'America/New_York', at('2027-03-14T07:00:00Z'))).toBe('2027-03-14');
    // 2026-11-01: 01:30 happens twice (EDT, then EST an hour later). Both passes name the same day; the per-day
    // claim (repos.alarms.ring) lets only the first one ring.
    const twice = { time: '01:30', days: EVERY_DAY };
    expect(ringDay(twice, 'America/New_York', at('2026-11-01T05:30:00Z'))).toBe('2026-11-01');
    expect(ringDay(twice, 'America/New_York', at('2026-11-01T06:30:00Z'))).toBe('2026-11-01');
    // 07:30 is 11:30 UTC the day before the change and 12:30 UTC the day after.
    expect(ringDay({ time: '07:30', days: EVERY_DAY }, 'America/New_York', at('2026-10-31T11:30:00Z'))).toBe('2026-10-31');
    expect(ringDay({ time: '07:30', days: EVERY_DAY }, 'America/New_York', at('2026-11-02T11:30:00Z'))).toBeNull();
    expect(ringDay({ time: '07:30', days: EVERY_DAY }, 'America/New_York', at('2026-11-02T12:30:00Z'))).toBe('2026-11-02');
  });

  it('says when it rings next, in real time across a DST change', () => {
    const alarm = { time: '07:30', days: EVERY_DAY, enabled: true };
    expect(nextRing(alarm, 'Asia/Taipei', at('2026-10-05T00:00:00Z'))).toBe('2026-10-05T23:30:00.000Z');
    expect(nextRing(alarm, 'Asia/Taipei', at('2026-10-04T20:00:00Z'))).toBe('2026-10-04T23:30:00.000Z');
    // Already rung this morning: tomorrow.
    expect(nextRing(alarm, 'Asia/Taipei', at('2026-10-04T20:00:00Z'), '2026-10-05')).toBe('2026-10-05T23:30:00.000Z');
    expect(nextRing(alarm, 'America/New_York', at('2026-11-01T13:00:00Z'))).toBe('2026-11-02T12:30:00.000Z');
    expect(nextRing({ ...alarm, days: [1] }, 'Asia/Taipei', at('2026-10-05T00:00:00Z'))).toBe('2026-10-11T23:30:00.000Z');
    expect(nextRing({ ...alarm, enabled: false }, 'Asia/Taipei', at('2026-10-05T00:00:00Z'))).toBeNull();
  });
});

describe('which of her lines wakes him (#57)', () => {
  const lines = LINES.mahiro.wakeup;

  it('mentions rain or snow first, when that is his morning', () => {
    expect(pickWakeLine(lines, '2026-10-05', 'rain').when.weather).toBe('rain');
    expect(pickWakeLine(lines, '2026-10-10', 'snow').when.weather).toBe('snow');
    expect(wakeWeatherOf('thunder')).toBe('rain');
    expect(wakeWeatherOf('fog')).toBe('cloudy');
  });

  it('takes turns by date among the lines that fit the day, never a weekend line on a weekday', () => {
    const week = ['2026-10-05', '2026-10-06', '2026-10-07', '2026-10-08', '2026-10-09'].map((d) => pickWakeLine(lines, d, null));
    for (const l of week) expect(l.when.days ?? 'weekday').toBe('weekday');
    expect(week.every((l) => !l.when.weather)).toBe(true);
    expect(new Set(week.map((l) => l.id)).size).toBeGreaterThan(1);
    for (let i = 1; i < week.length; i++) expect(week[i].id).not.toBe(week[i - 1].id);
    const sat = pickWakeLine(lines, '2026-10-10', 'cloudy');
    expect(sat.when.days ?? 'weekend').toBe('weekend');
  });

  it('fits his hour: before dawn, early, morning, by day, in the evening — never 「天亮了」 at 04:22 (PR 5)', () => {
    expect([0, 4, 5, 7, 8, 10, 11, 17, 18, 23].map(wakeHourOf)).toEqual(['dawn', 'dawn', 'early', 'early', 'morning', 'morning', 'day', 'day', 'evening', 'evening']);
    const week = ['2026-10-05', '2026-10-06', '2026-10-07', '2026-10-08', '2026-10-09', '2026-10-10', '2026-10-11'];
    for (const star of STAR_IDS) {
      const w = LINES[star].wakeup;
      for (const day of week) {
        for (const weather of [null, 'rain', 'snow', 'clear'] as const) {
          // Before dawn: her own before-dawn line, whatever the day or the sky (no 「早安」, no daylight, no breakfast).
          const dawn = pickWakeLine(w, day, weather, undefined, 4);
          expect(dawn.id, `${star} ${day} ${weather}`).toBe('dawn');
          expect(dawn.text['zh-Hant']).not.toMatch(/早安|天亮/);
          expect(dawn.text.en).not.toMatch(/morning/i);
          expect(pickWakeLine(w, day, weather, undefined, 14).id).toBe('day');
          expect(pickWakeLine(w, day, weather, undefined, 20).id).toBe('evening');
          // Early and morning: one of her eight recorded morning lines, never a line for another hour.
          for (const h of [5, 7, 9]) expect(['dawn', 'day', 'evening'], `${star} ${h}`).not.toContain(pickWakeLine(w, day, weather, undefined, h).id);
        }
      }
      // Every wake-up line is in her recorded voice, the before-dawn, day and evening ones too (#83).
      for (const l of w) expect(l.text.voice, `${star} ${l.id}`).toMatch(new RegExp(`^/voice/scene/${star}/[0-9a-f]{12}\\.mp3$`));
    }
  });

  it('says another line on the snooze call', () => {
    for (const star of STAR_IDS) {
      const first = pickWakeLine(LINES[star].wakeup, '2026-10-05', 'rain');
      expect(pickWakeLine(LINES[star].wakeup, '2026-10-05', 'rain', first.id).id).not.toBe(first.id);
    }
  });
});

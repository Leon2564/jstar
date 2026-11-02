import { describe, expect, it } from 'vitest';
import { promiseDay, timelessPromise } from '../src/promises';

/** Round 10: a promise's words froze 「明日」, so on the day itself the card still said tomorrow. */
describe('the day of a promise is counted when it is shown', () => {
  it('its words keep the time and the plan, never a relative day', () => {
    expect(timelessPromise('明日の夜9時、ここで待ってる')).toBe('夜9時、ここで待ってる');
    expect(timelessPromise('今夜9時、朗読を聞かせる')).toBe('夜9時、朗読を聞かせる');
    expect(timelessPromise('今日の深夜1時、ここで話す')).toBe('深夜1時、ここで話す');
    expect(timelessPromise('내일 밤 9시, 여기서 기다릴게')).toBe('밤 9시, 여기서 기다릴게');
    expect(timelessPromise('明天晚上9點，在這裡等你')).toBe('晚上9點，在這裡等你');
    // Round 12: zh-Hant's short forms too.
    expect(timelessPromise('明晚9點，在這裡見')).toBe('晚上9點，在這裡見');
    expect(timelessPromise('明早8點叫你起床')).toBe('早上8點叫你起床');
    expect(timelessPromise('Tomorrow night at 9, right here')).toBe('Night at 9, right here');
    expect(timelessPromise('Tomorrow at 9 pm, I\'ll be right here')).toBe('At 9 pm, I\'ll be right here');
    expect(timelessPromise('I\'ll be here tomorrow at 9 pm')).toBe('I\'ll be here at 9 pm');
    expect(timelessPromise('朗読を聞かせる')).toBe('朗読を聞かせる');
  });

  it('today / tonight / tomorrow from its due time and now (Japan time); a later day is its date', () => {
    const at15 = Date.parse('2026-10-01T06:00:00Z'); // 15:00 JST
    expect(promiseDay('2026-10-01T12:00:00Z', 'ja', at15)).toBe('今夜'); // 21:00 today
    expect(promiseDay('2026-10-01T16:00:00Z', 'en', at15)).toBe('tonight'); // 01:00 after midnight
    expect(promiseDay('2026-10-02T00:00:00Z', 'ko', at15)).toBe('내일'); // 09:00 tomorrow
    expect(promiseDay('2026-10-01T07:00:00Z', 'zh-Hant', at15)).toBe('今天');
    expect(promiseDay('2026-10-03T12:00:00Z', 'ja', at15)).toBeNull();
    // The same promise made yesterday for 21:00 today reads tonight today, not tomorrow.
    expect(promiseDay('2026-10-01T12:00:00Z', 'ja', Date.parse('2026-09-30T12:00:00Z'))).toBe('明日');
  });
});

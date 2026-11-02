import { describe, expect, it } from 'vitest';
import { heardPromise } from '../src/lib/promises';

/** Round 12: zh-Hant promise texts still carried 明晚 / 明天晚上, so on the day itself they still said tomorrow. */
describe('a promise heard in chat is stored without a relative day', () => {
  const now = Date.parse('2026-10-14T03:00:00Z');
  const due = '2026-10-15T12:00:00.000Z';
  it.each([
    ['明晚9點，在這裡見', '晚上9點，在這裡見'], ['明天晚上9點，在這裡等你', '晚上9點，在這裡等你'], ['내일 밤 9시, 여기서 기다릴게', '밤 9시, 여기서 기다릴게'],
    ['Tomorrow at 9 pm, right here with you', 'At 9 pm, right here with you'], ['明日の夜9時、ここで待ってる', '夜9時、ここで待ってる']
  ])('%s → %s', (text, stored) => {
    expect(heardPromise({ text, dueAt: due, kind: 'free' }, now)?.text).toBe(stored);
  });
});

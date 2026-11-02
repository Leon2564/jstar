import { WAKEUP_RULES, conditionOf, isStale, localText, pickWakeLine, userCityKey, validTimeZone, wakeWeatherOf, weatherPoint, type Lang, type LocalText, type StarId, type WakeWeather } from '@jstar/shared';
import { LINES } from '@jstar/shared/lines';
import type { AlarmRow, Repos } from '../db/types';
// Her recorded morning greeting (apps/web/public/voice/greet/<star>-morning.mp3): reviewed and live since v1.0.
import greetings from '../../../../tools/voice/greetings.json';

/**
 * What she says when she wakes him (#57): which of her eight wake-up lines (#82) a morning gets, and her answers to
 * 「起きた」 / 「あと5分」.
 *
 * Her lines are drafts until native review (#84), and a draft never reaches a user in production. Until they are
 * signed off, production wakes him with her recorded morning greeting instead (`GREET_LINE_ID`, the same words her
 * voice file says) and the two buttons get no spoken answer; the test site (demo mode) uses the drafts.
 *
 * Her call name for him (#56) is not in these lines: every wake-up line can be recorded once (#83). When a named
 * wake-up is wanted it will be her runtime voice (#73), not pre-recorded fragments joined together.
 */
export const GREET_LINE_ID = 'greet-morning';

const MORNING = greetings as unknown as Record<StarId, { morning: LocalText }>;

/** Her lines may reach this user: reviewed, or the test site. */
export const linesUsable = (star: StarId, demo: boolean) => demo || !LINES[star].draft;

/**
 * The line for his alarm: by his local hour (before dawn, early, morning, day, evening), weekday and weather, rotating
 * by date; `skip` = the one she already said (snooze).
 */
export function chooseWakeLine(star: StarId, day: string, weather: WakeWeather | null, demo: boolean, skip?: string, hour = 8): { id: string; text: LocalText } {
  if (!linesUsable(star, demo)) return { id: GREET_LINE_ID, text: MORNING[star].morning };
  const line = pickWakeLine(LINES[star].wakeup, day, weather, skip, hour);
  return { id: line.id, text: line.text };
}

/** A line by the id stored on the wake-up, in `lang`; null for an id that no longer exists (lines were rewritten). */
export function wakeLineText(star: StarId, lineId: string, lang: Lang, demo: boolean): string | null {
  if (lineId === GREET_LINE_ID) return localText(MORNING[star].morning, lang);
  if (!linesUsable(star, demo)) return null;
  const line = LINES[star].wakeup.find((l) => l.id === lineId);
  return line ? localText(line.text, lang) : null;
}

/**
 * Her recording of a wake-up line (#83 links `voice` into her line file; none yet = subtitle only). Her recorded
 * morning greeting is the web's own (`momentLines`), so the greeting id has none here.
 */
export function wakeLineVoice(star: StarId, lineId: string, demo: boolean): string | null {
  if (lineId === GREET_LINE_ID || !linesUsable(star, demo)) return null;
  return (LINES[star].wakeup.find((l) => l.id === lineId)?.text as { voice?: string } | undefined)?.voice ?? null;
}

/**
 * #12: her ringtone — the recording of the line she wakes him with, kept on the wake-up (`voice`) so her call rings in
 * her own voice before he answers. Her recorded morning greeting when the line has none (the web's own file).
 */
export function ringVoice(star: StarId, lineId: string, demo: boolean): { voice: string } {
  return { voice: wakeLineVoice(star, lineId, demo) ?? `/voice/greet/${star}-morning.mp3` };
}

/** Her recordings of her answers to 「起きた」 and 「あと5分」 (#83), when made. */
export function wakeReplyVoices(star: StarId, demo: boolean): { awake: string | null; snooze: string | null } | null {
  if (!linesUsable(star, demo)) return null;
  const r = LINES[star].wakeReplies as { awake: { voice?: string }; snooze: { voice?: string } };
  return { awake: r.awake.voice ?? null, snooze: r.snooze.voice ?? null };
}

export function wakeReplies(star: StarId, lang: Lang, demo: boolean): { awake: string; snooze: string } | null {
  if (!linesUsable(star, demo)) return null;
  const r = LINES[star].wakeReplies;
  return { awake: localText(r.awake, lang), snooze: localText(r.snooze, lang) };
}

/** His clock: the zone his devices last reported (`users.tz`), else the one the alarm was set in, else JST. */
export const clockOf = (userTz: string | null, alarm: Pick<AlarmRow, 'tz'> | null): string =>
  validTimeZone(userTz) ?? validTimeZone(alarm?.tz) ?? WAKEUP_RULES.defaultTz;

/**
 * The sky she mentions: his own city's (#62) when he chose one, else hers. Stale or missing data is no weather at
 * all, as everywhere else (#62 降级): she then just says good morning.
 */
export async function morningWeather(repos: Repos, userId: string, star: StarId, now: Date): Promise<WakeWeather | null> {
  const city = await repos.userCities.get(userId);
  const key = city ? userCityKey(city.lat, city.lon) : weatherPoint(star).cityId;
  const [row] = await repos.weather.get([key]);
  if (!row?.data || !row.fetchedAt || isStale(row.fetchedAt, now)) return null;
  return wakeWeatherOf(conditionOf(row.data.code));
}

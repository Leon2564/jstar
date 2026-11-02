import type { FastifyInstance } from 'fastify';
import { SYSTEM_SCENE_RULES, WEATHER_EVENTS, type StarId, type WeatherEvent } from '@jstar/shared';
import { GOODNIGHT_CUE, SYSTEM_LINES, SYSTEM_SCENES, openSystemScenes, promisePayoff, systemSceneOf } from '@jstar/shared/scenes/system';
import { zSystemLines } from '@jstar/shared/scenes/systemSchema';
import type { UserRow } from '../db/types';
import { WEATHER_INBOX_PREFIX } from '../jobs/weatherEvents';
import { todayWith } from './calendar';

/**
 * The system scenes (#71) on the server: which of hers are open for him right now. Every way a scene begins asks
 * here for these ones — her offer as he enters her room, his request in chat (「おやすみ」), an inbox item that names
 * one, and the start itself — so a birthday scene cannot be started on another day, nor a whisper without the pass.
 */

// The pack's own words are checked at boot, like every script (sceneTriggers.ts parses the scripts themselves).
zSystemLines.parse(SYSTEM_LINES);

export { SYSTEM_SCENES };
export const isSystemScene = (sceneId: string): boolean => !!systemSceneOf(sceneId);

/** Her weather messages (weatherEvents.ts, id prefix `wx_`) that reached him within the window, by event. */
async function weatherHeard(app: FastifyInstance, userId: string, star: StarId, now: number): Promise<WeatherEvent[]> {
  const since = new Date(now - SYSTEM_SCENE_RULES.weatherSceneMs).toISOString();
  // N-56: looked up by kind (the weather messages' id prefix) and time, not among his newest 50 messages.
  const rows = await app.repos.inbox.deliveredSince(userId, star, WEATHER_INBOX_PREFIX, since);
  const events = new Set(rows.map((r) => r.payload.event));
  return WEATHER_EVENTS.filter((e) => events.has(e));
}

/** Her system scenes open for him now, most important first (packages/shared/src/scenes/system.ts `openSystemScenes`). */
export async function openSystemFor(app: FastifyInstance, user: UserRow, star: StarId, now = Date.now()): Promise<string[]> {
  const [calendar, weather, promise] = await Promise.all([
    // Her birthday only once confirmed, or on the test site; "pretend it is that day" (demo) counts too.
    todayWith(app, user, star, new Date(now)),
    weatherHeard(app, user.id, star, now),
    app.repos.promises.latest(user.id, star)
  ]);
  return openSystemScenes({
    star, now, tz: user.tz, passUntil: user.passUntil, calendar: calendar.map((e) => e.kind), weather,
    promiseKept: promisePayoff(promise, now) === 'promiseKept', promiseMorning: promisePayoff(promise, now) === 'promiseMorning'
  });
}

/** What he might say to ask for it without naming it (#65): 「おやすみ」 is asking for goodnight. */
export const cueOf = (sceneId: string): { hint: string; words: string[] } | undefined => {
  const kind = systemSceneOf(sceneId)?.kind;
  return kind === 'whisper' || kind === 'goodnight' ? { hint: GOODNIGHT_CUE.hint, words: [...GOODNIGHT_CUE.words] } : undefined;
};

import { HER_MESSAGE_RULES, LANGS, STAR_IDS, addDays, jstDay, passActive, weatherPoint, type Lang } from '@jstar/shared';
import {
  herMessageLine as fallbackLine, inQuietHours, lastNight, herLocalClock, perDayOf, planDay, windowOf, herZonedInstant
} from '@jstar/shared/herMessages';
import type { HerMessageDue, HerMessageRow, WeatherRow } from '../db/types';
import { newId } from '../lib/crypto';
import { favouriteOf, herMessageInput, herMessageLine, inviteScene, writeHerMessage } from '../lib/herMessages';
import type { TickJob } from '../lib/tick';

/**
 * Her messages (#58, docs/requirements.md §11.3), as two tick jobs before `inbox.deliver`, so what they write is
 * delivered — badge and push — by the same tick.
 *
 * her-messages.plan decides each active user's day once it has begun where he is (his `users.tz`, JST when unknown)
 * and last night is over: which messages (planDay: the dream after an evening together, tonight's invitation, an
 * everyday note, as many as his setting allows) and when, spread over each window. A day planned is a row per
 * (user, day, kind) — a day with nothing left to send gets one skipped row — so a user is looked at once a day.
 *
 * her-messages.send writes the messages that are due. Each row is taken (planned → writing) before the model is
 * asked and marked sent together with her inbox line, so the model is asked at most once per message: a row a run
 * took and never finished is sent after a lease with her fallback line, without asking again. What is skipped:
 * a deleted, banned or opted-out user, a time in his quiet hours or long after its window (the tick was down), his
 * day's allowance already used (he lowered his setting), and — past HER_MESSAGE_RULES.dailyCap messages today, all
 * users together — everyone without a monthly pass.
 */

const PLAN_PAGE = 200;
/** A run that took a row and died holds it this long; then it goes out with her fallback line. */
const WRITING_LEASE_MS = 10 * 60_000;
/** Due rows per run, and how many are written at once: the tick's budget is shared with the jobs after this one. */
const SEND_MAX = 300;
const CONCURRENCY = 16;
/** No new message is started after this long, so `inbox.deliver` and the rest of the tick keep their time. */
const SEND_BUDGET_MS = 10_000;
/** A message is still sent this long after its window closed (a slow tick); later it is dropped, never sent at night. */
const LATE_GRACE_MS = 30 * 60_000;
/** Plan rows are history after this: they only say what she wrote on which day. */
const KEEP_DAYS = 30;

const iso = (ms: number) => new Date(ms).toISOString();

export const planHerMessages: TickJob = {
  name: 'her-messages.plan',
  // Every tick would only find the users who became active since the last run: a quarter-hour is soon enough.
  everyMs: 15 * 60_000 - 60_000,
  async run({ repos, now, signal, her }) {
    if (!her) return { off: true };
    const t = now.getTime();
    const since = addDays(jstDay(now), -HER_MESSAGE_RULES.activeDays);
    const planFrom = HER_MESSAGE_RULES.lastNight.to * 60;
    const planTo = Math.max(...(['dream', 'note', 'invite'] as const).map((k) => windowOf(k)[1]));
    // Users grouped by their local day, only where that day has begun and last night is over (the dream needs it).
    const days = new Map<string, (string | null)[]>();
    for (const tz of await repos.herMessages.zones()) {
      const c = herLocalClock(t, tz);
      if (c.minutes < planFrom || c.minutes >= planTo) continue;
      days.set(c.day, [...(days.get(c.day) ?? []), tz]);
    }
    let users = 0;
    let planned = 0;
    for (const [day, zones] of days) {
      let after = '';
      while (!signal.aborted) {
        const page = await repos.herMessages.toPlan(zones, day, since, after, PLAN_PAGE);
        for (const c of page) {
          if (signal.aborted) break;
          const night = lastNight(day, c.tz);
          const dreamStar = await repos.herMessages.lastNightWith(c.userId, iso(night.from), iso(night.to));
          const plan = planDay({ userId: c.userId, day, nowMinutes: herLocalClock(t, c.tz).minutes, tz: c.tz, mode: c.mode, star: favouriteOf(c.stars), dreamStar });
          const at = now.toISOString();
          const row = (p: Pick<HerMessageRow, 'kind' | 'star' | 'dueAt'>, skipped = false): HerMessageRow => ({
            userId: c.userId, day, ...p, inboxId: newId('inb'), status: skipped ? 'skipped' : 'planned',
            triedAt: null, sentAt: null, source: null, reason: skipped ? 'late' : null, createdAt: at
          });
          // Nothing left to send today still marks the day as planned.
          const rows = plan.length ? plan.map((p) => row({ ...p, dueAt: iso(p.dueAt) })) : [row({ kind: 'note', star: favouriteOf(c.stars), dueAt: at }, true)];
          const added = await repos.herMessages.plan(rows);
          if (plan.length) planned += added;
          users++;
        }
        if (page.length < PLAN_PAGE) break;
        after = page[page.length - 1].userId;
      }
    }
    const purged = signal.aborted ? 0 : await repos.herMessages.purge(addDays(jstDay(now), -KEEP_DAYS), 500);
    return { users, planned, purged };
  }
};

export const sendHerMessages: TickJob = {
  name: 'her-messages.send',
  everyMs: 0,
  async run({ repos, now, signal, log, her }) {
    if (!her) return { off: true };
    const started = Date.now();
    const t = now.getTime();
    const at = now.toISOString();
    const due = await repos.herMessages.due(at, iso(t - WRITING_LEASE_MS), SEND_MAX);
    if (!due.length) return { due: 0 };
    // 0:00 JST: the cap is per business day, whatever his zone.
    let sentToday = await repos.herMessages.sentSince(new Date(`${jstDay(now)}T00:00:00+09:00`).toISOString());
    const cities = [...new Set(STAR_IDS.map((s) => weatherPoint(s).cityId))];
    const weather = new Map<string, WeatherRow>((await repos.weather.get(cities)).map((w) => [w.cityKey, w]));
    const mine = new Map<string, number>();
    const out = { due: due.length, model: 0, fallback: 0, lost: 0, skipped: {} as Record<string, number> };

    /** Why this one is not sent now; null = send it. Checked and counted in one synchronous step after the reads. */
    const refusal = async (d: HerMessageDue): Promise<string | null> => {
      const sent = await repos.herMessages.sentOn(d.userId, d.day);
      if (!d.user.active) return 'inactive';
      if (d.user.mode === 'off') return 'off';
      // A demo row (reason 'demo', POST /v1/her-messages/demo) goes out at once, outside the windows and caps.
      if (d.reason !== 'demo') {
        if (inQuietHours(herLocalClock(t, d.user.tz).minutes)) return 'quiet';
        if (t > herZonedInstant(d.day, windowOf(d.kind)[1], d.user.tz) + LATE_GRACE_MS) return 'late';
        if (sent + (mine.get(d.userId) ?? 0) >= perDayOf(d.user.mode)) return 'allowance';
        if (sentToday >= HER_MESSAGE_RULES.dailyCap && !passActive(d.user.passUntil, t)) return 'cap';
      }
      mine.set(d.userId, (mine.get(d.userId) ?? 0) + 1);
      sentToday++;
      return null;
    };

    const one = async (d: HerMessageDue) => {
      const key = { userId: d.userId, day: d.day, kind: d.kind };
      const why = await refusal(d);
      if (why) {
        await repos.herMessages.skip(key, why);
        out.skipped[why] = (out.skipped[why] ?? 0) + 1;
        return;
      }
      const fresh = d.status === 'planned';
      if (!(await repos.herMessages.take(key, at, iso(t - WRITING_LEASE_MS)))) { sentToday--; return; }
      // Asked once: a row another run took and left is not asked again.
      const text = fresh ? await writeHerMessage(her.write, await herMessageInput(repos, d, now, weather)) : null;
      const seed = `${d.userId}|${d.day}|${d.kind}`;
      // M18: her own words carry the language they were written in; her fallback line is kept in every language.
      // C-room R6: her fallback line fits the hour it goes out at (his clock): no 「早安」 at 11:10.
      const hour = Math.floor(herLocalClock(t, d.user.tz).minutes / 60);
      const written = text ? { lang: d.user.lang } : { texts: Object.fromEntries(LANGS.map((l) => [l, fallbackLine(d.kind, l, seed, hour)])) as Record<Lang, string> };
      const line = herMessageLine(d, text ?? fallbackLine(d.kind, d.user.lang, seed, hour), inviteScene(d.star, her.demo), at, written);
      if (await repos.herMessages.send(key, at, at, text ? 'model' : 'fallback', line)) out[text ? 'model' : 'fallback']++;
      else { out.lost++; sentToday--; }
    };

    const queue = [...due];
    const worker = async () => {
      for (let d = queue.shift(); d; d = queue.shift()) {
        if (signal.aborted || Date.now() - started > SEND_BUDGET_MS) return;
        try { await one(d); } catch (err) { log.error({ err: String(err), user: d.userId, kind: d.kind }, 'her_message_failed'); }
      }
    };
    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, due.length) }, worker));
    return out;
  }
};

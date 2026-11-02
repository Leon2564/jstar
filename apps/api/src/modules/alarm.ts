import type { FastifyInstance } from 'fastify';
import {
  AlarmSetReq, WAKEUP_RULES, WakeOpenReq, WakePayload, WakeRingReq, WakeSnoozeReq, accessOpen, alarmMinutes, localClock, localText, nextRing, validTimeZone,
  type AlarmResT, type AlarmViewT, type InboxItemT, type WakeOpenResT, type WakePayloadT, type WakeSnoozeResT
} from '@jstar/shared';
import { httpError, requireUser } from '../app';
import type { AlarmRow, InboxRow, UserRow } from '../db/types';
import { newId } from '../lib/crypto';
import { chooseWakeLine, clockOf, morningWeather, ringVoice, wakeLineText, wakeLineVoice, wakeReplies, wakeReplyVoices } from '../lib/wakeup';
import { keepWakePromise } from '../lib/promises';
import { payloadIn } from '../lib/inboxText';

/** M18: her wake-up line in his language as he reads it (lib/inboxText.ts: by the line's id). */
const toItem = (r: InboxRow, lang: string): InboxItemT => ({
  id: r.id, star: r.star, kind: r.kind, payload: payloadIn(r, lang), deliveredAt: r.deliveredAt ?? r.dueAt, readAt: r.readAt, createdAt: r.createdAt
});

function view(a: AlarmRow, userTz: string | null, now: Date): AlarmViewT {
  const tz = clockOf(userTz, a);
  return { star: a.star, time: a.time, days: [...a.days].sort((x, y) => x - y), enabled: a.enabled, tz, nextAt: nextRing(a, tz, now, a.lastDay), updatedAt: a.updatedAt };
}

/** How early an open room may ring her snoozed call (its clock and the server's differ a little). */
const RING_EARLY_MS = 60_000;

/**
 * One of his delivered wake-ups (not someone else's, not another kind), with its payload checked. `ringing`: also her
 * snoozed call not delivered yet but due (F-04: his open room rang it at its time) — delivered now, no push after it.
 */
async function wakeItem(app: FastifyInstance, user: UserRow, id: string, ringing = false): Promise<{ row: InboxRow; payload: WakePayloadT }> {
  // N-37: looked up by its id — a morning's wake-up is found however many messages came after it.
  const now = Date.now();
  const row = (await app.repos.inbox.mine(user.id, id))
    ?? (ringing ? await app.repos.inbox.deliverMine(user.id, id, new Date(now).toISOString(), new Date(now + RING_EARLY_MS).toISOString()) : null);
  const payload = row?.kind === 'wakeup' ? WakePayload.safeParse(row.payload) : null;
  if (!row || !payload?.success) throw httpError('wake_not_found', 404);
  return { row, payload: payload.data };
}

/**
 * His wake-up alarm (#57): set, change and turn off the one alarm and who wakes him; open the morning's wake-up and
 * answer it (「起きた」 is the web's alone; 「あと5分」 asks her to call again). The ringing is the tick's
 * (jobs/ringAlarms.ts).
 */
export async function registerAlarm(app: FastifyInstance) {
  app.get('/', async (req): Promise<AlarmResT> => {
    const user = requireUser(req);
    const a = await app.repos.alarms.get(user.id);
    return { alarm: a ? view(a, user.tz, new Date()) : null };
  });

  app.put('/', { config: { rateLimit: { max: 30, timeWindow: '10 minutes' } } }, async (req): Promise<AlarmResT> => {
    const user = requireUser(req);
    // rules.ts ACCESS: free in v1.1; a later move into the monthly pass changes that one line.
    if (!accessOpen('wakeup', user.passUntil)) throw httpError('pass_required', 402);
    const body = AlarmSetReq.parse(req.body);
    const prev = await app.repos.alarms.get(user.id);
    const reported = validTimeZone(body.tz);
    const tz = reported ?? clockOf(user.tz, prev);
    const now = new Date();
    // Saved after today's time has passed, it rings from tomorrow (not the instant it is saved); saved before, it
    // rings today — also when it already rang earlier today, since he just asked for a later time.
    const local = localClock(now, tz);
    const lastDay = local.minutes >= alarmMinutes(body.time) ? local.date : null;
    const at = now.toISOString();
    const a = await app.repos.alarms.set({
      userId: user.id, star: body.star, time: body.time, days: body.days, enabled: body.enabled, tz, lastDay,
      createdAt: prev?.createdAt ?? at, updatedAt: at
    }, reported !== null);
    if (a.enabled) await app.recordEvent(user.id, 'alarm.set', { star: a.star });
    return { alarm: view(a, reported ?? user.tz, now) };
  });

  /** Opening the morning's wake-up: marks it read, counts `wakeup.opened` once a morning, and says what she says. */
  app.post('/wake/open', async (req): Promise<WakeOpenResT> => {
    const user = requireUser(req);
    const { id, lang = user.lang } = WakeOpenReq.parse(req.body);
    const { row, payload } = await wakeItem(app, user, id, true);
    const at = new Date().toISOString();
    const read = await app.repos.inbox.markRead(user.id, row.id, at);
    if (!read) throw httpError('wake_not_found', 404);
    // U-41: he answered, so he is up: her call still to come this morning (his 「あと5分」) is called off, and her other
    // wake-ups of the day are read — none rings again later, none turns into one of her messages.
    await app.repos.alarms.answered(user.id, payload.day, at);
    // The first open of the morning's call; the snooze call and re-opening it are the same morning.
    if (!row.readAt && !payload.snooze) await app.recordEvent(user.id, 'wakeup.opened', { star: row.star });
    const alarm = await app.repos.alarms.get(user.id);
    const today = localClock(new Date(), clockOf(user.tz, alarm)).date;
    const snoozeLeft = !payload.snooze && alarm?.lastDay === payload.day && today === payload.day ? Math.max(0, WAKEUP_RULES.maxSnoozes - alarm.snoozes) : 0;
    // #57/#66: her 「明日の朝、起こしてあげる」 is kept by this very wake-up (any promise made before it rang).
    const kept = await keepWakePromise(app.repos, user.id, row.star, Date.now(), Date.parse(row.deliveredAt ?? row.dueAt));
    return {
      id: row.id, star: row.star, day: payload.day,
      line: wakeLineText(row.star, payload.lineId, lang, app.demo) ?? payload.text, lineId: payload.lineId,
      voice: wakeLineVoice(row.star, payload.lineId, app.demo),
      replies: wakeReplies(row.star, lang, app.demo),
      replyVoices: wakeReplyVoices(row.star, app.demo),
      keptPromise: kept?.text ?? null,
      snoozeLeft, snoozeMinutes: WAKEUP_RULES.snoozeMinutes,
      item: toItem(read, lang), unread: await app.repos.inbox.unread(user.id)
    };
  });

  /** 「あと5分」: she calls once more in five minutes (a new wake-up row, pushed by the tick like the first). */
  app.post('/wake/snooze', { config: { rateLimit: { max: 10, timeWindow: '10 minutes' } } }, async (req): Promise<WakeSnoozeResT> => {
    const user = requireUser(req);
    const { id } = WakeSnoozeReq.parse(req.body);
    const { row, payload } = await wakeItem(app, user, id);
    if (payload.snooze) throw httpError('snooze_used', 409);
    const alarm = await app.repos.alarms.get(user.id);
    const now = new Date();
    if (!alarm || alarm.lastDay !== payload.day || localClock(now, clockOf(user.tz, alarm)).date !== payload.day) throw httpError('wake_over', 409);
    if (alarm.snoozes >= WAKEUP_RULES.maxSnoozes) throw httpError('snooze_used', 409);
    const weather = await morningWeather(app.repos, user.id, row.star, now).catch(() => null);
    // Another line than the one that woke him: the second call should not sound like a recording.
    const line = chooseWakeLine(row.star, payload.day, weather, app.demo, payload.lineId, Math.floor(localClock(now, clockOf(user.tz, alarm)).minutes / 60));
    const dueAt = new Date(now.getTime() + WAKEUP_RULES.snoozeMinutes * 60_000).toISOString();
    const next: InboxRow = {
      id: newId('inb'), userId: user.id, star: row.star, kind: 'wakeup',
      payload: { text: localText(line.text, user.lang), lineId: line.id, day: payload.day, snooze: true, ...ringVoice(row.star, line.id, app.demo) } satisfies WakePayloadT,
      dueAt, deliveredAt: null, readAt: null, createdAt: now.toISOString()
    };
    if (!(await app.repos.alarms.snooze(user.id, payload.day, WAKEUP_RULES.maxSnoozes, next))) throw httpError('snooze_used', 409);
    // This call is answered with 「あと5分」: the next one is hers in five minutes, so this one never rings again.
    await app.repos.inbox.markRead(user.id, row.id, now.toISOString());
    return { dueAt, snoozeLeft: Math.max(0, WAKEUP_RULES.maxSnoozes - alarm.snoozes - 1), next: toItem({ ...next, deliveredAt: dueAt }, user.lang) };
  });

  /**
   * F-04: his open room rings her snoozed call itself at its time (about five minutes, not the next tick and poll):
   * delivered now, so the tick never pushes it to his phone as well. Not yet due, or already delivered: 404.
   */
  app.post('/wake/ring', { config: { rateLimit: { max: 10, timeWindow: '10 minutes' } } }, async (req): Promise<{ item: InboxItemT }> => {
    const user = requireUser(req);
    const { id } = WakeRingReq.parse(req.body);
    const { row } = await wakeItem(app, user, id, true);
    return { item: toItem(row, user.lang) };
  });
}

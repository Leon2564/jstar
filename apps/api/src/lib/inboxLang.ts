import type { FastifyInstance } from 'fastify';
import { LANGS, type Lang } from '@jstar/shared';
import type { InboxRow, Repos, UserRow } from '../db/types';
import { resolveCallName } from './bond';
import { calendarExpiry } from './calendar';
import { herLocalClock } from '@jstar/shared/herMessages';
import { promiseDueTexts, textsIn } from './inboxText';

/**
 * Her inbox as he reads it now (M16, M18): what lapsed is no longer new, and every line of hers is in his language.
 *
 * - M16: her calendar message (#61) lapses at the end of its day (lib/calendar.ts `calendarExpiry`): still unread
 *   then, it is read as of that moment, so her room does not lead with it nor offer its scene on another day. Rows
 *   from before `expiresAt` lapse at the end of the day they came on.
 * - M18: her lines are in `texts` or found again among her lines (lib/inboxText.ts). Two kinds are not: her words the
 *   model wrote (her messages, #58), in the language he had then, are re-rendered into his by one cheap call each
 *   (`app.her.restate`), only when he reads them in another language, and the result is kept on the row; her line
 *   for a promise due (#59) from before `texts` is written again from the promise.
 */

/** Model calls one read may make; the rest are shown as written this time and re-rendered on a later read. */
const RESTATE_PER_READ = 6;
/** After a failed re-render, that row and language are not tried again for this long (no call on every poll). */
const RETRY_AFTER_MS = 10 * 60_000;
const failed = new Map<string, number>();

/** The language a line of hers is written in, by its script; null when it cannot be told. */
export function writtenIn(text: string): Lang | null {
  if (/[가-힣]/.test(text)) return 'ko';
  if (/[ぁ-ゖァ-ヺ]/.test(text)) return 'ja';
  if (/[一-鿿]/.test(text)) return 'zh-Hant';
  if (/[A-Za-z]/.test(text)) return 'en';
  return null;
}

/** Whether a row lapsed (M16) by `now`, on his clock. */
export const lapsed = (row: Pick<InboxRow, 'id' | 'payload' | 'createdAt'>, tz: string | null | undefined, now: number): boolean => {
  const until = calendarExpiry(row, tz);
  return until !== null && until <= now;
};

/**
 * C-room N8: what makes two of her rows the same message — her, the day it came on his clock, and the scene it invites
 * to or the day's event it is about (a pretend day asked twice on the test site, an invitation written again). Null
 * for anything else (her wake-ups, her notes, a promise come due): those are never folded together.
 */
export function sameMessageKey(row: Pick<InboxRow, 'star' | 'kind' | 'payload' | 'createdAt'>, tz: string | null | undefined): string | null {
  if (row.kind !== 'event' && row.kind !== 'message') return null;
  const p = row.payload;
  const scene = typeof p.sceneId === 'string' ? p.sceneId : typeof p.scene === 'string' ? p.scene : null;
  const what = scene ? `scene:${scene}` : typeof p.calendar === 'string' ? `cal:${p.calendar}:${typeof p.season === 'string' ? p.season : ''}` : null;
  return what && `${row.star}|${herLocalClock(Date.parse(row.createdAt), tz).day}|${what}`;
}

/**
 * Whether an unread row is superseded (N8): the same message is there again, newer and unread — or it was answered
 * (read: 下次吧, played) after this one came, so 下次吧 sticks. A copy written after his answer stays (the test site
 * may ask its pretend day again).
 */
function superseded(row: InboxRow, all: InboxRow[], tz: string | null | undefined): boolean {
  const key = sameMessageKey(row, tz);
  if (!key) return false;
  return all.some((o) => o.id !== row.id && sameMessageKey(o, tz) === key
    && (o.readAt ? Date.parse(o.readAt) >= Date.parse(row.createdAt) : Date.parse(o.createdAt) > Date.parse(row.createdAt) || (o.createdAt === row.createdAt && o.id > row.id)));
}

/**
 * M16: his unread calendar messages past their day, read as of that moment; N8: a copy of a message that is there
 * again (or that he answered) read now. Returns the rows as they are now.
 */
export async function lapseCalendar(repos: Repos, user: Pick<UserRow, 'id' | 'tz'>, rows: InboxRow[], now = Date.now()): Promise<{ rows: InboxRow[]; changed: boolean }> {
  let changed = false;
  const out = await Promise.all(rows.map(async (r) => {
    if (r.readAt || !r.deliveredAt) return r;
    const until = calendarExpiry(r, user.tz);
    const copy = superseded(r, rows, user.tz);
    if (!copy && (until === null || until > now)) return r;
    const at = copy ? now : Math.max(until!, Date.parse(r.deliveredAt));
    const read = await repos.inbox.markRead(user.id, r.id, new Date(at).toISOString());
    changed ||= !!read;
    return read ?? r;
  }));
  return { rows: out, changed };
}

/** Whether a row's line is missing in `lang`, and how it can be had. */
function need(row: InboxRow, lang: Lang): 'restate' | 'promise' | null {
  if (textsIn(row)?.[lang]) return null;
  const text = typeof row.payload.text === 'string' ? row.payload.text.trim() : '';
  if (!text) return null;
  if (row.kind === 'promise_due' && typeof row.payload.promiseId === 'string') return 'promise';
  // Her own words (#58): written in one language, said again in his only when it is another.
  if (row.kind === 'message' && typeof row.payload.herMessage === 'string') {
    const from = typeof row.payload.lang === 'string' ? row.payload.lang : writtenIn(text);
    return from && from !== lang ? 'restate' : null;
  }
  return null;
}

/**
 * M18: her lines in `rows` that are not known in `lang` yet, made so and kept on each row (`inbox.addTexts`). Best
 * effort: a line that cannot be had now is shown as written. Returns the rows with what was added.
 */
export async function inHisLanguage(app: FastifyInstance, user: Pick<UserRow, 'id' | 'nickname' | 'tz'>, rows: InboxRow[], lang: Lang, now = Date.now()): Promise<InboxRow[]> {
  const restate = app.her?.restate;
  let calls = 0;
  const calling = new Map<string, Promise<string | null>>();
  const callName = (star: InboxRow['star']) => {
    if (!calling.has(star)) {
      calling.set(star, (async () => {
        const stage = (await app.repos.relationship.get(user.id, star))?.stage ?? 'new';
        return (await resolveCallName(app.repos, user, star, stage, undefined, lang)).callName;
      })().catch(() => null));
    }
    return calling.get(star)!;
  };
  return Promise.all(rows.map(async (r) => {
    const how = need(r, lang);
    if (!how) return r;
    const key = `${r.id}|${lang}`;
    let texts: Partial<Record<Lang, string>> | null = null;
    try {
      if (how === 'promise') {
        const p = await app.repos.promises.byId(r.payload.promiseId as string);
        if (p && p.userId === user.id) texts = promiseDueTexts(p, Date.parse(r.createdAt), user.tz);
      } else if (restate && (failed.get(key) ?? 0) <= now && calls < RESTATE_PER_READ) {
        calls++;
        const text = await restate({ star: r.star, lang, text: String(r.payload.text).trim(), callName: await callName(r.star) });
        if (text) {
          // The words as written stay under their own language, so a switch back shows them again, not a re-render.
          const from = typeof r.payload.lang === 'string' && (LANGS as readonly string[]).includes(r.payload.lang) ? r.payload.lang as Lang : writtenIn(String(r.payload.text));
          texts = { ...(from ? { [from]: String(r.payload.text) } : {}), [lang]: text };
        } else {
          failed.set(key, now + RETRY_AFTER_MS);
        }
      }
    } catch (err) {
      failed.set(key, now + RETRY_AFTER_MS);
      app.log.warn({ err, id: r.id }, 'inbox_restate_failed');
    }
    if (failed.size > 5000) for (const [k, until] of failed) if (until <= now) failed.delete(k);
    if (!texts) return r;
    await app.repos.inbox.addTexts(user.id, r.id, texts);
    const kept = r.payload.texts && typeof r.payload.texts === 'object' ? r.payload.texts as Record<string, string> : {};
    return { ...r, payload: { ...r.payload, texts: { ...kept, ...texts } } };
  }));
}

/** Her rows as he reads them now: lapsed calendar messages read (M16), every line in his language (M18). */
export async function asHeReadsThem(app: FastifyInstance, user: Pick<UserRow, 'id' | 'nickname' | 'tz'>, rows: InboxRow[], lang: Lang, now = Date.now()): Promise<{ rows: InboxRow[]; changed: boolean }> {
  const { rows: current, changed } = await lapseCalendar(app.repos, user, rows, now);
  return { rows: await inHisLanguage(app, user, current, lang, now), changed };
}

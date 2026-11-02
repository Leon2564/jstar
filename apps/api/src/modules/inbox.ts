import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { InboxDemoReq, zStarId, type InboxItemT, type InboxReadResT, type InboxResT, type InboxVoiceResT } from '@jstar/shared';
import { httpError, requireUser } from '../app';
import type { InboxRow } from '../db/types';
import { newId } from '../lib/crypto';
import { keepPromise, toPromiseItem } from '../lib/promises';
import { herMessageOpened } from '../lib/herMessages';
import { payloadIn } from '../lib/inboxText';
import { asHeReadsThem, inHisLanguage, lapseCalendar, lapsed } from '../lib/inboxLang';
import { hearsHer, signLine } from '../lib/voiceLines';

/** The list is for the companion home; older items stay in the table but are not paged through (#49). */
const LIST_LIMIT = 50;
const IdParam = z.object({ id: z.string().min(1).max(64) });
/** API-only, so it stays out of the web bundle. */
/** `ids`: only these of hers (her room's ② reads what he saw — never an invitation he has not); without, all of them. */
const ReadStarReq = z.object({ star: zStarId, ids: z.array(z.string().min(1).max(64)).min(1).max(50).optional() });

/**
 * U-29 / M18: her lines in his language as he reads them (lib/inboxText.ts). M16: a calendar message past its day
 * names no scene any more — its moment is over.
 */
const toItem = (r: InboxRow, lang: string, tz: string | null = null, now = Date.now()): InboxItemT => {
  const payload = payloadIn(r, lang);
  const { sceneId: _over, ...rest } = payload;
  return {
    id: r.id, star: r.star, kind: r.kind, payload: lapsed(r, tz, now) ? rest : payload,
    deliveredAt: r.deliveredAt ?? r.dueAt, readAt: r.readAt, createdAt: r.createdAt
  };
};

export async function registerInbox(app: FastifyInstance) {
  /** Her delivered items, unread first; rows still waiting for their time are never shown. */
  app.get('/', async (req): Promise<InboxResT> => {
    const user = requireUser(req);
    // The count after what lapsed was read (M16).
    const { rows } = await asHeReadsThem(app, user, await app.repos.inbox.forUser(user.id, LIST_LIMIT), user.lang);
    return { items: rows.map((r) => toItem(r, user.lang, user.tz)), unread: await app.repos.inbox.unread(user.id) };
  });

  /**
   * Opening an item reads it (the badge goes down); opening it again changes nothing. Her `promise_due` line opened
   * within the promise's window is her keeping it (#59): the line is her opening, and the promise is kept.
   */
  app.post('/:id/read', async (req): Promise<InboxReadResT> => {
    const user = requireUser(req);
    const { id } = IdParam.parse(req.params);
    const now = Date.now();
    const readAt = new Date(now).toISOString();
    const read = await app.repos.inbox.markRead(user.id, id, readAt);
    if (!read) throw httpError('not_found', 404);
    const [row] = (await asHeReadsThem(app, user, [read], user.lang, now)).rows;
    // Her message (#58) opened for the first time becomes her line in the conversation — in his language (M18).
    await herMessageOpened(app.repos, { ...row, payload: payloadIn(row, user.lang) }, readAt);
    const promiseId = row.kind === 'promise_due' && typeof row.payload.promiseId === 'string' ? row.payload.promiseId : null;
    const found = promiseId ? await app.repos.promises.byId(promiseId) : null;
    const promise = found && found.userId === user.id ? ((await keepPromise(app.repos, found, now)) ?? (await app.repos.promises.byId(found.id))) : null;
    return { item: toItem(row, user.lang, user.tz, now), unread: await app.repos.inbox.unread(user.id), ...(promise ? { promise: toPromiseItem(promise, user.lang) } : {}) };
  });

  /**
   * N-44: he opened (or left) her chat — every delivered line of hers still unread is read at once, each as opening it
   * would (her messages join the conversation, a promise line in its window is kept). One request, not one per line:
   * per-line reads were cut short (the global rate limit, a page left mid-way) and her badge stayed.
   */
  app.post('/read-star', { config: { rateLimit: { max: 60, timeWindow: '1 minute' } } }, async (req): Promise<InboxResT> => {
    const user = requireUser(req);
    const { star, ids } = ReadStarReq.parse(req.body);
    const only = ids ? new Set(ids) : null;
    const now = Date.now();
    const readAt = new Date(now).toISOString();
    // QA #12: her invitations (an item naming a scene) are read when he opens or answers them, never in passing with
    // the rest; named in `ids` (he saw it), they are read like any other.
    const invitation = (r: { payload: Record<string, unknown> }) => typeof r.payload.scene === 'string' || typeof r.payload.sceneId === 'string';
    // M16: what lapsed is read as of its day first, so it is not read "now" with the rest; M18: what is read now
    // joins the conversation in his language.
    const mine = (await lapseCalendar(app.repos, user, (await app.repos.inbox.forUser(user.id, 500)).filter((r) => r.star === star), now)).rows;
    const unread = await inHisLanguage(app, user, mine.filter((r) => !r.readAt && (only ? only.has(r.id) : !invitation(r))), user.lang, now);
    for (const r of unread) {
      const row = await app.repos.inbox.markRead(user.id, r.id, readAt);
      if (!row) continue;
      await herMessageOpened(app.repos, { ...row, payload: payloadIn(r, user.lang) }, readAt);
      const promiseId = row.kind === 'promise_due' && typeof row.payload.promiseId === 'string' ? row.payload.promiseId : null;
      const found = promiseId ? await app.repos.promises.byId(promiseId) : null;
      if (found && found.userId === user.id) await keepPromise(app.repos, found, now);
    }
    const [items, left] = await Promise.all([app.repos.inbox.forUser(user.id, LIST_LIMIT), app.repos.inbox.unread(user.id)]);
    return { items: items.map((r) => toItem(r, user.lang, user.tz, now)), unread: left };
  });

  /**
   * #13: her message as a voice note. Only her own words, as he has them (one of his delivered items, its text), signed
   * for him like her chat reply, so `POST /v1/tts` speaks exactly that in her voice — on demand when he plays it, never
   * at the tick; every second is charged to his voice minutes there (§13.6). Not his to hear (no vendor, no voice of
   * hers, his role): `subtitle`, and the web shows no voice note.
   */
  app.post('/:id/voice', { config: { rateLimit: { max: 30, timeWindow: '1 minute' } } }, async (req): Promise<InboxVoiceResT> => {
    const user = requireUser(req);
    const { id } = IdParam.parse(req.params);
    const found = await app.repos.inbox.mine(user.id, id);
    const row = found ? (await asHeReadsThem(app, user, [found], user.lang)).rows[0] : null;
    // Her line as he reads it (U-29 / M18: in his language).
    const shown = row ? payloadIn(row, user.lang).text : null;
    const text = typeof shown === 'string' ? shown.trim() : '';
    if (!row || !text) throw httpError('not_found', 404);
    if (!hearsHer(app, user, row.star)) return { mode: 'subtitle' };
    return { mode: 'voice', line: text, sig: signLine(user.id, row.star, text) };
  });

  /** Demo mode only: a message from her to the caller, delivered by the next tick after `inMinutes`. */
  app.post('/demo', async (req) => {
    if (!app.demo) throw httpError('not_found', 404);
    const user = requireUser(req);
    const { star, text, inMinutes } = InboxDemoReq.parse(req.body);
    const now = Date.now();
    const row: InboxRow = {
      id: newId('inb'), userId: user.id, star, kind: 'message', payload: { text }, dueAt: new Date(now + inMinutes * 60_000).toISOString(),
      deliveredAt: null, readAt: null, createdAt: new Date(now).toISOString()
    };
    await app.repos.inbox.add(row);
    return { id: row.id, dueAt: row.dueAt };
  });
}

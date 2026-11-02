import type { FastifyInstance } from 'fastify';
import { LINES } from '@jstar/shared/lines';
import {
  localText, PromiseCreateReq, PromiseDemoReq, PromiseTonightReq, PromisesQuery,
  type Lang, type PromiseCreateResT, type PromisesResT
} from '@jstar/shared';
import { httpError, requireUser } from '../app';
import { newPromise, proposalFor, proposalLine, toPromiseItem } from '../lib/promises';
import { inviteFor } from '../lib/sceneTriggers';

/**
 * Promises (#59, docs/requirements.md §11.4): the home card's next promise, her proposal for the next time, and his
 * 「約束する」. Keeping and missing happen elsewhere: her greeting and opening her inbox line (lib/promises.ts), and
 * the tick (jobs/duePromises.ts).
 */
export async function registerPromises(app: FastifyInstance) {
  app.get('/', async (req): Promise<PromisesResT> => {
    const user = requireUser(req);
    const { star, lang: asked } = PromisesQuery.parse(req.query);
    const lang: Lang = asked ?? user.lang;
    const open = await app.repos.promises.open(user.id);
    const proposal = star && !open.some((p) => p.star === star) ? proposalFor(star, lang, Date.now(), app.demo) : null;
    return { promises: open.map((p) => toPromiseItem(p, lang)), proposal };
  });

  /** He said yes to her proposal: the promise is made now, due as her line says ("+1d" from now). */
  app.post('/', { config: { rateLimit: { max: 20, timeWindow: '1 minute' } } }, async (req, reply): Promise<PromiseCreateResT> => {
    const user = requireUser(req);
    const { star, lineId, lang: asked } = PromiseCreateReq.parse(req.body);
    const lang: Lang = asked ?? user.lang;
    const now = Date.now();
    const line = proposalLine(star, lineId, lang, now, app.demo);
    if (!line) throw httpError('unknown_line', 404);
    const row = newPromise({ userId: user.id, star, text: line.text, dueAt: line.dueAt, kind: line.kind, source: 'proposal', lang }, now);
    if (!(await app.repos.promises.create(row))) throw httpError('promise_open', 409);
    reply.status(201);
    return { promise: toPromiseItem(row, lang) };
  });

  /**
   * C-room N1: 「今晚見」 — his yes to her invitation for a scene that cannot start now. The time is worked out here again
   * (lib/sceneTriggers.ts `inviteFor`: well inside the next stretch her hour and routine allow), a promise of that
   * scene is made for then, and her invitation is read. Her greeting keeps it in its window and leads into the scene;
   * the tick reminds him when it is due (jobs/duePromises.ts). The same promise again (a second tap) is returned as it is.
   */
  app.post('/tonight', { config: { rateLimit: { max: 20, timeWindow: '1 minute' } } }, async (req, reply): Promise<PromiseCreateResT> => {
    const user = requireUser(req);
    const { star, sceneId, inboxId, lang: asked } = PromiseTonightReq.parse(req.body);
    const lang: Lang = asked ?? user.lang;
    const now = Date.now();
    const read = async () => { if (inboxId) await app.repos.inbox.markRead(user.id, inboxId, new Date(now).toISOString()); };
    const open = (await app.repos.promises.open(user.id, star))[0];
    if (open?.kind === 'scene' && open.sceneId === sceneId) { await read(); return { promise: toPromiseItem(open, lang) }; }
    const invite = await inviteFor(app, user, star, sceneId, now);
    if (!invite || invite.ready || !invite.dueAt) throw httpError('not_promisable', 409);
    const row = newPromise({ userId: user.id, star, text: localText(invite.title, lang), dueAt: invite.dueAt, kind: 'scene', source: 'proposal', lang, sceneId }, now);
    if (!(await app.repos.promises.create(row))) throw httpError('promise_open', 409);
    await read();
    reply.status(201);
    return { promise: toPromiseItem(row, lang) };
  });

  /** Demo mode only: a promise with her due in `inMinutes`, so the tick, the push and keeping can be tried today. */
  app.post('/demo', async (req, reply): Promise<PromiseCreateResT> => {
    if (!app.demo) throw httpError('not_found', 404);
    const user = requireUser(req);
    const { star, inMinutes, lang: asked } = PromiseDemoReq.parse(req.body);
    const lang: Lang = asked ?? user.lang;
    const now = Date.now();
    // Her second proposal line (a scene or an evening together), made "yesterday" so the push reads as it will.
    const line = LINES[star].promises[1];
    const text = localText(line.promise, lang);
    const row = newPromise({ userId: user.id, star, text, dueAt: new Date(now + inMinutes * 60_000).toISOString(), kind: line.kind, source: 'proposal', lang }, now - 86_400_000);
    if (!(await app.repos.promises.create(row))) throw httpError('promise_open', 409);
    reply.status(201);
    return { promise: toPromiseItem(row, lang) };
  });
}

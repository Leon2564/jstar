import type { FastifyInstance } from 'fastify';
import { HerMessageDemoReq, HerMessageSettings, type HerMessageSettingsT } from '@jstar/shared';
import { herLocalClock } from '@jstar/shared/herMessages';
import { httpError, requireUser } from '../app';
import { newId } from '../lib/crypto';
import { favouriteOf } from '../lib/herMessages';

/** Her messages (#58, docs/requirements.md §11.3): his setting, and in demo mode a message on demand. */
export async function registerHerMessages(app: FastifyInstance) {
  app.get('/settings', async (req): Promise<HerMessageSettingsT> => {
    const user = requireUser(req);
    return { mode: await app.repos.herMessages.mode(user.id) };
  });

  /** Takes effect at once: the send job checks the setting again before each message, planned or not. */
  app.put('/settings', async (req): Promise<HerMessageSettingsT> => {
    const user = requireUser(req);
    const { mode } = HerMessageSettings.parse(req.body);
    await app.repos.herMessages.setMode(user.id, mode, new Date().toISOString());
    return { mode };
  });

  /**
   * Demo mode only: her message of `kind` for the caller, due now — the next tick writes it (the model, or her
   * fallback line) and delivers it, badge and push, so the whole path can be tried without waiting for a window.
   */
  app.post('/demo', async (req, reply) => {
    if (!app.demo) throw httpError('not_found', 404);
    const user = requireUser(req);
    const { kind, star: asked } = HerMessageDemoReq.parse(req.body ?? {});
    const stars = (await app.repos.relationship.forUser(user.id)).filter((r) => r.lastDay).map((r) => ({ star: r.star, lastDay: r.lastDay!, daysTogether: r.daysTogether }));
    const star = asked ?? (stars.length ? favouriteOf(stars) : 'mahiro');
    const now = Date.now();
    const at = new Date(now).toISOString();
    await app.repos.herMessages.replan({
      userId: user.id, day: herLocalClock(now, user.tz).day, kind, star, inboxId: newId('inb'), dueAt: at,
      status: 'planned', triedAt: null, sentAt: null, source: null, reason: 'demo', createdAt: at
    });
    return reply.status(202).send({ kind, star, dueAt: at });
  });
}

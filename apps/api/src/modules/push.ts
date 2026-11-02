import type { FastifyInstance } from 'fastify';
import { PushSubscribeReq, PushTestReq, PushUnsubscribeReq } from '@jstar/shared';
import { httpError, requireUser } from '../app';
import { herPush } from '../lib/push';

/** A zone name the runtime knows ('Asia/Tokyo'); anything else is dropped rather than stored. */
function validTz(tz: string | undefined): string | null {
  if (!tz) return null;
  try { return new Intl.DateTimeFormat('en', { timeZone: tz }).resolvedOptions().timeZone; } catch { return null; }
}

/** What she says in the test notification: short, and nothing about the user. */
const TEST_LINE = { ja: 'ねえ、ちゃんと届いてる？', 'zh-Hant': '欸，有收到嗎？', en: 'Hey, did this reach you?', ko: '저기, 잘 도착했어?' } as const;

export async function registerPush(app: FastifyInstance) {
  // Push off (no VAPID keys): the web app never asks, and anything that still calls gets a stable code.
  const requirePush = () => { if (!app.vapid) throw httpError('push_disabled', 404); };

  app.post('/subscribe', { config: { rateLimit: { max: 20, timeWindow: '10 minutes' } } }, async (req) => {
    const user = requireUser(req);
    requirePush();
    const { endpoint, keys, tz } = PushSubscribeReq.parse(req.body);
    await app.repos.push.subscribe({ endpoint, userId: user.id, keys, tz: validTz(tz), createdAt: new Date().toISOString() });
    return { ok: true as const };
  });

  /** Turning push off works even when push is disabled server-side, so a user can always clean up. */
  app.delete('/subscribe', async (req) => {
    const user = requireUser(req);
    const { endpoint } = PushUnsubscribeReq.parse(req.body ?? {});
    return { ok: true as const, removed: await app.repos.push.unsubscribe(user.id, endpoint) };
  });

  /**
   * Test site and `npm run demo` only: one notification from her to the caller, so the lock-screen path can be
   * checked end to end before the inbox delivery (#49) sends real ones.
   */
  app.post('/test', { config: { rateLimit: { max: 5, timeWindow: '10 minutes' } } }, async (req) => {
    if (!app.demo) throw httpError('not_found', 404);
    const user = requireUser(req);
    requirePush();
    const { star } = PushTestReq.parse(req.body ?? {});
    return app.sendPush(user.id, herPush(star, user.lang, TEST_LINE[user.lang] ?? TEST_LINE.ja, { tag: `test-${star}` }));
  });
}

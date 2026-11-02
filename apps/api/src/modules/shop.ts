import type { FastifyInstance } from 'fastify';
import type { z } from 'zod';
import { PassRes, RULES, TopUpReq, TopUpRes, extendPass } from '@jstar/shared';
import { httpError, requireUser } from '../app';
import { newId } from '../lib/crypto';

/**
 * Point packs and the monthly pass (docs/requirements.md §4, §6).
 * Production: these endpoints only create a checkout session; the balance moves in the payment
 * provider's signed webhook. In demo mode the purchase is credited immediately.
 */
export async function registerShop(app: FastifyInstance) {
  // v1.0 is a free launch (docs: 正式产品决策 #8): no purchases until payments are integrated.
  app.addHook('preHandler', async () => { if (!RULES.shopOpen) throw httpError('shop_closed', 404); });

  app.post('/points', async (req): Promise<z.infer<typeof TopUpRes>> => {
    const user = requireUser(req);
    if (!app.demo) throw httpError('use_checkout_flow', 501);
    const { points } = TopUpReq.parse(req.body);
    const pack = RULES.pointPacks.find((p) => p.points === points);
    if (!pack) throw httpError('unknown_pack', 400);
    const updated = await app.repos.users.adjustWallet(user.id, { points: pack.points });
    await app.repos.audit.add({ id: newId('aud'), actorId: user.id, action: 'shop.points.demo', target: user.id, meta: { ...pack }, createdAt: new Date().toISOString() });
    return { checkoutUrl: null, points: updated!.points };
  });

  app.post('/pass', async (req): Promise<z.infer<typeof PassRes>> => {
    const user = requireUser(req);
    if (!app.demo) throw httpError('use_checkout_flow', 501);
    const updated = await app.repos.users.update(user.id, { passUntil: extendPass(user.passUntil, RULES.passDays) });
    await app.repos.audit.add({ id: newId('aud'), actorId: user.id, action: 'shop.pass.demo', target: user.id, meta: { passUntil: updated.passUntil }, createdAt: new Date().toISOString() });
    return { checkoutUrl: null, passUntil: updated.passUntil! };
  });
}

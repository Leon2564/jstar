import type { FastifyInstance, FastifyRequest } from 'fastify';
import { httpError } from '../app';
import { env } from '../env';
import { JOBS } from '../jobs';
import { safeEqual } from '../lib/crypto';
import { runTick } from '../lib/tick';

/**
 * Operations the platform calls, never a visitor. On Cloudflare the Worker answers every public /v1/ops/* request
 * with 404 itself; only its Cron Trigger reaches this route, with the internal key (AGENT_API_KEY, the same key
 * that guards /v1/ops/restart). Demo mode (`npm run demo`) takes the call without a key so a tick can be run by hand.
 */
function allowed(app: FastifyInstance, req: FastifyRequest): boolean {
  if (app.demo) return true;
  const h = req.headers.authorization;
  return typeof h === 'string' && safeEqual(h, `Bearer ${env.AGENT_API_KEY}`);
}

export async function registerOps(app: FastifyInstance) {
  app.post('/tick', async (req) => {
    // 404, not 401: the route should look absent to anyone without the key.
    if (!allowed(app, req)) throw httpError('not_found', 404);
    const res = await runTick(app.repos, JOBS, { log: req.log, sendPush: app.sendPush, weather: app.weather ?? undefined, demo: app.demo, her: app.her ?? undefined, memoryStore: app.memoryStore ?? undefined, flushMemory: app.flushMemory ?? undefined });
    req.log.info({ tick: res }, 'tick');
    return res;
  });
}

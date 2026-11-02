import type { FastifyInstance } from 'fastify';
import { RULES, type DeviceResT } from '@jstar/shared';
import { requireDevice } from '../app';

export async function registerDevice(app: FastifyInstance) {
  /** A visitor's state as the server sees it: the browser cache is replaced by this on load. */
  app.get('/', async (req): Promise<DeviceResT> => {
    const row = await app.repos.devices.get(requireDevice(req));
    const copies = new Map<string, number>();
    for (const id of row.redemptions.flatMap((r) => r.cardIds)) copies.set(id, (copies.get(id) ?? 0) + 1);
    return {
      trialLeft: Math.max(0, RULES.trialMessages - row.trialUsed),
      cards: [...copies].map(([cardId, n]) => ({ cardId, copies: n })),
      pendingPassDays: row.redemptions.reduce((n, r) => n + r.trialDays, 0)
    };
  });
}

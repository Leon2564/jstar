import type { FastifyInstance } from 'fastify';
import {
  BondQuery, CallAnswerReq, CallNameSetReq, cleanCallName,
  type BondResT, type CallAnswerResT, type CallNameSettingsT
} from '@jstar/shared';
import { httpError, requireUser } from '../app';
import { bonds } from '../lib/bond';

/**
 * What she calls him, and how she changes for him (#56, docs/requirements.md §10.3): her question when the relationship
 * reached a new way to call him, his answer, the name he asks all five to use, and how often he praised her looks.
 */
export async function registerBond(app: FastifyInstance) {
  const bond = bonds(app);

  app.get('/', async (req): Promise<BondResT> => {
    const user = requireUser(req);
    const { star, lang } = BondQuery.parse(req.query);
    return bond.view(user, star, lang ?? user.lang);
  });

  app.post('/call-name', { config: { rateLimit: { max: 20, timeWindow: '1 minute' } } }, async (req): Promise<CallAnswerResT> => {
    const user = requireUser(req);
    const { star, to, accept, lang } = CallAnswerReq.parse(req.body);
    const done = await bond.answer(user, star, to, accept, lang ?? user.lang);
    if (!done) throw httpError('not_asking', 409);
    return done;
  });

  app.get('/name', async (req): Promise<CallNameSettingsT> => ({ name: await app.repos.bond.name(requireUser(req).id) }));

  /** Takes effect from her next line; the persona service's safety filter checks the words before a prompt uses them. */
  app.put('/name', { config: { rateLimit: { max: 20, timeWindow: '1 minute' } } }, async (req): Promise<CallNameSettingsT> => {
    const user = requireUser(req);
    const { name: raw } = CallNameSetReq.parse(req.body);
    const clear = raw === null || !raw.trim();
    const name = clear ? null : cleanCallName(raw);
    if (!clear && !name) throw httpError('invalid_name', 400);
    await app.repos.bond.setName(user.id, name, new Date().toISOString());
    return { name };
  });
}

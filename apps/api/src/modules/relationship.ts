import type { FastifyInstance } from 'fastify';
import { RelationshipDemoReq, type RelationshipResT, type RelationshipViewT } from '@jstar/shared';
import { httpError, requireUser } from '../app';
import { confessions } from '../lib/confession';
import { relationships } from '../lib/relationship';
import { bonds } from '../lib/bond';

/** Relationship stages (#54): what the companion-home panel shows. Stages only ever move on the server. */
export async function registerRelationship(app: FastifyInstance) {
  const rel = relationships(app);
  const confession = confessions(app);
  const bond = bonds(app);

  /** Her confession (#55) rides along while the stage waits for it: the home opens on it, hints, or offers it. */
  const withConfession = async (userId: string, v: RelationshipViewT): Promise<RelationshipViewT> =>
    v.stage === 'confession_ready' ? { ...v, confession: await confession.status(userId, v.star) } : v;

  /** All five talents; each line is independent. Her hint is a key the web says in her words, never a number. */
  app.get('/', async (req): Promise<RelationshipResT> => {
    const user = requireUser(req);
    return { talents: await Promise.all((await rel.all(user.id)).map((v) => withConfession(user.id, v))) };
  });

  /**
   * Demo mode only: sets the stage with her, so the panel, her confession (#55) and her asking to call him differently
   * (#56) can be tried today. Her confession starts over each time (her message is sent again by the next tick).
   */
  app.post('/demo', async (req): Promise<RelationshipViewT> => {
    if (!app.demo) throw httpError('not_found', 404);
    const user = requireUser(req);
    const { star, stage } = RelationshipDemoReq.parse(req.body);
    await app.repos.confessions.reset(user.id, star);
    // Moved back below a change she already asked about: she may ask again, so each call-name change can be tried (#56).
    await bond.afterDemo(user.id, star, stage);
    return withConfession(user.id, await rel.view(user.id, star, await rel.demoSet(user.id, star, stage)));
  });
}


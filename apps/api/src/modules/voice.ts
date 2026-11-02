import type { FastifyInstance } from 'fastify';
import { VoiceExtendReq, type VoiceExtendResT, type VoiceStateT } from '@jstar/shared';
import { requireUser } from '../app';
import { extendVoice, ttsStarsOf, voiceOf } from '../lib/voice';

/**
 * Voice minutes (#74): `GET /v1/voice` (his voice time today) and `POST /v1/voice/extend` (+30 minutes for points,
 * idempotent per request id). No real money in v1.1 (#47).
 */
export async function registerVoice(app: FastifyInstance) {
  app.get('/', async (req): Promise<VoiceStateT> => voiceOf(app.repos, requireUser(req), ttsStarsOf(app)));

  app.post('/extend', { config: { rateLimit: { max: 20, timeWindow: '1 minute' } } }, async (req): Promise<VoiceExtendResT> => {
    const user = requireUser(req);
    const { requestId } = VoiceExtendReq.parse(req.body);
    return extendVoice(app, user, `ext:${requestId}`);
  });
}

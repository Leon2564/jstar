import type { FastifyInstance } from 'fastify';
import { AsrQuery, VOICE_INPUT, type AsrResT } from '@jstar/shared';
import { httpError, requireUser } from '../app';
import { AsrError } from '../lib/asr';

/** What MediaRecorder produces on the browsers that need this route (Firefox: Ogg/WebM Opus; iOS Safari: MP4 AAC). */
const AUDIO = /^audio\/(webm|ogg|mp4|x-m4a|aac|mpeg|wav|x-wav)$/;

/**
 * `POST /v1/asr` (#72): his recorded words as text, for browsers without speech recognition of their own. Members
 * only, rate-limited, and free: the text then goes through the normal chat or scene path, which is what counts
 * against the daily messages. A failed recognition costs nothing — the web app asks him to say it again.
 */
export async function registerAsr(app: FastifyInstance) {
  // Audio is the one body bigger than the API's 64 KB default; only this route accepts it, raw.
  app.addContentTypeParser(/^audio\//, { parseAs: 'buffer', bodyLimit: VOICE_INPUT.maxBytes }, (_req, body, done) => done(null, body));
  // Stable machine codes for the two ways a recording is refused before it reaches the handler.
  app.setErrorHandler((err, _req, reply) => {
    if (err.code === 'FST_ERR_CTP_BODY_TOO_LARGE') return reply.status(413).send({ error: 'audio_too_large' });
    if (err.code === 'FST_ERR_CTP_INVALID_MEDIA_TYPE') return reply.status(415).send({ error: 'unsupported_audio' });
    // Not an internal error: the recogniser is off or failed, and the web app says so (or hides the mic).
    if (err.statusCode === 503 && /^asr_/.test(err.message)) return reply.status(503).send({ error: err.message });
    throw err;
  });

  app.post('/', { bodyLimit: VOICE_INPUT.maxBytes, config: { rateLimit: { max: 20, timeWindow: '1 minute' } } }, async (req): Promise<AsrResT> => {
    requireUser(req);
    if (!app.transcribe) throw httpError('asr_unavailable', 503);
    const mime = String(req.headers['content-type'] ?? '').split(';')[0].trim().toLowerCase();
    if (!AUDIO.test(mime) || !Buffer.isBuffer(req.body)) throw httpError('unsupported_audio', 415);
    if (!req.body.length) throw httpError('empty_audio', 400);
    const { lang } = AsrQuery.parse(req.query ?? {});
    try {
      return await app.transcribe(req.body, mime, lang);
    } catch (e) {
      throw httpError(e instanceof AsrError ? e.code : 'asr_failed', 503);
    }
  });
}

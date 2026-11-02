import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { CONFESSION_RULES, ConfessionAudioQuery, type ConfessionAudioResT, type ConfessionMemoriesResT, type ConfessionMemoryT } from '@jstar/shared';
import { httpError, requireUser } from '../app';
import type { ConfessionVoiceRow } from '../db/types';

/** What MediaRecorder produces (Chrome/Firefox: WebM or Ogg Opus; iOS Safari: MP4 AAC), as for `POST /v1/asr`. */
const AUDIO = /^audio\/(webm|ogg|mp4|x-m4a|aac|mpeg|wav|x-wav)$/;
const IdParam = z.object({ id: z.string().min(1).max(64) });

const toMemory = (v: ConfessionVoiceRow): ConfessionMemoryT => ({
  memoryId: v.memoryId, star: v.star, transcript: v.transcript, audio: v.audioType !== null, createdAt: v.createdAt
});

/**
 * The memory of his answer to her confession (#55; storage rules: docs/compliance-jp.md §7.3). His words are kept with
 * the memory card from the moment he says yes; the recording of his voice only when he chose to keep it, sent once
 * from his browser after the yes, with `consent=yes`. Only he can list, play or delete it; the account deletion
 * removes all of it. Where the recording lives (the memory store, or base64 in its row before one is bound) is
 * app.memoryFiles' business (#51, lib/memoryAssets.ts); his export links to it (modules/memories.ts).
 */
export async function registerConfession(app: FastifyInstance) {
  // The recording is the one large body here: only this plugin accepts audio, raw, up to the kept size.
  app.addContentTypeParser(/^audio\//, { parseAs: 'buffer', bodyLimit: CONFESSION_RULES.voiceMaxBytes }, (_req, body, done) => done(null, body));
  app.setErrorHandler((err, _req, reply) => {
    if (err.code === 'FST_ERR_CTP_BODY_TOO_LARGE') return reply.status(413).send({ error: 'audio_too_large' });
    if (err.code === 'FST_ERR_CTP_INVALID_MEDIA_TYPE') return reply.status(415).send({ error: 'unsupported_audio' });
    throw err;
  });

  app.get('/memories', async (req): Promise<ConfessionMemoriesResT> => {
    const user = requireUser(req);
    return { memories: (await app.repos.confessions.voices(user.id)).map(toMemory) };
  });

  /** Keeps the recording of his yes, once, with the time he asked for it. No consent, no storage. */
  app.put('/memories/:id/audio', { bodyLimit: CONFESSION_RULES.voiceMaxBytes, config: { rateLimit: { max: 10, timeWindow: '1 minute' } } }, async (req): Promise<ConfessionAudioResT> => {
    const user = requireUser(req);
    const { id } = IdParam.parse(req.params);
    const parsed = ConfessionAudioQuery.safeParse(req.query ?? {});
    if (!parsed.success) throw httpError('consent_required', 400);
    const mime = String(req.headers['content-type'] ?? '').split(';')[0].trim().toLowerCase();
    if (!AUDIO.test(mime) || !Buffer.isBuffer(req.body)) throw httpError('unsupported_audio', 415);
    if (!req.body.length) throw httpError('empty_audio', 400);
    const memory = await app.repos.confessions.voice(user.id, id);
    if (!memory) throw httpError('not_found', 404);
    if (memory.audioType) throw httpError('audio_exists', 409);
    if (!(await app.memoryFiles.keepConfessionAudio(user.id, id, mime, req.body, new Date().toISOString()))) throw httpError('audio_exists', 409);
    return { memory: toMemory((await app.repos.confessions.voice(user.id, id))!) };
  });

  /** His recording, to him alone; never cached by anything in between. */
  app.get('/memories/:id/audio', async (req, reply) => {
    const user = requireUser(req);
    const { id } = IdParam.parse(req.params);
    const kept = await app.memoryFiles.confessionAudio(user.id, id);
    if (!kept) throw httpError('not_found', 404);
    reply.header('cache-control', 'private, no-store').type(kept.type);
    return reply.send(kept.bytes);
  });

  /** Deletes the recording; his words and the memory card stay. */
  app.delete('/memories/:id/audio', async (req): Promise<ConfessionAudioResT> => {
    const user = requireUser(req);
    const { id } = IdParam.parse(req.params);
    if (!(await app.memoryFiles.forgetConfessionAudio(user.id, id))) throw httpError('not_found', 404);
    return { memory: toMemory((await app.repos.confessions.voice(user.id, id))!) };
  });
}

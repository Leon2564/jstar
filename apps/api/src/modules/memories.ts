import type { FastifyInstance, FastifyRequest } from 'fastify';
import { MemoryFileQuery, STAR_IDS, jstDay, type MemoryExportT, type MemoryFileLinkT } from '@jstar/shared';
import { MEMORY_RULES, exportFileName, stillPosterPath } from '@jstar/shared/memories';
import { httpError, requireUser } from '../app';
import { env } from '../env';
import { newId } from '../lib/crypto';
import { fileLink, linkValid } from '../lib/memoryAssets';
import type { UserRow } from '../db/types';

/** A recording's file name inside a download: the type's own extension, so any player opens it. */
const EXT: Record<string, string> = { 'audio/webm': 'webm', 'audio/ogg': 'ogg', 'audio/mp4': 'm4a', 'audio/x-m4a': 'm4a', 'audio/aac': 'aac', 'audio/mpeg': 'mp3', 'audio/wav': 'wav', 'audio/x-wav': 'wav' };

/**
 * A scene card's still (#51): the poster of the clip on screen when it was made, as the site serves it
 * (@jstar/shared/memories `stillPosterPath`). Public like the clip, so the link does not expire; null for a card
 * without one, or a name that is not a media id.
 */
export function stillLink(origin: string, still: string | null | undefined): MemoryFileLinkT | null {
  if (!still || !/^[a-z0-9-]{3,80}$/.test(still)) return null;
  return { type: 'image/jpeg', url: `${origin}${stillPosterPath(still)}`, expiresAt: null };
}

/** Where his links point: the API's public origin (same as the site's on Cloudflare), else the one he came in on. */
const originOf = (req: FastifyRequest) => env.PUBLIC_API_ORIGIN || `${req.protocol}://${req.headers.host ?? 'localhost'}`;

/**
 * His memories are his (#51, docs/compliance-jp.md §7.6): he can take everything with him at any time — the memory
 * cards, his answer to her confession with the recording, his promises with her and his chats — as one JSON file.
 * Files are signed links that work without a session for MEMORY_RULES.linkTtlMs; once a JST day, which keeps an
 * export from being a way to hammer the database.
 */
export async function registerMemories(app: FastifyInstance) {
  const repos = app.repos;

  async function build(user: UserRow, origin: string, now: Date): Promise<MemoryExportT> {
    const [memories, voices, promises, chats] = await Promise.all([
      repos.memories.forUser(user.id),
      repos.confessions.voices(user.id),
      repos.promises.forUser(user.id),
      Promise.all(STAR_IDS.map(async (star) => ({ star, messages: await repos.messages.recent(user.id, star, MEMORY_RULES.exportChatPerTalent) })))
    ]);
    return {
      format: 'jstar-memories',
      version: 1,
      exportedAt: now.toISOString(),
      account: { id: user.id, nickname: user.nickname, email: user.email, lang: user.lang, createdAt: user.createdAt },
      memories: memories.map((m) => ({ id: m.id, star: m.star, kind: m.kind ?? 'chat', title: m.title, sceneId: m.sceneId ?? null, still: stillLink(origin, m.still), createdAt: m.createdAt })),
      confessions: voices.map((v) => ({
        memoryId: v.memoryId, star: v.star, transcript: v.transcript, createdAt: v.createdAt, keptAt: v.consentedAt,
        audio: v.audioType ? fileLink(env.JWT_SECRET, origin, { u: user.id, kind: 'confession', id: v.memoryId }, v.audioType, now.getTime()) : null
      })),
      promises: promises.map((p) => ({ id: p.id, star: p.star, text: p.text, kind: p.kind, status: p.status, madeAt: p.madeAt, dueAt: p.dueAt, keptAt: p.keptAt })),
      chats: chats.filter((c) => c.messages.length).map((c) => ({ star: c.star, messages: c.messages.map((m) => ({ role: m.role, text: m.text, createdAt: m.createdAt })) }))
    };
  }

  /** Everything, once a JST day: a second request that day is 429 `export_limit` (the first's links still work). */
  app.get('/me/export', { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } }, async (req, reply) => {
    const user = requireUser(req);
    const now = new Date();
    const day = jstDay(now);
    if (!(await repos.memoryAssets.claimExport(user.id, day, now.toISOString()))) throw httpError('export_limit', 429);
    let out: MemoryExportT;
    try {
      out = await build(user, originOf(req), now);
      await repos.audit.add({ id: newId('aud'), actorId: user.id, action: 'memories.export', target: user.id, meta: { memories: out.memories.length }, createdAt: now.toISOString() });
    } catch (e) {
      // A failed export does not use up his day.
      await repos.memoryAssets.releaseExport(user.id, day).catch(() => undefined);
      throw e;
    }
    reply.header('cache-control', 'private, no-store').header('content-disposition', `attachment; filename="${exportFileName(day)}"`);
    return out;
  });

  /**
   * A file through a link from his export. The signature is the permission, so no session is needed and the link
   * works as a plain download; anything wrong (expired, altered, deleted, account gone) is the same 404.
   */
  app.get('/memories/file', async (req, reply) => {
    const q = MemoryFileQuery.safeParse(req.query ?? {});
    if (!q.success || !linkValid(env.JWT_SECRET, q.data)) throw httpError('not_found', 404);
    // A deleted account's rows are gone, so its links find nothing.
    const file = await app.memoryFiles.confessionAudio(q.data.u, q.data.id);
    if (!file) throw httpError('not_found', 404);
    reply.header('cache-control', 'private, no-store')
      .header('content-disposition', `attachment; filename="confession-${q.data.id}.${EXT[file.type] ?? 'bin'}"`).type(file.type);
    return reply.send(file.bytes);
  });
}

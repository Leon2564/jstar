import { randomBytes } from 'node:crypto';
import { Readable, Transform } from 'node:stream';
import type { ReadableStream as NodeReadableStream } from 'node:stream/web';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { TtsReq, splitSentences, type Lang, type StarId, type TtsResT, type TtsTicketResT } from '@jstar/shared';
import type { UserRow } from '../db/types';
import { Mp3Meter } from '../lib/mp3';
import { deviceOf, httpError } from '../app';
import { bonds } from '../lib/bond';
import { claimVoice, settleVoice, ttsAllowed, ttsStarsOf, voiceOf } from '../lib/voice';
import { lineSigned } from '../lib/voiceLines';
import { TtsError } from '../lib/tts';

/** Sentences one account may have synthesized per minute (a long reply is a handful; this is far above real use). */
const PER_USER_PER_MINUTE = 40;
/** A stream ticket is good for this long (the page plays it at once); tests shorten it. */
export const streamTiming = { ticketMs: 30_000 };

/**
 * Her runtime voice (#73): `POST /v1/tts`, for every member once a vendor is configured (owner, 2026-10-02).
 *
 * Only her own words (docs/requirements.md §13.6): the request carries a line of hers exactly as the server gave it to
 * him — her chat reply (`voiceSig`) or a scene line (`voiceSigs`) — with its signature, and the index of the sentence
 * wanted; the server checks the signature (403 `not_her_line`: his text, an edited line, another account's), fills in
 * what she calls him for a `{name}` line, cuts the line as the web app does (splitSentences) and speaks that sentence.
 * Text of his is never spoken in her voice.
 *
 * No provider, no voice of hers, his minutes used up, or a failing vendor: the answer is `subtitle` and the web app
 * shows her line as text, as it always has. Every second synthesized is charged to his voice time (#74, §13.6: free
 * minutes a day, the monthly pass's more, extensions). A request id is claimed in the ledger before the provider is
 * asked, so it is synthesized once: sending it again is 409 `request_conflict`. A failed synthesis is not charged.
 */
export async function registerTts(app: FastifyInstance) {
  const bond = bonds(app);
  const recent = new Map<string, number[]>();
  const tooMany = (userId: string, now: number): boolean => {
    const times = (recent.get(userId) ?? []).filter((t) => now - t < 60_000);
    if (times.length >= PER_USER_PER_MINUTE) { recent.set(userId, times); return true; }
    times.push(now);
    recent.set(userId, times);
    if (recent.size > 5000) for (const [k, v] of recent) if (!v.some((t) => now - t < 60_000)) recent.delete(k);
    return false;
  };

  type Subtitle = Extract<TtsResT, { mode: 'subtitle' }>;
  type Wanted = { user: UserRow | null; owner: string; star: StarId; sentence: string; lang: Lang; requestId: string; leftSeconds: number };
  /**
   * The sentence of hers this request may have spoken, or why not (a subtitle). Throws 403 not_her_line, 429, 400
   * bad_index. Shared by the whole-file path and the streamed one, so both are guarded and limited alike.
   */
  const wanted = async (req: FastifyRequest): Promise<Wanted | Subtitle> => {
    const user = req.user ?? null;
    const device = user ? null : deviceOf(req);
    if (!user && !device) throw httpError('unauthorized', 401);
    const owner = user?.id ?? `device:${device!}`;
    const { star, line, sig, index, lang, requestId } = TtsReq.parse(req.body);
    // Her own words, for this account: checked before anything else is looked at.
    if (!lineSigned(owner, star, line, sig)) throw httpError('not_her_line', 403);
    const now = Date.now();
    if (tooMany(owner, now)) throw httpError('rate_limited', 429);
    const stars = ttsStarsOf(app);
    const voice = user ? await voiceOf(app.repos, user, stars, now) : null;
    const leftSeconds = voice?.leftSeconds ?? 600;
    if (!app.synthesize || (user && !ttsAllowed(stars, user.role))) return { mode: 'subtitle', reason: 'off', leftSeconds };
    // A talent without a cloned voice is never asked for (nor charged): she stays in subtitles.
    if (!stars.includes(star)) return { mode: 'subtitle', reason: 'no_voice', leftSeconds };
    if (voice && voice.leftSeconds <= 0) return { mode: 'subtitle', reason: 'no_minutes', leftSeconds: 0 };
    const speakLang = lang ?? user?.lang ?? 'ja';
    let text = line;
    if (text.includes('{name}')) {
      if (!user) return { mode: 'subtitle', reason: 'failed', leftSeconds };
      // What she calls him, as her scene shows it (GET /v1/bond); without one the web app plays her unnamed line.
      const name = (await bond.view(user, star, speakLang)).callName;
      if (!name) return { mode: 'subtitle', reason: 'failed', leftSeconds };
      text = text.split('{name}').join(name);
    }
    // Anything else to fill in (a stream comment, #68) is his text, not hers: never spoken.
    if (/\{\w+\}/.test(text)) return { mode: 'subtitle', reason: 'failed', leftSeconds };
    const sentence = splitSentences(text)[index];
    if (!sentence) throw httpError('bad_index', 400);
    return { user, owner, star, sentence: sentence.trim(), lang: speakLang, requestId, leftSeconds };
  };

  app.post('/', { config: { rateLimit: { max: 60, timeWindow: '1 minute' } } }, async (req): Promise<TtsResT> => {
    const w = await wanted(req);
    if ('mode' in w) return w;
    const { user, star, sentence, lang: speakLang, requestId } = w;
    if (!user) {
      try {
        const out = await app.synthesize!({ star, text: sentence, lang: speakLang });
        return { mode: 'voice', audio: out.audio.toString('base64'), mime: out.mime, seconds: out.seconds, leftSeconds: w.leftSeconds };
      } catch (e) {
        const reason = e instanceof TtsError && e.code === 'tts_no_voice' ? 'no_voice' : 'failed';
        req.log.warn({ code: e instanceof TtsError ? e.code : 'tts_error', star }, 'tts_trial_fallback');
        return { mode: 'subtitle', reason, leftSeconds: w.leftSeconds };
      }
    }
    const now = Date.now();
    const claim = await claimVoice(app, user, `tts:${requestId}`, now);
    if (!claim) throw httpError('request_conflict', 409);
    let out;
    try {
      out = await app.synthesize!({ star, text: sentence, lang: speakLang });
    } catch (e) {
      await settleVoice(app, user, claim, null, now);
      const reason = e instanceof TtsError && e.code === 'tts_no_voice' ? 'no_voice' : 'failed';
      // Her words are never logged; the failure is.
      req.log.warn({ code: e instanceof TtsError ? e.code : 'tts_error', star }, 'tts_fallback');
      return { mode: 'subtitle', reason, leftSeconds: w.leftSeconds };
    }
    const charged = await settleVoice(app, user, claim, out.seconds, now);
    return { mode: 'voice', audio: out.audio.toString('base64'), mime: out.mime, seconds: out.seconds, leftSeconds: charged.leftSeconds };
  });

  // ---------------------------------------------------------------- streamed (first sound)

  /**
   * One-use stream tickets: the page's <audio> cannot send his Authorization header, so `POST /ticket` (authorized,
   * guarded as above) keeps the sentence here under a random id for TICKET_MS, and `GET /stream/:id` takes it once.
   * Her words never go into a URL (URLs are logged). One API instance (max_instances 1), so memory is enough; a
   * restart only loses tickets, and the page falls back to the whole-file path.
   *
   * First sound (QA: 1.4–3.3 s): the ticket claims the request id and asks the vendor at once, so her synthesis runs
   * while the page turns the ticket into a stream request; `GET` pipes what has come and what follows. A ticket never
   * taken is dropped after TICKET_MS: the vendor call aborted, the claim taken back (nothing reached him).
   */
  type Ticket = Wanted & {
    claim: { requestId: string; nonce: string; day: string } | null;
    at: number;
    upstream: AbortController;
    body: Promise<ReadableStream<Uint8Array>>;
    timer: ReturnType<typeof setTimeout>;
  };
  const tickets = new Map<string, Ticket>();
  const drop = (id: string, t: Ticket) => {
    if (tickets.get(id) !== t) return;
    tickets.delete(id);
    t.upstream.abort();
    if (t.user && t.claim) void settleVoice(app, t.user, t.claim, null, t.at).catch(() => undefined);
  };

  app.post('/ticket', { config: { rateLimit: { max: 60, timeWindow: '1 minute' } } }, async (req): Promise<TtsTicketResT> => {
    if (!app.streamSynthesize) throw httpError('no_stream', 404);
    const w = await wanted(req);
    if ('mode' in w) return w;
    const now = Date.now();
    const claim = w.user ? await claimVoice(app, w.user, `tts:${w.requestId}`, now) : null;
    if (w.user && !claim) throw httpError('request_conflict', 409);
    const upstream = new AbortController();
    const body = app.streamSynthesize({ star: w.star, text: w.sentence, lang: w.lang }, upstream.signal);
    body.catch(() => undefined);
    const id = randomBytes(18).toString('base64url');
    const t: Ticket = { ...w, claim, at: now, upstream, body, timer: setTimeout(() => drop(id, t), streamTiming.ticketMs) };
    t.timer.unref?.();
    tickets.set(id, t);
    return { mode: 'stream', url: `/v1/tts/stream/${id}`, leftSeconds: w.leftSeconds };
  });

  /**
   * Her sentence as it is synthesized: the vendor's MP3 piped to the <audio> as it comes, never buffered (a pass-through
   * stream, no compression). Charged the MP3 frames that passed to him, counted as they go — all of them when it
   * ends, what had reached him when he stops it, nothing (the claim taken back) when nothing did.
   */
  app.get('/stream/:id', async (req, reply) => {
    const id = (req.params as { id?: string }).id ?? '';
    const t = tickets.get(id);
    if (!t) return reply.status(404).send({ error: 'no_ticket' });
    tickets.delete(id);
    clearTimeout(t.timer);
    let body: ReadableStream<Uint8Array>;
    try {
      body = await t.body;
    } catch (e) {
      if (t.user && t.claim) await settleVoice(app, t.user, t.claim, null, t.at);
      req.log.warn({ code: e instanceof TtsError ? e.code : 'tts_error', star: t.star }, 'tts_stream_fallback');
      return reply.status(e instanceof TtsError && e.code === 'tts_no_stream' ? 404 : 502).send({ error: 'tts_failed' });
    }
    const meter = new Mp3Meter();
    let settled = false;
    const settle = (finished: boolean) => {
      if (settled) return;
      settled = true;
      // Nothing reached him: not charged. Otherwise the seconds that did (all of them when it finished).
      const seconds = meter.frames ? meter.seconds : null;
      if (t.user && t.claim) void settleVoice(app, t.user, t.claim, seconds, t.at).catch((err) => req.log.warn({ err: String(err) }, 'tts_stream_settle_failed'));
      if (!finished) t.upstream.abort();
    };
    const counter = new Transform({
      transform(chunk: Buffer, _enc, done) { meter.push(chunk); done(null, chunk); }
    });
    const source = Readable.fromWeb(body as unknown as NodeReadableStream<Uint8Array>);
    source.on('error', () => counter.destroy());
    source.pipe(counter);
    // The response is done (all of it sent) or cut (he stopped her, or left): charge what passed, once.
    reply.raw.on('close', () => settle(reply.raw.writableFinished));
    return reply
      .header('content-type', 'audio/mpeg')
      .header('cache-control', 'no-store, no-transform')
      .header('x-content-type-options', 'nosniff')
      .send(counter);
  });
}

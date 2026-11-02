import cors from '@fastify/cors';
import rateLimit from '@fastify/rate-limit';
import Fastify, { type FastifyInstance } from 'fastify';
import { ZodError } from 'zod';
import { STAR_IDS, type EventName, type EventProps, type StarId } from '@jstar/shared';
import { ttsStarsOf } from './lib/voice';
import { env } from './env';
import { createD1Client } from './db/d1';
import { createMemoryRepos } from './db/memory';
import { SEED_CARDS, seedCatalog, seedDemo } from './db/seed';
import { createSqlRepos } from './db/sql';
import type { Repos, UserRow } from './db/types';
import { verifyJwt } from './lib/crypto';
import { recordEvent } from './lib/events';
import { registerAuth } from './modules/auth';
import { registerCatalog } from './modules/catalog';
import { registerChat } from './modules/chat';
import { registerGacha } from './modules/gacha';
import { registerSerial } from './modules/serial';
import { registerAdmin } from './modules/admin';
import { registerDevice } from './modules/device';
import { registerShop } from './modules/shop';
import { registerInbox } from './modules/inbox';
import { registerOps } from './modules/ops';
import { registerPush } from './modules/push';
import { registerScene } from './modules/scene';
import { registerAsr } from './modules/asr';
import { relayTranscriber, type Transcribe } from './lib/asr';
import { relayStreamer, relaySynthesizer, type StreamSynthesize, type Synthesize } from './lib/tts';
import { localTts } from './lib/localTts';
import { registerVoice } from './modules/voice';
import { registerTts } from './modules/tts';
import { registerRelationship } from './modules/relationship';
import { registerConfession } from './modules/confession';
import { sendOtpMail, type Mailer } from './lib/mail';
import { TURNSTILE_HEADER, turnstileEnabled, verifyTurnstile, type HumanCheck } from './lib/turnstile';
import { createPusher, httpTransport, vapidFromEnv, type PushTransport, type SendPush, type VapidKeys } from './lib/push';
import { openMeteo, type WeatherClient } from './lib/weather';
import { registerWorld } from './modules/world';
import { registerPromises } from './modules/promises';
import { registerAlarm } from './modules/alarm';
import { registerHerMessages } from './modules/herMessages';
import { registerBond } from './modules/bond';
import { flushMemoryPersona, herMessagePersona, restateHerMessagePersona } from './lib/agent';
import type { FlushPersona } from './lib/memoryFlush';
import type { HerMessages } from './lib/herMessages';
import { registerGift } from './modules/gift';
import { registerCalendar } from './modules/calendar';
import { memoryFiles, relayMemoryStore, type MemoryFiles, type MemoryStore } from './lib/memoryAssets';
import { registerMemories } from './modules/memories';
import { registerLive } from './modules/live';

declare module 'fastify' {
  interface FastifyInstance {
    repos: Repos; demo: boolean; mailer: Mailer; human: HumanCheck | null;
    /** Product event for the admin metrics (#52): see lib/events.ts. */
    recordEvent<N extends EventName>(userId: string, name: N, props: EventProps<N>): Promise<void>;
    /** Web Push keys, null while push is off. */
    vapid: VapidKeys | null;
    /** Notifies all of a user's browsers (lib/push.ts). The inbox delivery (#49) calls this. */
    sendPush: SendPush;
    /** Open-Meteo (#62, lib/weather.ts); null = weather off. */
    weather: WeatherClient | null;
    /** Server speech to text (lib/asr.ts), null while it is off. */
    transcribe: Transcribe | null;
    /** Her runtime voice (#73, lib/tts.ts): the TTS provider, null = provider `none` (every line stays a subtitle). */
    synthesize: Synthesize | null;
    /** Her sentence streamed as it is synthesized (#73, GET /v1/tts/stream); null = only the whole-file path. */
    streamSynthesize: StreamSynthesize | null;
    /** The talents with a cloned voice at that provider (the Worker's TTS_STARS); only meaningful with `synthesize`. */
    ttsStars: readonly StarId[];
    /** Her messages (#58, lib/herMessages.ts) for the tick; null = off. */
    her: HerMessages | null;
    /** His memory files (#51, lib/memoryAssets.ts): the R2 relay, or null = recordings stay base64 in D1. */
    memoryStore: MemoryStore | null;
    /** Folds pending chat turns into memory (lib/memoryFlush.ts): the persona service, or null = off (tests). */
    flushMemory: FlushPersona | null;
    /** The recording of his yes wherever it lives: the confession routes, his export and the tick go through this. */
    memoryFiles: MemoryFiles;
  }
  interface FastifyRequest { user?: UserRow }
}

/**
 * `human`: the Turnstile check, or null for no challenges (the default when TURNSTILE_URL is unset).
 * `push`: VAPID keys (null = push off) and how requests reach the push services; defaults come from the environment.
 */
export interface BuildOpts {
  repos?: Repos; logger?: boolean; demo?: boolean; mailer?: Mailer; human?: HumanCheck | null;
  push?: { vapid: VapidKeys | null; transport?: PushTransport };
  /** Weather provider (#62); null = off. Tests pass a fake or nothing: the default is off under test, so no test reaches the network. */
  weather?: WeatherClient | null;
  /** Speech to text for `POST /v1/asr`; null = off. Defaults to the Worker relay at ASR_URL (off when unset). */
  transcribe?: Transcribe | null;
  /** Her runtime voice for `POST /v1/tts` (#73); null = off. Defaults to the Worker relay at TTS_URL (off when unset). */
  synthesize?: Synthesize | null;
  /** Streamed synthesis; defaults to the relay at TTS_URL (null when unset). */
  streamSynthesize?: StreamSynthesize | null;
  /** Who has a cloned voice; defaults to TTS_STARS, else all five (the relay answers `no_voice` for one without). */
  ttsStars?: readonly StarId[];
  /** Her messages (#58): how the tick writes them; null = off. Defaults to the persona service, off under test. */
  her?: HerMessages | null;
  /** His memory files (#51): a store (tests pass the relay with a fake bucket), or null = D1 base64. Defaults to MEMORY_URL. */
  memoryStore?: MemoryStore | null;
  /** Batched chat memory: how pending turns are folded in; null = off. Defaults to the persona service, off under test. */
  flushMemory?: FlushPersona | null;
}

export async function buildApp(opts: BuildOpts = {}): Promise<FastifyInstance> {
  const app = Fastify({ logger: opts.logger ?? env.NODE_ENV !== 'test', trustProxy: env.TRUST_PROXY, bodyLimit: 64 * 1024 });
  const demo = opts.demo ?? env.DEMO_MODE;
  const repos = opts.repos ?? (env.DB === 'd1' ? createSqlRepos(createD1Client(env.DB_URL)) : createMemoryRepos({ cards: SEED_CARDS }));
  await seedCatalog(repos);
  if (demo) await seedDemo(repos, env.SERIAL_HMAC_KEY);
  app.decorate('repos', repos);
  app.decorate('demo', demo);
  app.decorate('mailer', opts.mailer ?? sendOtpMail);
  app.decorate('human', opts.human !== undefined ? opts.human : turnstileEnabled() ? verifyTurnstile : null);
  // A metric must never fail the flow it measures: a storage error is logged and dropped. Invalid props are a
  // programming error and still throw, so tests catch them.
  app.decorate('recordEvent', async function <N extends EventName>(userId: string, name: N, props: EventProps<N>) {
    try { await recordEvent(repos, userId, name, props); } catch (err) {
      if (err instanceof ZodError) throw err;
      app.log.warn({ err, event: name }, 'event_not_recorded');
    }
  });
  const vapid = opts.push ? opts.push.vapid : vapidFromEnv(env, (m) => app.log.warn(m));
  app.decorate('vapid', vapid);
  app.decorate('sendPush', createPusher(repos, vapid, opts.push?.transport ?? httpTransport(env.PUSH_URL)));
  app.decorate('weather', opts.weather !== undefined ? opts.weather : env.NODE_ENV === 'test' ? null : openMeteo(env.WEATHER_URL));
  app.decorate('transcribe', opts.transcribe !== undefined ? opts.transcribe : relayTranscriber(env.ASR_URL));
  // Local preview may call Fish directly through the exact Worker adapter. Production always uses the private relay,
  // so vendor credentials never enter the API container or browser there.
  const directVoice = env.NODE_ENV !== 'production' && !env.TTS_URL ? localTts(env) : null;
  const configuredVoice = relaySynthesizer(env.TTS_URL) ?? directVoice?.synthesize ?? null;
  const configuredStream = relayStreamer(env.TTS_URL) ?? directVoice?.streamSynthesize ?? null;
  app.decorate('synthesize', opts.synthesize !== undefined ? opts.synthesize : configuredVoice);
  app.decorate('streamSynthesize', opts.streamSynthesize !== undefined ? opts.streamSynthesize : opts.synthesize !== undefined ? null : configuredStream);
  app.decorate('ttsStars', opts.ttsStars ?? (opts.synthesize !== undefined ? starList(undefined) : env.TTS_URL ? starList(env.TTS_STARS) : directVoice?.stars ?? []));
  app.decorate('her', opts.her !== undefined ? opts.her : env.NODE_ENV === 'test' ? null : { write: herMessagePersona, restate: restateHerMessagePersona, demo });
  app.decorate('flushMemory', opts.flushMemory !== undefined ? opts.flushMemory : env.NODE_ENV === 'test' ? null : flushMemoryPersona);
  const memoryStore = opts.memoryStore !== undefined ? opts.memoryStore : relayMemoryStore(env.MEMORY_URL, env.AGENT_API_KEY);
  app.decorate('memoryStore', memoryStore);
  app.decorate('memoryFiles', memoryFiles({ repos, store: memoryStore, log: app.log }));

  // Retry-After is readable by the web app (N-58: a rate-limited send waits it out once, at most 3 s).
  // Local preview links are opened as either localhost or 127.0.0.1 depending on the host app. They are the
  // same loopback site, so development accepts both spellings while production remains on its explicit origins.
  const corsOrigins = new Set([env.PUBLIC_WEB_ORIGIN, env.PUBLIC_ADMIN_ORIGIN]);
  if (env.NODE_ENV !== 'production') {
    for (const origin of [...corsOrigins]) {
      try {
        const url = new URL(origin);
        if (url.hostname === 'localhost') { url.hostname = '127.0.0.1'; corsOrigins.add(url.origin); }
        else if (url.hostname === '127.0.0.1') { url.hostname = 'localhost'; corsOrigins.add(url.origin); }
      } catch { /* env validation owns malformed public origins */ }
    }
  }
  await app.register(cors, { origin: [...corsOrigins], credentials: true, maxAge: 600, exposedHeaders: ['retry-after'] });
  await app.register(rateLimit, { global: true, max: 120, timeWindow: '1 minute' });

  app.addHook('onSend', async (_req, reply, payload) => {
    reply.header('x-content-type-options', 'nosniff');
    reply.header('referrer-policy', 'strict-origin-when-cross-origin');
    reply.header('cross-origin-opener-policy', 'same-origin');
    reply.header('permissions-policy', 'geolocation=(), microphone=(), camera=()');
    return payload;
  });

  /** Bearer session; `request.user` is the only source of identity for handlers. */
  app.addHook('preHandler', async (req) => {
    const header = req.headers.authorization;
    if (!header?.startsWith('Bearer ')) return;
    const claims = verifyJwt<{ sub?: string }>(header.slice(7), env.JWT_SECRET);
    if (!claims?.sub) return;
    const user = await app.repos.users.byId(claims.sub);
    if (user && !user.banned) req.user = user;
  });

  app.setErrorHandler((err, req, reply) => {
    if (err instanceof ZodError) {
      return reply.status(400).send({ error: 'invalid_request', issues: err.issues.map((i) => ({ path: i.path.join('.'), code: i.code })) });
    }
    const status = err.statusCode && err.statusCode >= 400 ? err.statusCode : 500;
    if (status >= 500) req.log.error({ err }, 'request_failed');
    // Never leak internals to the client; the message is a stable machine code.
    reply.status(status).send({ error: status >= 500 ? 'internal_error' : err.message || 'request_failed' });
  });

  app.get('/health', async () => ({ ok: true, env: env.NODE_ENV }));
  /** What the web app needs to know before it renders: demo hints, the bot check, and whether to offer notifications. */
  app.get('/v1/config', async () => {
    const voiceStars = [...ttsStarsOf(app)];
    return { demo: app.demo, turnstile: app.human ? env.TURNSTILE_SITEKEY || null : null, vapidPublicKey: app.vapid?.publicKey ?? null, asr: !!app.transcribe, voice: voiceStars.length > 0, voiceStars };
  });

  await app.register(registerAuth, { prefix: '/v1/auth' });
  await app.register(registerCatalog, { prefix: '/v1' });
  await app.register(registerSerial, { prefix: '/v1/serial' });
  await app.register(registerChat, { prefix: '/v1/chat' });
  await app.register(registerGacha, { prefix: '/v1/gacha' });
  await app.register(registerShop, { prefix: '/v1/shop' });
  await app.register(registerDevice, { prefix: '/v1/device' });
  await app.register(registerPush, { prefix: '/v1/push' });
  await app.register(registerAdmin, { prefix: '/v1/admin' });
  await app.register(registerInbox, { prefix: '/v1/inbox' });
  await app.register(registerOps, { prefix: '/v1/ops' });
  await app.register(registerScene, { prefix: '/v1/scene' });
  await app.register(registerWorld, { prefix: '/v1/world' });
  await app.register(registerAsr, { prefix: '/v1/asr' });
  await app.register(registerRelationship, { prefix: '/v1/relationship' });
  await app.register(registerPromises, { prefix: '/v1/promises' });
  await app.register(registerAlarm, { prefix: '/v1/alarm' });
  await app.register(registerConfession, { prefix: '/v1/confession' });
  await app.register(registerHerMessages, { prefix: '/v1/her-messages' });
  await app.register(registerGift, { prefix: '/v1/gift' });
  await app.register(registerBond, { prefix: '/v1/bond' });
  await app.register(registerCalendar, { prefix: '/v1/calendar' });
  await app.register(registerMemories, { prefix: '/v1' });
  await app.register(registerVoice, { prefix: '/v1/voice' });
  await app.register(registerTts, { prefix: '/v1/tts' });
  await app.register(registerLive, { prefix: '/v1/live' });

  return app;
}

/** A visitor's browser id: holds the trial allowance and cards redeemed before sign-up. */
export function deviceOf(req: { headers: Record<string, unknown> }): string | null {
  const v = String(req.headers['x-device-id'] ?? '').trim();
  // Browsers without storage used to share the id "ephemeral": one visitor's redeemed cards were claimable by the next.
  return /^[A-Za-z0-9_-]{8,64}$/.test(v) && v !== 'ephemeral' ? v : null;
}
export function requireDevice(req: { headers: Record<string, unknown> }): string {
  const d = deviceOf(req);
  if (!d) throw Object.assign(new Error('device_id_required'), { statusCode: 400 });
  return d;
}

export const httpError = (code: string, statusCode: number) => Object.assign(new Error(code), { statusCode });

/**
 * Bot check for the costly or guessable actions (sign-in mail, a device's first trial message, repeated wrong codes).
 * Without a valid token the caller gets 403 `challenge_required`; the web app then runs Turnstile and retries once.
 */
export async function requireHuman(app: FastifyInstance, req: { headers: Record<string, unknown>; ip: string }): Promise<void> {
  if (!app.human) return;
  const token = req.headers[TURNSTILE_HEADER];
  if (!(await app.human(typeof token === 'string' ? token : undefined, req.ip))) throw Object.assign(new Error('challenge_required'), { statusCode: 403 });
}

export function requireUser(req: { user?: UserRow }): UserRow {
  if (!req.user) throw Object.assign(new Error('unauthorized'), { statusCode: 401 });
  return req.user;
}
export function requireAdmin(req: { user?: UserRow }): UserRow {
  const user = requireUser(req);
  if (user.role !== 'admin') throw Object.assign(new Error('forbidden'), { statusCode: 403 });
  return user;
}

/** TTS_STARS (comma-separated) as talents; unset = all five. Unknown names are dropped. */
function starList(raw: string | undefined): readonly StarId[] {
  if (raw === undefined) return STAR_IDS;
  const want = new Set(raw.split(',').map((x) => x.trim()));
  return STAR_IDS.filter((x) => want.has(x));
}

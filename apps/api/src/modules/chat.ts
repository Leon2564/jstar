import { PassThrough } from 'node:stream';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import {
  ChatGreetingQuery, ChatSendReq, RULES, localClock, validTimeZone, countDay, freshRelationship, inLanguage, jstDay, levelFromXp, localText, loverLevel, routineNow, viewOfEvent, WORLD, zStarId,
  type ChatGreetingResT, type ChatSendResT, type ChatStreamEventT, type Lang, type RelationshipState
} from '@jstar/shared';
import { httpError, requireDevice, requireHuman, requireUser } from '../app';
import { newId } from '../lib/crypto';
import { zSceneRequestDirective } from '@jstar/shared/scenes/schema';
import { askPersona, greetPersona, streamPersona, type AgentEvent, type AgentInput, type AgentOutfitOption, type AgentRelationship, type AgentReply, type AgentSceneOption, type AgentSceneTalk } from '../lib/agent';
import { outfitOptions, pickupForTurn } from '../lib/pickup';
import { relationships } from '../lib/relationship';
import { SCRIPTS, offersPausedFor, sceneOptions } from '../lib/sceneTriggers';
import { confessions } from '../lib/confession';
import { LINES, wokenLine } from '@jstar/shared/lines';
import type { MessageRow, UserRow } from '../db/types';
import { dayPart, greetingTemplate, withWeather, wrongTimeSalutation } from '../lib/greetingTemplate';
import { nameIn } from '@jstar/shared/kanaName';

/** How long his room waits for her model greeting, both tries together (N-36), before her written one. */
const GREETING_BUDGET_MS = 15_000;
/** How long his room waits for the model's line before her written one (N-39); the model's is cached when it comes. */
const GREETING_WAIT_MS = 2_500;
/** Kana in a name (N-55): outside Japanese her greeting writes it in her language's script, never as set. */
const KANA_NAME = /[\u3041-\u3096\u30a1-\u30fa]/;
/** The whole greeting route answers within this (N-39: client p95 ≤ 3 s), her written greeting when it must. */
export const GREETING_TOTAL_MS = 2_300;
import { agentPromise, heardPromise, newPromise, promiseOpening, toPromiseItem } from '../lib/promises';
import { agentRoutine, agentWorld, greetingMood, greetingWeather } from '../lib/herWorld';
import { todayWith } from '../lib/calendar';
import { factsForAgent, heardWishes, saveMemory, tastesForAgent, wishesOf } from '../lib/wishes';
import { bonds } from '../lib/bond';
import { flushMemory, keepTurn, unsavedFor } from '../lib/memoryFlush';
import { z } from 'zod';
import { hearsHer, signLine } from '../lib/voiceLines';

/** He left the chat with one talent (POST /v1/chat/memory/flush). API-only, so it stays out of the web bundle. */
const ChatMemoryFlushReq = z.object({ star: zStarId });

const HISTORY_TURNS = 20;
const DAY_MS = 86_400_000;

/**
 * Her view of the relationship for the persona (#54). Today already counts as a day together — he is talking to her
 * now — even though the day is only stored once the turn is delivered.
 */
/** M4 (C-room): his hour on his clock, or undefined when his zone is unknown or keeps Japan's time (her clock then). */
export function hisHour(tz: string | null, now: Date): number | undefined {
  if (!tz) return undefined;
  const his = localClock(now, tz), jst = localClock(now, 'Asia/Tokyo');
  return his.minutes === jst.minutes && his.date === jst.date ? undefined : Math.floor(his.minutes / 60);
}

/** QA #4: the agent's suggestions for his next words, as the contract allows them: strings, short, at most 3, not his. */
export function suggestions(raw: unknown, his: string): string[] {
  if (!Array.isArray(raw)) return [];
  const said = his.trim();
  return [...new Set(raw.filter((r): r is string => typeof r === 'string').map((r) => r.trim()).filter((r) => r && r.length <= 40 && r !== said))].slice(0, 3);
}

function forAgent(row: RelationshipState | null, xp: number, now = new Date()): AgentRelationship {
  const s = countDay(row ?? freshRelationship(now.toISOString()), jstDay(now));
  return { stage: s.stage, daysTogether: s.daysTogether, anniversary: s.anniversary, loverLevel: loverLevel(s, xp) };
}

/** A turn that passed the allowance check: who it is for and how to give the message back if nothing is delivered. */
interface Turn {
  owner: string; star: MessageRow['star']; text: string; lang: Lang;
  input: AgentInput;
  release: () => Promise<void>;
  /** Stores the finished turn and builds the response. */
  finish: (reply: AgentReply) => Promise<ChatSendResT>;
}

/**
 * The chat path: allowance, persona service, storage and rewards for one turn. Shared by the chat routes and by
 * free talk inside a scene (#64), which also needs the agent's raw reply for its `directive` (#65).
 */
export function chatTurns(app: FastifyInstance) {
  const rel = relationships(app);
  const bond = bonds(app);
  const toTurns = (rows: MessageRow[]) => rows.map((m) => ({ role: m.role, text: m.text }));
  /** Stores both sides of the turn; returns his message's id. */
  const store = async (ownerId: string, star: MessageRow['star'], text: string, reply: string) => {
    const now = new Date().toISOString();
    const id = newId('msg');
    await app.repos.messages.add({ id, ownerId, star, role: 'user', text, createdAt: now });
    await app.repos.messages.add({ id: newId('msg'), ownerId, star, role: 'assistant', text: reply, createdAt: now });
    return id;
  };
  /** Her world for the prompt (#63); the weather is a nicety, so a storage error leaves it out rather than failing the turn. */
  const worldFor = async (star: MessageRow['star'], lang: Lang, userId: string | null) => {
    try {
      const now = new Date();
      // What today is (#61): her birthday (confirmed only), his, their anniversary, the season.
      const user = userId ? await app.repos.users.byId(userId) : null;
      const today = (await todayWith(app, user, star, now)).map(viewOfEvent);
      return await agentWorld(app.repos, star, lang, userId, now, WORLD, today);
    } catch (err) {
      app.log.warn({ err: String(err) }, 'her_world_failed');
      return null;
    }
  };
  /**
   * A hard-blocked message: the allowance goes back and the attempt is recorded for the moderation queue (#14) as
   * audit action `chat.blocked`, with only a short excerpt of what was said.
   */
  const refuse = async (turn: Turn, reason: string | null | undefined): Promise<never> => {
    await turn.release();
    const code = reason || 'content_blocked';
    await app.repos.audit.add({
      id: newId('aud'), actorId: turn.owner, action: 'chat.blocked', target: turn.owner,
      meta: { star: turn.star, reason: code, excerpt: [...turn.text].slice(0, 80).join('') }, createdAt: new Date().toISOString()
    }).catch((e) => app.log.error({ err: e }, 'chat_blocked_audit_failed'));
    throw httpError(code, 422);
  };
  /** Calls the persona service; the reserved allowance is handed back if nothing was delivered. */
  const askFull = async (turn: Turn): Promise<{ result: ChatSendResT; reply: AgentReply }> => {
    let reply: AgentReply;
    try { reply = await askPersona(turn.input); } catch (e) { await turn.release(); throw e; }
    if (reply.blocked) return refuse(turn, reply.reason);
    return { result: await turn.finish(reply), reply };
  };
  const ask = async (turn: Turn): Promise<ChatSendResT> => (await askFull(turn)).result;

  /**
   * The scenes he could ask for in this turn (#65); none when there are none to offer. A failure here costs the turn
   * its scene requests, never the turn itself.
   */
  const offerable = async (user: UserRow, star: MessageRow['star'], lang: Lang): Promise<AgentSceneOption[]> => {
    try { return await sceneOptions(app, user, star, lang); } catch (err) {
      app.log.warn({ err }, 'scene_options_failed');
      return [];
    }
  };

  /** Her variant cards for this turn (#78); like the scenes, a failure costs only the outfit talk. */
  const outfitsFor = async (user: UserRow, star: MessageRow['star'], lang: Lang, scenes: AgentSceneOption[]): Promise<AgentOutfitOption[]> => {
    try { return await outfitOptions(app, user, star, lang, scenes); } catch (err) {
      app.log.warn({ err }, 'outfit_options_failed');
      return [];
    }
  };

  /**
   * One chat turn for a registered user. The daily allowance (docs/requirements.md §3) is reserved before
   * the model is called so two parallel requests cannot both slip through on the last message.
   * `scene`: the turn is free talk inside a scene (#64), which may turn along the step's jumps; otherwise he may ask
   * for one of her scenes (#65).
   */
  const userTurn = async (user: UserRow, body: unknown, opts: { scene?: AgentSceneTalk } = {}): Promise<Turn> => {
    const { star, text, lang, tz: told, suggest, channel } = ChatSendReq.parse(body);
    // Round 12: a time he names is his own — his browser's zone, else the one his account knows, else Japan's.
    const tz = validTimeZone(told) ?? validTimeZone(user.tz);
    const cost = channel === 'text' ? RULES.textMessageCostPoints : 0;
    const reserved = cost ? await app.repos.users.adjustWallet(user.id, { points: -cost }) : await app.repos.users.byId(user.id);
    if (!reserved) throw httpError('insufficient_points', 402);
    let charged = cost > 0;
    const release = async () => {
      if (!charged) return;
      charged = false;
      await app.repos.users.adjustWallet(user.id, { points: cost });
    };

    try {
      const [history, memory, xpBefore, sent, bondRow, promise, scenes, world] = await Promise.all([
        app.repos.messages.recent(user.id, star, HISTORY_TURNS), app.repos.chatMemory.get(user.id, star),
        app.repos.affinity.get(user.id, star), app.repos.messages.countUser(user.id, star), app.repos.relationship.get(user.id, star), app.repos.promises.latest(user.id, star),
        opts.scene ? Promise.resolve([]) : offerable(user, star, lang), worldFor(star, lang, user.id)
      ]);
      // What she calls him at this stage, and the looks of hers he could praise (#56).
      const [called, looks] = await Promise.all([bond.callNameFor(user, star, bondRow?.stage ?? 'new', memory?.facts ?? null, lang), bond.looksFor(user.id, star)]);
      const outfits = opts.scene ? [] : await outfitsFor(user, star, lang, scenes);
      // Every RULES.memoryCardEvery-th message with her becomes a memory card, titled by the agent.
      const wantCard = (sent + 1) % RULES.memoryCardEvery === 0;
      // #77: her tastes come up in everyday conversation — what he knows, and now and then one thing she has been wanting.
      const tastes = tastesForAgent(star, lang, sent, wishesOf(memory));
      const input: AgentInput = {
        star, lang, userId: user.id, text, history: toTurns(history), level: levelFromXp(xpBefore), ...(tz ? { tz } : {}), ...(suggest ? { suggest: true } : {}),
        memory: memory ? { facts: factsForAgent(memory.facts), summary: memory.summary } : null, wantCard, ...forAgent(bondRow, xpBefore),
        callName: called.callName, looks,
        // Memory in batches (lib/memoryFlush.ts): the turns it has not taken in yet go back with every turn.
        memoryMode: 'batch', unsaved: unsavedFor(memory),
        promise: agentPromise(promise, Date.now()), world, ...agentRoutine(star, new Date()),
        ...(scenes.length ? { scenes } : {}), ...(opts.scene ? { scene: opts.scene } : {}), ...(tastes ? { tastes } : {}), ...(outfits.length ? { outfits } : {})
      };
      const finish = async (reply: AgentReply): Promise<ChatSendResT> => {
        const msgId = await store(user.id, star, text, reply.reply);
        // N-50: his line and hers are kept first; her memory is bookkeeping (#143's batching) and never costs him the
        // turn — a failure there is logged, the pending buffer and the next update catch up.
        try {
          // What she likes and just said out loud is something he now knows about her (chat memory `her_wishes`).
          await saveMemory(app.repos, user.id, star, memory, reply.memory, heardWishes(star, reply.reply));
          // Taken into memory: the pending turns leave the buffer; not yet: this turn joins them.
          await keepTurn(app.repos, user.id, star, memory, reply.memorySaved, { id: msgId, text, reply: reply.reply });
        } catch (err) {
          app.log.warn({ err: String(err), star }, 'chat_memory_bookkeeping_failed');
        }
        // He praised a look of hers (#56): only the count is kept, and only for looks offered this turn.
        if (reply.praised) await bond.heard(user.id, star, reply.praised, looks.map((l) => l.id));

        await app.repos.affinity.add(user.id, star, RULES.xpPerMessage);
        // A message is a day together; a stage entered pays its free pull inside the relationship change (#54),
        // no longer one per level, so the wallet is only re-read when that happened.
        const { row, xp } = await rel.touch(user.id, star);
        const wallet = row.rewardRank > (bondRow?.rewardRank ?? 0) ? await app.repos.users.byId(user.id) : reserved;

        // The title is the agent's short summary, never his raw words; no title (a decline or a self-harm turn) = no card.
        let memoryCard: ChatSendResT['memoryCard'] = null;
        if (wantCard && reply.cardTitle) {
          memoryCard = { id: newId('mem'), title: reply.cardTitle.slice(0, 40), createdAt: new Date().toISOString() };
          await app.repos.memories.add({ ...memoryCard, userId: user.id, star });
        }
        // A promise both agreed on (#59), as the memory model heard it; refused while one with her is open.
        const heard = reply.promise ? heardPromise(reply.promise, Date.now()) : null;
        const made = heard ? newPromise({ ...heard, userId: user.id, star, source: 'chat', sourceMsgId: msgId, lang }, Date.now()) : null;
        const saved = made && (await app.repos.promises.create(made)) ? made : null;
        // #65: she agreed to a scene he asked for, or offered another — only one this turn listed as ready.
        const asked = zSceneRequestDirective.safeParse(reply.directive);
        const listed = asked.success && scenes.some((o) => o.id === asked.data.scene && o.ready) ? asked.data : null;
        // M2: the scene he asked for still starts; another she offers instead waits out the pause after a scene
        // (TRIGGER_RULES.afterSceneCooldownMs, goodnight's night), as her offers in the room do.
        const paused = listed?.action === 'offer' && ((await offersPausedFor(app, user.id, user.tz, Date.now()).catch(() => null)) ?? 0) > Date.now();
        const scene = paused ? null : listed;
        // #78: she mentioned her variant he does not have and its Pickup is live — a link under her line, counted as shown.
        const pickup = scene ? null : await pickupForTurn(app.repos, star, reply.directive, outfits).catch(() => null);
        if (pickup) await app.recordEvent(user.id, 'variant.prompted', { star, cardId: pickup.cardId, via: pickup.via });
        charged = false;
        return {
          reply: reply.reply, affinityXp: xp, level: levelFromXp(xp), memoryCard, trialMessagesLeft: null,
          chatLeft: Math.floor((wallet ?? reserved).points / RULES.textMessageCostPoints), points: (wallet ?? reserved).points, freePulls: (wallet ?? reserved).freePulls,
          relationship: await rel.view(user.id, star, row, xp),
          promise: saved ? toPromiseItem(saved, lang) : null,
          ...(scene ? { scene: { sceneId: scene.scene, action: scene.action, title: SCRIPTS.get(scene.scene)!.meta.title } } : {}),
          ...(pickup ? { pickup } : {}),
          ...(suggest && suggestions(reply.replies, text).length ? { replies: suggestions(reply.replies, text) } : {}),
          // Her reply in her voice (#73): signed for him, so /v1/tts speaks these words and nothing else.
          ...(hearsHer(app, user, star) ? { voiceSig: signLine(user.id, star, reply.reply.trim()) } : {})
        };
      };
      return { owner: user.id, star, text, lang, input, release, finish };
    } catch (e) {
      await release();
      throw e;
    }
  };

  /** Trial chat for visitors: allowance per device, messages kept under the device so they carry over at sign-up. */
  const trialTurn = async (req: { headers: Record<string, unknown>; body: unknown; ip: string }): Promise<Turn> => {
    const { star, text, lang } = ChatSendReq.parse(req.body);
    const device = requireDevice({ headers: req.headers });
    // A new device's first trial message is checked for a bot: each device id buys model calls.
    if (app.human && (await app.repos.devices.get(device)).trialUsed === 0) await requireHuman(app, req);
    const left = await app.repos.devices.reserveTrial(device, RULES.trialMessages);
    if (left === null) throw httpError('trial_exhausted', 402);
    const owner = `device:${device}`;
    const release = () => app.repos.devices.releaseTrial(device);
    try {
      const [history, world] = await Promise.all([app.repos.messages.recent(owner, star, HISTORY_TURNS), worldFor(star, lang, null)]);
      // A visitor's trial keeps no memory, so none is written (no memory call at all).
      const input: AgentInput = { star, lang, userId: owner, text, history: toTurns(history), level: 1, world, ...agentRoutine(star, new Date()), memoryMode: 'off' };
      const finish = async (reply: AgentReply): Promise<ChatSendResT> => {
        await store(owner, star, text, reply.reply);
        return {
          reply: reply.reply, affinityXp: 0, level: 1, memoryCard: null, trialMessagesLeft: left, chatLeft: null, points: 0, freePulls: 0,
          // The visitor may hear only the reply the server just produced for this device. The TTS route verifies this
          // device-bound signature before asking Fish, exactly as it does for a member account.
          ...(app.synthesize && app.ttsStars.includes(star) ? { voiceSig: signLine(owner, star, reply.reply.trim()) } : {})
        };
      };
      return { owner, star, text, lang, input, release, finish };
    } catch (e) {
      await release();
      throw e;
    }
  };

  return { userTurn, trialTurn, ask, askFull, refuse, worldFor };
}

/** His e-mail handle (the account nickname of an e-mail account) in a line of hers: never a name he gave her (round 10). */
export const handleIn = (text: string, user: Pick<UserRow, 'via' | 'nickname' | 'email'>): boolean => {
  if (user.via !== 'email') return false;
  const said = text.toLowerCase();
  return [user.nickname, user.email?.split('@')[0]].some((h) => !!h && h.length >= 3 && said.includes(h.toLowerCase()));
};

export async function registerChat(app: FastifyInstance) {
  const { userTurn, trialTurn, ask, refuse, worldFor } = chatTurns(app);
  const confession = confessions(app);
  const calls = bonds(app);

  /**
   * Streams one turn as NDJSON (ChatStreamEvent). The first agent event decides the HTTP answer: a hard block or an
   * unavailable agent is a plain 422/503 with the allowance given back, exactly like the non-streaming route; after
   * that the reply streams and the turn is stored when the agent says `done`.
   */
  const streamTurn = async (turn: Turn, reply: FastifyReply) => {
    const events = streamPersona(turn.input);
    let first: IteratorResult<AgentEvent>;
    try { first = await events.next(); } catch (e) { await turn.release(); throw e; }
    if (first.done || first.value.type === 'error') { await turn.release(); throw httpError('agent_unavailable', 503); }
    if (first.value.type === 'blocked') return refuse(turn, first.value.reason);

    const out = new PassThrough();
    const send = (ev: ChatStreamEventT) => out.write(`${JSON.stringify(ev)}\n`);
    const pump = async () => {
      let shown = '';
      let finished = false;
      try {
        for (let it: IteratorResult<AgentEvent> = first; !it.done; it = await events.next()) {
          const ev = it.value;
          if (ev.type === 'delta') { shown += ev.text; send(ev); }
          else if (ev.type === 'replace') { shown = ev.text; send(ev); }
          else if (ev.type === 'done') {
            send({ type: 'done', result: await turn.finish({ reply: ev.reply, blocked: false, boundary: ev.boundary, memory: ev.memory, cardTitle: ev.cardTitle, promise: ev.promise, directive: ev.directive, praised: ev.praised, memorySaved: ev.memorySaved, replies: ev.replies }) });
            finished = true;
            break;
          } else break; // error / blocked mid-stream
        }
        // The agent broke off: keep what she already said rather than charging for nothing, if anything was said.
        if (!finished && shown.trim()) {
          // Memory never saw this turn: it waits with the other unsaved ones.
          send({ type: 'done', result: await turn.finish({ reply: shown.trim(), blocked: false, memorySaved: false }) });
          finished = true;
        }
      } catch (e) {
        app.log.error({ err: e }, 'chat_stream_failed');
      } finally {
        if (!finished) {
          await turn.release().catch(() => undefined);
          send({ type: 'error', error: 'agent_unavailable' });
        }
        out.end();
      }
    };
    void pump();
    return reply
      .header('content-type', 'application/x-ndjson; charset=utf-8')
      .header('cache-control', 'no-store')
      .header('x-accel-buffering', 'no')
      .send(out);
  };

  app.post('/send', { config: { rateLimit: { max: 30, timeWindow: '1 minute' } } }, async (req): Promise<ChatSendResT> =>
    ask(await userTurn(requireUser(req), req.body)));

  app.post('/trial', { config: { rateLimit: { max: 20, timeWindow: '10 minutes' } } }, async (req): Promise<ChatSendResT> =>
    ask(await trialTurn(req)));

  app.post('/send/stream', { config: { rateLimit: { max: 30, timeWindow: '1 minute' } } }, async (req, reply) =>
    streamTurn(await userTurn(requireUser(req), req.body), reply));

  app.post('/trial/stream', { config: { rateLimit: { max: 20, timeWindow: '10 minutes' } } }, async (req, reply) =>
    streamTurn(await trialTurn(req), reply));

  /**
   * He left the chat (the web calls this as he goes, keepalive): what memory has not taken in yet goes in now, rather
   * than at his next message or when the tick finds the conversation quiet. Nothing to do is not an error.
   */
  app.post('/memory/flush', { config: { rateLimit: { max: 20, timeWindow: '1 minute' } } }, async (req) => {
    const user = requireUser(req);
    const { star } = ChatMemoryFlushReq.parse(req.body);
    if (!app.flushMemory) return { status: 'off' as const };
    try {
      return { status: await flushMemory(app.repos, app.flushMemory, user.id, star, user.lang) };
    } catch (err) {
      req.log.warn({ err: String(err) }, 'memory_flush_failed');
      return { status: 'failed' as const };
    }
  });

  app.get('/history', async (req) => {
    const user = requireUser(req);
    const star = zStarId.parse((req.query as { star?: string }).star);
    const rows = await app.repos.messages.recent(user.id, star, 200);
    return { messages: rows.map((m) => ({ id: m.id, role: m.role, text: m.text, createdAt: m.createdAt })) };
  });

  /**
   * Her first line on the companion home: time of day (JST), days since the last message, affinity and memory.
   * Generated once per user, talent, JST day and language, then served from chat_memory.
   */
  app.get('/greeting', { config: { rateLimit: { max: 30, timeWindow: '1 minute' } } }, async (req): Promise<ChatGreetingResT> => {
    const user = requireUser(req);
    const { star, lang: asked, tz: told } = ChatGreetingQuery.parse(req.query);
    const lang = asked ?? user.lang;
    // M4 (C-room): his clock, when his zone is known and is not Japan's: her greeting fits his time of day.
    const tz = validTimeZone(told) ?? validTimeZone(user.tz);
    const hour = hisHour(tz, new Date());
    // N-19/N-36: her greeting never fails his room — a store, weather or persona-service error, or a timeout, and
    // she says her written greeting in his language (200, not cached), with the reason logged.
    // N-39: and never slowly — one deadline for the whole route (reads, the model's moment); past it her written
    // greeting answers and the work goes on to fill the cache for his next visit.
    const started = Date.now();
    const totalMs = Number(process.env.GREETING_TOTAL_MS ?? GREETING_TOTAL_MS);
    const LATE = Symbol('late');
    // N-57: her written greeting at the deadline fits what is known of them by then — never 「はじめまして」 by default.
    const fallback = { text: greetingTemplate(lang, 1, null, new Date(), null, star, 'new', hour) };
    const work = greeting(req, user, star, lang, started + totalMs, fallback, tz, hour).catch((e: unknown) => {
      req.log.warn({ star, lang, reason: e instanceof Error ? e.message : String(e) }, 'greeting served from her written template');
      return null;
    });
    const late = new Promise<typeof LATE>((r) => { const t = setTimeout(() => r(LATE), totalMs); t.unref?.(); });
    const first = await Promise.race([work, late]);
    if (first === LATE) req.log.warn({ star, lang, ms: Date.now() - started }, 'greeting past its deadline: her written template');
    return first && first !== LATE ? first : { text: fallback.text, cached: false };
  });

  async function greeting(req: FastifyRequest, user: UserRow, star: MessageRow['star'], lang: Lang, deadline: number, fallback: { text: string },
    tz: string | null = null, hour?: number): Promise<ChatGreetingResT> {
    const started = Date.now();
    // The companion home asks for her greeting each time he opens her room: that visit is the denominator of
    // scene triggers per room entry and the visit signal of the 7-day retention (#52). Not on the way to her words.
    void app.recordEvent(user.id, 'room.entered', { star }).catch((err) => req.log.warn({ err: String(err) }, 'room_entered_failed'));
    // N-39: everything her room needs to decide is read at once, not one query after another.
    const day = jstDay();
    const routine = routineNow(star, new Date());
    const [opening, confessing, memory, world, setName] = await Promise.all([
      // A promise falling due is kept by her coming to meet him (#59): that line replaces the greeting, uncached.
      promiseOpening(app.repos, user, star, lang, Date.now()),
      confession.status(user.id, star),
      app.repos.chatMemory.get(user.id, star),
      worldFor(star, lang, user.id),
      app.repos.bond.name(user.id)
    ]);
    // Round 11: rain or snow at her window is in every greeting — combined with her promise, confession or woken line.
    const news = greetingWeather(world);
    if (opening) return { text: withWeather(opening.text, lang, news, 'after', star), cached: false, promise: toPromiseItem(opening.promise, lang) };
    // Her confession day (#55), before 17:00: she only hints at tonight. Not cached — the evening changes it.
    if (confessing?.phase === 'due' && !confessing.tonight) return { text: withWeather(localText(LINES[star].confession.hint, lang), lang, news, 'after', star), cached: false };
    // Her sleeping hours (#60): he woke her, and her first words are drowsy ones of her own — any time, her room is open.
    // Not cached: the day's greeting is kept for when she is up.
    if (routine.presence === 'asleep') return { text: withWeather(localText(wokenLine(star, day), lang), lang, news, 'after', star), cached: false };
    // The cache is per day, language, the part of her day (#60: what she was doing this morning is not what she is doing
    // tonight) and the weather she would open with (#63): rain that starts after this morning's greeting gets a
    // greeting of its own. Kept in the language column, so no schema change.
    const mood = greetingMood(world);
    // M4: and his part of the day, when her greeting fits his clock rather than hers.
    const cacheLang = [`${lang}@${routine.slot}`, hour === undefined ? null : `you-${dayPart(new Date(), hour).replace(' ', '-')}`, mood].filter(Boolean).join('~');
    // N-05: only a greeting in his language is shown — his names aside (they may be in kana), a cached one too.
    // U-10: his names as he stored them in ja / zh-Hant (ケンタ stays ケンタ); a kana name in Latin / Hangul for en / ko (N-55).
    const inScript = (n: string | null | undefined) => (lang === 'ja' || !n || !KANA_NAME.test(n) ? n : nameIn(n, lang));
    const names = [setName, memory?.facts?.call_name, memory?.facts?.name].map(inScript);
    const cached = memory?.greeting && memory.greeting.day === day && (memory.greeting.lang === cacheLang || memory.greeting.lang === `${cacheLang}~first`)
      && inLanguage(memory.greeting.text, lang, names) && !handleIn(memory.greeting.text, user) ? memory.greeting : null;
    // Round 12: a greeting written for their first meeting is not one once they have talked or made a promise since.
    const stillFirst = async () => {
      const [[said], made] = await Promise.all([app.repos.messages.recent(user.id, star, 1), app.repos.promises.latest(user.id, star)]);
      return !said && !made;
    };
    if (cached && (!cached.lang.endsWith('~first') || (await stillFirst()))) {
      return { text: withWeather(cached.text, lang, news, 'before', star), cached: true };
    }

    const [[last], xp, bond, latest] = await Promise.all([
      app.repos.messages.recent(user.id, star, 1), app.repos.affinity.get(user.id, star), app.repos.relationship.get(user.id, star), app.repos.promises.latest(user.id, star)
    ]);
    const daysSince = last ? Math.max(0, Math.round((Date.parse(day) - Date.parse(jstDay(new Date(last.createdAt)))) / DAY_MS)) : null;
    // Opening her room is not a day together (only a message or a scene is), so the stored count is what she knows.
    const together = bond ? { stage: bond.stage, daysTogether: bond.daysTogether, anniversary: bond.anniversary, loverLevel: loverLevel(bond, xp) } : { stage: 'new' as const, daysTogether: 0 };
    const promise = agentPromise(latest, Date.now());
    const { callName } = await calls.callNameFor(user, star, together.stage, memory?.facts ?? null, lang);
    // N-57: no messages yet is not a first meeting when they have days together (scenes, her messages): by relationship.
    // Round 12: nor once there is a promise between them — 「はじめまして、だよね」 right after they made one.
    const met = daysSince === null && (together.daysTogether > 0 || together.stage !== 'new' || latest) ? 1 : daysSince;
    const input = {
      star, lang, level: levelFromXp(xp), daysSince: met, memory: memory ? { facts: factsForAgent(memory.facts), summary: memory.summary } : null, ...together, promise, world,
      presence: routine.presence, status: routine.status.en, callName, ...(hour !== undefined && tz ? { tz } : {})
    };
    const template = greetingTemplate(lang, met, inScript(callName) ?? null, new Date(), news, star, together.stage, hour);
    fallback.text = template;
    // N-19: a greeting not in his language (or for another time of day, N-38) is asked for once more, strictly; still
    // not, or the persona service down, and she says her written greeting in his language — never an error.
    const written = (async (): Promise<string | null> => {
      let reason = 'language';
      for (const strict of [false, true]) {
        // One budget for both tries, so the answer always comes before a gateway gives up on it.
        const left = GREETING_BUDGET_MS - (Date.now() - started);
        if (left < 2_000) { reason = 'timeout'; break; }
        try {
          const said = await greetPersona(strict ? { ...input, strict } : input, left);
          const late = wrongTimeSalutation(said, hour ?? new Date());
          if (late) { reason = late; continue; }
          // Round 10: his e-mail handle (the account nickname) is never a name she calls him, in any language.
          if (handleIn(said, user)) { reason = 'email_handle'; continue; }
          if (inLanguage(said, lang, [inScript(callName), ...names])) {
            // The model left the rain out (7 of 20 on the test site): her weather words go first.
            const shown = withWeather(said, lang, news, 'before', star);
            await app.repos.chatMemory.setGreeting(user.id, star, { day, lang: met === null ? `${cacheLang}~first` : cacheLang, text: shown });
            return shown;
          }
          reason = 'language';
        } catch (e) {
          reason = e instanceof Error ? e.message : 'agent_unavailable';
          break;
        }
      }
      req.log.warn({ star, lang, reason }, 'greeting served from her written template');
      return null;
    })().catch((err) => { req.log.warn({ err: String(err) }, 'greeting_generation_failed'); return null; });
    // N-39: the model is off the hot path — it has a moment to answer; otherwise her written greeting now, and the
    // model's line, once it comes, is kept for his next visit.
    // Within the route's deadline: whatever the reads took is taken off the model's moment.
    const waitMs = Math.max(0, Math.min(Number(process.env.GREETING_WAIT_MS ?? GREETING_WAIT_MS), deadline - Date.now() - 150));
    const WAIT = Symbol('wait');
    const timer = new Promise<typeof WAIT>((r) => { const t = setTimeout(() => r(WAIT), waitMs); t.unref?.(); });
    const first = await Promise.race([written, timer]);
    if (first === WAIT) req.log.info({ star, lang }, 'greeting: her written line now, the model line cached for next time');
    return { text: typeof first === 'string' ? first : template, cached: false };
  }
}

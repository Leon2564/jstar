import type { CalendarEventInfo, Lang, Presence, RelationshipStage, StarId, SunPhase, WeatherAlert, WeatherCondition } from '@jstar/shared';
import { env } from '../env';
import type { AgentLook } from './bond';

export interface AgentTurn { role: 'user' | 'assistant'; text: string }
/** Long-term memory for one (user, talent): the agent reads it every turn and returns it updated. */
export interface AgentMemory { facts: Record<string, string>; summary: string | null }
/**
 * Where he stands with her (#54), for the persona's stage notes. `anniversary` is the JST day they became lovers;
 * `loverLevel` only while lovers. Omitted for visitors: the agent then treats him as just met.
 */
export interface AgentRelationship {
  stage?: RelationshipStage; daysTogether?: number; anniversary?: string | null; loverLevel?: number | null;
}
/**
 * A promise with her (#59), as the persona service sees it: `open` = still to come; `kept` = she is keeping it right
 * now (kept within the last window). `dueAt` is ISO UTC.
 */
export interface AgentPromise { text: string; dueAt: string; kind: 'wakeup' | 'message' | 'scene' | 'free'; status: 'open' | 'kept' }
/**
 * Her world this turn (#63, lib/herWorld.ts): the weather at her window and, if he chose a city, at his. Built by the
 * API from its own stored weather, never taken from the browser. `city` is her hometown's name only once the agency
 * confirmed it (#48); null = she says "here" and never names a city.
 */
export interface AgentWorld {
  city: string | null;
  /** Cherry-blossom season in her city (world.ts SEASONS): she may invite him to see the night blossoms. */
  sakura: boolean;
  now: {
    weather: WeatherCondition; tempC: number; isDay: boolean; phase: SunPhase; alert: WeatherAlert | null;
    /** Today is this season's first snow here. */
    firstSnow: boolean;
    hot: boolean;
  } | null;
  /** His city, when he chose one and both weathers are known. */
  user: { name: string; weather: WeatherCondition; tempC: number; isDay: boolean } | null;
  /**
   * What today is (#61, lib/calendar.ts), most important first: her birthday only once the agency confirmed it, his
   * birthday as a kind only (never the date or his age). Omitted on an ordinary day.
   */
  today?: CalendarEventInfo[];
}
/** What she is doing now by her routine (#60, lib/herWorld.ts `agentRoutine`); `status` is English, like #58's. */
export interface AgentRoutine { presence?: Presence | null; status?: string | null }
export interface AgentInput extends AgentRelationship, AgentRoutine {
  star: StarId; lang: Lang; history: AgentTurn[]; text: string; userId: string;
  /** His time zone (IANA), for a time he names (round 12); Japan's when absent. */
  tz?: string;
  /** QA #4: end her reply with his next words as choices (apps/agent/app/suggest.py). */
  suggest?: boolean;
  nickname?: string | null; level?: number; memory?: AgentMemory | null;
  /** This turn earns a memory card: the agent writes its title (or declines to, for a decline or support turn). */
  wantCard?: boolean;
  /** The promise with her (#59): she knows it, and the memory model makes no second one while it is open. */
  promise?: AgentPromise | null;
  /** #65: scenes he could ask for now (outside a scene), each with why it cannot start yet. */
  scenes?: AgentSceneOption[];
  /** #65: this turn is free talk inside a scene, which may turn along the step's declared jumps. */
  scene?: AgentSceneTalk;
  /** #78: her variant cards, for `outfit:<cardId>` requests and for bringing one up herself (outside a scene). */
  outfits?: AgentOutfitOption[];
  world?: AgentWorld | null;
  /** #77: what he knows she likes, and the one thing she may mention wanting in this reply (names in `lang`). */
  tastes?: AgentTastes;
  /** What she calls him now (#56): the stage's form of address with his name; null = no name she can use. */
  callName?: string | null;
  /** #56: her looks he could praise this turn (her usual outfit, her face, her variant card), the often-praised marked. */
  looks?: AgentLook[];
  /**
   * Memory updates (cost work, apps/agent/app/memory.py `memory_due`): `batch` = only when due, the turns in between
   * kept in chat_memory.pending and sent back as `unsaved`; `off` = never (a visitor's trial). The agent's default is
   * `every` (an update per turn).
   */
  memoryMode?: 'every' | 'batch' | 'off';
  /** The turns memory has not taken in yet, oldest first, not including this one. */
  unsaved?: AgentTurn[];
}
/**
 * Her tastes as the persona sees them (#77): `known` = liked things he has learned (she told him, or loved his gift);
 * `hint` = on this turn only, one thing she has been wanting and may mention in passing if it fits. Never a request.
 */
export interface AgentTastes { known: string[]; hint: string | null }
/** `cue` (#71): what he may say to ask for it without naming it — 「おやすみ」 for goodnight — hint for the model, words for the stub. */
export interface AgentSceneOption { id: string; title: string; ready: boolean; problems: string[]; cue?: { hint: string; words: string[] } }
export interface AgentSceneTalk { id: string; step: string; jumps: { to: string; hint: string; words: string[] }[] }
/**
 * One of her variant cards (#78), as the API sees it this turn. `pickup`: a Pickup of it is live. `invite`: she may
 * bring it up on her own now (PICKUP_RULES.invite passed), `line` being her reviewed line to say it in. `sceneId`: its
 * variant scene he could start now (#76), for an outfit he owns.
 */
export interface AgentOutfitOption { cardId: string; title: string; owned: boolean; pickup: boolean; invite: boolean; line: string | null; sceneId: string | null }
export interface AgentReply {
  reply: string; blocked: boolean; reason?: string | null; boundary?: string | null;
  /** Updated memory to persist; null when nothing changed. */
  memory?: AgentMemory | null;
  /** A safe, model-written card title; null when this turn must not become a card. */
  cardTitle?: string | null;
  /**
   * #65: `{ scene, action: 'start' | 'offer' }` for a scene he asked for, or `{ jumpTo }` in a scene's free talk;
   * #78: `{ outfit, action: 'pickup' | 'invite' }` when she mentioned her variant card he does not have.
   * Untrusted until checked against the scenes offered (chat.ts) or the script (the scene engine).
   */
  directive?: unknown;
  /** A promise both agreed on in this turn (#59): `{ text, dueAt, kind }` from the memory model. Untrusted until lib/promises.ts `heardPromise`. */
  promise?: unknown;
  /** #56: ids of her looks he praised in this turn, as the memory model heard them. Untrusted until lib/bond.ts `heard`. */
  praised?: unknown;
  /**
   * This turn and every `unsaved` one are in `memory` (or there is nothing to keep). `false`: memory did not take them
   * in this turn and the API keeps them for the next update. Absent (an agent that updates every turn): saved.
   */
  memorySaved?: boolean;
  /** QA #4: his next words, when asked for with `suggest`. Untrusted until chat.ts `suggestions`. */
  replies?: unknown;
}
/** One line of the agent's NDJSON stream (apps/agent/app/engine.py). */
export type AgentEvent =
  | { type: 'delta'; text: string }
  | { type: 'replace'; text: string }
  | { type: 'done'; reply: string; boundary: string | null; memory: AgentMemory | null; cardTitle: string | null; promise?: unknown; directive?: unknown; praised?: unknown; memorySaved?: boolean; replies?: unknown }
  | { type: 'blocked'; reason: string }
  | { type: 'error'; error: string };

/** Seconds. A turn is bounded end to end; the agent itself falls back to a second model well within these. */
const CHAT_TIMEOUT_MS = 45_000;
const STREAM_TIMEOUT_MS = 60_000;
const GREETING_TIMEOUT_MS = 20_000;

const unavailable = (cause?: unknown) => Object.assign(new Error('agent_unavailable', { cause }), { statusCode: 503 });
const headers = () => ({ 'content-type': 'application/json', authorization: `Bearer ${env.AGENT_API_KEY}` });

async function call(path: string, body: unknown, timeoutMs: number): Promise<Response> {
  let res: Response;
  try {
    res = await fetch(`${env.AGENT_BASE_URL}${path}`, { method: 'POST', headers: headers(), body: JSON.stringify(body), signal: AbortSignal.timeout(timeoutMs) });
  } catch (e) {
    throw unavailable(e);
  }
  if (!res.ok) throw unavailable(`http_${res.status}`);
  return res;
}

/**
 * Client for the persona service (apps/agent). The API never talks to a model directly:
 * persona prompts, memory extraction and the content boundary all live in one place.
 */
export async function askPersona(input: AgentInput): Promise<AgentReply> {
  return (await (await call('/v1/chat', input, CHAT_TIMEOUT_MS)).json()) as AgentReply;
}

/** The same turn, streamed: yields the agent's events as they arrive. Throws `agent_unavailable` if it cannot start. */
export async function* streamPersona(input: AgentInput): AsyncGenerator<AgentEvent> {
  const res = await call('/v1/chat/stream', input, STREAM_TIMEOUT_MS);
  if (!res.body) throw unavailable('no_body');
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  try {
    for (;;) {
      let chunk: Awaited<ReturnType<typeof reader.read>>;
      try { chunk = await reader.read(); } catch (e) { throw unavailable(e); }
      if (chunk.done) break;
      buf += decoder.decode(chunk.value, { stream: true });
      let nl: number;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (line) yield JSON.parse(line) as AgentEvent;
      }
    }
    if (buf.trim()) yield JSON.parse(buf) as AgentEvent;
  } finally {
    reader.releaseLock();
  }
}

export interface GreetingInput extends AgentRelationship, AgentRoutine { star: StarId; lang: Lang; nickname?: string | null; level: number; daysSince: number | null; memory?: AgentMemory | null; promise?: AgentPromise | null; world?: AgentWorld | null; callName?: string | null; strict?: boolean; tz?: string }

/**
 * Her message written on her own (#58): what the persona service needs beyond memory and the relationship — what she
 * is doing now (her routine, in English for the prompt), the weather where she is (never the city: it may be
 * unconfirmed), and for an invitation the scene she has in mind.
 */
export interface HerMessageInput extends AgentRelationship {
  star: StarId; lang: Lang; kind: 'dream' | 'note' | 'invite'; userId: string;
  nickname?: string | null; level: number; memory?: AgentMemory | null; promise?: AgentPromise | null;
  status?: string | null; weather?: string | null; scene?: string | null;
  /** What she calls him now (#56). */
  callName?: string | null;
}
/** Tight: the tick waits on it, and her fallback line is always there. */
const HER_MESSAGE_TIMEOUT_MS = 9_000;

/** Her message as the model wrote it and the safety pass kept it; null when the model failed or it was thrown away. */
export async function herMessagePersona(input: HerMessageInput): Promise<string | null> {
  const body = (await (await call('/v1/her-message', input, HER_MESSAGE_TIMEOUT_MS)).json()) as { text?: string | null };
  return typeof body.text === 'string' && body.text.trim() ? body.text.trim() : null;
}

/** M18: her message (#58), written in another language, said again in his — what the persona service needs for it. */
export interface HerRestateInput {
  star: StarId; lang: Lang; text: string;
  /** What she calls him in `lang` (#56): kept as it is. */
  callName?: string | null;
}
/** One cheap call; the inbox waits on it only this long, and shows her words as written otherwise. */
const HER_RESTATE_TIMEOUT_MS = 6_000;

/** Her message in `lang`, through the persona service's checks; null when it could not be had. */
export async function restateHerMessagePersona(input: HerRestateInput): Promise<string | null> {
  const body = (await (await call('/v1/her-message/restate', input, HER_RESTATE_TIMEOUT_MS)).json()) as { text?: string | null };
  return typeof body.text === 'string' && body.text.trim() ? body.text.trim() : null;
}

/** The turns memory has not taken in yet, for the persona service to fold in (he left, or the chat went quiet). */
export interface MemoryFlushInput { star: StarId; lang: Lang; userId: string; memory: AgentMemory | null; unsaved: AgentTurn[] }
/** `saved: false`: the memory model failed; the turns stay pending and are tried again later. */
export interface MemoryFlushResult { memory: AgentMemory | null; saved: boolean }
/** A summary is one model call; the tick and his leaving both wait on it only this long. */
const MEMORY_FLUSH_TIMEOUT_MS = 15_000;

export async function flushMemoryPersona(input: MemoryFlushInput): Promise<MemoryFlushResult> {
  const body = (await (await call('/v1/memory/flush', input, MEMORY_FLUSH_TIMEOUT_MS)).json()) as Partial<MemoryFlushResult>;
  return { memory: body.memory ?? null, saved: body.saved === true };
}

/** Her first line on the companion home. */
export async function greetPersona(input: GreetingInput, timeoutMs: number = GREETING_TIMEOUT_MS): Promise<string> {
  const body = (await (await call('/v1/greeting', input, Math.min(timeoutMs, GREETING_TIMEOUT_MS))).json()) as { text?: string };
  if (!body.text) throw unavailable('empty_greeting');
  return body.text;
}

/**
 * A gift he just gave her (#77), for her reaction. `taste`: how it lands with her; `wished`: she had mentioned wanting
 * it, and `wishLine` is what she said then (her own words, so she can refer to them). `fallback` is her written line,
 * which the persona service answers with when the model cannot.
 */
export interface GiftReactionInput extends AgentRelationship {
  star: StarId; lang: Lang; nickname?: string | null; level: number; memory?: AgentMemory | null;
  gift: { id: string; name: string }; taste: 'liked' | 'plain' | 'disliked'; wished: boolean; wishLine: string | null; fallback: string;
}
const GIFT_TIMEOUT_MS = 15_000;

/** Her reaction to a gift, in her voice. Throws `agent_unavailable`; the caller then says her written line. */
export async function giftPersona(input: GiftReactionInput): Promise<string> {
  const body = (await (await call('/v1/gift', input, GIFT_TIMEOUT_MS)).json()) as { text?: string };
  if (!body.text) throw unavailable('empty_gift_reaction');
  return body.text;
}

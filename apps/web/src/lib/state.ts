import { STAR_IDS, isStarId, type StarId } from '../data/cast';
import { isCardId } from '../data/cardIds';
import { chatLeft, jstDay } from '@jstar/shared/rules';
import { levelFromXp } from '@jstar/shared/domain';
import { CONFIG } from './config';
import { detectLang, isLang, type Lang } from '../i18n';
import type { InboxItemT, RelationshipViewT, VariantStateT, VoiceStateT } from '@jstar/shared/contracts';
import { isRelationshipStage, type RelationshipState } from '@jstar/shared/relationship';
import { isConfessionAnswer, type ConfessionState } from '@jstar/shared/confession';

export type From = 'me' | 'her' | 'system';
/** `failed` (M10): his line that did not go — marked wherever the conversation shows it, until he sends it again. */
export interface Msg { id: string; from: From; text: string; kind?: 'text' | 'voice' | 'memory'; ref?: string; failed?: true }
/** `still` (#51): a scene card's picture — the clip on screen when it was made (a media id or family). */
/** `sceneId` (N-20): a scene's card, so its title can be shown in the language of the moment. */
export interface MemoryCard { id: string; star: StarId; title: string; date: string; still?: string; sceneId?: string; kind?: 'chat' | 'scene' | 'promise' | 'confession' }
/** `named` (M4): he chose his nickname; until then it is a stand-in made from his address and never shown as his name. */
export interface User { via: 'line' | 'email'; email?: string; nickname: string; named?: boolean }
/** The cards of the last redeemed code, in draw order (the first is the guaranteed SR+), for the result screen. */
/** `seen` (L10): its reveal was played out once; coming back shows the cards face up. */
export interface LastRedeem { cards: { id: string; isNew: boolean }[]; days: number; seen?: boolean }

export interface AppState {
  v: 1;
  ageOk: boolean;
  user: User | null;
  star: StarId;
  trialStar: StarId;
  trialLeft: number;
  trialLog: Msg[];
  chats: Record<StarId, Msg[]>;
  affinity: Record<StarId, number>;
  owned: Record<string, number>;
  /** The official card manually placed into each talent's presentation; owning a card alone never selects it. */
  selectedCards: Partial<Record<StarId, string>>;
  memories: MemoryCard[];
  points: number;
  freePulls: number;
  /** Pulls since the last SSR or better, and exchange shards (server-authoritative in server mode). */
  pity: number;
  shards: number;
  /** Pool picked on the gacha screen: "all" or "star:<id>". */
  gachaPool: string;
  /** Monthly check-in: login days this month and reward days paid. */
  checkIn: { month: string; days: number; claimed: number[] };
  redeemed: string[];
  serialFails: number;
  serialLockUntil: number;
  lastPull: string[];
  lastRedeem: LastRedeem | null;
  sound: boolean;
  lang: Lang;
  /** Monthly pass expiry and the daily chat counter (docs/requirements.md §3–4). Server mode overwrites these from the API. */
  passUntil: string | null;
  chatDay: string;
  chatUsed: number;
  bonusDay: string | null;
  redeemedCount: number;
  /** Transient: pass points granted on this visit, shown once. Never persisted. */
  bonusNotice: number;
  /** Transient: false until the API confirms the account's birthday (asked once after sign-up). Never persisted. */
  birthdayOk: boolean;
  /** Transient: her delivered inbox items (GET /v1/inbox, unread first), for the companion-home badges. Never persisted. */
  inbox: InboxItemT[];
  /**
   * Prototype mode's own relationship stage machine per talent (#54), run by the same shared rules the API applies.
   * Server mode never reads it: there the API is the only place a stage moves.
   */
  rel: Partial<Record<StarId, RelationshipState>>;
  /** Transient: the relationship with each talent as the API reported it (GET /v1/relationship, chat turns). Never persisted. */
  relView: Partial<Record<StarId, RelationshipViewT>>;
  /** Prototype mode's record of her confession per talent (#55), beside `rel`. Server mode never reads it. */
  confession: Partial<Record<StarId, ConfessionState>>;
  /**
   * Transient: his voice time today as the API reports it (#74, and whether her runtime voice is on for him, #73).
   * Null in prototype mode and for visitors: no meter, no limit, her lines as they always were. Never persisted.
   */
  voice: VoiceStateT | null;
  /**
   * Transient: his variant cards' own state as the API reported it (#75, #76: level, layers, her home pin), by card
   * id. Never persisted; prototype mode has none, and every variant card reads as level 1 there.
   */
  variants: Partial<Record<string, VariantStateT>>;
  /** Transient (M3): a word for the next screen — he just logged out. Never persisted. */
  notice: 'loggedOut' | null;
}

const STORAGE_KEY = 'jstar.v1';
const MAX_MSGS = 200;
const MAX_TEXT = 500;

function emptyByStar<T>(v: () => T): Record<StarId, T> {
  return Object.fromEntries(STAR_IDS.map((id) => [id, v()])) as Record<StarId, T>;
}

/** A card's still as stored: a media id or family, nothing else (#51). */
const stillOf = (v: unknown): { still?: string } => (typeof v === 'string' && /^[a-z0-9-]{3,80}$/.test(v) ? { still: v } : {});

export function initialState(): AppState {
  return {
    v: 1, ageOk: false, user: null, star: 'mahiro', trialStar: 'mahiro',
    trialLeft: CONFIG.trialMessages, trialLog: [],
    chats: emptyByStar<Msg[]>(() => []), affinity: emptyByStar(() => 0),
    owned: {}, selectedCards: {}, memories: [], points: 0, freePulls: 1, pity: 0, shards: 0, gachaPool: 'all', checkIn: { month: '', days: 0, claimed: [] }, redeemed: [],
    serialFails: 0, serialLockUntil: 0, lastPull: [], lastRedeem: null, sound: false, lang: 'ja',
    passUntil: null, chatDay: '', chatUsed: 0, bonusDay: null, redeemedCount: 0, bonusNotice: 0, birthdayOk: true,
    inbox: [], rel: {}, relView: {}, confession: {}, voice: null, variants: {}, notice: null
  };
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const clampInt = (v: unknown, min: number, max: number, dflt: number) =>
  typeof v === 'number' && Number.isFinite(v) ? Math.min(max, Math.max(min, Math.floor(v))) : dflt;
const str = (v: unknown, max = MAX_TEXT) => (typeof v === 'string' ? v.slice(0, max) : '');
const isoOrNull = (v: unknown) => (typeof v === 'string' && v.length <= 40 && !Number.isNaN(Date.parse(v)) ? v : null);

function cleanRedeem(v: unknown): LastRedeem | null {
  if (!isObj(v) || !Array.isArray(v.cards)) return null;
  const cards = v.cards.slice(0, 10).flatMap((c) => (isObj(c) && isCardId(c.id) ? [{ id: c.id, isNew: c.isNew === true }] : []));
  return cards.length ? { cards, days: clampInt(v.days, 0, 90, 0), ...(v.seen === true ? { seen: true } : {}) } : null;
}

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const dayOrNull = (v: unknown) => (typeof v === 'string' && DAY_RE.test(v) ? v : null);

/** A stored prototype relationship; anything malformed starts that talent over at `new` rather than guessing. */
function cleanRel(v: unknown): RelationshipState | null {
  if (!isObj(v) || !isRelationshipStage(v.stage)) return null;
  const days = clampInt(v.daysTogether, 0, 100_000, 0);
  return {
    stage: v.stage, stageSince: isoOrNull(v.stageSince) ?? new Date(0).toISOString(), stageDay: clampInt(v.stageDay, 0, days, 0), daysTogether: days,
    lastDay: dayOrNull(v.lastDay), confessedAt: isoOrNull(v.confessedAt), anniversary: dayOrNull(v.anniversary),
    loverXp: v.loverXp === null || v.loverXp === undefined ? null : clampInt(v.loverXp, 0, 10_000_000, 0), rewardRank: clampInt(v.rewardRank, 0, 99, 0)
  };
}

/** A stored prototype confession; anything malformed starts it over. */
function cleanConfession(v: unknown): ConfessionState | null {
  if (!isObj(v)) return null;
  const round = (x: unknown) => (x === null || x === undefined ? -1 : clampInt(x, -1, 99, -1));
  return {
    tries: clampInt(v.tries, 0, 99, 0), lastAnswer: isConfessionAnswer(v.lastAnswer) ? v.lastAnswer : null,
    answeredDays: v.answeredDays === null || v.answeredDays === undefined ? null : clampInt(v.answeredDays, 0, 100_000, 0), answeredOn: dayOrNull(v.answeredOn),
    invitedRound: round(v.invitedRound), reachedRound: round(v.reachedRound), reachedOn: dayOrNull(v.reachedOn)
  };
}

function cleanMsgs(v: unknown): Msg[] {
  if (!Array.isArray(v)) return [];
  return v.slice(-MAX_MSGS).flatMap((m): Msg[] => {
    if (!isObj(m) || !['me', 'her', 'system'].includes(m.from as string)) return [];
    const kind = ['text', 'voice', 'memory'].includes(m.kind as string) ? (m.kind as Msg['kind']) : 'text';
    return [{ id: str(m.id, 40) || Math.random().toString(36).slice(2), from: m.from as From, text: str(m.text), kind, ref: m.ref ? str(m.ref, 60) : undefined, ...(m.failed === true && m.from === 'me' ? { failed: true as const } : {}) }];
  });
}

/**
 * Loads persisted state and re-validates every field.
 * Anything malformed or tampered with falls back to a safe default instead of crashing.
 * NOTE: points, owned cards and trial counters are client-side only in the prototype;
 * in production they are server-authoritative and this cache is display-only.
 */
export function sanitize(raw: unknown): AppState {
  const d = initialState();
  if (!isObj(raw) || raw.v !== 1) return d;
  const user = isObj(raw.user) && (raw.user.via === 'line' || raw.user.via === 'email')
    ? { via: raw.user.via as User['via'], email: raw.user.email ? str(raw.user.email, 120) : undefined, nickname: str(raw.user.nickname, 20) || 'あなた', ...(typeof raw.user.named === 'boolean' ? { named: raw.user.named } : {}) }
    : null;
  const chats = emptyByStar<Msg[]>(() => []);
  const affinity = emptyByStar(() => 0);
  if (isObj(raw.chats)) for (const id of STAR_IDS) chats[id] = cleanMsgs(raw.chats[id]);
  if (isObj(raw.affinity)) for (const id of STAR_IDS) affinity[id] = clampInt(raw.affinity[id], 0, 100000, 0);
  const owned: Record<string, number> = {};
  if (isObj(raw.owned)) for (const [k, n] of Object.entries(raw.owned)) if (isCardId(k)) owned[k] = clampInt(n, 1, 999, 1);
  const selectedCards: Partial<Record<StarId, string>> = {};
  if (isObj(raw.selectedCards)) for (const id of STAR_IDS) {
    const cardId = raw.selectedCards[id];
    if (typeof cardId === 'string' && isCardId(cardId) && cardId.startsWith(`s1-${id}-`) && owned[cardId]) selectedCards[id] = cardId;
  }
  const memories = Array.isArray(raw.memories)
    ? raw.memories.slice(-100).flatMap((m): MemoryCard[] => (isObj(m) && isStarId(m.star) ? [{ id: str(m.id, 40), star: m.star, title: str(m.title, 40), date: str(m.date, 10), ...stillOf(m.still), ...(typeof m.sceneId === 'string' && m.sceneId ? { sceneId: str(m.sceneId, 60) } : {}), ...(['chat', 'scene', 'promise', 'confession'].includes(m.kind as string) ? { kind: m.kind as MemoryCard['kind'] } : {}) }] : []))
    : [];
  return {
    v: 1,
    ageOk: raw.ageOk === true,
    user,
    star: isStarId(raw.star) ? raw.star : d.star,
    trialStar: isStarId(raw.trialStar) ? raw.trialStar : d.trialStar,
    trialLeft: clampInt(raw.trialLeft, 0, CONFIG.trialMessages, CONFIG.trialMessages),
    trialLog: cleanMsgs(raw.trialLog).slice(-20),
    chats, affinity, owned, selectedCards, memories,
    points: clampInt(raw.points, 0, 10_000_000, 0),
    freePulls: clampInt(raw.freePulls, 0, 99, 0),
    pity: clampInt(raw.pity, 0, CONFIG.pityPulls, 0),
    shards: clampInt(raw.shards, 0, 1_000_000, 0),
    gachaPool: /^(all|star:(mahiro|nana|unpai|alice|eimi))$/.test(str(raw.gachaPool, 20)) ? str(raw.gachaPool, 20) : 'all',
    checkIn: isObj(raw.checkIn)
      ? { month: /^\d{4}-\d{2}$/.test(str(raw.checkIn.month, 7)) ? str(raw.checkIn.month, 7) : '', days: clampInt(raw.checkIn.days, 0, 31, 0),
          claimed: Array.isArray(raw.checkIn.claimed) ? raw.checkIn.claimed.filter((d): d is number => typeof d === 'number' && d > 0 && d <= 31).slice(0, 8) : [] }
      : { month: '', days: 0, claimed: [] },
    redeemed: Array.isArray(raw.redeemed) ? raw.redeemed.filter((c): c is string => typeof c === 'string').slice(-200).map((c) => c.slice(0, 20)) : [],
    serialFails: clampInt(raw.serialFails, 0, 1000, 0),
    serialLockUntil: clampInt(raw.serialLockUntil, 0, Number.MAX_SAFE_INTEGER, 0),
    lastPull: Array.isArray(raw.lastPull) ? raw.lastPull.filter(isCardId).slice(0, 10) : [],
    lastRedeem: cleanRedeem(raw.lastRedeem),
    sound: raw.sound === true,
    lang: isLang(raw.lang) ? raw.lang : d.lang,
    passUntil: isoOrNull(raw.passUntil),
    chatDay: /^\d{4}-\d{2}-\d{2}$/.test(str(raw.chatDay, 10)) ? str(raw.chatDay, 10) : '',
    chatUsed: clampInt(raw.chatUsed, 0, 10_000, 0),
    bonusDay: /^\d{4}-\d{2}-\d{2}$/.test(str(raw.bonusDay, 10)) ? str(raw.bonusDay, 10) : null,
    redeemedCount: clampInt(raw.redeemedCount, 0, 10_000, 0),
    bonusNotice: 0,
    birthdayOk: true,
    inbox: e2eInbox(),
    rel: isObj(raw.rel) ? Object.fromEntries(STAR_IDS.flatMap((id) => { const r = cleanRel((raw.rel as Record<string, unknown>)[id]); return r ? [[id, r]] : []; })) : {},
    relView: {},
    voice: null,
    confession: isObj(raw.confession) ? Object.fromEntries(STAR_IDS.flatMap((id) => { const c = cleanConfession((raw.confession as Record<string, unknown>)[id]); return c ? [[id, c]] : []; })) : {},
    variants: {},
    notice: null
  };
}

/**
 * Her inbox comes from the API only; the e2e suite (prototype mode, no API) may hand one in (`window.__INBOX__`, only
 * with `__E2E__`, like `__PICKUPS__`) to show her messages and her call (tests/e2e/roomVisual.spec.ts).
 */
function e2eInbox(): InboxItemT[] {
  const w = (typeof window === 'undefined' ? {} : window) as { __E2E__?: boolean; __INBOX__?: InboxItemT[] };
  return w.__E2E__ && Array.isArray(w.__INBOX__) ? w.__INBOX__ : [];
}

export function load(): AppState {
  try {
    const s = window.localStorage.getItem(STORAGE_KEY);
    return s ? sanitize(JSON.parse(s)) : { ...initialState(), lang: detectLang(window.navigator?.language) };
  } catch {
    return initialState();
  }
}

export function save(state: AppState): void {
  try {
    // Her inbox, the API's relationship view, his voice time and his variant cards' state are account data the server holds; they never go into the browser's storage.
    const { inbox: _inbox, relView: _relView, voice: _voice, variants: _variants, notice: _notice, ...kept } = state;
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(kept));
  } catch {
    /* storage full or blocked (private mode): the session keeps working in memory */
  }
}

export function clearSaved(): void {
  try { window.localStorage.removeItem(STORAGE_KEY); } catch { /* ignore */ }
}

export function level(aff: number): number {
  return levelFromXp(aff);
}

/** Messages left today for a registered user; null while the monthly pass is active. */
export function chatLeftOf(s: Pick<AppState, 'chatDay' | 'chatUsed' | 'passUntil'>): number | null {
  return chatLeft(s.chatDay === jstDay() ? s.chatUsed : 0, s.passUntil);
}

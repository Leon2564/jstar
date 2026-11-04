/**
 * Service layer. Pages only talk to this module.
 *
 * With VITE_API_BASE set (server mode) every call goes to @jstar/api and the result is authoritative.
 * Without it (prototype mode, used for offline demos and the e2e suite) the same rules from
 * @jstar/shared/rules are applied to the browser state. Either way a call returns the API's response
 * shape, and failures throw ApiError with the API's error code — so pages handle one contract.
 */
// Subpath imports keep zod (contracts) out of the entry bundle; the contract types are erased at build time.
import type { BondResT, CallAnswerResT, CardAffectionResT } from '@jstar/shared/contracts';
import { RULES, extendPass } from '@jstar/shared/rules';
import { levelFromXp } from '@jstar/shared/domain';
import { isExchangeable } from '@jstar/shared/variants';
import { freshRelationship, viewOf } from '@jstar/shared/relationship';
import type { ChatSendResT, DeviceResT, DrawHistoryResT, DrawResT, ExchangeResT, InboxReadResT, InboxResT, MeResT, PromiseItemT, PromisesResT, RedemptionHistoryResT, RelationshipResT, RelationshipViewT, SerialRedeemResT } from '@jstar/shared/contracts';
import { confessionStatus } from '@jstar/shared/confession';
import type { ConfessionMemoryT, MemoryExportT } from '@jstar/shared/contracts';
import type { CalendarResT } from '@jstar/shared/contracts';
import type { StarId } from '../data/cast';
import { type AppState, type Msg, type User } from '../lib/state';
import { translate, type Key, type Lang } from '../i18n';
import { DEMO_SERIALS, isValidSerialFormat, normalizeSerial } from '../lib/serial';
import { ApiError, getToken, http, serverMode, setToken, type OnText } from './http';
import { setTurnstileKey } from '../lib/turnstile';
import { pushSignedOut, setPushKey } from '../lib/push';

export { ApiError, serverMode };
export type { OnText };
export const errorCode = (e: unknown): string => (e instanceof ApiError ? e.code : 'network');
/** The content boundary refused the message (docs/compliance-jp.md §6); it was not counted. */
export const isBlocked = (e: unknown): boolean => e instanceof ApiError && e.status === 422;

const latency = () => new Promise((r) => setTimeout(r, (window as unknown as { __E2E__?: boolean }).__E2E__ ? 20 : 350));
const fail = (code: string, status: number): never => { throw new ApiError(code, status); };
let seq = 0;
const localId = (p: string) => `${p}_${Date.now().toString(36)}${(seq++).toString(36)}`;

export const EMAIL_RE = /^[^\s@<>()[\]\\,;:"]{1,64}@[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)+$/;
export const DEMO_OTP = '1234';

/** Whether to show demo hints (the fixed code on the sign-up screen). Resolved once before the first render. */
let demo = !serverMode();
export const isDemo = () => demo;
let runtimeVoice = false;
let runtimeVoiceStars: string[] = [];
/** Public availability only; the API still verifies every signed line before synthesizing it. */
export const trialVoiceFor = (star: StarId): boolean => runtimeVoice && runtimeVoiceStars.includes(star);
export async function loadConfig(): Promise<void> {
  if (!serverMode()) return;
  try {
    const c = await http.config();
    demo = c.demo; setTurnstileKey(c.turnstile); setPushKey(c.vapidPublicKey); asr = !!c.asr;
    runtimeVoice = !!c.voice;
    runtimeVoiceStars = c.voiceStars ?? [];
  } catch { demo = false; runtimeVoice = false; runtimeVoiceStars = []; }
}

// ---------------------------------------------------------------- voice input (#72)

/** The API transcribes recordings (`POST /v1/asr`), for browsers without speech recognition of their own. */
let asr = false;
export const asrOn = () => asr && serverMode() && !!getToken();
/** His recorded words as text. The clip is sent once and kept nowhere. */
export async function transcribeClip(clip: Blob, lang: string): Promise<string> {
  return (await http.asr(clip, lang)).text;
}

// ---------------------------------------------------------------- session

export type Bootstrap = { kind: 'member'; me: MeResT } | { kind: 'visitor'; device: DeviceResT } | { kind: 'signed-out' } | { kind: 'offline' };

/** Server state that replaces the browser cache on load. Prototype mode has nothing to fetch. */
export async function bootstrap(): Promise<Bootstrap> {
  if (!serverMode()) return { kind: 'offline' };
  try {
    if (getToken()) return { kind: 'member', me: await http.me() };
    return { kind: 'visitor', device: await http.device() };
  } catch (e) {
    if (e instanceof ApiError && e.status === 401) { setToken(null); return { kind: 'signed-out' }; }
    return { kind: 'offline' };
  }
}

/** M1: resolves with how many minutes the code is good for (the form says so). */
export async function sendOtp(email: string, lang = 'ja'): Promise<number> {
  if (!EMAIL_RE.test(email.trim()) || email.length > 120) fail('invalid_email', 400);
  if (serverMode()) return (await http.otpStart(email.trim(), lang)).ttlMinutes ?? 10;
  await latency();
  return 10;
}

export interface Login { user: User; me: MeResT | null }

export async function verifyOtp(code: string, email: string, lang?: string): Promise<Login> {
  if (serverMode()) {
    const s = await http.otpVerify(email.trim(), code, lang);
    setToken(s.token);
    return { user: { via: 'email', email: email.trim(), nickname: s.user.nickname, named: s.user.named }, me: await http.me() };
  }
  await latency();
  if (code !== DEMO_OTP) fail('invalid_code', 400);
  return { user: { via: 'email', email: email.trim(), nickname: email.split('@')[0].replace(/[^\p{L}\p{N}_-]/gu, '').slice(0, 12) || 'あなた' }, me: null };
}

/** #176: keep the account's language (what the server writes for him in) the app's; signed in, server mode only. */
export async function syncLang(lang: string): Promise<void> {
  if (!serverMode() || !getToken()) return;
  try { await http.setLang(lang); } catch { /* next load tries again */ }
}

export function logout(): void {
  const token = getToken();
  setToken(null);
  // This browser stops receiving the signed-out account's notifications (lock screens are shared screens).
  pushSignedOut(token);
}

// ---------------------------------------------------------------- chat

function stubReply(turn: number, text: string, lang: Lang): string {
  // e2e: her reply of the test's choosing (her room's geometry with her longest line, tests/e2e/roomVisual.spec.ts).
  const w = window as unknown as { __E2E__?: boolean; __REPLY__?: string };
  return (w.__E2E__ && w.__REPLY__) || translate(lang, `reply.${turn % 6}` as Key, { last: text.slice(0, 24) });
}

/** Prototype mode: plays the stub reply out in pieces, the way the server streams a real one. */
async function playOut(reply: string, onText?: OnText): Promise<void> {
  if (!onText) return;
  const step = Math.max(1, Math.ceil(reply.length / 4));
  for (let i = step; i < reply.length + step; i += step) {
    onText(reply.slice(0, i));
    await new Promise((r) => setTimeout(r, (window as unknown as { __E2E__?: boolean }).__E2E__ ? 5 : 60));
  }
}

/**
 * Trial replies use the regular JSON endpoint even when the page asks for progressive text. Public preview tunnels
 * may close an NDJSON response after the model has already finished the turn; that made a valid visitor message look
 * unsent and encouraged a retry that could spend another trial turn. Playing the completed reply out locally keeps
 * the same typing presentation while the server remains the single authority for the turn and its allowance.
 */
export async function trialChat(state: AppState, star: StarId, text: string, lang: Lang, onText?: OnText): Promise<ChatSendResT> {
  if (serverMode()) {
    const result = await http.trialChat(star, text, lang);
    await playOut(result.reply, onText);
    return result;
  }
  await latency();
  if (state.trialLeft <= 0) fail('trial_exhausted', 402);
  const turn = state.trialLog.filter((m) => m.from === 'me').length;
  const reply = stubReply(turn, text, lang);
  await playOut(reply, onText);
  return { reply, affinityXp: 0, level: 1, memoryCard: null, trialMessagesLeft: state.trialLeft - 1, chatLeft: null, points: state.points, freePulls: state.freePulls };
}

/**
 * `suggest`: her room asks for his next words with her reply (QA #4, `replies`).
 * Server turns use the complete JSON response, then play the finished line out locally. This keeps one authoritative
 * request per message while preserving progressive subtitles across proxies and browsers with fragile stream reads.
 */
export async function chat(state: AppState, star: StarId, text: string, lang: Lang, onText?: OnText, suggest?: boolean, channel: 'text' | 'video' = 'text'): Promise<ChatSendResT> {
  if (serverMode()) {
    const result = await http.chat(star, text, lang, suggest, channel);
    await playOut(result.reply, onText);
    return result;
  }
  await latency();
  const cost = channel === 'text' ? RULES.textMessageCostPoints : 0;
  if (state.points < cost) fail('insufficient_points', 402);
  const points = state.points - cost;
  const xp = state.affinity[star] + RULES.xpPerMessage;
  const mine = state.chats[star].filter((m) => m.from === 'me').length + 1;
  // Like the server, the card is titled for the moment, never with his raw words.
  const memoryCard = mine % RULES.memoryCardEvery === 0
    ? { id: localId('mem'), title: translate(lang, 'chat.memoryTitle'), createdAt: new Date().toISOString() }
    : null;
  const reply = stubReply(mine, text, lang);
  await playOut(reply, onText);
  // The relationship's free pulls (a stage entered, #54) are added by the store, which runs the stage machine.
  return { reply, affinityXp: xp, level: levelFromXp(xp), memoryCard, trialMessagesLeft: null, chatLeft: Math.floor(points / RULES.textMessageCostPoints), points, freePulls: state.freePulls };
}

/** Her greeting for the companion home (GET /v1/chat/greeting); null offline or on any failure, so the page keeps its own line. */
export async function greeting(star: StarId, lang: Lang): Promise<string | null> {
  if (!serverMode()) return null;
  try { return (await http.greeting(star, lang)).text; } catch { return null; }
}

/** Server-mode conversation history for one talent; null in prototype mode (the browser holds it). */
export async function history(star: StarId): Promise<Msg[] | null> {
  if (!serverMode()) return null;
  const { messages } = await http.history(star);
  return messages.map((m) => ({ id: m.id, from: m.role === 'user' ? 'me' : 'her', text: m.text }));
}

// ---------------------------------------------------------------- relationship stages (#54)

/** All five relationships from the API; null in prototype mode (the browser runs its own) or on failure. */
/** The five relationships as last read for this session (round 13): shown while a new read is retried. */
const relKey = () => `jstar.relView.${(getToken() ?? '').slice(-12)}`;
export function lastRelationships(): RelationshipResT | null {
  try { return JSON.parse(localStorage.getItem(relKey()) || 'null') as RelationshipResT | null; } catch { return null; }
}

/**
 * The five relationships. Round 13: a 429 or a server/network failure is tried again with backoff (its Retry-After
 * honoured, at most 5 s), so her status panel does not lose its stage row for a moment's rate limit; the last read is
 * kept for the next visit. Null after the last try (the caller keeps what it shows).
 */
export async function relationships(o: { tries?: number; wait?: (ms: number) => Promise<unknown> } = {}): Promise<RelationshipResT | null> {
  if (!serverMode()) return null;
  const tries = o.tries ?? 4;
  const wait = o.wait ?? ((ms: number) => new Promise((ok) => setTimeout(ok, ms)));
  for (let i = 0; i < tries; i++) {
    try {
      const r = await http.relationship();
      try { localStorage.setItem(relKey(), JSON.stringify(r)); } catch { /* storage blocked: nothing kept */ }
      return r;
    } catch (e) {
      const status = e instanceof ApiError ? e.status : 0;
      if (status && status !== 429 && status < 500) return null;
      if (i + 1 < tries) await wait(Math.min(e instanceof ApiError && e.retryAfterMs != null ? e.retryAfterMs : 800 * 2 ** i, 5_000));
    }
  }
  return null;
}

/** Where he stands with her, for the panel and the story unlock: the API's word in server mode, the browser's own otherwise. */
export function relationshipOf(state: Pick<AppState, 'rel' | 'relView' | 'affinity'> & Partial<Pick<AppState, 'confession'>>, star: StarId): RelationshipViewT | null {
  if (serverMode()) return state.relView[star] ?? null;
  const rel = state.rel[star] ?? freshRelationship(new Date(0).toISOString());
  // Prototype mode is a demo: her confession (#55) is offered whatever the review state of her lines.
  return { ...viewOf(star, rel, state.affinity[star]), confession: confessionStatus(star, rel, state.confession?.[star] ?? null) };
}

/**
 * Demo / test site only: today becomes her confession day (#55). Server mode asks the API (POST /v1/relationship/demo)
 * and returns her new view; prototype mode returns null and the store sets it.
 */
export async function demoConfessionDay(star: StarId): Promise<RelationshipViewT | null> {
  return serverMode() ? http.relationshipDemo(star, 'confession_ready') : null;
}

// ---------------------------------------------------------------- her year with him (#61)

/** What today is with each of the five, most important first; null in prototype mode (no calendar there) or on failure. */
export async function calendarToday(): Promise<CalendarResT | null> {
  if (!serverMode()) return null;
  try { return await http.calendar(); } catch { return null; }
}
/** Test site only: pretend `day` ("YYYY-MM-DD") is today for a while; her messages for it arrive with the next tick. */
export async function demoCalendarDay(day: string): Promise<CalendarResT | null> {
  if (!serverMode() || !isDemo()) return null;
  try { return await http.calendarDemo(day); } catch { return null; }
}

// ---------------------------------------------------------------- her confession (#55)

/** The memories of his yes (his words, whether his voice is kept). Empty in prototype mode, which keeps no recordings. */
export async function confessionMemories(): Promise<ConfessionMemoryT[]> {
  if (!serverMode()) return [];
  try { return (await http.confessionMemories()).memories; } catch { return []; }
}
/** Keeps the recording of his yes, sent only because he ticked the consent box (docs/compliance-jp.md §7.3). */
export async function keepConfessionVoice(memoryId: string, clip: Blob): Promise<boolean> {
  if (!serverMode()) return false;
  try { await http.confessionKeep(memoryId, clip); return true; } catch { return false; }
}
export async function confessionVoice(memoryId: string): Promise<Blob> {
  return http.confessionAudio(memoryId);
}
export async function forgetConfessionVoice(memoryId: string): Promise<ConfessionMemoryT> {
  return (await http.confessionForget(memoryId)).memory;
}

// ---------------------------------------------------------------- his export (#51)

/**
 * Everything he has with them as one JSON file (the server's MemoryExport, with signed links to his recordings).
 * Prototype mode has only this browser's memory cards, so the file holds those. Throws ApiError `export_limit` (429)
 * after today's export.
 */
export async function exportMemories(state: Pick<AppState, 'memories' | 'user' | 'lang'>): Promise<Blob> {
  if (serverMode()) return http.exportMemories();
  const now = new Date().toISOString();
  const local: MemoryExportT = {
    format: 'jstar-memories', version: 1, exportedAt: now,
    account: { id: 'local', nickname: state.user?.nickname ?? '', email: state.user?.email ?? null, lang: state.lang, createdAt: now },
    // #51: a scene card's still is its clip's poster, public like the clip (the API's `stillLink`).
    memories: state.memories.map((m) => ({
      id: m.id, star: m.star, kind: m.still ? 'scene' : 'chat', title: m.title, sceneId: null, createdAt: m.date,
      still: m.still ? { type: 'image/jpeg', url: `${location.origin}/media/${/-\d+x\d+$/.test(m.still) ? m.still : `${m.still}-9x16`}/poster.jpg`, expiresAt: null } : null
    })),
    confessions: [], promises: [], chats: []
  };
  return new Blob([JSON.stringify(local, null, 2)], { type: 'application/json' });
}

// ---------------------------------------------------------------- her inbox (#49)

/** What she sent on her own, delivered by the server's tick. Null in prototype mode or on failure: no badge then. */
export async function inbox(): Promise<InboxResT | null> {
  if (!serverMode()) return null;
  try { return await http.inbox(); } catch { return null; }
}

/** Marks an item read when it is opened; null offline or on failure (the badge simply stays until the next load). */
export async function readInbox(id: string): Promise<InboxReadResT | null> {
  if (!serverMode()) return null;
  try { return await http.inboxRead(id); } catch { return null; }
}

// ---------------------------------------------------------------- promises (#59)

/** His open promises and, with no promise with her open, her proposal for the next time. Null offline or on failure. */
export async function promises(star: StarId, lang: Lang): Promise<PromisesResT | null> {
  if (!serverMode()) return null;
  try { return await http.promises(star, lang); } catch { return null; }
}

/** He said 「約束する」 to her proposal. Only offered in server mode (the proposal comes from the API). */
export async function makePromise(star: StarId, lineId: string, lang: Lang): Promise<PromiseItemT> {
  return (await http.promiseMake(star, lineId, lang)).promise;
}

// ---------------------------------------------------------------- her variant look at home (#76)

/** Pins (or unpins) her variant look to her home; the card's state after it. Throws when it did not go through. */
export async function pinVariantHome(cardId: string, pinned: boolean): Promise<CardAffectionResT> {
  return http.cardHomePin(cardId, pinned);
}

// ---------------------------------------------------------------- what she calls him (#56)

/** What she calls him, her question when she wants to call him differently, and his praise for her looks. Null offline or on failure. */
export async function bondOf(star: StarId, lang: Lang): Promise<BondResT | null> {
  if (!serverMode()) return null;
  try { return await http.bond(star, lang); } catch { return null; }
}

/** His answer to her question; throws when it did not go through (she is then still asking, or asked elsewhere: 409). */
export async function answerCallName(star: StarId, to: 'familiar' | 'lover', accept: boolean, lang: Lang): Promise<CallAnswerResT> {
  return http.callAnswer(star, to, accept, lang);
}

// ---------------------------------------------------------------- serial codes

export async function redeemSerial(state: AppState, raw: string): Promise<SerialRedeemResT & { code: string }> {
  const code = normalizeSerial(raw);
  if (!isValidSerialFormat(code)) fail('invalid_serial_format', 400);
  const demoCode = (DEMO_SERIALS as readonly string[]).includes(code);
  // The public demo codes belong to each browser's walkthrough. Keeping them local prevents one visitor from
  // consuming the shared sample before everybody else has had a chance to try the redemption flow.
  if (serverMode() && !demoCode) return { ...(await http.redeem(code)), code };
  await latency();
  if (!demoCode) fail('serial_not_found', 404);
  if (state.redeemed.includes(code)) fail('serial_already_used', 409);
  // Prototype mode only: the catalog and draw code load on demand so they stay out of the main bundle.
  const [{ CARDS }, { drawLucky }] = await Promise.all([import('../data/cards'), import('../lib/gacha')]);
  const seen = new Set(Object.keys(state.owned));
  const cards = drawLucky(CARDS, Math.random).map(({ card: c }) => {
    const isNew = !seen.has(c.id);
    seen.add(c.id);
    return { id: c.id, star: c.star, rarity: c.rarity, isNew };
  });
  // Offline there is one browser, so the pass days apply right away instead of waiting for the sign-up claim.
  const days = RULES.serialDefaultTrialDays;
  return { code, cards, trialDays: days, claimed: false, passUntil: extendPass(state.passUntil, days), drawId: localId('drw'), pointsGranted: RULES.serialPoints };
}

// ---------------------------------------------------------------- gacha and shop

export async function drawCards(state: AppState, n: 1 | 6 | 10, free: boolean, pool: string = state.gachaPool): Promise<DrawResT> {
  // Local review builds keep the wallet and collection in this browser. A top-up made here must therefore
  // draw from the same local state instead of depending on a separately running API session.
  if (serverMode() && !import.meta.env.DEV) return http.draw(n, free, pool);
  await latency();
  if (state.freePulls < n) fail('no_free_pull', 409);
  const { pull, poolOpen } = await import('../lib/gacha');
  if (!poolOpen(pool)) fail('pool_closed', 409);
  const seen = new Set(Object.keys(state.owned));
  const { drawn, pity } = pull(n, state.pity, pool);
  const cards = drawn.map(({ card: c }) => {
    const isNew = !seen.has(c.id);
    seen.add(c.id);
    return { id: c.id, star: c.star, rarity: c.rarity, isNew };
  });
  const duplicateShards = cards.reduce((sum, card) => sum + (card.isNew ? 0 : RULES.duplicateShards[card.rarity]), 0);
  return { cards, wallet: { points: state.points, freePulls: state.freePulls - n, pity, shards: state.shards + duplicateShards }, drawId: localId('drw') };
}

/** Star Shards → a chosen card; cost and duplicate rebate both follow its rarity. */
export async function exchangeCard(state: AppState, cardId: string): Promise<ExchangeResT> {
  if (serverMode()) return http.exchange(cardId);
  await latency();
  const { CARD_BY_ID } = await import('../data/cards');
  const card = CARD_BY_ID[cardId];
  if (!card || !isExchangeable(card)) fail('not_exchangeable', 400);
  const shardCost = RULES.exchangeShards[card.rarity];
  if (state.shards < shardCost) fail('insufficient_shards', 402);
  const isNew = !state.owned[card.id];
  return { card: { id: card.id, star: card.star, rarity: card.rarity, isNew }, wallet: { points: state.points, freePulls: state.freePulls, pity: state.pity, shards: state.shards - shardCost + (isNew ? 0 : RULES.duplicateShards[card.rarity]) } };
}

/** The last 180 days of draws (server mode only; offline there is no history). */
export async function drawHistory(): Promise<DrawHistoryResT | null> {
  return serverMode() ? http.drawHistory() : null;
}

/** Printed codes this account redeemed (server mode only; offline the device keeps just a count). */
export async function redemptions(): Promise<RedemptionHistoryResT | null> {
  return serverMode() ? http.redemptions() : null;
}

/** Records the birthday; the API closes the account (403 underage) when it is under the minimum age. */
export async function confirmBirthday(birthday: string): Promise<MeResT | null> {
  return serverMode() ? http.setBirthday(birthday) : null;
}

/** 退会: the API erases personal data; this browser then forgets the session and its cache. */
export async function deleteAccount(): Promise<void> {
  if (serverMode()) await http.deleteAccount();
  // The API already deleted the subscriptions; this drops the browser's own one too.
  logout();
}

/** Returns the new balance. */
export async function buyPoints(state: AppState, points: number): Promise<number> {
  if (!RULES.pointPacks.some((p) => p.points === points)) fail('unknown_pack', 400);
  // The local experience is a design demo: top-ups should be instant and must not depend on
  // a checkout provider or a server session that may have been restarted during the review.
  if (!serverMode() || import.meta.env.DEV) {
    await latency();
    return state.points + points;
  }
  return (await http.buyPoints(points)).points;
}

/** Returns the new expiry. */
export async function buyPass(state: AppState): Promise<string> {
  if (serverMode()) return (await http.buyPass()).passUntil;
  await latency();
  return extendPass(state.passUntil, RULES.passDays);
}

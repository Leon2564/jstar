/**
 * Server-backed mode.
 *
 * With VITE_API_BASE set, the service layer in `api.ts` calls these functions instead of the
 * local prototype logic: draws, serial redemption, the trial allowance and points then come
 * from @jstar/api, which is the only place they can be trusted.
 */
import type { AsrResT, ChatGreetingResT, ChatHistoryResT, ChatSendResT, ChatStreamEventT, DeviceResT, DrawHistoryResT, DrawResT, ExchangeResT, InboxItemT, InboxReadResT, InboxResT, InboxVoiceResT, MeResT, RedemptionHistoryResT, RelationshipResT, SerialRedeemResT, SessionResT, PublicConfigResT, PushSubscribeReqT, PushTestResT, SceneCurrentResT, SceneRoomResT, SceneRunResT, SceneRunViewT, SceneStepReqT, CitySearchResT, SetCityResT, WorldResT, PromisesResT, PromiseCreateResT } from '@jstar/shared/contracts';
import type { AlarmResT, AlarmSetReqT, WakeOpenResT, WakeSnoozeResT } from '@jstar/shared/contracts';
import type { ConfessionAudioResT, ConfessionMemoriesResT, RelationshipViewT } from '@jstar/shared/contracts';
import type { HerMessageSettingsT } from '@jstar/shared/contracts';
import type { GiftsResT, GiftSendResT } from '@jstar/shared/contracts';
import type { BondResT, CallAnswerResT, CallNameSettingsT } from '@jstar/shared/contracts';
import type { CardAffectionResT } from '@jstar/shared/contracts';
import type { CalendarDemoResT, CalendarResT } from '@jstar/shared/contracts';
import type { ScenePreviewListResT, ScenePreviewResT } from '@jstar/shared/contracts';
import type { TtsReqT, TtsResT, TtsTicketResT, VoiceExtendResT, VoiceStateT } from '@jstar/shared/contracts';
import { turnstileAvailable, turnstileToken } from '../lib/turnstile';

const RAW_BASE: string = (import.meta.env.VITE_API_BASE as string | undefined)
  ?? (import.meta.env.MODE === 'development' ? '/api' : '');
/** `VITE_API_BASE=/` means the API shares the page's origin, so one build serves any host. */
export const API_BASE = RAW_BASE.replace(/\/$/, '');
export const serverMode = () => RAW_BASE.length > 0;

const TOKEN_KEY = 'jstar.token';
const DEVICE_KEY = 'jstar.device';

export const getToken = () => { try { return localStorage.getItem(TOKEN_KEY); } catch { return null; } };
export const setToken = (t: string | null) => { try { t ? localStorage.setItem(TOKEN_KEY, t) : localStorage.removeItem(TOKEN_KEY); } catch { /* private mode */ } };

/**
 * Stable per-browser id so the server can hold the visitor trial allowance and redeemed cards. Without storage
 * it lives for this page session only — never a shared constant, which let one visitor claim another's cards.
 */
let sessionDevice: string | null = null;
export function deviceId(): string {
  try {
    const existing = localStorage.getItem(DEVICE_KEY);
    if (existing) return existing;
    const id = crypto.randomUUID();
    localStorage.setItem(DEVICE_KEY, id);
    return id;
  } catch {
    sessionDevice ??= `s-${crypto.randomUUID()}`;
    return sessionDevice;
  }
}

/** His time zone (round 12): a time he names in chat is his own, not Tokyo's. */
const myZone = (): string | undefined => { try { return Intl.DateTimeFormat().resolvedOptions().timeZone; } catch { return undefined; } };

export class ApiError extends Error {
  /** `retryAfterMs`: the server's Retry-After (a 429), when it sent one (N-58). */
  constructor(public code: string, public status: number, public retryAfterMs?: number) { super(code); }
}

/** An HTTP error from its response: the body's code, and the Retry-After of a 429 (seconds, or an HTTP date). */
const httpError = (res: Response, body: { error?: string }): ApiError => {
  const after = res.headers.get('retry-after');
  const secs = after == null ? NaN : /^\d+$/.test(after.trim()) ? Number(after) : (Date.parse(after) - Date.now()) / 1000;
  // A plain rate limit (the limiter's 「Too Many Requests」, not one of ours like `export_limit`) is `rate_limited`.
  const code = res.status === 429 && !/^[a-z_]+$/.test(body.error ?? '') ? 'rate_limited' : body.error ?? `http_${res.status}`;
  return new ApiError(code, res.status, Number.isFinite(secs) ? Math.max(0, secs * 1000) : undefined);
};

async function fetchOnce(path: string, init: RequestInit, extra: Record<string, string> = {}): Promise<Response> {
  try {
    return await fetch(`${API_BASE}${path}`, {
      ...init,
      headers: {
        'content-type': 'application/json',
        'x-device-id': deviceId(),
        ...(getToken() ? { authorization: `Bearer ${getToken()}` } : {}),
        ...(init.headers ?? {}),
        ...extra
      }
    });
  } catch {
    throw new ApiError('network', 0);
  }
}

/** The API decides when a bot check is needed (403 `challenge_required`): run Turnstile once and retry. */
async function send(path: string, init: RequestInit = {}): Promise<Response> {
  const res = await fetchOnce(path, init);
  if (res.status !== 403 || !turnstileAvailable()) return res;
  const body = (await res.clone().json().catch(() => ({}))) as { error?: string };
  if (body.error !== 'challenge_required') return res;
  const token = await turnstileToken();
  return token ? fetchOnce(path, init, { 'x-turnstile-token': token }) : res;
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await send(path, init);
  const body = (await res.json().catch(() => ({}))) as { error?: string };
  if (!res.ok) throw httpError(res, body);
  return body as T;
}

/** Her reply so far, called as tokens arrive (the whole text each time, so a `replace` needs no special case). */
export type OnText = (textSoFar: string) => void;

export interface LiveSessionT {
  ready: true;
  liveId: string;
  rtc: { app_id: string; channel_id: string; user_id: string; token: string; token_expire_at?: string };
}

export type LiveStarT = 'mahiro' | 'nana' | 'unpai' | 'alice' | 'eimi';
export type LiveLayoutT = 'desktop' | 'mobile';

export interface LiveEventT {
  seq: number;
  /** Subtitle in the currently selected site language. */
  text: string;
  /** The exact Japanese line sent to the avatar voice. */
  spoken: string;
}

/**
 * Reads a streamed chat turn (NDJSON ChatStreamEvent lines) and resolves with the final result. Errors before the
 * stream starts come back as plain HTTP errors, exactly as on the non-streaming route.
 */
export async function readChatStream(res: Response, onText: OnText): Promise<ChatSendResT> {
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    throw httpError(res, body);
  }
  let text = '';
  let result: ChatSendResT | null = null;
  const handle = (line: string) => {
    if (!line.trim()) return;
    const ev = JSON.parse(line) as ChatStreamEventT;
    if (ev.type === 'delta') { text += ev.text; onText(text); }
    else if (ev.type === 'replace') { text = ev.text; onText(text); }
    else if (ev.type === 'done') result = ev.result;
    else throw new ApiError(ev.error || 'agent_unavailable', 503);
  };
  if (res.body) {
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    for (;;) {
      let chunk: Awaited<ReturnType<typeof reader.read>>;
      try { chunk = await reader.read(); } catch { throw new ApiError('network', 0); }
      if (chunk.done) break;
      buf += decoder.decode(chunk.value, { stream: true });
      let nl: number;
      while ((nl = buf.indexOf('\n')) >= 0) { handle(buf.slice(0, nl)); buf = buf.slice(nl + 1); }
    }
    handle(buf);
  } else {
    (await res.text()).split('\n').forEach(handle);
  }
  if (!result) throw new ApiError('network', 0);
  return result;
}

/** A streamed turn; falls back to the plain route when the API predates streaming (404). */
async function chatStream(path: string, body: unknown, onText: OnText): Promise<ChatSendResT> {
  const res = await send(`${path}/stream`, { method: 'POST', body: JSON.stringify(body) });
  if (res.status === 404) {
    const plain = await request<ChatSendResT>(path, { method: 'POST', body: JSON.stringify(body) });
    onText(plain.reply);
    return plain;
  }
  return readChatStream(res, onText);
}

const get = <T>(path: string) => request<T>(path);
const post = <T>(path: string, body: unknown = {}) => request<T>(path, { method: 'POST', body: JSON.stringify(body) });

export const http = {
  config: () => get<Partial<PublicConfigResT> & { demo: boolean }>('/v1/config'),
  otpStart: (email: string, lang: string) => post<{ ok: boolean; ttlMinutes?: number }>('/v1/auth/otp/start', { email, lang }),
  otpVerify: (email: string, code: string, lang?: string) => post<SessionResT>('/v1/auth/otp/verify', { email, code, ...(lang ? { lang } : {}) }),
  /** #176: the language the server writes his texts in (her wake-up, her messages, pushes). */
  setLang: (lang: string) => request<MeResT>('/v1/auth/me/lang', { method: 'PUT', body: JSON.stringify({ lang }) }),
  me: () => get<MeResT>('/v1/auth/me'),
  setNickname: (nickname: string) => request<MeResT>('/v1/auth/me/nickname', { method: 'PUT', body: JSON.stringify({ nickname }) }),
  device: () => get<DeviceResT>('/v1/device'),
  redeem: (code: string) => post<SerialRedeemResT>('/v1/serial/redeem', { code }),
  chat: (star: string, text: string, lang: string, suggest?: boolean) => post<ChatSendResT>('/v1/chat/send', { star, text, lang, tz: myZone(), ...(suggest ? { suggest } : {}) }),
  trialChat: (star: string, text: string, lang: string) => post<ChatSendResT>('/v1/chat/trial', { star, text, lang }),
  chatStream: (star: string, text: string, lang: string, onText: OnText, suggest?: boolean) => chatStream('/v1/chat/send', { star, text, lang, tz: myZone(), ...(suggest ? { suggest } : {}) }, onText),
  trialChatStream: (star: string, text: string, lang: string, onText: OnText) => chatStream('/v1/chat/trial', { star, text, lang }, onText),
  liveStart: (star: LiveStarT, lang: string, layout: LiveLayoutT) => post<LiveSessionT>('/v1/live/session', { star, lang, layout }),
  liveMessage: (liveId: string, text: string) => post<{ ok: true }>(`/v1/live/${encodeURIComponent(liveId)}/message`, { text }),
  liveEvents: (liveId: string, after: number, lang: string) => get<{ events: LiveEventT[] }>(`/v1/live/${encodeURIComponent(liveId)}/events?after=${after}&lang=${encodeURIComponent(lang)}`),
  liveEnd: (liveId: string) => post<{ ok: boolean }>(`/v1/live/${encodeURIComponent(liveId)}/end`),
  greeting: (star: string, lang: string) => get<ChatGreetingResT>(`/v1/chat/greeting?star=${encodeURIComponent(star)}&lang=${encodeURIComponent(lang)}`),
  history: (star: string) => get<ChatHistoryResT>(`/v1/chat/history?star=${encodeURIComponent(star)}`),
  draw: (count: 1 | 6 | 10, useFreePull: boolean, pool: string) => post<DrawResT>('/v1/gacha/draw', { pool, count, useFreePull }),
  exchange: (cardId: string) => post<ExchangeResT>('/v1/gacha/exchange', { cardId }),
  drawHistory: () => get<DrawHistoryResT>('/v1/gacha/history'),
  redemptions: () => get<RedemptionHistoryResT>('/v1/serial/history'),
  setBirthday: (birthday: string) => post<MeResT>('/v1/auth/me/birthday', { birthday }),
  deleteAccount: () => request<{ ok: boolean }>('/v1/auth/me', { method: 'DELETE', body: JSON.stringify({ confirm: 'DELETE' }) }),
  buyPoints: (points: number) => post<{ points: number }>('/v1/shop/points', { points }),
  buyPass: () => post<{ passUntil: string }>('/v1/shop/pass'),
  inbox: () => get<InboxResT>('/v1/inbox'),
  inboxRead: (id: string) => post<InboxReadResT>(`/v1/inbox/${encodeURIComponent(id)}/read`),
  inboxVoice: (id: string) => post<InboxVoiceResT>(`/v1/inbox/${encodeURIComponent(id)}/voice`),
  pushSubscribe: (sub: PushSubscribeReqT) => post<{ ok: true }>('/v1/push/subscribe', sub),
  /** `token`: the session being signed out of, which is already gone from storage by then. */
  pushUnsubscribe: (endpoint?: string, token?: string | null) => request<{ ok: true; removed: number }>('/v1/push/subscribe', {
    method: 'DELETE', body: JSON.stringify(endpoint ? { endpoint } : {}), ...(token ? { headers: { authorization: `Bearer ${token}` } } : {})
  }),
  pushTest: (star: string) => post<PushTestResT>('/v1/push/test', { star }),
  sceneStart: (sceneId: string, lang: string, offerId?: string, preview?: boolean) =>
    post<SceneRunResT>('/v1/scene/start', { sceneId, lang, ...(offerId ? { offerId } : {}), ...(preview ? { preview: true } : {}) }),
  /** Previews of scenes whose clips are pending (#80, #81): the test site only (demo mode); 404 elsewhere. */
  scenePreviews: () => get<ScenePreviewListResT>('/v1/scene/previews'),
  scenePreview: (id: string) => get<ScenePreviewResT>(`/v1/scene/preview/${encodeURIComponent(id)}`),
  /** Her home keeps her variant look (#76), from its level 10; `pinned: false` lets it rotate again. */
  cardHomePin: (cardId: string, pinned: boolean) => request<CardAffectionResT>(`/v1/cards/${encodeURIComponent(cardId)}/home-pin`, { method: 'PUT', body: JSON.stringify({ pinned }) }),
  sceneRoom: (star: string, inboxId?: string) => post<SceneRoomResT>('/v1/scene/room', { star, ...(inboxId ? { inboxId } : {}) }),
  sceneOfferDecline: (offerId: string) => post<{ ok: true; declined: boolean }>('/v1/scene/offer/decline', { offerId }),
  sceneStep: (body: Omit<SceneStepReqT, 'lang'> & { lang: string }) => post<SceneRunResT>('/v1/scene/step', body),
  sceneEnd: (runId: string, reason: 'left' | 'idle') => post<SceneRunResT>('/v1/scene/end', { runId, reason }),
  sceneCurrent: () => get<SceneCurrentResT>('/v1/scene/current'),
  sceneRun: (id: string) => get<{ run: SceneRunViewT }>(`/v1/scene/runs/${encodeURIComponent(id)}`),
  world: () => get<WorldResT>('/v1/world'),
  citySearch: (q: string, lang: string) => get<CitySearchResT>(`/v1/world/cities?q=${encodeURIComponent(q)}&lang=${encodeURIComponent(lang)}`),
  citySet: (id: number, lang: string) => request<SetCityResT>('/v1/world/city', { method: 'PUT', body: JSON.stringify({ id, lang }) }),
  cityClear: () => request<{ ok: true; removed: boolean }>('/v1/world/city', { method: 'DELETE', body: '{}' }),
  /** Voice input (#72): the recording as the raw body, its own type as the content type. */
  asr: (clip: Blob, lang: string) => request<AsrResT>(`/v1/asr?lang=${encodeURIComponent(lang)}`, { method: 'POST', body: clip, headers: { 'content-type': clip.type || 'audio/webm' } }),
  relationship: () => get<RelationshipResT>('/v1/relationship'),
  promises: (star: string, lang: string) => get<PromisesResT>(`/v1/promises?star=${encodeURIComponent(star)}&lang=${encodeURIComponent(lang)}`),
  promiseMake: (star: string, lineId: string, lang: string) => post<PromiseCreateResT>('/v1/promises', { star, lineId, lang }),
  /** C-room N1: 「今晚見」 — her invitation's scene, promised for when it can start. */
  promiseTonight: (star: string, sceneId: string, inboxId: string, lang: string) => post<PromiseCreateResT>('/v1/promises/tonight', { star, sceneId, inboxId, lang }),
  alarm: () => get<AlarmResT>('/v1/alarm'),
  alarmSet: (body: Omit<AlarmSetReqT, 'enabled'> & { enabled: boolean }) => request<AlarmResT>('/v1/alarm', { method: 'PUT', body: JSON.stringify(body) }),
  wakeOpen: (id: string, lang: string) => post<WakeOpenResT>('/v1/alarm/wake/open', { id, lang }),
  wakeSnooze: (id: string) => post<WakeSnoozeResT>('/v1/alarm/wake/snooze', { id }),
  wakeRing: (id: string) => post<{ item: InboxItemT }>('/v1/alarm/wake/ring', { id }),
  relationshipDemo: (star: string, stage: string) => post<RelationshipViewT>('/v1/relationship/demo', { star, stage }),
  /** Her confession (#55): the memories of his yes, and the recording he chose to keep (sent as the raw body). */
  confessionMemories: () => get<ConfessionMemoriesResT>('/v1/confession/memories'),
  confessionKeep: (memoryId: string, clip: Blob) => request<ConfessionAudioResT>(`/v1/confession/memories/${encodeURIComponent(memoryId)}/audio?consent=yes`, {
    method: 'PUT', body: clip, headers: { 'content-type': (clip.type || 'audio/webm').split(';')[0] }
  }),
  confessionForget: (memoryId: string) => request<ConfessionAudioResT>(`/v1/confession/memories/${encodeURIComponent(memoryId)}/audio`, { method: 'DELETE', body: '{}' }),
  /** The recording, to him alone: fetched with his session, played from a blob URL (never a public link). */
  confessionAudio: async (memoryId: string): Promise<Blob> => {
    const res = await fetchOnce(`/v1/confession/memories/${encodeURIComponent(memoryId)}/audio`, { method: 'GET' });
    if (!res.ok) throw new ApiError(res.status === 404 ? 'not_found' : `http_${res.status}`, res.status);
    return res.blob();
  },
  /** His export (#51): everything, as the JSON file the server built; 429 `export_limit` after today's. */
  exportMemories: async (): Promise<Blob> => {
    const res = await fetchOnce('/v1/me/export', { method: 'GET' });
    if (!res.ok) {
      const body = (await res.json().catch(() => ({}))) as { error?: string };
      throw new ApiError(body.error ?? `http_${res.status}`, res.status);
    }
    return res.blob();
  },
  herSettings: () => get<HerMessageSettingsT>('/v1/her-messages/settings'),
  herSettingsSet: (mode: HerMessageSettingsT['mode']) => request<HerMessageSettingsT>('/v1/her-messages/settings', { method: 'PUT', body: JSON.stringify({ mode }) }),
  gifts: (star: string) => get<GiftsResT>(`/v1/gift?star=${encodeURIComponent(star)}`),
  /** Voice minutes (#74): today's voice time, and +30 minutes for points (idempotent per request id). */
  voice: () => get<VoiceStateT>('/v1/voice'),
  voiceExtend: (requestId: string) => post<VoiceExtendResT>('/v1/voice/extend', { requestId }),
  /** Her runtime voice (#73): one or two sentences; `subtitle` when it is off, out of minutes or failed. */
  tts: (body: TtsReqT) => post<TtsResT>('/v1/tts', body),
  /** A one-use stream URL for her sentence (#73, first sound); 404 no_stream = use `tts`. */
  ttsTicket: (body: TtsReqT) => post<TtsTicketResT>('/v1/tts/ticket', body),
  giftSend: (star: string, giftId: string, lang: string) => post<GiftSendResT>('/v1/gift', { star, giftId, lang }),
  /** What she calls him and how she changes for him (#56). */
  bond: (star: string, lang: string) => get<BondResT>(`/v1/bond?star=${encodeURIComponent(star)}&lang=${encodeURIComponent(lang)}`),
  callAnswer: (star: string, to: 'familiar' | 'lover', accept: boolean, lang: string) => post<CallAnswerResT>('/v1/bond/call-name', { star, to, accept, lang }),
  callNameGet: () => get<CallNameSettingsT>('/v1/bond/name'),
  callNameSet: (name: string | null) => request<CallNameSettingsT>('/v1/bond/name', { method: 'PUT', body: JSON.stringify({ name }) }),
  /** Her year with him (#61): what today is with each of the five; the demo route pretends another day (test site). */
  calendar: () => get<CalendarResT>('/v1/calendar'),
  calendarDemo: (day: string | null) => post<CalendarDemoResT>('/v1/calendar/demo', { day })
};

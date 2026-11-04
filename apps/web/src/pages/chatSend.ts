/**
 * Sending a message to her and receiving her streamed reply — one implementation for her chat page and her room's live
 * conversation (the owner: "talk to her right there, in the video room"). Same API and streaming, same history,
 * memory, promises and limits; N-58's failed send (tried once more by itself, then his bubble says it did not go,
 * with a resend) and the 402 daily limit (the store's `chatExhausted`, which shows the limit panel).
 * Lives in the member pages' lazy chunk, never in the entry bundle.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import type { ChatSendResT } from '@jstar/shared/contracts';
import type { Lang, StarId } from '@jstar/shared/domain';
import { chatLeftOf, type Msg } from '../lib/state';
import { uid, useStore, useT } from '../lib/store';
import { chat, errorCode, isBlocked, serverMode } from '../services/api';
import { getToken, http } from '../services/http';
import { retryWaitMs } from '../services/sendRetry';

/** N-58: a send that did not go, in the four languages (kept in this lazy chunk, off the entry dictionary). */
export const SEND_FAILED: Record<string, { msg: string; resend: string }> = {
  ja: { msg: '送れませんでした', resend: 'もう一度送る' },
  'zh-Hant': { msg: '沒有送出', resend: '再送一次' },
  en: { msg: "Didn't send", resend: 'Send again' },
  ko: { msg: '보내지 못했어요', resend: '다시 보내기' }
};

/** M11: his reply went and she answered — the moment her notifications may be offered (components/pushOffer.tsx). */
export const REPLIED = 'jstar:replied';

export interface ChatSend {
  /** A message of his is on its way, or her reply is still coming. */
  busy: boolean;
  /** Her reply while it streams in; null before the first token and once it is stored in the log. */
  live: string | null;
  /** His messages that did not go (N-58). */
  failed: ReadonlySet<string>;
  /** Messages left today (null: unlimited). */
  left: number | null;
  /** Sends `text` (a resend takes the failed bubble `again`'s place). */
  deliver: (text: string, again?: string) => Promise<void>;
  /** False when it cannot be sent now (empty, her reply still coming, or no messages left today). */
  send: (raw: string) => boolean;
}

export interface ChatSendOptions {
  /** Messages sent on this screen (his and her replies): the history merge keeps them (N-50). */
  sentHere: Set<string>;
  onToast: (msg: string) => void;
  /** Override the UI language for a room whose character must always answer in one language. */
  language?: Lang;
  /** Before his message goes (the chat page clears its scene and pickup asks). */
  onStart?: () => void;
  /** Her reply arrived: what was added after his message, and how long the log was before he sent it. */
  onResult?: (r: ChatSendResT, added: Msg[], before: number) => void;
  /** Ask for his next words with her reply (her room's choices, QA #4). */
  suggest?: boolean;
  /** Video-room messages are included in the per-minute video rate. */
  channel?: 'text' | 'video';
  /** Her reply has arrived in full: her room speaks it in her runtime voice when that is on (#73, lib/herVoice.ts). */
  speak?: (reply: string, sig?: string) => void;
  /**
   * C-room N3: her room offers her notifications itself — once she is done (her last page, his choices) or he leaves
   * the call — never over her words as they type out. Her chat page offers them as her reply arrives.
   */
  holdOffer?: boolean;
}

/** B-R2: when today's count was last asked for (one ask serves her chat and her room for a few seconds). */
let countAsked = 0;
const COUNT_FRESH_MS = 5_000;

export function useChatSend(star: StarId, o: ChatSendOptions): ChatSend {
  const { state, actions } = useStore();
  // B-R2: today's count is the server's — asked as her chat or her room opens and whenever he comes back to the tab
  // (another tab, his phone, the day turning), never only on a full reload. Not over a send of his on its way.
  const busyRef = useRef(false);
  useEffect(() => {
    if (!serverMode() || !getToken()) return;
    let live = true;
    const ask = () => {
      if (Date.now() - countAsked < COUNT_FRESH_MS) return;
      countAsked = Date.now();
      void http.me().then((me) => { if (live && !busyRef.current) actions.chatCount(me.chat); }).catch(() => undefined);
    };
    const back = () => { if (document.visibilityState === 'visible') ask(); };
    ask();
    window.addEventListener('focus', back);
    document.addEventListener('visibilitychange', back);
    return () => { live = false; window.removeEventListener('focus', back); document.removeEventListener('visibilitychange', back); };
  }, [actions]);
  const t = useT();
  const msgsRef = useRef(state.chats[star]);
  msgsRef.current = state.chats[star];
  const stateRef = useRef(state);
  stateRef.current = state;
  const [busy, setBusy] = useState(false);
  busyRef.current = busy;
  const [live, setLive] = useState<string | null>(null);
  // M10: what did not go is marked on the line itself (the store), so every unsent line stays marked — after he left
  // and came back, and on the other screen (her room, her chat) — not only the last one sent here.
  const msgs = state.chats[star];
  const failed = useMemo<ReadonlySet<string>>(() => new Set(msgs.filter((m) => m.failed).map((m) => m.id)), [msgs]);
  const left = chatLeftOf(state);

  async function deliver(text: string, again?: string) {
    setBusy(true);
    // A resend takes the failed bubble's place (N-58).
    if (again) actions.setChat(star, msgsRef.current.filter((m) => m.id !== again));
    const before = msgsRef.current.filter((m) => m.id !== again).length;
    const mine: Msg = { id: uid(), from: 'me', text };
    o.onStart?.();
    o.sentHere.add(mine.id);
    actions.chatAppend(star, [mine]);
    try {
      // N-58: her service busy (503), a timeout, a dropped connection or a rate limit (after its Retry-After, at most
      // 3 s) is tried once more by itself before he hears of it.
      const replyLanguage = o.language ?? t.lang;
      const r = await chat(stateRef.current, star, text, replyLanguage, setLive, o.suggest, o.channel).catch(async (e: unknown) => {
        const wait = retryWaitMs(e);
        if (wait == null) throw e;
        setLive(null);
        await new Promise((ok) => setTimeout(ok, wait));
        return chat(stateRef.current, star, text, replyLanguage, setLive, o.suggest, o.channel);
      });
      actions.applyChat(star, r);
      const add: Msg[] = [{ id: uid(), from: 'her', text: r.reply }];
      if (r.memoryCard) add.push({ id: uid(), from: 'system', text: r.memoryCard.title, kind: 'memory' });
      for (const m of add) o.sentHere.add(m.id);
      actions.chatAppend(star, add);
      // Her voice for this reply (#73): only her cloned voice, never a generic TTS; otherwise she stays in subtitles.
      o.speak?.(r.reply, r.voiceSig);
      o.onResult?.(r, add, before);
      // M11: his reply went — the moment her notifications may be offered (components/pushOffer.tsx, once).
      if (!o.holdOffer) window.dispatchEvent(new Event(REPLIED));
    } catch (e) {
      if (errorCode(e) === 'insufficient_points') actions.chatExhausted();
      else if (isBlocked(e)) o.onToast(t('chat.blocked'));
      // N-58: never silently dropped — his bubble says it did not go, with a one-tap resend (his words stay on it).
      else actions.chatFailed(star, mine.id);
    } finally {
      setLive(null);
      setBusy(false);
    }
  }

  function send(raw: string): boolean {
    const text = raw.trim().slice(0, 500);
    if (!text || busy || left === 0) return false;
    void deliver(text);
    return true;
  }

  return { busy, live, failed, left, deliver, send };
}

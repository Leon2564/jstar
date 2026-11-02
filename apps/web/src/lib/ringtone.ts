/**
 * #12: her call rings in her own voice — 「鈴聲是她的聲音」. The ringtone is a recording of hers: the line she wakes
 * him with (the wake-up's `voice`, made with her cloned voice ahead of time, never at ring time), else her recorded
 * greeting for the hour. It plays, pauses, plays again, until he answers or puts her off (L5, C-room: it rang once),
 * for at most RING_MS.
 *
 * Browsers refuse sound before the page has been touched (autoplay), and his sound switch may be off: then nothing
 * plays by itself and the call says so — `blocked` — with a tap that plays it (a tap is a gesture: always allowed).
 * His first tap or key anywhere tries again by itself. Lives in the member pages' chunk.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import type { InboxItemT } from '@jstar/shared/contracts';
import { soundOn, stopVoice } from './sound';
import { clockSlot } from '../components/voiceLines';

/** How long she rings at most, unanswered: until he answers or puts her off, in practice (a safety cap). */
export const RING_MS = 10 * 60_000;
/** The pause between two rings. */
export const RING_GAP_MS = 1_400;

/** Her ringtone for this call: the wake-up's own recording, else her greeting for the hour (both her real voice). */
export function ringtoneOf(item: Pick<InboxItemT, 'star' | 'kind' | 'payload'>, hour = new Date().getHours()): string {
  const voice = item.payload.voice;
  if (typeof voice === 'string' && voice.startsWith('/voice/')) return voice;
  return `/voice/greet/${item.star}-${item.kind === 'wakeup' ? 'morning' : clockSlot(hour)}.mp3`;
}

export interface Ringtone {
  /** Nothing is sounding by itself (autoplay refused, or his sound is off): the call offers a tap to hear her. */
  blocked: boolean;
  /** His tap: rings now (a gesture, so the browser allows it), whatever his sound switch says. */
  unmute: () => void;
}

export function useRingtone(src: string | null): Ringtone {
  const [blocked, setBlocked] = useState(false);
  type Ring = { audio: HTMLAudioElement; timer?: ReturnType<typeof setTimeout>; watch?: ReturnType<typeof setInterval>; until: number };
  const ring = useRef<Ring | null>(null);
  const stop = useCallback(() => {
    const r = ring.current;
    ring.current = null;
    if (!r) return;
    clearTimeout(r.timer);
    clearInterval(r.watch);
    r.audio.onended = null;
    r.audio.pause();
  }, []);
  const start = useCallback((url: string): void => {
    stop();
    if (typeof Audio === 'undefined') { setBlocked(true); return; }
    // One voice of hers at a time (N-32): her greeting stops for her call.
    stopVoice();
    const audio = new Audio(url);
    const r: Ring = { audio, until: Date.now() + RING_MS };
    ring.current = r;
    const play = () => {
      r.timer = undefined;
      if (ring.current !== r) return;
      if (Date.now() > r.until) { stop(); return; }
      try { audio.currentTime = 0; } catch { /* not loaded yet: it starts at 0 anyway */ }
      let p: Promise<void> | undefined;
      try { p = audio.play(); } catch { p = Promise.reject(new Error('no_audio')); }
      void Promise.resolve(p).then(() => { if (ring.current === r) setBlocked(false); }, () => { if (ring.current === r) { setBlocked(true); stop(); } });
    };
    // Again after a short gap, whenever her recording ends — and (L5) whenever it stopped by itself without `ended`
    // (a browser that pauses a finished clip, an interruption): checked twice a second while she rings.
    const again = () => { if (ring.current === r && r.timer === undefined) r.timer = setTimeout(play, RING_GAP_MS); };
    audio.onended = again;
    r.watch = setInterval(() => { if (audio.paused && audio.currentTime > 0) again(); }, 500);
    play();
  }, [stop]);
  useEffect(() => {
    if (!src) { stop(); setBlocked(false); return; }
    // His sound is off: she does not ring by herself; the call offers the tap.
    if (!soundOn()) { setBlocked(true); return stop; }
    start(src);
    // Refused before any gesture: his first tap or key anywhere tries again.
    // Not on her call's own buttons: 接聽 or 再睡5分鐘 end the ring, so they never start it first.
    const retry = (e: Event) => { if (!ring.current && !(e.target as Element | null)?.closest?.('button, a')) start(src); };
    window.addEventListener('pointerdown', retry, { capture: true, once: true });
    window.addEventListener('keydown', retry, { capture: true, once: true });
    return () => {
      window.removeEventListener('pointerdown', retry, { capture: true });
      window.removeEventListener('keydown', retry, { capture: true });
      stop();
    };
  }, [src, start, stop]);
  const unmute = useCallback(() => { if (src) start(src); }, [src, start]);
  return { blocked, unmute };
}

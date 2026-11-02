/**
 * Her runtime voice in her room (#73, docs/requirements.md §13.6): her free-talk reply, once it has arrived, spoken in
 * HER cloned voice — sentence by sentence through `POST /v1/tts` (lib/ttsQueue.ts: the next sentence is asked for
 * while one plays), on her one voice channel (scene/voiceChannel.ts, N-32), each second charged to his voice minutes.
 *
 * Only when the server offers it to him for her (`voice.tts`, and she is in `voice.ttsStars`), sound is on, he has
 * voice time left, and her room's voice switch is on (this device remembers it; on by default). Anything else — off,
 * no minutes, offline, a vendor failure, no voice of hers — leaves her reply as the subtitles it already is, silently.
 * Scene lines keep their recordings (the scene player); this is only her free talk. Lives in the member pages' chunk.
 */
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import type { Lang, StarId } from '@jstar/shared/domain';
import { useStore } from './store';
import { onHush, soundOn, useSound } from './sound';
import { estimateSeconds, lineRequestId, speakLine, type SpeakClip } from './ttsQueue';
import { playVoiceOnce, preloadVoice, streamSource, type Voice } from '../scene/voiceChannel';
import { clipUrl, releaseClipUrl } from './clipUrl';
import { API_BASE, http } from '../services/http';
import { requestLipsync } from './lipsync';
import { trialVoiceFor } from '../services/api';

const KEY = 'jstar.herVoice';
const subs = new Set<() => void>();
let pref = read();
function read(): boolean {
  try { return localStorage.getItem(KEY) !== 'off'; } catch { return true; }
}
/** Her room's voice switch (目錄): on unless he turned it off on this device. */
export function setHerVoicePref(on: boolean) {
  pref = on;
  try { localStorage.setItem(KEY, on ? 'on' : 'off'); } catch { /* storage blocked: this page only */ }
  subs.forEach((f) => f());
}
const usePref = () => useSyncExternalStore((f) => { subs.add(f); return () => subs.delete(f); }, () => pref, () => true);
const e2e = () => typeof window !== 'undefined' && !!(window as unknown as { __E2E__?: boolean }).__E2E__;

/**
 * Where her voice is in her reply (#73): which characters of the reply she has said (`from`) and is saying now (up to
 * `to`, over `ms`), so her subtitle types out as she speaks. `key` changes with every sentence.
 */
export interface VoiceCaption { from: number; to: number; ms: number; key: number }

/**
 * `off`: not speaking (her subtitle types at its own pace). `waiting`: her reply is being voiced, its first sentence
 * not sounding yet. `playing`: a sentence is sounding. `gap`: between two sentences.
 */
export type VoicePhase = 'off' | 'waiting' | 'playing' | 'gap';

/** Her talking loop starts this long after her audio does: the loop's mouth opens a moment into it (tuned by eye). */
export const CLIP_DELAY_MS = 80;
/**
 * Her lip-sync (#73): her voice never waits for video (QA: renders take 2–7 s each; waiting left 1.2 s silences). A
 * sentence plays at once over her talk loop; its render, asked for as soon as its audio came (several at once), is
 * shown when it is there — from the start, or switched to mid-sentence at her voice's position.
 */
export const LIPSYNC_WAIT_MS = 0;
/** Her talk loops' frame rate (Seedance, 24 fps): where in the loop a sentence's render starts. */
export const LOOP_FPS = 24;

/** Her sentence's lip-synced video: shown over her talk loop from when `playing` (her audio sounds) until it ends. */
export interface LipsyncShot { src: string; key: number; playing: boolean }

export interface HerVoice {
  /** The server offers her runtime voice to him, for her: the switch is shown. */
  available: boolean;
  /** Available and switched on: her replies are spoken, and his voice minutes are shown. */
  on: boolean;
  setOn: (on: boolean) => void;
  /** Her next reply will be spoken if it comes signed (on, sound on, minutes left): hold her subtitle for the audio. */
  willSpeak: boolean;
  phase: VoicePhase;
  /** Her audio is sounding now (a hair after it starts, CLIP_DELAY_MS): her talking loop plays exactly then. */
  audible: boolean;
  caption: VoiceCaption | null;
  /**
   * Speaks her reply with the signature the server gave it (stops what she was saying); nothing when she cannot.
   * `cache` (#13, her voice note's message id): its sentences are kept for this page's life once synthesized, and a
   * replay plays them from here — never synthesized, nor charged, twice.
   */
  speak: (text: string, sig?: string, cache?: string) => void;
  stop: () => void;
  /** Her sentence lip-synced onto her talk loop, when lip-sync is on for her and the render came in time. */
  lipsync: LipsyncShot | null;
}

/** Where each sentence sits in the line (the queue trims them; the subtitle shows the line as written). */
export function sentenceSpans(line: string, sentences: string[]): [number, number][] {
  const spans: [number, number][] = [];
  let at = 0;
  for (const s of sentences) {
    const t = s.trim();
    const i = line.indexOf(t, at);
    const start = i >= 0 ? i : at;
    const end = i >= 0 ? i + t.length : Math.min(line.length, at + t.length);
    spans.push([start, end]);
    at = end;
  }
  return spans;
}

/** #13: her voice notes' sentences, as synthesized this page's life, by message id (and language). */
const NOTES = new Map<string, Map<number, Extract<SpeakClip, { mode: 'voice' }>>>();
function noteClips(key: string) {
  let m = NOTES.get(key);
  if (!m) { m = new Map(); NOTES.set(key, m); }
  return m;
}

export function useHerVoice(star: StarId, lang: string, talkClip?: string): HerVoice {
  const { state, actions } = useStore();
  const v = state.voice;
  const sound = useSound();
  const available = v ? !!v.tts && (v.ttsStars?.includes(star) ?? true) : trialVoiceFor(star);
  const switchedOn = usePref();
  const on = available && switchedOn;
  const willSpeak = on && sound && (v?.leftSeconds ?? (available ? 600 : 0)) > 0 && !e2e();
  const [phase, setPhase] = useState<VoicePhase>('off');
  const [audible, setAudible] = useState(false);
  const [caption, setCaption] = useState<VoiceCaption | null>(null);
  const current = useRef<{ stop: () => void } | null>(null);
  const clipTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const live = useRef({ on, lang, left: v?.leftSeconds ?? (available ? 600 : 0), clip: talkClip });
  live.current = { on, lang, left: v?.leftSeconds ?? (available ? 600 : 0), clip: talkClip };
  const [lipsync, setLipsync] = useState<LipsyncShot | null>(null);
  const urls = useRef<string[]>([]);
  const dropVideos = useCallback(() => {
    setLipsync(null);
    const old = urls.current;
    urls.current = [];
    // Revoked a moment later: the video element may still be letting go of it.
    if (old.length) setTimeout(() => old.forEach((u) => URL.revokeObjectURL(u)), 1000);
  }, []);

  const quiet = useCallback(() => {
    if (clipTimer.current) clearTimeout(clipTimer.current);
    clipTimer.current = null;
    setAudible(false);
  }, []);
  const stop = useCallback(() => {
    current.current?.stop();
    current.current = null;
    quiet();
    setPhase('off');
    setCaption(null);
    dropVideos();
  }, [quiet, dropVideos]);
  // His voice input, her recorded lines, leaving: stopVoice() hushes this too (N-32).
  useEffect(() => onHush(stop), [stop]);
  useEffect(() => stop, [stop]);
  // Switched off mid-sentence: she stops.
  useEffect(() => { if (!on) stop(); }, [on, stop]);

  const speak = useCallback((text: string, sig?: string, cache?: string) => {
    stop();
    const now = live.current;
    // Only her own words: a reply the server signed (no signature, nothing to say in her voice).
    if (!sig || !now.on || now.left <= 0 || !soundOn() || e2e() || !text.trim()) return;
    const id = lineRequestId();
    const line = text.trim();
    let spans: [number, number][] = [];

    const kept = cache ? noteClips(`${cache}:${now.lang}`) : null;
    const whole = (i: number, suffix = '') => {
      const had = kept?.get(i);
      if (had) return Promise.resolve(had);
      return http.tts({ star, line, sig, index: i, lang: now.lang as Lang, requestId: `${id}:${i}${suffix}` }).then((r) => {
        // Kept without his minutes (-1: not reported again on a replay, which costs nothing).
        if (kept && r.mode === 'voice') kept.set(i, { ...r, leftSeconds: -1 });
        return r;
      });
    };
    const playWhole = (clip: { audio: string; mime: string }, onPlaying: () => void) => {
      const voice = playVoiceOnce(clipUrl(clip), { onPlaying });
      void voice.done.then(() => releaseClipUrl(clip));
      return voice;
    };
    const speech = speakLine(line, {
      // Her first sentence streams (she starts ~0.5 s after her reply); the rest come whole, ahead of her.
      fetch: async (sentence, i): Promise<SpeakClip> => {
        // A voice note (cached) comes whole, so it can be kept and played again.
        if (i > 0 || kept) return whole(i);
        const t = await http.ttsTicket({ star, line, sig, index: 0, lang: now.lang as Lang, requestId: `${id}:0` }).catch(() => null);
        if (!t) return whole(0, 's');
        if (t.mode !== 'stream') return t;
        return { mode: 'stream', url: `${API_BASE}${t.url}`, seconds: estimateSeconds(sentence), leftSeconds: t.leftSeconds, fallback: () => whole(0, 'f') };
      },
      play: (clip, onPlaying) => {
        if (clip.mode === 'voice') return playWhole(clip, onPlaying);
        // The stream: if it fails before a sound, this sentence comes whole instead (never silence, never twice).
        let sounded = false, halted = false;
        // Through Media Source Extensions where it can (plays at the first bytes), else the URL itself.
        const fed = streamSource(clip.url);
        let inner: Voice = playVoiceOnce(fed?.src ?? clip.url, { onPlaying: () => { sounded = true; onPlaying(); } });
        const first = inner;
        const done = first.done.then(async () => {
          fed?.stop();
          if (sounded || halted || !clip.fallback) return;
          const r = await clip.fallback().catch(() => null);
          if (!r || r.mode !== 'voice' || halted) return;
          const again = playWhole(r, onPlaying);
          inner = again;
          await again.done;
        });
        return { done, stop: () => { halted = true; inner.stop(); } };
      },
      prepare: (clip) => preloadVoice(clipUrl(clip)),
      // Rendered in parallel, each from the loop frame her audio before it ends on (the service wraps it to the loop).
      video: (clip, _i, startSeconds) => {
        const token = (clip as { lipsync?: string }).lipsync;
        const loop = live.current.clip;
        if (!token || !loop) return Promise.resolve(null);
        return requestLipsync({ clip: loop, audio: clip.audio, mime: clip.mime, token, start: Math.floor(startSeconds * LOOP_FPS) })
          .then((r) => {
            if (!r) return null;
            if (current.current !== speech) { URL.revokeObjectURL(r.url); return null; }
            urls.current.push(r.url);
            return r.url;
          });
      },
      videoWaitMs: () => LIPSYNC_WAIT_MS
    }, {
      // Before the sentence: shown once her audio sounds. Late (she already speaks): at once, at her voice's position.
      onVideo: (i, src, late) => { if (current.current === speech) setLipsync(src ? { src, key: Date.now() + i, playing: !!late } : null); },
      onLeft: (n) => actions.voiceLeftNow(n),
      onPlaying: (i, sentences, seconds) => {
        if (current.current !== speech) return;
        if (!spans.length) spans = sentenceSpans(text, sentences);
        const [from, to] = spans[i] ?? [0, text.length];
        // Her words appear as she says them: the sentence types out over its own audio.
        setCaption({ from, to, ms: Math.max(200, seconds * 1000), key: Date.now() + i });
        setPhase('playing');
        setLipsync((l) => (l ? { ...l, playing: true } : l));
        if (clipTimer.current) clearTimeout(clipTimer.current);
        clipTimer.current = setTimeout(() => setAudible(true), CLIP_DELAY_MS);
      },
      onEnded: () => { if (current.current === speech) { quiet(); setPhase('gap'); setLipsync(null); } }
    });
    current.current = speech;
    setPhase('waiting');
    void speech.done.catch(() => undefined).finally(() => {
      // Said, cut short or not voiced at all: her subtitle takes over from where her voice was (lib/ttsQueue).
      if (current.current === speech) { current.current = null; quiet(); setPhase('off'); setCaption(null); dropVideos(); }
      // C-room L3: what her voice used, as the server counts it (a stream reports his minutes as it starts): the one
      // count every meter of his reads (state.voice — the input's and 目錄's alike).
      if (state.user) void http.voice().then((now) => actions.setVoice(now)).catch(() => undefined);
    });
  }, [star, stop, quiet, actions, dropVideos, state.user]);

  return { available, on, setOn: setHerVoicePref, willSpeak, phase, audible, caption, speak, stop, lipsync };
}

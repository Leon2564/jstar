/**
 * Her one voice in a scene (N-32): a new piece of her voice stops the one still playing before it starts, so two of
 * her lines never sound at once — her reply to him, a recorded line and her runtime voice alike. `stopAll` is for his
 * answer: he spoke (or sent), and she stops at once (#72).
 */
import { duck, onHush, pauseOwnVoice } from '../lib/sound';

export interface Voice { done: Promise<void>; stop: () => void }
let current: HTMLAudioElement | null = null;
/** Clips fetched ahead (her next sentence while this one plays), so the next starts without a gap. */
const ready = new Map<string, HTMLAudioElement>();

/** Starts loading a clip that is about to play (playVoiceOnce with the same src then uses it). */
export function preloadVoice(src: string): void {
  if (ready.has(src) || typeof Audio === 'undefined') return;
  const a = new Audio(src);
  a.preload = 'auto';
  a.load?.();
  ready.set(src, a);
  // Only the next one or two are ever waiting.
  while (ready.size > 3) ready.delete(ready.keys().next().value as string);
}

/**
 * Plays one piece of her voice. `onPlaying`: the audio is actually sounding now (the element's `playing` event) — what
 * her talking loop and her subtitle follow (#73), not the moment the clip was asked for.
 */
export function playVoiceOnce(src: string, o: { onPlaying?: () => void } = {}): Voice {
  pauseOwnVoice();
  current?.pause();
  const a = ready.get(src) ?? new Audio(src);
  ready.delete(src);
  // iOS's ManagedMediaSource plays only with AirPlay off (her streamed sentence comes as a blob: MediaSource URL).
  if (src.startsWith('blob:')) (a as HTMLAudioElement & { disableRemotePlayback?: boolean }).disableRemotePlayback = true;
  current = a;
  let finish: () => void = () => undefined;
  const done = new Promise<void>((r) => { finish = () => { if (current === a) { current = null; duck(false); } r(); }; });
  a.onended = finish; a.onerror = finish; a.onpause = finish;
  if (o.onPlaying) a.onplaying = () => o.onPlaying?.();
  duck(true);
  void a.play().catch(finish);
  return { done, stop: () => a.pause() };
}

/**
 * Her streamed sentence (#73, first sound) fed to the <audio> through Media Source Extensions: an <audio src=URL>
 * holds back until ~1 s of the stream is in (Chrome measured: ≈ 1.1 s for a short sentence arriving at Fish's pace),
 * while appended to a SourceBuffer it plays ≈ 50 ms after the first bytes. Null where MSE cannot take MP3 (then the
 * plain URL is used); `stop()` aborts the download (the API then charges only what came) and frees the object URL.
 */
export function streamSource(url: string, doFetch: typeof fetch = fetch): { src: string; stop: () => void } | null {
  const w = globalThis as unknown as { ManagedMediaSource?: typeof MediaSource; MediaSource?: typeof MediaSource };
  const MS = w.ManagedMediaSource ?? w.MediaSource;
  if (!MS || typeof URL.createObjectURL !== 'function' || !MS.isTypeSupported?.('audio/mpeg')) return null;
  const ms = new MS();
  const src = URL.createObjectURL(ms);
  const abort = new AbortController();
  let over = false;
  const finish = (error?: boolean) => {
    if (ms.readyState === 'open') { try { ms.endOfStream(error ? 'network' : undefined); } catch { /* closing */ } }
  };
  ms.addEventListener('sourceopen', () => {
    let sb: SourceBuffer;
    try { sb = ms.addSourceBuffer('audio/mpeg'); } catch { finish(true); return; }
    const queue: Uint8Array[] = [];
    let done = false;
    const pump = () => {
      if (sb.updating) return;
      const next = queue.shift();
      if (next) { try { sb.appendBuffer(next as Uint8Array<ArrayBuffer>); } catch { finish(true); } }
      else if (done) finish();
    };
    sb.addEventListener('updateend', pump);
    void (async () => {
      try {
        const res = await doFetch(url, { signal: abort.signal });
        if (!res.ok || !res.body) { finish(true); return; }
        const reader = res.body.getReader();
        for (;;) {
          const { value, done: end } = await reader.read();
          if (end) break;
          if (value?.length) { queue.push(value); pump(); }
        }
        done = true;
        pump();
      } catch { if (!over) finish(true); }
    })();
  }, { once: true });
  return { src, stop: () => { over = true; abort.abort(); setTimeout(() => URL.revokeObjectURL(src), 1000); } };
}

/** Stops whatever of her voice is playing. */
export function stopAll(): void {
  current?.pause();
}

/**
 * Where her voice is now, in seconds into the piece playing (null when none plays): the one clock her lip-sync follows,
 * in her room (components/roomLipsync.tsx) and in scenes (components/lipsyncVideo.tsx). Asked to play but not sounding
 * yet, it is 0.
 */
export const voiceTime = (): number | null => (current && !current.paused ? current.currentTime : null);

/** How long the piece of her voice playing is (s; null when none plays or it is not known yet): with voiceTime, when
 * she will be done — the scene player loads her next line's render for where the clip will be then (#73). */
export const voiceDuration = (): number | null => (current && Number.isFinite(current.duration) ? current.duration : null);

/** Whether any of her voice is playing now (tests, and the player's own checks). */
export const speakingNow = (): boolean => !!current && !current.paused;

// A line of hers played elsewhere (lib/sound.ts playVoice), or stopVoice(), stops this channel too (N-32).
if (typeof window !== 'undefined') onHush(stopAll);

/**
 * Hands-free (#72, optional): while he is not touching anything and she is not speaking, the mic listens by itself —
 * a simple volume threshold (the "simple VAD" of the issue) — and the moment he starts talking the ordinary voice
 * input takes over (lib/voice.ts: live words, stop on silence, send). Off unless he turns it on; remembered on this
 * device only. Nothing is recorded or sent while it merely waits: the level meter reads the microphone in the browser.
 */

const KEY = 'jstar.handsFree';

export function handsFreeOn(): boolean {
  try { return localStorage.getItem(KEY) === 'on'; } catch { return false; }
}
export function setHandsFree(on: boolean) {
  try { if (on) localStorage.setItem(KEY, 'on'); else localStorage.removeItem(KEY); } catch { /* storage blocked: this visit only */ }
}

/** How loud counts as him talking (RMS, 0–1), and for how long, before listening starts. */
export const VAD = { loud: 0.035, holdMs: 200, tickMs: 50 } as const;

/** Whether this browser can wait on the microphone at all (WebAudio + getUserMedia). */
export function canWaitForVoice(): boolean {
  if (typeof window === 'undefined' || !navigator.mediaDevices?.getUserMedia) return false;
  const w = window as unknown as { AudioContext?: unknown; webkitAudioContext?: unknown };
  return !!(w.AudioContext ?? w.webkitAudioContext);
}

/**
 * Waits for his voice: calls `onVoice` once when the level stays above VAD.loud for VAD.holdMs, then lets the
 * microphone go (the recogniser opens its own). `onError`: the microphone was refused or is missing. Returns stop.
 */
export function waitForVoice(onVoice: () => void, onError: (e: 'denied' | 'failed') => void): () => void {
  let stopped = false;
  let stream: MediaStream | null = null;
  let ctx: AudioContext | null = null;
  let timer: ReturnType<typeof setInterval> | undefined;
  const release = () => {
    clearInterval(timer);
    stream?.getTracks().forEach((t) => t.stop());
    void ctx?.close().catch(() => undefined);
    stream = null; ctx = null;
  };
  void (async () => {
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
    } catch (e) {
      const name = (e as { name?: string }).name;
      if (!stopped) onError(name === 'NotAllowedError' || name === 'SecurityError' ? 'denied' : 'failed');
      return;
    }
    if (stopped) { release(); return; }
    const w = window as unknown as { AudioContext?: typeof AudioContext; webkitAudioContext?: typeof AudioContext };
    const Ctx = w.AudioContext ?? w.webkitAudioContext;
    if (!Ctx) { release(); onError('failed'); return; }
    try {
      ctx = new Ctx();
      const an = ctx.createAnalyser();
      an.fftSize = 1024;
      ctx.createMediaStreamSource(stream).connect(an);
      const buf = new Float32Array(an.fftSize);
      let loudFor = 0;
      timer = setInterval(() => {
        an.getFloatTimeDomainData(buf);
        let sum = 0;
        for (const v of buf) sum += v * v;
        loudFor = Math.sqrt(sum / buf.length) > VAD.loud ? loudFor + VAD.tickMs : 0;
        if (loudFor >= VAD.holdMs && !stopped) { stopped = true; release(); onVoice(); }
      }, VAD.tickMs);
    } catch {
      release();
      if (!stopped) onError('failed');
    }
  })();
  return () => { stopped = true; release(); };
}

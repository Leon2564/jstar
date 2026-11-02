/**
 * Voice input (#72): hold the mic to talk, or tap it on and off; it also stops by itself after a short silence.
 * Her line stops the moment he starts. What he said is shown as it is heard and sent when he lets go, through the
 * same chat / scene path as typing, so voice and text share one conversation and one memory.
 *
 * Two recognisers, picked per browser:
 * - `speech`: the browser's own SpeechRecognition (Chrome, Edge, Safari). Free, with live words while he talks.
 * - `server`: MediaRecorder + `POST /v1/asr` (Workers AI Whisper) where there is none (Firefox; iOS with Siri
 *   dictation off). Words appear once he stops. Only when the API says it is on.
 * Neither keeps a recording: the browser streams to its own service, or the clip goes to the API in memory.
 * With neither, the mic is not shown and the text box is all there is.
 */
import { VOICE_INPUT, type AsrLang } from '@jstar/shared/voice';
import type { Lang } from '../i18n';

export type VoicePhase = 'idle' | 'starting' | 'listening' | 'finishing';
/** Why the last attempt ended without sending: said once, then the text box takes over. */
export type VoiceNotice = 'denied' | 'noSpeech' | 'failed' | 'noMic';
export interface VoiceSnapshot {
  phase: VoicePhase;
  /** What has been heard so far (live with `speech`, at the end with `server`). */
  text: string;
  /** The microphone was refused: the mic stays, but he is steered to typing. */
  blocked: boolean;
}

export type EngineError = 'denied' | 'no-speech' | 'no-mic' | 'unavailable' | 'failed';
/** What a recogniser reports back; `sound` = he is making noise (resets the silence timer). */
export interface EngineEvents {
  onStart(): void;
  onText(text: string): void;
  onSound(): void;
  onEnd(): void;
  onError(e: EngineError): void;
}
export interface Engine { stop(): void; abort(): void }
export type EngineFactory = (lang: Lang, ev: EngineEvents) => Engine;

/** A press shorter than this is a tap: listening stays on until the next tap or the silence. */
export const HOLD_MS = 350;
/** After letting go, the recogniser's last words (or the server's answer) are waited for this long at most. */
const FINISH_GUARD_MS = 20_000;

const BCP47: Record<Lang, string> = { ja: 'ja-JP', 'zh-Hant': 'zh-TW', en: 'en-US', ko: 'ko-KR' };
export const asrLang = (lang: Lang): AsrLang => (lang === 'zh-Hant' ? 'zh' : lang);

// ------------------------------------------------------------------ recognisers

interface SpeechAlt { transcript: string }
interface SpeechResultList { length: number; [i: number]: { length: number; isFinal: boolean; [j: number]: SpeechAlt } }
interface SpeechRec {
  lang: string; continuous: boolean; interimResults: boolean; maxAlternatives: number;
  onstart: (() => void) | null; onresult: ((e: { results: SpeechResultList }) => void) | null;
  onerror: ((e: { error: string }) => void) | null; onend: (() => void) | null;
  start(): void; stop(): void; abort(): void;
}
type SpeechCtor = new () => SpeechRec;

function speechCtor(): SpeechCtor | null {
  if (typeof window === 'undefined') return null;
  const w = window as unknown as { SpeechRecognition?: SpeechCtor; webkitSpeechRecognition?: SpeechCtor };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null;
}

/** Chrome on Android repeats earlier words in continuous mode; one utterance per start avoids it. */
const androidChrome = () => typeof navigator !== 'undefined' && /Android/i.test(navigator.userAgent);

export const speechEngine: EngineFactory = (lang, ev) => {
  const Ctor = speechCtor();
  if (!Ctor) { queueMicrotask(() => ev.onError('unavailable')); return { stop() {}, abort() {} }; }
  const rec = new Ctor();
  rec.lang = BCP47[lang];
  rec.interimResults = true;
  rec.continuous = !androidChrome();
  rec.maxAlternatives = 1;
  let failed = false;
  rec.onstart = () => ev.onStart();
  rec.onresult = (e) => {
    let text = '';
    for (let i = 0; i < e.results.length; i++) text += e.results[i][0]?.transcript ?? '';
    ev.onSound();
    ev.onText(text);
  };
  rec.onerror = (e) => {
    if (e.error === 'aborted') return;
    failed = true;
    ev.onError(
      e.error === 'not-allowed' ? 'denied'
        : e.error === 'no-speech' ? 'no-speech'
          : e.error === 'audio-capture' ? 'no-mic'
            // Siri dictation off (iOS), no speech service, or no network to it: the server can still listen.
            : e.error === 'service-not-allowed' || e.error === 'network' || e.error === 'language-not-supported' ? 'unavailable'
              : 'failed'
    );
  };
  rec.onend = () => { if (!failed) ev.onEnd(); };
  try { rec.start(); } catch { queueMicrotask(() => ev.onError('failed')); }
  return { stop: () => rec.stop(), abort: () => { failed = true; rec.abort(); } };
};

/** A recording format the server accepts, in the order browsers do best (Firefox/Chrome Opus, Safari AAC). */
function recorderMime(): string | null {
  const MR = typeof window !== 'undefined' ? (window as unknown as { MediaRecorder?: { isTypeSupported?: (t: string) => boolean } }).MediaRecorder : undefined;
  if (!MR) return null;
  const types = ['audio/webm;codecs=opus', 'audio/ogg;codecs=opus', 'audio/mp4', 'audio/webm'];
  return types.find((t) => MR.isTypeSupported?.(t)) ?? '';
}

/** How loud counts as talking (RMS of the waveform, 0–1): above room noise, below a normal voice at arm's length. */
const LOUD = 0.02;

/** MediaRecorder + the API's recogniser. `upload` sends the clip and resolves with the words. */
export function serverEngine(upload: (clip: Blob, lang: AsrLang) => Promise<string>): EngineFactory {
  return (lang, ev) => {
    let stream: MediaStream | null = null;
    let rec: MediaRecorder | null = null;
    let ctx: AudioContext | null = null;
    let meter: ReturnType<typeof setInterval> | undefined;
    let aborted = false;
    let heard = false;
    const chunks: Blob[] = [];
    const release = () => {
      clearInterval(meter);
      stream?.getTracks().forEach((t) => t.stop());
      void ctx?.close().catch(() => undefined);
    };
    const done = async () => {
      release();
      if (aborted) return;
      const clip = new Blob(chunks, { type: (rec?.mimeType || 'audio/webm').split(';')[0] });
      // Nothing above room noise: no upload (Whisper invents words for silence), just "say it again".
      if (!heard || !clip.size) { ev.onError('no-speech'); return; }
      if (clip.size > VOICE_INPUT.maxBytes) { ev.onError('failed'); return; }
      try {
        ev.onText(await upload(clip, asrLang(lang)));
        if (!aborted) ev.onEnd();
      } catch (e) {
        if (!aborted) ev.onError((e as { code?: string }).code === 'asr_unavailable' ? 'unavailable' : 'failed');
      }
    };
    void (async () => {
      try {
        stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
      } catch (e) {
        const name = (e as { name?: string }).name;
        ev.onError(name === 'NotAllowedError' || name === 'SecurityError' ? 'denied' : name === 'NotFoundError' || name === 'NotReadableError' ? 'no-mic' : 'failed');
        return;
      }
      if (aborted) { release(); return; }
      const mime = recorderMime();
      try {
        rec = new MediaRecorder(stream, { ...(mime ? { mimeType: mime } : {}), audioBitsPerSecond: 32_000 });
      } catch { release(); ev.onError('failed'); return; }
      rec.ondataavailable = (e) => { if (e.data.size) chunks.push(e.data); };
      rec.onstop = () => void done();
      // The level meter drives the silence stop; without WebAudio the clip is simply taken as speech.
      const AC = (window as unknown as { AudioContext?: typeof AudioContext; webkitAudioContext?: typeof AudioContext });
      const Ctx = AC.AudioContext ?? AC.webkitAudioContext;
      if (Ctx) {
        try {
          ctx = new Ctx();
          const an = ctx.createAnalyser();
          an.fftSize = 1024;
          ctx.createMediaStreamSource(stream).connect(an);
          const buf = new Float32Array(an.fftSize);
          meter = setInterval(() => {
            an.getFloatTimeDomainData(buf);
            let sum = 0;
            for (const v of buf) sum += v * v;
            if (Math.sqrt(sum / buf.length) > LOUD) { heard = true; ev.onSound(); }
          }, 100);
        } catch { heard = true; }
      } else heard = true;
      rec.start(250);
      ev.onStart();
    })();
    return {
      stop: () => { if (rec && rec.state !== 'inactive') rec.stop(); else if (!rec) { aborted = true; release(); ev.onError('no-speech'); } },
      abort: () => { aborted = true; if (rec && rec.state !== 'inactive') rec.stop(); release(); }
    };
  };
}

/** Whether this browser can record for the server fallback. */
export function canRecord(): boolean {
  return typeof window !== 'undefined' && !!navigator.mediaDevices?.getUserMedia && recorderMime() !== null;
}

// ------------------------------------------------------------------ picking one

/** A recogniser that failed for reasons other than him (no service, no network) is not offered again this visit. */
let speechBroken = false;
let serverBroken = false;
export function markBroken(which: 'speech' | 'server') { if (which === 'speech') speechBroken = true; else serverBroken = true; }
/** Tests only. */
export function resetVoiceSupport() { speechBroken = false; serverBroken = false; }

/**
 * The recognisers this browser can use, best first. `server` is the API's fallback (null when it is off or this is
 * the offline prototype). Empty = no mic at all.
 */
export function voiceEngines(server: EngineFactory | null): { kind: 'speech' | 'server'; make: EngineFactory }[] {
  const out: { kind: 'speech' | 'server'; make: EngineFactory }[] = [];
  if (!speechBroken && speechCtor()) out.push({ kind: 'speech', make: speechEngine });
  if (!serverBroken && server && canRecord()) out.push({ kind: 'server', make: server });
  return out;
}

// ------------------------------------------------------------------ the state machine

export interface VoiceOptions {
  lang: Lang;
  engines: { kind: 'speech' | 'server'; make: EngineFactory }[];
  /** He started talking: stop her voice and her line (the interruption). */
  onStart?: () => void;
  /** What he said, trimmed and non-empty, once he stops. */
  onFinal: (text: string) => void;
  onNotice?: (n: VoiceNotice) => void;
  /** Called on every change; the React hook re-renders from it. */
  onChange?: (s: VoiceSnapshot) => void;
}

export interface VoiceController {
  get(): VoiceSnapshot;
  /** Pointer down on the mic: starts (hold); or, while a tap left it listening, ends it. */
  press(): void;
  /** Pointer up: a hold ends and sends; a short tap leaves it listening. */
  release(): void;
  /** Keyboard / switch access: on, then off and send. */
  toggle(): void;
  /** He started typing instead: stop without sending (what was heard stays for the text box). */
  cancel(): void;
  dispose(): void;
}

export function createVoice(opts: VoiceOptions): VoiceController {
  let s: VoiceSnapshot = { phase: 'idle', text: '', blocked: false };
  let engine: Engine | null = null;
  let which = 0;
  let mode: 'hold' | 'toggle' = 'hold';
  let pressedAt = 0;
  let heard = false;
  let run = 0;
  const timers: Record<'silence' | 'max' | 'guard' | 'noSpeech', ReturnType<typeof setTimeout> | undefined> = { silence: undefined, max: undefined, guard: undefined, noSpeech: undefined };
  const clear = (k?: keyof typeof timers) => {
    for (const key of (k ? [k] : Object.keys(timers)) as (keyof typeof timers)[]) { clearTimeout(timers[key]); timers[key] = undefined; }
  };
  const set = (patch: Partial<VoiceSnapshot>) => { s = { ...s, ...patch }; opts.onChange?.(s); };

  const finishIdle = (notice?: VoiceNotice) => {
    clear();
    engine = null;
    run++;
    set({ phase: 'idle' });
    if (notice) opts.onNotice?.(notice);
  };

  const deliver = () => {
    const text = s.text.trim();
    finishIdle(text ? undefined : 'noSpeech');
    if (text) { set({ text: '' }); opts.onFinal(text.slice(0, 500)); }
  };

  const finish = () => {
    if (s.phase !== 'listening' && s.phase !== 'starting') return;
    clear('silence'); clear('max'); clear('noSpeech');
    set({ phase: 'finishing' });
    timers.guard = setTimeout(() => { engine?.abort(); deliver(); }, FINISH_GUARD_MS);
    engine?.stop();
  };

  const begin = () => {
    const option = opts.engines[which];
    if (!option) { finishIdle('failed'); return; }
    const mine = ++run;
    heard = false;
    const live = () => mine === run;
    engine = option.make(opts.lang, {
      onStart: () => {
        if (!live() || s.phase !== 'starting') return;
        set({ phase: 'listening', blocked: false });
        timers.max = setTimeout(finish, VOICE_INPUT.maxMs);
        timers.noSpeech = setTimeout(() => { if (!heard && live()) { engine?.abort(); finishIdle('noSpeech'); } }, VOICE_INPUT.noSpeechMs);
      },
      onText: (text) => { if (live()) set({ text }); },
      onSound: () => {
        if (!live() || s.phase !== 'listening') return;
        heard = true;
        clear('noSpeech'); clear('silence');
        timers.silence = setTimeout(finish, VOICE_INPUT.silenceMs);
      },
      onEnd: () => { if (live()) deliver(); },
      onError: (e) => {
        if (!live()) return;
        if (e === 'unavailable') {
          markBroken(option.kind);
          // The next recogniser takes over for this very press (the browser's own service is off: record instead).
          if (opts.engines[which + 1] && s.phase === 'starting') { which++; begin(); return; }
          which++;
          finishIdle('failed');
          return;
        }
        // What was heard before a late error is still his.
        if (e === 'no-speech' && s.text.trim()) { deliver(); return; }
        if (e === 'denied') set({ blocked: true });
        finishIdle(e === 'denied' ? 'denied' : e === 'no-speech' ? 'noSpeech' : e === 'no-mic' ? 'noMic' : 'failed');
      }
    });
  };

  const start = (m: 'hold' | 'toggle') => {
    mode = m;
    pressedAt = Date.now();
    set({ phase: 'starting', text: '' });
    // Her line stops the moment he reaches for the mic, not when the recogniser is ready.
    opts.onStart?.();
    begin();
  };

  return {
    get: () => s,
    press() {
      if (s.phase === 'idle') start('hold');
      else if (s.phase === 'listening' && mode === 'toggle') finish();
    },
    release() {
      if (s.phase === 'listening' && mode === 'hold') {
        if (Date.now() - pressedAt >= HOLD_MS) finish(); else mode = 'toggle';
      } else if (s.phase === 'starting') {
        // Released while the permission prompt or the recogniser is still coming up: keep listening until he stops.
        mode = 'toggle';
      }
    },
    toggle() {
      if (s.phase === 'idle') start('toggle');
      else if (s.phase === 'listening' || s.phase === 'starting') finish();
    },
    cancel() {
      if (s.phase === 'idle') return;
      engine?.abort();
      finishIdle();
    },
    dispose() { engine?.abort(); clear(); run++; }
  };
}

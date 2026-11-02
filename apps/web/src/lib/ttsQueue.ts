/**
 * Her runtime voice on the web (#73): a line she says that could not be recorded in advance (her free-talk reply, a
 * `tts: true` line with his name) is cut into sentences and played in order: her first streamed as it is synthesized
 * (a ticket, then the <audio> plays `GET /v1/tts/stream/…`), the next ones fetched whole (`POST /v1/tts`) ahead of
 * her, by queued audio time, so she starts within a second and never pauses between sentences.
 * Her subtitle follows the audio: each sentence appears when it starts to play.
 *
 * Nothing here is an error for him: when her voice is off (no provider, not an operator), his minutes are used up,
 * the network is down or the provider fails, the answer is `subtitle` and the line shows as text — as it always has.
 * If that happens mid-line, the rest of the line is shown as text.
 */
import { splitSentences } from '@jstar/shared/voice';
import type { TtsResT } from '@jstar/shared/contracts';

export { splitSentences } from '@jstar/shared/voice';

export interface Playback { done: Promise<void>; stop: () => void }
/** A sentence of hers to play: its whole audio (`voice`), or a stream URL the <audio> plays as it comes (`stream`). */
export type StreamClip = { mode: 'stream'; url: string; seconds: number; leftSeconds: number; fallback?: () => Promise<TtsResT> };
export type SpeakClip = TtsResT | StreamClip;
export type PlayClip = Extract<TtsResT, { mode: 'voice' }> | StreamClip;
export interface SpeakDeps {
  /** One sentence (its index makes the request id): `POST /v1/tts`, or a stream ticket for her first. */
  fetch: (sentence: string, index: number) => Promise<SpeakClip>;
  /**
   * Plays one sentence's audio; resolves when it ends, fails or is stopped. `onPlaying` when it is actually sounding.
   */
  play: (clip: PlayClip, onPlaying: () => void) => Playback;
  /** A later sentence's audio has come while she speaks: get it ready, so there is no gap before it. */
  prepare?: (clip: { audio: string; mime: string }) => void;
  /**
   * Her lip-sync (#73, lib/lipsync.ts): asked for each sentence that came whole as soon as its audio is here (a streamed
   * sentence has no whole audio to render: it plays over her talk loop), up to `videoConcurrency` at once, in sentence
   * order; `startSeconds` is how much of her audio comes before it (where the loop is when it starts). Resolves with a
   * video URL, or null. Her voice never waits for it beyond `videoWaitMs(index)` (0 in her room).
   */
  video?: (clip: Extract<TtsResT, { mode: 'voice' }>, index: number, startSeconds: number) => Promise<string | null>;
  videoWaitMs?: (index: number) => number;
  /** Renders at once (default VIDEO_CONCURRENCY). */
  videoConcurrency?: number;
}

/** Her lip-sync renders asked for at once (the service runs up to 10 GPU containers; a few per room is plenty). */
export const VIDEO_CONCURRENCY = 3;
export interface SpeakEvents {
  /** Sentence `index` starts to play: show the subtitle up to it. */
  onSentence?: (index: number, sentences: string[]) => void;
  /** Voice seconds he has left, after each answer. */
  onLeft?: (leftSeconds: number) => void;
  /** Sentence `index` is sounding now; it lasts `seconds` (her subtitle reveals it over that time, #73). */
  onPlaying?: (index: number, sentences: string[], seconds: number) => void;
  /** Sentence `index` has ended (or stopped): she is silent until the next one sounds. */
  onEnded?: (index: number) => void;
  /**
   * Sentence `index` is about to play with this video (null: without, over her talk loop) — or, `late`, its video came
   * while it already sounds: switch to it there (seeked to where her voice is).
   */
  onVideo?: (index: number, src: string | null, late?: boolean) => void;
}

/** Resolves with `p`'s value, or `fallback` once `ms` have passed. */
export function within<T>(p: Promise<T>, ms: number, fallback: T): Promise<T> {
  return new Promise((resolve) => {
    const t = setTimeout(() => resolve(fallback), Math.max(0, ms));
    p.then((v) => { clearTimeout(t); resolve(v); }, () => { clearTimeout(t); resolve(fallback); });
  });
}
/**
 * `voice`: she said it all (or was stopped). `subtitle`: nothing was voiced — show the line as text. `cut`: she said
 * the first `said` sentences, then her voice stopped (minutes ran out, a failure): show the rest as text.
 */
export type SpeakResult = { mode: 'voice' } | { mode: 'subtitle'; reason: string } | { mode: 'cut'; said: number; reason: string };

/**
 * How far ahead her next sentences are asked for (#73, gaps): until AHEAD_SECONDS of her audio is queued after the
 * one she is saying (known once a sentence has come, estimated from its length until then), with at most MAX_OPEN
 * requests open per line — well under the API's 40 sentences a minute per account. The first is asked for first, so
 * she starts as soon as possible; more go out as each answer comes and as each sentence starts.
 */
export const AHEAD_SECONDS = 6;
export const MAX_OPEN = 4;
/** Her speaking rate, to estimate a sentence before it is synthesized: ≈ 6.5 characters a second (CJK), 14 (Latin). */
export const estimateSeconds = (t: string): number => {
  const chars = [...t.trim()];
  const latin = chars.filter((c) => /[A-Za-z]/.test(c)).length > chars.length / 2;
  return chars.length / (latin ? 14 : 6.5);
};

export function speakLine(text: string, deps: SpeakDeps, ev: SpeakEvents = {}): { sentences: string[]; done: Promise<SpeakResult>; stop: () => void } {
  const sentences = splitSentences(text);
  const asked: (Promise<SpeakClip> | undefined)[] = [];
  const got: (SpeakClip | undefined)[] = [];
  const known: (number | undefined)[] = [];
  const videos: (Promise<string | null> | undefined)[] = [];
  /**
   * Lip-sync renders, in parallel (QA: one after another they ran slower than she speaks): each sentence's as soon as
   * its audio is here, at most `videoConcurrency` at once, the earliest sentence first. Its start frame follows from the
   * audio before it (known, else estimated), so renders need not wait for each other.
   */
  const limit = deps.videoConcurrency ?? VIDEO_CONCURRENCY;
  let rendering = 0;
  const waiting = new Set<number>();
  const deferred = new Map<number, (v: string | null) => void>();
  const startOf = (k: number) => sentences.slice(0, k).reduce((n, t, j) => n + (known[j] ?? estimateSeconds(t)), 0);
  const pump = (): void => {
    while (deps.video && !stopped && rendering < limit && waiting.size) {
      const k = Math.min(...waiting);
      waiting.delete(k);
      const r = got[k] as Extract<TtsResT, { mode: 'voice' }>;
      const settle = deferred.get(k)!;
      deferred.delete(k);
      rendering++;
      deps.video(r, k, startOf(k)).catch(() => null).then((v) => { rendering--; settle(v); pump(); });
    }
  };
  /** Sentence `k`'s render: its promise now (the sentence looks for it), asked for when a render slot is free. */
  const film = (k: number): void => {
    if (!deps.video || stopped || videos[k] || got[k]?.mode !== 'voice') return;
    videos[k] = new Promise<string | null>((r) => deferred.set(k, r));
    waiting.add(k);
    pump();
  };
  /** Stopped: renders not yet asked for never will be. */
  const dropRenders = () => { waiting.clear(); deferred.forEach((settle) => settle(null)); deferred.clear(); };
  let stopped = false;
  let playing: Playback | null = null;
  let open = 0;
  let at = 0;
  const ask = (i: number): Promise<SpeakClip> => {
    if (asked[i]) return asked[i]!;
    open++;
    const p = deps.fetch(sentences[i], i)
      .catch((): TtsResT => ({ mode: 'subtitle', reason: 'failed', leftSeconds: -1 }))
      .then((r) => {
        open--;
        got[i] = r;
        if (r.mode === 'voice') { known[i] = r.seconds; if (!stopped && i > at) deps.prepare?.(r); }
        film(i);
        // An answer came: keep the queue filled.
        if (!stopped) askAhead();
        return r;
      });
    asked[i] = p;
    return p;
  };
  /** Asks for the sentences after the one she is at, in order, until AHEAD_SECONDS are queued or MAX_OPEN are open. */
  const askAhead = () => {
    let queued = 0;
    for (let k = at + 1; k < sentences.length && !stopped && queued < AHEAD_SECONDS; k++) {
      if (!asked[k]) { if (open >= MAX_OPEN) break; void ask(k); }
      queued += known[k] ?? estimateSeconds(sentences[k]);
    }
  };
  const done = (async (): Promise<SpeakResult> => {
    for (let i = 0; i < sentences.length; i++) {
      at = i;
      const first = ask(i);
      // Her first sentence goes out first (the soonest she can start); the next ones follow right after.
      if (i === 0) void Promise.resolve().then(() => askAhead());
      const r = await first;
      if (stopped) return { mode: 'voice' };
      if (r.leftSeconds >= 0) ev.onLeft?.(r.leftSeconds);
      if (r.mode !== 'voice' && r.mode !== 'stream') return i === 0 ? { mode: 'subtitle', reason: r.reason } : { mode: 'cut', said: i, reason: r.reason };
      // While this one plays, the next ones are on their way.
      askAhead();
      let shown = false;
      if (deps.video) {
        // Whole: lip-synced if its render is here (her voice waits for it at most videoWaitMs: 0 in her room).
        // Streamed: over her talk loop.
        if (r.mode === 'voice') {
          film(i);
          const src = await within(videos[i]!, deps.videoWaitMs?.(i) ?? 0, null);
          if (stopped) return { mode: 'voice' };
          shown = !!src;
          ev.onVideo?.(i, src);
        } else ev.onVideo?.(i, null);
      }
      ev.onSentence?.(i, sentences);
      let sounding = true;
      playing = deps.play(r, () => { if (!stopped) ev.onPlaying?.(i, sentences, r.seconds); });
      // Its render came while she says it: switch to it there.
      if (!shown && videos[i]) void videos[i]!.then((src) => { if (src && sounding && !stopped) ev.onVideo?.(i, src, true); });
      await playing.done;
      sounding = false;
      playing = null;
      ev.onEnded?.(i);
      if (stopped) return { mode: 'voice' };
    }
    return { mode: 'voice' };
  })();
  return { sentences, done, stop: () => { stopped = true; dropRenders(); playing?.stop(); } };
}

/** A request id per line (the API charges each sentence once, however often it is retried). */
export function lineRequestId(): string {
  const c = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
  return c?.randomUUID ? `line-${c.randomUUID()}` : `line-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

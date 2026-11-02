import type { Lang, StarId } from '@jstar/shared';

/**
 * Her voice at runtime (#73): what she says that could not be recorded in advance — her free-talk replies, her lines
 * with his name — synthesized in HER cloned voice. The provider sits behind the Worker's tts.internal relay (the API
 * container has no internet, and the vendor key is a Worker secret), exactly as speech input does with asr.internal.
 *
 * Providers: `none` (the default: no relay configured — every line stays a subtitle) or the relay, which answers with
 * the vendor the Worker is configured for (Fish Audio / MiniMax / ElevenLabs, infra/cloudflare/src/tts.ts). A generic
 * synthetic voice never stands in for hers: a talent without a cloned voice is `tts_no_voice`, and she stays in subtitles.
 */
export interface Synthesis {
  audio: Buffer;
  mime: string;
  /** Length of the audio, as the provider measured it: this is what his voice time is charged (#74). */
  seconds: number;
}
export type Synthesize = (req: { star: StarId; text: string; lang: Lang }) => Promise<Synthesis>;

export class TtsError extends Error {
  constructor(public code: 'tts_unavailable' | 'tts_failed' | 'tts_no_voice' | 'tts_no_stream') { super(code); }
}

/** The audio types a provider may answer with; anything else is refused rather than passed to the browser. */
const AUDIO = /^audio\/(mpeg|mp3|ogg|opus|webm|wav|x-wav|aac|mp4)$/;
/** One or two sentences of speech: a few hundred KB at most. */
const MAX_BYTES = 2 * 1024 * 1024;

/**
 * The Worker relay (`POST {relay}/synthesize {star, text, lang}` → the audio, `x-tts-seconds` its length). Empty relay =
 * provider `none`: her runtime voice is off (local dev, tests, any deploy without a vendor account, #84).
 * 404 = the relay has no provider (or `{error: "no_voice"}`: none for her); anything else not 200 = failed.
 */
export function relaySynthesizer(relay: string, f: typeof fetch = fetch): Synthesize | null {
  if (!relay) return null;
  return async ({ star, text, lang }) => {
    let res: Response;
    try {
      res = await f(`${relay}/synthesize`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ star, text, lang }),
        signal: AbortSignal.timeout(15_000)
      });
    } catch {
      throw new TtsError('tts_unavailable');
    }
    if (res.status === 404) {
      const why = (await res.json().catch(() => ({}))) as { error?: unknown };
      throw new TtsError(why.error === 'no_voice' ? 'tts_no_voice' : 'tts_unavailable');
    }
    if (!res.ok) throw new TtsError('tts_failed');
    const mime = String(res.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase();
    const seconds = Number(res.headers.get('x-tts-seconds'));
    const audio = Buffer.from(await res.arrayBuffer());
    // Unmeasured audio cannot be charged fairly, so it is not played either.
    if (!AUDIO.test(mime) || !Number.isFinite(seconds) || seconds <= 0 || !audio.length || audio.length > MAX_BYTES) throw new TtsError('tts_failed');
    return { audio, mime, seconds };
  };
}

/**
 * Her sentence as a stream (#73, first sound): `POST {relay}/stream {star, text, lang}` → the vendor's MP3 as it is
 * synthesized (Fish). Resolves with the body once the vendor has answered; `signal` aborts it (he left, or stopped
 * her). TtsError `tts_no_stream` when the vendor cannot stream (the web app then uses the whole-file path).
 */
export type StreamSynthesize = (req: { star: StarId; text: string; lang: Lang }, signal: AbortSignal) => Promise<ReadableStream<Uint8Array>>;

export function relayStreamer(relay: string, f: typeof fetch = fetch): StreamSynthesize | null {
  if (!relay) return null;
  return async ({ star, text, lang }, signal) => {
    let res: Response;
    try {
      res = await f(`${relay}/stream`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ star, text, lang }), signal });
    } catch {
      throw new TtsError('tts_unavailable');
    }
    if (res.status === 501) throw new TtsError('tts_no_stream');
    if (res.status === 404) throw new TtsError('tts_no_voice');
    if (!res.ok || !res.body || !/^audio\/mpeg/.test(res.headers.get('content-type') ?? '')) throw new TtsError('tts_failed');
    return res.body;
  };
}

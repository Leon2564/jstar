import type { AsrLang, AsrResT } from '@jstar/shared';

/**
 * Speech to text for browsers without their own recogniser (Firefox, some in-app browsers, iOS when Siri
 * dictation is off). The recording goes to the Worker's asr.internal relay, which runs Workers AI Whisper on the
 * Cloudflare account the service already lives on — no new vendor, no new key. Nothing here keeps the audio: it
 * is passed on in memory, and neither the audio nor the text is logged.
 */
export type Transcribe = (audio: Buffer, mime: string, lang: AsrLang | undefined) => Promise<AsrResT>;

export class AsrError extends Error {
  constructor(public code: 'asr_unavailable' | 'asr_failed') { super(code); }
}

/** The Worker relay (`POST {relay}/transcribe`). Empty relay = server speech input is off (local dev, tests). */
export function relayTranscriber(relay: string, f: typeof fetch = fetch): Transcribe | null {
  if (!relay) return null;
  return async (audio, mime, lang) => {
    let res: Response;
    try {
      res = await f(`${relay}/transcribe`, {
        method: 'POST',
        headers: { 'content-type': mime, ...(lang ? { 'x-asr-lang': lang } : {}) },
        body: audio,
        signal: AbortSignal.timeout(20_000)
      });
    } catch {
      throw new AsrError('asr_unavailable');
    }
    if (!res.ok) throw new AsrError(res.status === 404 ? 'asr_unavailable' : 'asr_failed');
    const out = (await res.json().catch(() => ({}))) as { text?: unknown; lang?: unknown };
    return { text: typeof out.text === 'string' ? out.text.trim().slice(0, 500) : '', lang: typeof out.lang === 'string' ? out.lang : null };
  };
}

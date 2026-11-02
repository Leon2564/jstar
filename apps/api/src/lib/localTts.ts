import { STAR_IDS, type StarId } from '@jstar/shared';
import { synthesizeRelay, TTS_ADAPTERS, ttsStars, type TtsEnv } from '../../../../infra/cloudflare/src/tts';
import { relayStreamer, relaySynthesizer, type StreamSynthesize, type Synthesize } from './tts';

/**
 * Local preview adapter for the same Fish Audio implementation used by the production Worker.
 * Keys remain in the API process; browsers only receive short-lived TTS tickets and audio bytes.
 * Production never uses this path: it keeps calling the private Worker relay at TTS_URL.
 */
export function localTts(env: TtsEnv, vendorFetch: typeof fetch = fetch): {
  synthesize: Synthesize | null;
  streamSynthesize: StreamSynthesize | null;
  stars: readonly StarId[];
} {
  const stars = ttsStars(env).filter((star): star is StarId => STAR_IDS.includes(star as StarId));
  if (!stars.length) return { synthesize: null, streamSynthesize: null, stars };

  const bridge: typeof fetch = (input, init) => {
    const request = new Request(input, init);
    return synthesizeRelay(request, env, TTS_ADAPTERS, vendorFetch);
  };
  return {
    synthesize: relaySynthesizer('http://tts.local', bridge),
    streamSynthesize: relayStreamer('http://tts.local', bridge),
    stars
  };
}

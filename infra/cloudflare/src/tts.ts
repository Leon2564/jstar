/**
 * The API container's text to speech (#73): her voice for what could not be recorded in advance, synthesized by the
 * vendor that holds HER cloned voice. Reachable only through the container's outbound interception
 * (`http://tts.internal`): `POST /synthesize {star, text, lang}` → the audio, with `x-tts-seconds` its measured length
 * (what the API charges to his voice minutes, #74). The vendor keys stay here as Worker secrets.
 *
 * Three vendors are implemented (docs/tts.md has the request and response shapes with their sources):
 * - `fish`: Fish Audio, model `s2.1-pro` (the owner's pick, 2026-10-02). `POST /v1/tts` with her voice model's
 *   `reference_id`; the answer is a chunked MP3, whose duration is counted from its frames.
 * - `qwen`: Alibaba Cloud Model Studio (DashScope, international / Singapore), Qwen3-TTS-VC — the same model family as
 *   her recorded lines (tools/voice, Qwen3-TTS 1.7B). HTTP with SSE: base64 PCM chunks, 24 kHz mono 16-bit.
 * - `byteplus`: BytePlus Seed Speech, Voice Replication 2.0 (`seed-icl-2.0`). HTTP unidirectional streaming: JSON
 *   objects with base64 PCM, then `code 20000000`.
 * Qwen and BytePlus answer PCM, wrapped here in a WAV header: its length IS the measured duration (bytes / rate / 2).
 *
 * Configuration (Worker vars / secrets; with no voice configured her runtime voice is off and TTS_URL is not set):
 * - `TTS_VOICES` (var): JSON `{ "<star>": "<voice id>" }`, or `{ "<star>": { "provider": "qwen", "voice": "<id>" } }`
 *   to give one talent another vendor (the pilot may pick the better vendor per talent). A talent without an entry
 *   has no runtime voice: 404 `no_voice`, and she stays in subtitles.
 * - `TTS_PROVIDER` (var): the vendor of plain-string entries: `fish` | `qwen` | `byteplus` (`minimax` | `elevenlabs`
 *   remain empty slots).
 * - Keys (secrets): `FISH_API_KEY` (fish), `DASHSCOPE_API_KEY` (qwen), `BYTEPLUS_VOICE_API_KEY` (byteplus; NOT the
 *   ModelArk key), or the generic `TTS_API_KEY` for the vendor named in TTS_PROVIDER. A vendor without its key has no
 *   voices.
 * - Optional vars: `FISH_TTS_MODEL` (default s2.1-pro), `FISH_TTS_LATENCY`, `QWEN_TTS_MODEL` (must equal the
 *   enrollment's target_model), `DASHSCOPE_BASE_URL`, `BYTEPLUS_TTS_RESOURCE`, `BYTEPLUS_TTS_URL`.
 *
 * NEVER a generic voice: no preset or stock voice (and not Workers AI's MeloTTS or any other synthetic default) ever
 * speaks as her. Her voice is only her licensed clone (#84); anything else is subtitles.
 *
 * No Workers imports here, so the API's tests run this very handler (apps/api/tests/voice.test.ts).
 */
import { toSimplified } from './hans';

export const TTS_PROVIDERS = ['none', 'qwen', 'byteplus', 'fish', 'minimax', 'elevenlabs'] as const;
export type TtsProvider = (typeof TTS_PROVIDERS)[number];
type Vendor = Exclude<TtsProvider, 'none'>;

export interface TtsEnv {
  TTS_PROVIDER?: string;
  FISH_API_KEY?: string;
  FISH_TTS_MODEL?: string;
  FISH_TTS_LATENCY?: string;
  FISH_TTS_URL?: string;
  /** Fish sampling (defaults 0.7 / 0.7): lower is more consistent. Unset = Fish's defaults. */
  FISH_TTS_TEMPERATURE?: string;
  FISH_TTS_TOP_P?: string;
  /** `off`: her zh-Hant lines go to Fish as written (no Mandarin cue, see spokenText). */
  FISH_ZH_HINT?: string;
  TTS_API_KEY?: string;
  TTS_VOICES?: string;
  DASHSCOPE_API_KEY?: string;
  DASHSCOPE_BASE_URL?: string;
  QWEN_TTS_MODEL?: string;
  BYTEPLUS_VOICE_API_KEY?: string;
  BYTEPLUS_TTS_RESOURCE?: string;
  BYTEPLUS_TTS_URL?: string;
}

/** The models (config/models.json voice.runtimeFish / runtimeQwen / runtimeByteplus; a test keeps them equal). */
export const FISH_TTS_MODEL = 's2.1-pro';
export const FISH_TTS_URL = 'https://api.fish.audio/v1/tts';
export const QWEN_TTS_MODEL = 'qwen3-tts-vc-2026-01-22';
export const BYTEPLUS_TTS_RESOURCE = 'seed-icl-2.0';
/** DashScope international (Singapore): its API keys are not the Beijing region's. */
export const DASHSCOPE_BASE_URL = 'https://dashscope-intl.aliyuncs.com/api/v1';
export const BYTEPLUS_TTS_URL = 'https://voice.ap-southeast-1.bytepluses.com/api/v3/tts/unidirectional';
/** BytePlus documents this X-Api-App-Key as a fixed value for the v3 TTS API (not a secret). */
const BYTEPLUS_APP_KEY = 'aGjiRDfUWi';
/** What both vendors are asked for: 24 kHz mono 16-bit PCM. */
export const PCM_RATE = 24_000;

/** One vendor's synthesis: her cloned voice `voiceId` saying `text`; `seconds` must be the audio's real length. */
export type TtsAdapter = (input: { voiceId: string; text: string; lang: string; apiKey: string; fetch: typeof fetch; env?: TtsEnv }) =>
  Promise<{ audio: ArrayBuffer; mime: string; seconds: number }>;

const STARS = ['mahiro', 'nana', 'unpai', 'alice', 'eimi'] as const;
const LANGS = new Set(['ja', 'zh-Hant', 'en', 'ko']);
/** VOICE_RULES.ttsMaxChars in packages/shared: one or two sentences per request. */
const MAX_CHARS = 200;
/** A synthesis that takes longer than this is a failure (the web app then shows the sentence as text). */
const TIMEOUT_MS = 12_000;

/** Our languages as Qwen-TTS's `language_type` (specifying it reads better than `Auto`, per the docs). */
export const QWEN_LANG: Record<string, string> = { ja: 'Japanese', 'zh-Hant': 'Chinese', en: 'English', ko: 'Korean' };
/** Our languages as Seed Speech's `explicit_language` (`zh-cn`: Chinese, Mandarin). */
export const BYTEPLUS_LANG: Record<string, string> = { ja: 'ja', 'zh-Hant': 'zh-cn', en: 'en', ko: 'ko' };

/**
 * Her zh-Hant lines are Traditional Chinese read in Mandarin. The text a vendor reads (never what he sees) can be
 * converted to Simplified first: per vendor, set from the pilot's reading test (docs/tts.md § Traditional Chinese).
 */
export const HANT_AS_HANS: Record<Vendor, boolean> = { qwen: false, byteplus: false, fish: false, minimax: false, elevenlabs: false };

/**
 * Her zh-Hant line for Fish (#73, docs/tts.md › zh-Hant experiments): her Japanese-trained clone reads Mandarin with a
 * Japanese accent, worst on drawn-out marks and ellipses (早～安～！……). Those become plain pauses, and an S2
 * natural-language cue in front asks for standard Mandarin — never spoken (checked), billed as text. In the pilot this
 * took Mandarin CER from 22–25 % to 16–18 %. `FISH_ZH_HINT=off` sends the line as written.
 */
export const FISH_ZH_HINT = '[用標準的台灣國語自然地說] ';
export function mandarinPauses(t: string): string {
  const c = t
    .replace(/[～〜~]+/g, '')
    .trim()
    .replace(/^[….]+/, '')
    .replace(/…+/g, '，')
    .replace(/[，、]{2,}/g, '，')
    .replace(/，([。！？!?」』])/g, '$1')
    .replace(/([。！？!?])[，、]+/g, '$1')
    .replace(/^，+|，+$/g, '');
  return c || t;
}

export function spokenText(vendor: Vendor, lang: string, text: string, env: TtsEnv = {}): string {
  if (lang !== 'zh-Hant') return text;
  if (vendor === 'fish' && env.FISH_ZH_HINT !== 'off') return FISH_ZH_HINT + mandarinPauses(text);
  return HANT_AS_HANS[vendor] ? toSimplified(text) : text;
}

class VendorError extends Error {}

// ---------------------------------------------------------------- audio

/** Base64 to bytes (atob exists in Workers and Node ≥ 16). */
export function b64bytes(s: string): Uint8Array {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function concat(parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) { out.set(p, at); at += p.length; }
  return out;
}

/** 16-bit mono PCM as a WAV file, and its duration (measured from the samples, never estimated from the text). */
export function wavFromPcm(pcm: Uint8Array, rate = PCM_RATE): { audio: ArrayBuffer; seconds: number } {
  const n = pcm.length - (pcm.length % 2);
  const buf = new ArrayBuffer(44 + n);
  const v = new DataView(buf);
  const tag = (at: number, s: string) => { for (let i = 0; i < 4; i++) v.setUint8(at + i, s.charCodeAt(i)); };
  tag(0, 'RIFF'); v.setUint32(4, 36 + n, true); tag(8, 'WAVE');
  tag(12, 'fmt '); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
  v.setUint32(24, rate, true); v.setUint32(28, rate * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true);
  tag(36, 'data'); v.setUint32(40, n, true);
  new Uint8Array(buf, 44).set(pcm.subarray(0, n));
  return { audio: buf, seconds: n / 2 / rate };
}

/** A PCM WAV file's duration from its own header (fmt + data chunks); null when it is not one. */
export function wavSeconds(buf: ArrayBuffer): number | null {
  const v = new DataView(buf);
  const str = (at: number) => String.fromCharCode(v.getUint8(at), v.getUint8(at + 1), v.getUint8(at + 2), v.getUint8(at + 3));
  if (buf.byteLength < 12 || str(0) !== 'RIFF' || str(8) !== 'WAVE') return null;
  let rate = 0, block = 0, data = -1;
  for (let at = 12; at + 8 <= buf.byteLength;) {
    const id = str(at), size = v.getUint32(at + 4, true);
    if (id === 'fmt ') { rate = v.getUint32(at + 12, true); block = v.getUint16(at + 20, true); }
    if (id === 'data') { data = Math.min(size, buf.byteLength - at - 8); break; }
    at += 8 + size + (size % 2);
  }
  return rate > 0 && block > 0 && data >= 0 ? data / block / rate : null;
}

// ---------------------------------------------------------------- MP3 duration

const MP3_KBPS: Record<string, number[]> = {
  // [version 1 | 2 (and 2.5)][layer III] bitrate index → kbps
  v1: [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320],
  v2: [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160]
};
const MP3_RATES: Record<number, number[]> = { 3: [44100, 48000, 32000], 2: [22050, 24000, 16000], 0: [11025, 12000, 8000] };

/**
 * An MP3's duration counted from its Layer III frames (samples per frame / sample rate, summed): exact, unlike an
 * estimate from the bitrate. An ID3v2 tag in front is skipped; a Xing / Info header frame (no audio) is not counted.
 * Null when no frame is found.
 */
export function mp3Seconds(buf: ArrayBuffer): number | null {
  const b = new Uint8Array(buf);
  let at = 0;
  if (b.length > 10 && b[0] === 0x49 && b[1] === 0x44 && b[2] === 0x33) at = 10 + ((b[6] & 0x7f) << 21 | (b[7] & 0x7f) << 14 | (b[8] & 0x7f) << 7 | (b[9] & 0x7f));
  let seconds = 0, frames = 0;
  while (at + 4 <= b.length) {
    if (b[at] !== 0xff || (b[at + 1] & 0xe0) !== 0xe0) { at++; continue; }
    const ver = (b[at + 1] >> 3) & 3, layer = (b[at + 1] >> 1) & 3, bri = b[at + 2] >> 4, sri = (b[at + 2] >> 2) & 3, pad = (b[at + 2] >> 1) & 1;
    const rate = MP3_RATES[ver]?.[sri];
    const kbps = (ver === 3 ? MP3_KBPS.v1 : MP3_KBPS.v2)[bri];
    if (ver === 1 || layer !== 1 || !rate || !kbps) { at++; continue; }
    const samples = ver === 3 ? 1152 : 576;
    const len = Math.floor(((samples / 8) * kbps * 1000) / rate) + pad;
    // A Xing / Info frame carries the stream's table of contents, no sound.
    const side = ver === 3 ? ((b[at + 3] >> 6) === 3 ? 17 : 32) : ((b[at + 3] >> 6) === 3 ? 9 : 17);
    const tag = String.fromCharCode(...b.subarray(at + 4 + side, at + 8 + side));
    if (!(frames === 0 && (tag === 'Xing' || tag === 'Info'))) seconds += samples / rate;
    frames++;
    at += len;
  }
  return frames ? seconds : null;
}

// ---------------------------------------------------------------- Fish Audio

/**
 * Fish Audio TTS: `POST https://api.fish.audio/v1/tts` (Bearer key; header `model: s2.1-pro`) with
 * `{text, reference_id, format: "mp3", mp3_bitrate: 64, latency, normalize}`. The answer is the audio itself,
 * `Transfer-Encoding: chunked`; errors are JSON `{status, message}` (401 key, 402 no API credit, 429 concurrency).
 * MP3 because every browser plays it and it is small (64 kbps mono: 8 KB a second through the API). Fish detects the
 * language from the text (S2.1-Pro: 83 languages), so none is sent.
 */
/** An optional sampling value in [0, 1] from a var; anything else is left to the vendor's default. */
const unit = (k: string, v: string | undefined): Record<string, number> => {
  const n = v === undefined || v === '' ? NaN : Number(v);
  return n >= 0 && n <= 1 ? { [k]: n } : {};
};

/** Fish's TTS request for her line (shared by the whole-file adapter and the streaming relay). */
export function fishRequest({ voiceId, text, lang, apiKey, fetch: f, env = {} }: Parameters<TtsAdapter>[0], signal?: AbortSignal): Promise<Response> {
  return f(env.FISH_TTS_URL || FISH_TTS_URL, {
    method: 'POST',
    headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json', model: env.FISH_TTS_MODEL || FISH_TTS_MODEL },
    body: JSON.stringify({
      text: spokenText('fish', lang, text, env),
      reference_id: voiceId,
      format: 'mp3',
      mp3_bitrate: 64,
      latency: env.FISH_TTS_LATENCY === 'low' || env.FISH_TTS_LATENCY === 'normal' ? env.FISH_TTS_LATENCY : 'balanced',
      normalize: true,
      ...unit('temperature', env.FISH_TTS_TEMPERATURE), ...unit('top_p', env.FISH_TTS_TOP_P)
    }),
    signal: signal ?? AbortSignal.timeout(TIMEOUT_MS)
  });
}

export const fishAdapter: TtsAdapter = async (input) => {
  const res = await fishRequest(input);
  if (!res.ok) throw new VendorError(`fish ${res.status}`);
  const audio = await res.arrayBuffer();
  const seconds = mp3Seconds(audio);
  if (!seconds) throw new VendorError('fish: no audio');
  return { audio, mime: 'audio/mpeg', seconds };
};

// ---------------------------------------------------------------- Qwen (DashScope)

/**
 * Qwen3-TTS-VC over HTTP with SSE (`X-DashScope-SSE: enable`): `POST {base}/services/aigc/multimodal-generation/generation
 * {model, input: {text, voice, language_type}}`. Every event's `output.audio.data` is a base64 PCM piece (24 kHz mono
 * 16-bit); the last has `finish_reason: "stop"`, empty data and the whole file's `url`. An error event carries `code`
 * and `message`. If no piece came (a non-streaming answer), the WAV at `url` is fetched and measured instead.
 */
export const qwenAdapter: TtsAdapter = async ({ voiceId, text, lang, apiKey, fetch: f, env = {} }) => {
  const base = (env.DASHSCOPE_BASE_URL || DASHSCOPE_BASE_URL).replace(/\/+$/, '');
  const res = await f(`${base}/services/aigc/multimodal-generation/generation`, {
    method: 'POST',
    headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json', 'x-dashscope-sse': 'enable' },
    body: JSON.stringify({
      model: env.QWEN_TTS_MODEL || QWEN_TTS_MODEL,
      input: { text: spokenText('qwen', lang, text), voice: voiceId, language_type: QWEN_LANG[lang] ?? 'Auto' }
    }),
    signal: AbortSignal.timeout(TIMEOUT_MS)
  });
  if (!res.ok) throw new VendorError(`qwen ${res.status}`);
  const pieces: Uint8Array[] = [];
  let url = '';
  for (const line of (await res.text()).split(/\r?\n/)) {
    if (!line.startsWith('data:')) continue;
    let ev: { code?: string; message?: string; output?: { finish_reason?: string | null; audio?: { data?: string; url?: string } } };
    try { ev = JSON.parse(line.slice(5).trim()); } catch { continue; }
    if (ev.code && !ev.output) throw new VendorError(`qwen ${ev.code}`);
    const a = ev.output?.audio;
    if (a?.data) pieces.push(b64bytes(a.data));
    if (a?.url) url = a.url;
  }
  if (pieces.length) return { ...wavFromPcm(concat(pieces)), mime: 'audio/wav' };
  if (!url) throw new VendorError('qwen: no audio');
  const file = await f(url, { signal: AbortSignal.timeout(TIMEOUT_MS) });
  const audio = file.ok ? await file.arrayBuffer() : null;
  const seconds = audio ? wavSeconds(audio) : null;
  if (!audio || !seconds) throw new VendorError('qwen: unreadable audio');
  return { audio, mime: 'audio/wav', seconds };
};

// ---------------------------------------------------------------- BytePlus (Seed Speech)

/** The JSON objects in a body that holds several of them back to back (newline-separated or not). */
export function jsonObjects(body: string): unknown[] {
  const out: unknown[] = [];
  let depth = 0, start = -1, inStr = false, esc = false;
  for (let i = 0; i < body.length; i++) {
    const c = body[i];
    if (inStr) { if (esc) esc = false; else if (c === '\\') esc = true; else if (c === '"') inStr = false; continue; }
    if (c === '"') inStr = true;
    else if (c === '{') { if (depth++ === 0) start = i; }
    else if (c === '}' && depth > 0 && --depth === 0) { try { out.push(JSON.parse(body.slice(start, i + 1))); } catch { /* not JSON */ } }
  }
  return out;
}

/**
 * Seed Speech v3 unidirectional streaming (HTTP): `POST /api/v3/tts/unidirectional` with `X-Api-Key`,
 * `X-Api-Resource-Id: seed-icl-2.0` (a cloned voice) and the fixed `X-Api-App-Key`; `{req_params: {text, speaker,
 * audio_params: {format: "pcm", sample_rate: 24000}, additions: "<json string>"}}`. The answer is a stream of
 * `{code: 0, data: "<base64>"}` objects ending with `{code: 20000000, message: "ok"}`; any other code is an error.
 */
export const byteplusAdapter: TtsAdapter = async ({ voiceId, text, lang, apiKey, fetch: f, env = {} }) => {
  const res = await f(env.BYTEPLUS_TTS_URL || BYTEPLUS_TTS_URL, {
    method: 'POST',
    headers: {
      'x-api-key': apiKey,
      'x-api-resource-id': env.BYTEPLUS_TTS_RESOURCE || BYTEPLUS_TTS_RESOURCE,
      'x-api-app-key': BYTEPLUS_APP_KEY,
      'x-api-request-id': crypto.randomUUID(),
      'content-type': 'application/json'
    },
    body: JSON.stringify({
      req_params: {
        text: spokenText('byteplus', lang, text),
        speaker: voiceId,
        audio_params: { format: 'pcm', sample_rate: PCM_RATE },
        additions: JSON.stringify({ explicit_language: BYTEPLUS_LANG[lang] ?? 'ja', disable_markdown_filter: true })
      }
    }),
    signal: AbortSignal.timeout(TIMEOUT_MS)
  });
  if (!res.ok) throw new VendorError(`byteplus ${res.status}`);
  const pieces: Uint8Array[] = [];
  let finished = false;
  for (const o of jsonObjects(await res.text()) as { code?: number; data?: string | null }[]) {
    if (o.code === 0 && typeof o.data === 'string' && o.data) pieces.push(b64bytes(o.data));
    else if (o.code === 20000000) finished = true;
    else if (typeof o.code === 'number' && o.code !== 0) throw new VendorError(`byteplus ${o.code}`);
  }
  if (!finished || !pieces.length) throw new VendorError('byteplus: incomplete audio');
  return { ...wavFromPcm(concat(pieces)), mime: 'audio/wav' };
};

/** The adapters. MiniMax / ElevenLabs stay empty slots: 501, and the API falls back to subtitles. */
export const TTS_ADAPTERS: Record<Vendor, TtsAdapter | null> = {
  fish: fishAdapter,
  qwen: qwenAdapter,
  byteplus: byteplusAdapter,
  minimax: null,
  elevenlabs: null
};

// ---------------------------------------------------------------- configuration

const isVendor = (p: string): p is Vendor => p !== 'none' && (TTS_PROVIDERS as readonly string[]).includes(p);
const defaultVendor = (env: TtsEnv) => (env.TTS_PROVIDER ?? 'none').trim().toLowerCase();

/** A vendor's key: its own secret, else the generic TTS_API_KEY when it is the vendor named in TTS_PROVIDER. */
export function keyFor(env: TtsEnv, p: Vendor): string | undefined {
  const own = p === 'fish' ? env.FISH_API_KEY : p === 'qwen' ? env.DASHSCOPE_API_KEY : p === 'byteplus' ? env.BYTEPLUS_VOICE_API_KEY : undefined;
  return own || (defaultVendor(env) === p ? env.TTS_API_KEY : undefined) || undefined;
}

/** The default vendor in effect: `none` unless a known vendor is named AND its key is set. */
export function ttsProvider(env: TtsEnv): TtsProvider {
  const p = defaultVendor(env);
  return isVendor(p) && keyFor(env, p) ? p : 'none';
}

/**
 * Her cloned voice and the vendor holding it, or null (no entry, an unknown vendor, or no key for it). With `lang`, an
 * entry `"<star>:<lang>"` wins over `"<star>"` — another voice (or vendor) for one language, e.g. her zh-Hant lines on
 * Qwen while the rest stay on Fish.
 */
export function voiceFor(env: TtsEnv, star: string, lang?: string): { provider: Vendor; voiceId: string; apiKey: string } | null {
  let entry: unknown;
  try {
    const all = JSON.parse(env.TTS_VOICES ?? '{}') as Record<string, unknown>;
    if (lang) {
      const own = voiceFor(env, `${star}:${lang}`);
      if (own) return own;
    }
    entry = all[star];
  } catch { return null; }
  const o = typeof entry === 'string' ? { provider: defaultVendor(env), voice: entry } : (entry as { provider?: unknown; voice?: unknown } | undefined);
  const provider = typeof o?.provider === 'string' ? o.provider.trim().toLowerCase() : '';
  const voiceId = typeof o?.voice === 'string' ? o.voice.trim() : '';
  if (!voiceId || !isVendor(provider)) return null;
  const apiKey = keyFor(env, provider);
  return apiKey ? { provider, voiceId, apiKey } : null;
}

/** The talents with a runtime voice now (the API is told, so nobody asks for one she does not have). */
export const ttsStars = (env: TtsEnv): string[] => STARS.filter((s) => voiceFor(env, s));

/**
 * `POST /stream {star, text, lang}`: her sentence as it is synthesized (#73, first sound): Fish's chunked MP3 piped
 * through untouched, so her first audio reaches the browser ~0.3 s after the request instead of after the whole
 * sentence. Only Fish streams (MP3 frames can be played as they come); another vendor is 501 `no_stream`, and the API
 * falls back to the whole-file path. No `x-tts-seconds`: the API counts the MP3 frames as they pass.
 */
async function streamRelay(req: Request, env: TtsEnv, f: typeof fetch): Promise<Response> {
  const { star, text, lang } = (await req.json().catch(() => ({}))) as { star?: unknown; text?: unknown; lang?: unknown };
  if (typeof star !== 'string' || !(STARS as readonly string[]).includes(star) || typeof text !== 'string' || !text.trim() || [...text].length > MAX_CHARS) {
    return Response.json({ error: 'bad_request' }, { status: 400 });
  }
  const speak = typeof lang === 'string' && LANGS.has(lang) ? lang : 'ja';
  const voice = voiceFor(env, star, speak);
  if (!voice) return Response.json({ error: 'no_voice' }, { status: 404 });
  if (voice.provider !== 'fish') return Response.json({ error: 'no_stream', provider: voice.provider }, { status: 501 });
  try {
    const res = await fishRequest({ voiceId: voice.voiceId, text: text.trim(), lang: speak, apiKey: voice.apiKey, fetch: f, env }, req.signal);
    if (!res.ok || !res.body) throw new VendorError(`fish ${res.status}`);
    return new Response(res.body, { headers: { 'content-type': 'audio/mpeg', 'cache-control': 'no-store', 'x-tts-provider': 'fish' } });
  } catch (e) {
    console.warn(JSON.stringify({ msg: 'tts_vendor_failed', provider: 'fish', star, stream: true, error: e instanceof VendorError ? e.message : 'network' }));
    return Response.json({ error: 'tts_failed' }, { status: 502 });
  }
}

export async function synthesizeRelay(req: Request, env: TtsEnv, adapters: Record<Vendor, TtsAdapter | null> = TTS_ADAPTERS, f: typeof fetch = fetch): Promise<Response> {
  const path = new URL(req.url).pathname;
  if (req.method === 'POST' && path === '/stream') {
    if (!ttsStars(env).length) return Response.json({ error: 'no_provider' }, { status: 404 });
    return streamRelay(req, env, f);
  }
  if (req.method !== 'POST' || path !== '/synthesize') return new Response('not found', { status: 404 });
  const anyVoice = ttsStars(env).length > 0;
  if (!anyVoice && ttsProvider(env) === 'none') return Response.json({ error: 'no_provider' }, { status: 404 });
  const { star, text, lang } = (await req.json().catch(() => ({}))) as { star?: unknown; text?: unknown; lang?: unknown };
  if (typeof star !== 'string' || !(STARS as readonly string[]).includes(star) || typeof text !== 'string' || !text.trim() || [...text].length > MAX_CHARS) {
    return Response.json({ error: 'bad_request' }, { status: 400 });
  }
  const speak = typeof lang === 'string' && LANGS.has(lang) ? lang : 'ja';
  const voice = voiceFor(env, star, speak);
  if (!voice) return Response.json({ error: 'no_voice' }, { status: 404 });
  const adapter = adapters[voice.provider];
  if (!adapter) return Response.json({ error: 'adapter_not_implemented', provider: voice.provider }, { status: 501 });
  try {
    const out = await adapter({ voiceId: voice.voiceId, text: text.trim(), lang: speak, apiKey: voice.apiKey, fetch: f, env });
    if (!(out.seconds > 0) || !out.audio.byteLength) return Response.json({ error: 'tts_failed' }, { status: 502 });
    return new Response(out.audio, { headers: { 'content-type': out.mime, 'x-tts-seconds': String(Math.round(out.seconds * 1000) / 1000), 'x-tts-provider': voice.provider } });
  } catch (e) {
    // Her words are never logged, not even on failure; the vendor's error code is (no text, no key).
    console.warn(JSON.stringify({ msg: 'tts_vendor_failed', provider: voice.provider, star, error: e instanceof VendorError ? e.message : 'network' }));
    return Response.json({ error: 'tts_failed' }, { status: 502 });
  }
}

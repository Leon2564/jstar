# Her runtime voice (#73): the vendors

What could not be recorded in advance — her free-talk replies, a line with his name — is synthesized in **her cloned
voice** by a vendor, through the Worker relay `tts.internal` (`infra/cloudflare/src/tts.ts`), for **every member**
(owner, 2026-10-02), and only ever **her own words** (§ Only her own words, below).

**In use: Fish Audio** (owner's pick, 2026-10-02; § Fish Audio). Alibaba Model Studio Qwen3-TTS-VC and BytePlus Seed
Speech are implemented too (their sections follow), selectable per talent in `TTS_VOICES`, should the pilot ever
favour them.

| | Alibaba Cloud Model Studio (百炼 / DashScope), `qwen` | BytePlus Seed Speech, `byteplus` |
|---|---|---|
| Why | Same model family as her recorded lines (Qwen3-TTS, tools/voice) | Seed Speech 2.0 / Voice Replication 2.0 |
| Region / host | International (Singapore): `dashscope-intl.aliyuncs.com` | `voice.ap-southeast-1.bytepluses.com` |
| Enrollment model | `qwen-voice-enrollment`, `target_model: qwen3-tts-vc-2026-01-22` | `POST /api/v3/tts/voice_clone` (Voice Replication 2.0) |
| Synthesis model | `qwen3-tts-vc-2026-01-22` (HTTP; must equal target_model) | resource `seed-icl-2.0` (cloned voices) |
| Key (local file) | `.env.dashscope.local` → `DASHSCOPE_API_KEY` | `.env.byteplus-voice.local` → `BYTEPLUS_VOICE_API_KEY` (not the ModelArk `ARK_API_KEY`: rejected with 45000010) |
| Key (Worker secret) | `DASHSCOPE_API_KEY` | `BYTEPLUS_VOICE_API_KEY` |
| Synthesis price (intl) | **$0.115 / 10,000 input characters**, output free; 110,000 free characters for 90 days | Not on a public page we could read; console pricing (see below) |
| Voice price | **$0.01 per created voice** (failures free); 1,000 free creations within 90 days (Singapore) | A voice slot per SpeakerID: prepaid in the console, or postpaid (charged at the first real synthesis) |
| Reference audio | WAV 16-bit / MP3 / M4A, **10–20 s recommended, ≤ 60 s, ≤ 10 MB, ≥ 24 kHz, mono**, ≥ 3 s continuous clean speech, other pauses ≤ 2 s | wav/mp3/ogg/m4a/aac/pcm, ≤ 10 MB; **10–15 s suggested** (VR 2.0 best practice: WAV, mono, 14–30 s) |
| Languages | zh (Mandarin), en, de, it, pt, es, **ja**, **ko**, fr, ru | zh, en, **ja**, es, id, pt, de, fr, **ko**, it, th, vi, ru, fil, ms, ar, … |

Pilot results, the Traditional Chinese check and the per-talent choice go in `tools/voice/out/pilot-*.md` (gitignored:
it holds her voice) and are summarised in issue #73.

## Fish Audio — S2.1-Pro (in use)

Sources (read 2026-10-02): OpenAPI https://docs.fish.audio/api-reference/openapi.json (`/v1/tts`, `/model`,
`/model/{id}`, `/wallet/{user_id}/api-credit`); https://docs.fish.audio/api-reference/endpoint/openapi-v1/text-to-speech;
https://docs.fish.audio/developer-guide/core-features/creating-models (voice cloning);
https://docs.fish.audio/developer-guide/best-practices/voice-cloning; https://docs.fish.audio/developer-guide/models-pricing/models-overview;
https://docs.fish.audio/developer-guide/models-pricing/pricing-and-rate-limits.

Key: `.env.fish.local` → `FISH_API_KEY` (Worker secret `FISH_API_KEY`, or `TTS_API_KEY` with `TTS_PROVIDER=fish`).

### Create her voice model

```
POST https://api.fish.audio/model            (multipart/form-data; also JSON / form-urlencoded)
Authorization: Bearer $FISH_API_KEY

type=tts  title="JSTAR <star>"  visibility=private  train_mode=fast  enhance_audio_quality=false
voices=@<star>.wav  voices=@<star>-1.wav  voices=@<star>-2.wav        (1–20 files: wav / mp3 / m4a / opus)
texts=<transcript 1>  texts=<transcript 2>  texts=<transcript 3>       (optional; "if unspecified, ASR")
→ 201 { "_id": "<model id = reference_id>", "type": "tts", "title": …, "state": "created" | "training" | "trained" | "failed",
        "train_mode": "fast", "languages": ["ja"], "visibility": "private", "quality": {audios: [{duration_ms, language,
        quality_passed, quality_reason}]} | null, … }
GET https://api.fish.audio/model/{id} → the same object (poll until state = trained; fast mode is usually immediate)
```

Fish advises "2–3 clips of 15–20 seconds" and "a minute or two of clear speech improves fidelity"; the enrollment sends
her main reference plus two more built the same way from clips the first does not use (≈ 45–55 s each talent, none
held out). `enhance_audio_quality` is off: the references are already denoised. Creating a model is not billed.

### Synthesize (what the adapter calls)

```
POST https://api.fish.audio/v1/tts
Authorization: Bearer $FISH_API_KEY
Content-Type: application/json
model: s2.1-pro                                  (header; s2.1-pro-free = same model, $0, fair use, no TTFA guarantee)

{ "text": "…", "reference_id": "<model id>", "format": "mp3", "mp3_bitrate": 64, "latency": "balanced", "normalize": true }
→ 200, Transfer-Encoding: chunked, body = the audio (MP3, 44.1 kHz mono)
→ 401 / 402 (no API credit) / 429 (concurrency) / 503: { "status": …, "message": "…" }
```

Other fields (defaults): `temperature` 0.7, `top_p` 0.7, `chunk_length` 300 (100–300), `prosody {speed, volume,
normalize_loudness}`, `sample_rate` (mp3: 32k / 44.1k), `opus_bitrate`, `max_new_tokens` 1024, `repetition_penalty` 1.2,
`min_chunk_length` 50, `condition_on_previous_chunks` true, `references` (inline zero-shot, MessagePack only).
`latency`: `normal` (best quality) | `balanced` (reduced latency) | `low`. No language parameter: S2.1-Pro detects it
(83 languages). We ask for **MP3 64 kbps** (plays everywhere, 8 KB per second through the API and to the browser) and
count `seconds` from its Layer III frames (`mp3Seconds`: 1152 samples per frame / 44.1 kHz, ID3 tag and Xing/Info
frame excluded) — exact, never estimated. `FISH_TTS_MODEL` / `FISH_TTS_LATENCY` override model and latency.

Price: **$15 per million UTF-8 bytes of input text** (s2.1-pro; Japanese / Chinese ≈ 3 bytes a character, so about
$0.045 per 1,000 Japanese characters). Concurrency: 5 requests below $100 prepaid, 15 from $100, 50 from $1,000.

### Pilot, 2026-10-02 (100 sentences: 5 per language per talent; `tools/voice/out/pilot-20261002-1735.md`)

| | likeness (ECAPA) | margin | CER | pass (≤ 15 %) | first audio p50 / p90 | sentence p50 | cost |
|---|---|---|---|---|---|---|---|
| all | 0.763 | 0.228 | 9.5 % | 79 % | 327 / 406 ms | 1.7 s (RTF 0.37) | $0.106 |
| ja | 0.790 | 0.257 | 4.7 % | 92 % | 334 / 1307 ms | | |
| zh-Hant | 0.755 | 0.209 | **21.6 %** | **52 %** | | | |
| en | 0.726 | 0.214 | 2.3 % | 100 % | | | |
| ko | 0.782 | 0.233 | 9.4 % | 72 % | | | |

Per talent: mahiro 0.776 / CER 7.0 %, nana 0.784 / 10.3 %, unpai 0.750 / 16.8 %, alice 0.733 / 3.6 %, eimi 0.774 /
9.7 %; every take was identified as the right talent (top-1 100 %). Real clips of hers score 0.79–0.88. Her Japanese
is close to her recorded lines; English is clear; Korean is mostly good. **Mandarin is the weak language**: short
openings (早安、欸欸、下次) come out Japanese-accented and Whisper mishears them; reading the line as Simplified did not
help (26 % vs 22 %), so `HANT_AS_HANS.fish` stays false. Listen to the worst takes the report lists before deciding
whether zh-Hant users get her voice.

### zh-Hant experiments, 2026-10-02 (the owner reads zh-Hant; 25 zh-Hant lines, 5 per talent, each run)

Every run as production sends them: one request per sentence (`--split`). CER = Whisper back-transcription against
the line (Simplified on both sides); "excl." leaves out 呵呵 / 嗯 / 哈哈, which Whisper does not write down. All runs
`npm run voice:pilot -- --provider fish --langs zh-Hant --split …` (reports `tools/voice/out/pilot-*-v*.md`).

| Variant | CER | excl. laughs | pass ≤ 15 % | likeness |
|---|---|---|---|---|
| v0 baseline (s2.1-pro, balanced, enrolled with transcripts) | 24.6 % | 23.1 % | 36 % | 0.765 |
| v1 latency `normal` | 27.0 % | 26.2 % | 32 % | 0.782 |
| v2 model `s1` | 33.9 % | 33.8 % | 36 % | 0.721 |
| v3 drawn-out marks / ellipses as pauses (`clean`) | 28.8 % | 27.2 % | 24 % | 0.779 |
| v4 clean + short sentences joined (< 12 chars) | 20.9 % | 20.7 % | 40 % | 0.764 |
| v6 clean + lead-in 「嗯，」 | 21.3 % | 22.5 % | 56 % | 0.780 |
| v7 re-enrolled **without** transcripts | 26.8 % | 25.3 % | 48 % | 0.763 |
| v8 without transcripts, up to 8 references (≈ 46–150 s) | 44.1 % | 43.8 % | 20 % | 0.757 |
| **v5 clean + Mandarin cue `[用標準的台灣國語自然地說]`** | **16.3 %** | **14.4 %** | **68 %** | 0.771 |
| v13 the same again (sampling varies) | 17.6 % | 16.9 % | 64 % | 0.768 |
| v9 cue + short sentences joined | 17.2 % | 16.1 % | 60 % | 0.775 |
| v10 cue + temperature 0.4 / top_p 0.5 | 20.5 % | 19.7 % | 64 % | 0.775 |
| v11 the cue in English | 17.4 % | 17.3 % | 52 % | 0.769 |
| v12 cue + voices without transcripts | 19.2 % | 17.8 % | 52 % | 0.763 |
| v14 cue + pinyin for greetings and names (phoneme control) | 18.1 % | — | 56 % | 0.772 |

Fish has no language or accent parameter (OpenAPI `/v1/tts`: text, temperature, top_p, references, reference_id,
prosody, chunk_length, normalize, format, sample_rate, mp3/opus bitrate, latency, max_new_tokens,
repetition_penalty, min_chunk_length, condition_on_previous_chunks, early_stop_threshold, features,
pronunciation_dictionary); it detects the language from the text. Only S2's natural-language `[bracket]` cue moved
it: about a third fewer errors (16–18 % over three runs vs 22–25 %), never spoken (no run's transcript contains it),
at the cost of the cue's bytes (+$0.0006 a sentence). It is on by default for zh-Hant (`FISH_ZH_HINT=off` disables
it). What remains is the clone's Japanese accent on short openings (早安 heard as 「桑啊」「送安」), a few names
(詠美) and dropped laughs; no Fish setting reached the ≤ 10 % target. Model and latency changes, more references and
dropping the transcripts made it worse. Total spent on these runs: $0.47.

If her Mandarin must be better than that, give her zh-Hant lines another vendor: a `"<star>:zh-Hant"` entry in
`TTS_VOICES` wins for that language (`{"mahiro": "<fish id>", "mahiro:zh-Hant": {"provider": "qwen", "voice": "…"}}`).
Qwen3-TTS-VC needs an Alibaba Model Studio key (`DASHSCOPE_API_KEY`, international); enroll with `npm run
voice:enroll -- --provider qwen --text off` (the local Qwen check read Chinese from a Japanese reference only without the
transcript) and compare with `npm run voice:pilot -- --provider fish,qwen --langs zh-Hant --split`.

## Our adapter in one paragraph

`synthesizeRelay` takes `{star, text, lang}` from the API container, finds her voice in `TTS_VOICES`
(`{"mahiro": "<voice id>"}`, or `{"mahiro": {"provider": "byteplus", "voice": "S_…"}}` to give one talent the other
vendor), and calls that vendor's adapter. Both adapters ask for **24 kHz mono 16-bit PCM**, collect it, and wrap it in a
WAV header: the returned `x-tts-seconds` is the sample count / 24,000 — measured, never estimated — and that is what his
voice minutes are charged (#74, rounded up per sentence). A talent with no voice (or whose vendor has no key) is 404
`no_voice`: subtitles, never a generic voice. The Worker gives the API container `TTS_URL` and `TTS_STARS` (who has a
voice) only when at least one talent has a usable voice; with nothing configured nothing changes for anyone.

Why HTTP and not the WebSocket APIs: our text is complete before we synthesize (her reply is finished, then cut into
sentences; the web app asks for sentence n+1 while n plays, `apps/web/src/lib/ttsQueue.ts`). The WebSocket APIs'
advantage is streaming *text in*; we have none to stream. One HTTPS request per sentence works from a Worker's `fetch`
with no connection state, and both vendors stream the audio back over it (SSE / chunked JSON), so the vendor starts
sending as soon as it has audio. If first-audio latency must drop further, the next step is relaying the PCM stream
to the browser as it arrives — not the WebSocket protocol.

## Alibaba Cloud Model Studio — Qwen3-TTS-VC

Sources (read 2026-10-02; pages last updated 2026-09-28):
- Voice cloning guide: https://www.alibabacloud.com/help/en/model-studio/voice-cloning-user-guide (zh: https://help.aliyun.com/zh/model-studio/qwen-tts-voice-cloning)
- Voice cloning HTTP API reference: https://www.alibabacloud.com/help/en/model-studio/voice-clone-design-http-api
- Non-realtime synthesis API: https://www.alibabacloud.com/help/en/model-studio/qwen-tts-api (guide: …/non-realtime-tts-user-guide)
- Realtime (WebSocket) guide: https://www.alibabacloud.com/help/en/model-studio/realtime-tts-user-guide
- Models and languages: https://www.alibabacloud.com/help/en/model-studio/tts-model
- Pricing: https://www.alibabacloud.com/help/en/model-studio/model-pricing (zh: https://help.aliyun.com/zh/model-studio/model-pricing)

Endpoints (Singapore). The docs also offer workspace hosts `https://{WorkspaceId}.ap-southeast-1.maas.aliyuncs.com`
("the existing domains remain fully functional"); the Qwen-TTS examples use `dashscope-intl.aliyuncs.com`, and so do we
(`DASHSCOPE_BASE_URL` overrides it). Singapore and Beijing keys are different.

### Create a voice

```
POST https://dashscope-intl.aliyuncs.com/api/v1/services/audio/tts/customization
Authorization: Bearer $DASHSCOPE_API_KEY
Content-Type: application/json

{
  "model": "qwen-voice-enrollment",
  "input": {
    "action": "create",
    "target_model": "qwen3-tts-vc-2026-01-22",
    "preferred_name": "jstar_mahiro",              // letters, digits, _ ; ≤ 16
    "audio": { "data": "data:audio/wav;base64,…" }, // or a public https URL; MIME audio/wav | audio/mpeg | audio/mp4
    "text": "<transcript of the audio>",            // optional, improves cloning
    "language": "ja"                                // optional, language of the audio; default zh
  }
}
→ 200 { "output": { "voice": "<voice id>", "target_model": "qwen3-tts-vc-2026-01-22",
                    "fallback_mode": false },          // true = poor audio / text mismatch; quality may be lower
        "usage": { "count": 1 }, "request_id": "…" }
```

`fallback_reason` (only with `fallback_mode: true`): `no_merged_segments` | `no_valid_asr_segments`. Our enrollment
treats `fallback_mode: true` as a failure to look at (it is reported, not silently accepted).

List: `{"model": "qwen-voice-enrollment", "input": {"action": "list", "page_size": 10, "page_index": 0}}` →
`output.voice_list[] {voice, gmt_create, gmt_modified, language, target_model}` plus `page_index`, `page_size`,
`total_count`. Delete: `{"input": {"action": "delete", "voice": "<voice id>"}}` → `output.voice`. Qwen voices have
no "query details" or "update".

Quota: 1,000 Qwen-TTS voices per account; a voice unused for a year is deleted automatically. A voice is bound to its
`target_model`: synthesis with another model fails.

### Synthesize (HTTP, what the adapter calls)

```
POST https://dashscope-intl.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation
Authorization: Bearer $DASHSCOPE_API_KEY
Content-Type: application/json
X-DashScope-SSE: enable                       // streaming; without it the answer is one JSON with a URL

{ "model": "qwen3-tts-vc-2026-01-22",
  "input": { "text": "…", "voice": "<voice id>", "language_type": "Japanese" } }
```

- `text`: up to 512 tokens for Qwen-TTS models (we send ≤ 200 characters, one or two sentences).
- `language_type`: `Chinese | English | German | Italian | Portuguese | Spanish | Japanese | Korean | French | Russian`
  or `Auto` (default). "Specifying the language significantly improves synthesis quality." Ours: ja → `Japanese`,
  zh-Hant → `Chinese`, en → `English`, ko → `Korean`.
- Response (streaming and non-streaming have the same shape):

```
{ "status_code": 200, "request_id": "…", "code": "", "message": "",
  "output": { "text": null, "choices": null, "finish_reason": null | "stop",
              "audio": { "data": "<base64 PCM piece>", "url": "…wav?Expires=…", "id": "audio_…", "expires_at": 1766116806 } },
  "usage": { "input_tokens": 76, "output_tokens": 1045, "characters": 0, "total_tokens": 1121, … } }
```

  Streaming: every intermediate event's `audio.data` is a base64 piece of the audio; the last (`finish_reason: "stop"`)
  has empty `data` and the complete file's `url` (valid 24 h). The docs' playback example writes the pieces straight
  to a 24 kHz, 16-bit, mono PCM stream, so the pieces are raw PCM: we concatenate and wrap them. Non-streaming: `data`
  is always empty and `url` points to a WAV on OSS (the example host is in mainland China) — a second download from
  the Worker, which is why we stream. The adapter still falls back to the URL (and measures the WAV's header) if a
  stream ever carries no pieces.

### Realtime (WebSocket), not used

`wss://dashscope-intl.aliyuncs.com/api-ws/v1/realtime?model=qwen3-tts-vc-realtime-2026-01-15` (`Authorization`
header). Client events `session.update {mode: server_commit | commit, voice, language_type, response_format: "pcm",
sample_rate: 24000}`, `input_text_buffer.append {text}`, `input_text_buffer.commit`, `session.finish`; server events
`session.created/updated`, `response.audio.delta {delta: base64}`, `response.audio.done`, `response.done`,
`session.finished`, `error`. A voice for it must be enrolled with `target_model: qwen3-tts-vc-realtime-2026-01-15`
(a separate voice; $0.13 / 10,000 characters). Useful when the LLM's tokens are streamed into TTS; see "Why HTTP" above.

### Prices (international, Singapore; model-pricing page)

| Model | Input price per 10,000 characters | Free quota (90 days) |
|---|---|---|
| qwen3-tts-vc-2026-01-22 | $0.115 (output free) | 110,000 characters |
| qwen3-tts-vc-realtime-2026-01-15 | $0.13 | 110,000 characters |
| voice creation (Qwen-TTS) | $0.01 per voice | 1,000 creations (Singapore only) |

## BytePlus Seed Speech — Voice Replication 2.0

Sources (read 2026-10-02; the pages render with JavaScript, their markdown is in the page data):
- Overview and ordering: https://docs.byteplus.com/en/docs/byteplusvoice/voicereplication
- Voice Replication 2.0: https://docs.byteplus.com/en/docs/byteplusvoice/voicereplicationv2
- Enrollment ("Voice Enrollment"): https://docs.byteplus.com/en/docs/byteplusvoice/voicereplication-v3-voice-training
- Status: https://docs.byteplus.com/en/docs/byteplusvoice/voicereplication-v3-voice-status-query
- Error codes: https://docs.byteplus.com/en/docs/byteplusvoice/voicereplication-v3-error-code-reference
- Management (slot purchase, lists): https://docs.byteplus.com/en/docs/byteplusvoice/voicereplicationopenapi
- TTS HTTP (unidirectional streaming): https://docs.byteplus.com/en/docs/byteplusvoice/unidirectional_tts_http
- TTS WebSocket (bidirectional): https://docs.byteplus.com/en/docs/byteplusvoice/streaming_tts
- Console / API key: https://docs.byteplus.com/en/docs/byteplusvoice/Speech_Console_Guide

### Speaker IDs and billing

Every cloned voice lives in a **voice slot** with a SpeakerID. Two ways: buy slots in the console ("Purchase" → voice
slot; prepaid; the SpeakerIDs are copied from the console, `S_…`), or **postpaid** voices created over the API with
`speaker_id: "custom_speaker_id"` plus our own `custom_speaker_id` (8–256 chars, `[A-Za-z0-9_-]`, starts with a letter,
not `S_`/`ICL_`/`MIX_`/`xx_`…, not ending `_tob`/`_bigtts`/`_streaming`). A postpaid slot is charged **at its first
real synthesis**, is then fixed (cannot be retrained), and a voice only tested is deleted after 7 days. A slot can be
trained up to 15 times. Slots no longer expire or pay storage. The console's free trial is 20,000 characters / 10 QPS.
Per-character prices are on the console's pricing page (not readable without an account); the pilot report records
the characters sent so the bill can be checked against it.

### Enroll (train) a voice

```
POST https://voice.ap-southeast-1.bytepluses.com/api/v3/tts/voice_clone
Content-Type: application/json
X-Api-Key: $BYTEPLUS_VOICE_API_KEY
X-Api-Request-Id: <uuid>

{ "speaker_id": "S_xxx",                          // or "custom_speaker_id" + "custom_speaker_id": "jstar_mahiro_v1"
  "audio": { "data": "<base64 audio>", "format": "wav" },   // format required for pcm / m4a
  "language": 2,                                  // 0 zh, 1 en, 2 ja, 8 ko, … — the audio's language
  "text": "<what is said>",                       // optional; an error if the audio differs too much
  "extra_params": { "disable_volume_normalization": false, "demo_text": "…" } }
→ { "code": …, "message": "…", "speaker_id": "S_xxx", "status": 2, "language": 2, "available_training_times": 14,
    "create_time": …, "speaker_status": [{ "model_type": 5, "demo_audio": "https://…" }] }
```

Status: 0 NotFound, 1 Training, 2 Success, 3 Failed, 4 Active; TTS works at 2 or 4. Not documented: which id a
*postpaid* voice is synthesized with; our enrollment records its `custom_speaker_id` (`jstar-<star>-v1`) as the voice
and, if synthesis refuses it (45000000), the `speaker_id` the API returned is in the same record. A prepaid slot is
synthesized with its SpeakerID (`S_…`), as documented. `model_type` 5 = Voice
Replication 2.0. `POST /api/v3/tts/get_voice {speaker_id}` returns the same object. The docs note on `text`: "the
prompt must be in the same language as the text. Cross-lingual voice cloning and synthesis are not supported", and
`tone_fidelity` (closest to the prompt) explicitly supports only the prompt's language. Her references are Japanese;
whether zh/en/ko synthesis keeps her voice is exactly what the pilot measures.

Enrollment errors worth knowing: 45001104 voiceprint check failed (protected-voice similarity), 45001109 WER check
failed (audio ≠ text), 45001112 SNR too low, 45001114 audio quality too low, 45001123 training quota used up,
45001127/45001128 audio or its text rejected by review.

### Synthesize (HTTP, what the adapter calls)

```
POST https://voice.ap-southeast-1.bytepluses.com/api/v3/tts/unidirectional
X-Api-Key: $BYTEPLUS_VOICE_API_KEY
X-Api-Resource-Id: seed-icl-2.0          // cloned voices, Voice Replication 2.0 (seed-tts-2.0 is the stock voices)
X-Api-App-Key: aGjiRDfUWi                // documented fixed value
X-Api-Request-Id: <uuid>
Content-Type: application/json

{ "req_params": { "text": "…", "speaker": "S_xxx",
    "audio_params": { "format": "pcm", "sample_rate": 24000 },
    "additions": "{\"explicit_language\":\"ja\",\"disable_markdown_filter\":true}" } }
```

- `audio_params.format`: `mp3` | `ogg_opus` | `pcm` ("passing WAV … in streaming scenarios will return multiple WAV
  headers. PCM is recommended"); `sample_rate` one of 8000…48000, default 24000.
- `additions` is a JSON *string*. `explicit_language`: `zh-cn` (Chinese, with English mixed in), `en`, `ja`, `ko`, …
  Ours: ja → `ja`, zh-Hant → `zh-cn`, en → `en`, ko → `ko`.
- Response: a stream of `{"code": 0, "message": "", "data": "<base64 audio>"}` objects, then
  `{"code": 20000000, "message": "ok", "data": null}`. Errors: 40402003 text too long, 45000000 speaker permission
  denied / concurrency quota, 55000000 server error. The response header `X-Tt-Logid` identifies the request for
  support. The adapter parses the objects whether or not they are newline-separated.

## Traditional Chinese (zh-Hant)

Her zh-Hant lines are Traditional characters read in Mandarin. Neither vendor documents Traditional input. We
checked the local Qwen3-TTS 1.7B (same family as Qwen3-TTS-VC) by synthesizing six of mahiro's zh-Hant lines in
Traditional and in their Simplified form and back-transcribing with Whisper; the result decides `HANT_AS_HANS.qwen`
in tts.ts (see below). The pilot repeats the check for both vendors (`--hant-check`), since the cloud model may differ.
The conversion, when on, applies only to the text the vendor reads (`infra/cloudflare/src/hans.ts`, ICU's
`Hant-Hans` table); he always sees her line as written.

Local check, 2026-10-02 (Qwen3-TTS-12Hz-1.7B-Base on this Mac, mahiro's denoised references, `language="Chinese"`;
6 lines × 2 seeds per row; Whisper large-v3-turbo, CER on Simplified characters with punctuation removed):

| Cloning mode | zh-Hant text as written | same text converted to Simplified |
|---|---|---|
| ICL (her Japanese reference audio **and its transcript**) | 72 % CER — garbled, Japanese-sounding | 91 % CER |
| speaker embedding only (`x_vector_only_mode`) | **2.2 %** (1 dropped 啊, 1 歡→翻) | **0.7 %** |

Two findings. (1) Traditional characters are read correctly: the difference between scripts is one or two characters
in 12 takes, within noise — so `HANT_AS_HANS.qwen` stays **false** (he hears exactly the text he reads). (2) The
local model's ICL mode cannot speak another language from a Japanese prompt plus transcript; only the
speaker-embedding mode can. How the cloud Qwen3-TTS-VC conditions on the enrolled voice is not documented, so the
pilot's zh-Hant / en / ko CER is the check that matters (`--hant-check` repeats the Traditional/Simplified comparison
on the cloud), and enrollment can be retried without the transcript (`--no-text`) if the cross-lingual CER is poor.

## Operating it

1. Key: `.env.fish.local` (`FISH_API_KEY`); for the other vendors `.env.dashscope.local` (`DASHSCOPE_API_KEY`,
   international) or `.env.byteplus-voice.local` (`BYTEPLUS_VOICE_API_KEY`, `BYTEPLUS_SPEAKERS` for prepaid slots).
2. `npm run voice:enroll -- --provider fish --dry-run` (no network: picks, prepares and checks each reference), then
   without `--dry-run`. Voice ids go to `tools/voice/out/<provider>-voices.json` (gitignored), and the `TTS_VOICES`
   JSON to set is printed. Enrolled 2026-10-02 (Fish model ids, not secret): mahiro `afd13d645b894982a8ecf908b9cf2b70`,
   nana `164b45103cca44bda5024551a4cfe432`, unpai `0738e456d24a4045bad94b5f25318bc3`, alice
   `0c1d076b02204c5f900cd943ba251f84`, eimi `9a463f173e9e4d23949b54dad6baedd2`.
3. `npm run voice:pilot -- --provider fish --hant-check` (several vendors: `--provider fish,qwen`): 20 lines per
   talent, scored for likeness (ECAPA vs held-out real clips), CER (Whisper), latency and cost →
   `tools/voice/out/pilot-<date>.md` and `.json`, with the suggested `TTS_VOICES` per talent.
4. Worker. The test / Nest deploys (deploy-test.yml, deploy-nest.yml) write these into the Worker's secrets when set:
   GitHub secret `FISH_API_KEY` (and/or `DASHSCOPE_API_KEY`, `BYTEPLUS_VOICE_API_KEY`; `printf '%s' "$KEY" | gh secret
   set NAME`, never `--body`), and repository variables `TEST_TTS_PROVIDER=fish` / `TEST_TTS_VOICES='<json>'`
   (`NEST_TTS_PROVIDER` / `NEST_TTS_VOICES` for Nest; `gh variable set NAME --body '<value>'`). Then
   `gh workflow run deploy-test.yml --ref release/v1.1` (deploy.sh rolls out and restarts the containers, which read
   `TTS_URL` / `TTS_STARS` at start). A local deploy instead: `wrangler secret put FISH_API_KEY` / `TTS_PROVIDER` /
   `TTS_VOICES` on the Worker, deploy, restart.
5. Check: `/v1/config` says `voice: true` and lists `voiceStars`; a member's `/v1/voice` says `tts: true`.

## Sentences, prefetch and what is charged

Her line is cut by one shared function, `splitSentences` in `@jstar/shared/voice`, on both sides: the web app asks for
sentence `i`, and the API cuts the line it signed the same way to find sentence `i`. It cuts at 。．！？♪, at ASCII
`.` `!` `?` followed by a space or the end (not after "Mr." / "e.g." / an initial, in "3.50", or before a word in lower
case), at an ellipsis ending a sentence (not "I mean… you know"), and at line breaks; a piece shorter than 6
characters joins the next; one breath is at most 70 CJK / 140 Latin characters (cut at 、，, ; :, else a space); and a
piece may be at most 2.5× as long as everything before it (at least ~2 s: 16 CJK / 40 Latin characters; a quarter
over is allowed, and no cut leaves a scrap), so it is synthesized before she gets to it. Her
**first** piece is one short breath in every language (`firstBreath`): a first sentence over 16 CJK / 40 Latin
characters is cut at its first pause (，、,;:) inside that budget, else at the budget (Latin: the last space before
it), so her first sound comes ≤ 1.5 s after her reply (QA had 3.5 s for a 7.2 s first sentence in zh).

**Her first sentence streams.** The web app asks `POST /v1/tts/ticket` (the same body and guard as `POST /v1/tts`:
signature, voice, minutes, 40 sentences a minute) and gets a one-use URL `/v1/tts/stream/<id>` (60 s; her words stay
on the server, never in a URL), which her `<audio>` plays directly (same origin: CSP `media-src 'self'`). `GET` claims
the request id, asks the Worker relay `POST /stream`, which pipes Fish's chunked MP3 through untouched, and the API
pipes it on while counting its MP3 frames (`lib/mp3.ts`): at the end he is charged those seconds; if he stops her or
leaves, the seconds that had passed; if nothing had, the claim is taken back. Fish's first audio byte comes ≈ 0.33 s
after the request, so she starts well within a second of her reply. A vendor that cannot stream (501 → 404
`no_stream`), a lost ticket or a stream that ends before any sound: that sentence comes whole instead (its own request
id), never silence. Safari may probe a media URL twice; the ticket is one-use, so there it falls back to whole files.

**Where her first sound's time went (QA 1.4–3.3 s), measured 2026-10-03:**

| Step | Before | Now |
|---|---|---|
| Fish's first audio byte (from this Mac in Japan; `latency` balanced or low: same, 0.55 s p50, 0.65 s max over 8) | 0.55 s | 0.55 s — the floor |
| `GET` after the ticket: a second round trip, then the ledger claim, then the vendor asked | +1 round trip + claim | asked at ticket time: synthesis runs while the page asks for the stream |
| The `<audio src>` element holding back until ~1 s of the stream is in (Chrome: 1.1–1.3 s after the first byte at Fish's pace; for a short sentence, the whole of it) | ≈ 1.1 s | ≈ 0.05 s: the stream is fed to it through Media Source Extensions (`streamSource`), plain URL only where MSE cannot take MP3 |
| Relay, API, Worker | pass-through streams (no `arrayBuffer`), `no-transform`, audio/mpeg is never compressed | same |

So her first sound is now ≈ ticket round trip + 0.55 s (Fish) + ~0.05 s; Fish's own time to first audio is the floor.
`latency: low` brought nothing measurable, so it stays `balanced`.

**The rest come whole, ahead of her, by audio time:** the web app keeps at least 6 s of her audio asked for after the
sentence she is saying (known once a sentence has come, estimated from its length until then: ≈ 6.5 CJK / 14 Latin
characters a second), with at most 4 requests open per line. A piece is at most 2.5× as long as everything before it
(cut at a pause or space, or — a long Japanese run with neither — at the limit itself), so it is ready before she gets
to it. QA's case (0.94 s, 1.28 s, then 10 s) has no gap over 250 ms (`apps/web/tests/unit/voiceMinutes.test.tsx`).
Scene lines take the same whole-file queue (blob: URLs; the CSP refuses data:). With lip-sync on for her
(docs/lipsync.md), the streamed first sentence plays over her talk loop; the later, whole sentences are rendered in the
background, three at once, as soon as each one's audio is here, and her voice never waits for a video: a render in
time plays from the sentence's start, a late one is switched to mid-sentence at her voice's position (re-synced when
they drift more than 40 ms apart), and none at all leaves the sentence on her talk loop. Simulated at QA's render speeds
(2.0–6.8 s each, 15 sentences): one render at a time lip-synced 1 sentence; three at once, 13 (11 from their start),
84 % of her audio, with no gap (`apps/web/tests/unit/lipsync.test.ts`).

What is charged: each sentence when it is synthesized (the claim before the vendor is asked, refunded if synthesis
fails), not when it is heard. When he talks over her or leaves, up to two sentences already synthesized ahead are
charged without being heard (a few seconds). Refunding them would need the web app to report "not played" and the
API to trust it, which would let an account get unlimited synthesis by reporting everything unplayed unless capped
per day in a new ledger kind; not done (owner can revisit if it matters).

## Only her own words (who hears it)

Every signed-in member hears her runtime voice once a vendor and her voice are configured (`VOICE_RULES.ttsRoles`,
owner 2026-10-02), with his voice minutes (§13.6: free minutes a day, more with the monthly pass, extensions for points).

`POST /v1/tts` never takes free text. The server signs each line it gives her that may be spoken at runtime, for the
account it gave it to: her chat reply (`voiceSig` on the chat result) and her scene lines a runtime voice may say
(`voiceSigs[beatId][lang]` on a scene run: `tts` lines, her free-talk replies, lines with `{name}`). The signature is an
HMAC (key derived from JWT_SECRET) over (account, talent, exact text). The request sends that line, its signature and
the index of the sentence wanted; the server verifies (403 `not_her_line` for his text, an edited line, another
account's or another talent's line), fills `{name}` with what she calls him (GET /v1/bond's `callName`; any other
placeholder is never spoken), cuts the line with the same `splitSentences` as the web app (`@jstar/shared/voice`) and
synthesizes that one sentence. Limits: 60 requests a minute per IP and 40 sentences a minute per account (429), each
sentence charged (rounded-up seconds) before the vendor is asked and refunded on failure.

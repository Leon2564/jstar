# tools/voice — local voice cloning for the five talents (issue #21)

Pre-generated voice lines for the home greetings and the 150 Series-1 cards, cloned
from the agency recordings **entirely on this Mac** (Apple M4, 16 GB, MPS). No recording,
transcript, embedding or model is uploaded anywhere; open weights are downloaded only
from their official Hugging Face repos and code from PyPI / the projects' GitHub.
No paid API was used (nothing to add to `docs/SPEND.md`).

## Output

| What | Path | Count |
|---|---|---|
| Home greetings (8 slots × 5 talents) | `apps/web/public/voice/greet/<star>-<slot>.mp3` | 40 |
| Card lines (`line.ja` of `packages/shared/src/catalog.s1.json`) | `apps/web/public/voice/<id>.mp3` | 150 |

Mono MP3, 48 kbps CBR, 24 kHz · −16 LUFS integrated (measured on the MP3: −16.5…−16.2) ·
silence trimmed · 2.3–6.1 s (mean 3.9 s, limit 12 s) · 4.7 MB in total.
Greeting texts with zh-Hant/en subtitles: `greetings.json`. The web app already falls
back to `/voice/<id>.mp3` when a card has no `voice` field.

## Model: Qwen3-TTS-12Hz-1.7B-Base, zero-shot (ICL)

Qwen3-TTS 1.7B Base (Apache-2.0) clones from ~30 s of the talent's own denoised speech
plus its transcript; 3 takes per line; the best take is picked automatically. No
fine-tune: zero-shot already reaches the likeness of the real recordings (below) and
keeps the process near 1 GB RSS on a machine shared with other jobs.

### Evaluation (15 lines × 2 takes per system; all judges local)

- **Likeness:** ECAPA-TDNN (SpeechBrain) cosine to the talent's *held-out* real clips
  (never used as references); *margin* = own − best other talent. WavLM-SV was rejected
  as a judge: it cannot tell these five voices apart (real clips top-1 only 45–100 %).
- **Intelligibility:** Whisper large-v3-turbo back-transcription → kana CER.
- **Naturalness:** UTMOSv2 predicted MOS (English-trained, relative only) and Whisper
  confidence; **delivery:** median pitch and speaking rate vs the real clips.

| System | sim | margin | CER | UTMOSv2 | rate error |
|---|---|---|---|---|---|
| Irodori-TTS v4.1-Small (MIT, JP-only), raw refs 60 s | 0.758 | 0.220 | 1.5 % | – | 29 % |
| Irodori v4.1, denoised refs 60 s | 0.774 | 0.234 | 1.3 % | 2.65 | 26 % |
| Irodori v4.1, denoised, pace ×0.82 | 0.772 | 0.226 | 1.7 % | 2.79 | 12 % |
| Irodori v4.1, denoised 120 s, speaker CFG 7 | 0.780 | 0.223 | 2.0 % | 2.75 | 27 % |
| Qwen3-TTS 1.7B, raw refs 15 s | 0.762 | 0.218 | 1.0 % | – | 15 % |
| Qwen3-TTS 1.7B, denoised 15 s | 0.781 | 0.234 | 1.1 % | 3.16 | 14 % |
| **Qwen3-TTS 1.7B, denoised 30 s (chosen)** | **0.789** | **0.235** | 2.6 % | **3.15** | 14 % |
| *Real clips (denoised), for reference* | *0.79–0.88* | *0.24–0.27* | – | *3.29* | – |

Both systems match the real-clip likeness and are intelligible; the naturalness proxies
and pace favour Qwen3-TTS. Not run: Fish Speech / OpenAudio S1-mini and F5-TTS
(non-commercial weights); GPT-SoVITS (per-talent fine-tune, not needed once zero-shot
matched real-clip likeness, and heavier on the shared machine); CosyVoice 2.

## Production result (all 190 lines)

| Talent | ECAPA sim (real clips) | margin (real) | identified as herself | CER | Notes |
|---|---|---|---|---|---|
| mahiro | 0.738 (0.792) | 0.234 (0.251) | 100 % | 1.4 % | Lowest similarity: her recording is the noisiest (floor −18 dB before denoise); soft, slightly breathy delivery comes through |
| nana | 0.847 (0.880) | 0.208 (0.266) | 100 % | 2.0 % | Calm, low-variance pitch reproduced well |
| unpai | 0.783 (0.788) | 0.224 (0.263) | 100 % | 1.0 % | Energetic lines ("〜", "！") needed the most reading fixes |
| alice | 0.819 (0.794) | 0.295 (0.273) | 100 % | 1.3 % | Most distinct voice of the five |
| eimi | 0.827 (0.789) | 0.274 (0.242) | 100 % | 0.9 % | Only 58 s of usable own voice (long non-speech stretches), still enough |

QA: every take is back-transcribed; a line passes at kana CER ≤ 0.15, ≤ 12 s, no
clipping. First pass: 184/190. Fixes: 13 lines re-read from a TTS-only reading in
`readings.json` (e.g. お昼→おひる, 熱→ねつ, 白い馬→しろいうま, 跳ぼう→とぼう, 三、二、一→さん、に、いち,
trailing 〜→ー) and regenerated with new seeds; 3 lines accepted after reading the
transcripts (`qa_accept.json`, the speech is verbatim — only the kana converter
disagrees). Final: 190/190, mean CER 1.3 %. The displayed lines are unchanged.

Caveat: these are machine proxies. Pitch accent and "is this really her" still need a
human ear; start with the samples below.

### Samples to listen to first

- `greet/alice-welcome.mp3`, `greet/eimi-gacha-ssr.mp3` — highest likeness
- `greet/mahiro-welcome.mp3`, `s1-mahiro-26.mp3` — mahiro, the hardest voice
- `s1-unpai-03.mp3`, `s1-unpai-20.mp3` — unpai's energetic lines after reading fixes
- `s1-nana-29.mp3`, `s1-eimi-30.mp3` — SSR/UR intimate tone

## Recordings: what needed fixing

| Finding | Fix |
|---|---|
| Speech ≈ −50 dBFS with rare loud bumps; LUFS normalisation keyed on the bumps | Gain from the 95th percentile of 50 ms frames (+9…+18.5 dB), soft limiter, each slice to −20 LUFS (`prep.py`) |
| ~30 % of every file is another speaker — the same voice in all five files (an interviewer) | ECAPA clustering per file; only clips ≥ 0.6 to the talent's centroid are used (`speakers.py`) |
| Strong background floor that zero-shot cloning copies | DeepFilterNet3 on every clip; generated noise floor −47 → −65 dB (`denoise.py`) |

## Pipeline

```bash
V=.voice                                                 # main checkout, gitignored
$V/venv-prep/bin/python tools/voice/prep.py              # normalise, VAD-slice, Whisper transcripts
$V/venv-df/bin/python   tools/voice/denoise.py           # DeepFilterNet3
$V/venv-prep/bin/python tools/voice/speakers.py          # keep the talent's own voice (ECAPA)
python3 tools/voice/make_jobs.py greetings > $V/work/jobs.jsonl
python3 tools/voice/make_jobs.py cards --catalog packages/shared/src/catalog.s1.json >> $V/work/jobs.jsonl
$V/venv-qwen/bin/python tools/voice/synth_qwen.py $V/work/jobs.jsonl --cands 3
$V/venv-prep/bin/python tools/voice/qa.py score          # ASR + CER + likeness
$V/venv-prep/bin/python tools/voice/qa.py pick --tag=    # best take per line, lists failures
$V/venv-prep/bin/python tools/voice/post.py              # trim, −16 LUFS, MP3
```

A changed card line: write its id to a file and run `tools/voice/redo.sh FILE 3000`
(new seeds, score, re-pick), then `post.py`. Add a `readings.json` entry if the model
misreads a word. Evaluation-only tools: `synth_irodori.py`, `prosody.py`, `mos.py`,
`qa.py baseline|summary`. Weights are fetched with `fetch_hf.sh` (resumable).
Environments under `.voice/`: `venv-prep`, `venv-qwen` (`qwen-tts`), `venv-df`
(`deepfilternet`, torch 2.5), `venv-irodori`, `venv-mos`. One model process at a time.

### Scene lines (v1.1, #83)

Her lines in the scenes (`packages/shared/src/scenes/index.ts`, `variantScenes.ts`) and line files
(`lines/<star>.json`, `lines/system.json` talents) — `unnamed` versions included, danmaku `quote` and `{name}` /
`{danmaku}` texts left to her runtime voice (#73). Ids hash (star, Japanese), so an edited line needs a new take:

```bash
python3 tools/voice/make_scene_jobs.py jobs > $V/work/scene_jobs.jsonl   # lines without an MP3
$V/venv-qwen/bin/python tools/voice/synth_qwen.py $V/work/scene_jobs.jsonl --cands 3
$V/venv-prep/bin/python tools/voice/qa.py score
$V/venv-prep/bin/python tools/voice/make_scene_jobs.py pick       # + her own speaker margin > 0
$V/venv-prep/bin/python tools/voice/make_scene_jobs.py master     # apps/web/public/voice/scene/<star>/<id>.mp3
python3 tools/voice/make_scene_jobs.py link                       # `voice` into the scene / line JSON
python3 tools/voice/make_scene_jobs.py report; python3 tools/voice/make_scene_jobs.py orphans
```

Failed lines: ids in a file, `tools/voice/redo_scene.sh FILE 5000` (new seeds), then `master` and `link`.

### Runtime voice (#73): enrollment and pilot

Her free-talk replies are synthesized at runtime by a cloud vendor (docs/tts.md: Alibaba Cloud Model Studio
Qwen3-TTS-VC or BytePlus Seed Speech). These tools prepare her voice there and compare the vendors; everything they
write is under `tools/voice/out/` (gitignored: references, voice ids, takes).

```bash
npm run voice:enroll -- --provider qwen --dry-run   # choose + check each 15–20 s reference; nothing is sent
npm run voice:enroll -- --provider qwen             # upload to the vendor's enrollment endpoint → out/qwen-voices.json
npm run voice:pilot  -- --provider qwen,byteplus --hant-check   # 20 lines per talent per vendor → out/pilot-<stamp>.md/.json
```

- **Reference** (`enroll.py`): from her denoised, speaker-verified clips (the same ones as above, never a held-out clip):
  one continuous 15–19.5 s stretch of the recording if she has one, else her best clips joined with 0.45 s pauses;
  −20 LUFS, −1 dBFS peak, 24 kHz mono 16-bit WAV; checked against both vendors' rules (10–20 s, ≥ 24 kHz, mono,
  ≤ 10 MB, ≥ 3 s continuous speech, no pause > 2 s) and scored (ECAPA likeness to her held-out clips, SNR).
- **Pilot** (`pilot.py`): 5 ja / 5 zh-Hant / 5 en / 5 ko lines per talent from `packages/shared/src/lines/<star>.json`,
  synthesized by the Worker's own adapters (`tts_synth.ts`), scored like the recorded lines (ECAPA likeness,
  Whisper CER per language via `langs.py`), with first-audio latency, real-time factor and cost, and a suggested
  vendor per talent with the `TTS_VOICES` value to set.
- Keys: `.env.dashscope.local` (`DASHSCOPE_API_KEY`), `.env.byteplus-voice.local` (`BYTEPLUS_VOICE_API_KEY`, optional
  `BYTEPLUS_SPEAKERS` for prepaid slots). Her audio goes nowhere but the chosen vendor's enrollment endpoint.

# Her voice and her video in sync: lip-sync decision memo

Date: 2026-10-02. Branch `docs/lipsync`. Scope: what the owner asked for on 2026-10-02 ("her voice and her video
matched properly: real lip-sync, not a talk loop that plays while the audio plays").

**Owner's direction (2026-10-02).**
- **C:** lip-sync the recorded lines offline, once.
- **A:** lip-sync her talk loop to each chat TTS sentence, hiding the wait behind her subtitles.
- **B** (a real-time streaming avatar) is only the fallback, if A's latency proves unacceptable.

This memo makes that choice implementation-ready.

> **This changes a v1.1 decision.** v1.1 said "no digital human this phase". A and C are not a streaming avatar: her
> Seedance clips stay the picture and only the mouth is re-drawn. But A does add something the stack never had, a GPU
> service called per sentence. **B would fully reverse the decision**: a vendor-rendered avatar, billed per session
> minute.

## 0. Status (2026-10-02, branch feat/lipsync)

Built as decided below: **C** (recorded lines, offline) and **A** (her runtime voice, per sentence), licence-clean
(MediaPipe face boxes, ellipse mask, colour match; `infra/lipsync/core.py`).

- **Benchmark on Modal** (`modal run infra/lipsync/modal_app.py::bench` / `::coldstart`):

  | GPU | Core fps (batch 8 / 16 / 32) | 720p sentence, render + encode, for 2 / 4 / 6 s | Model load |
  |---|---|---|---|
  | L40S | 84 / 95 / 98 | 0.92 / 1.70 / 2.65 s | 12–19 s |
  | H100 | 115 / 172 / 203 | 0.72 / 1.16 / 1.68 s | 23 s |

  - Deployed endpoint, warm, a 3.7 s sentence: 1.6–1.9 s render on the server.
  - Cold start: 37 s for a container in Modal's default pool, plus the first preparation of her three talk loops
    (26 s once; they are cached in the Volume after that).
  - Pinning region `ap` left an L40S cold start waiting ~150 s for capacity, so the service runs unpinned with GPU
    fallbacks: L40S, then A100, then H100.
- **Scene batch** (`::scenes`; 20 min):
  - `tools/lipsync/plan.ts` replays every scene graph. 429 of the 644 recordings are played by a scene, giving 608
    renders over 201 clips.
  - The other 215 (room lines) were rendered onto her three talk loops.
  - 1,142 renders exist, each at both sizes, in R2 `jstar-lipsync`, listed in `apps/web/src/data/lipsync.gen.json`.
  - Skipped: lines on clips where a face shows in fewer than 80 % of frames (detail and empty shots), and the empty
    `*-night-*` shots. Those lines play as before.
  - Spend ≈ $5 in all, including the benchmarks (estimate from container seconds).
- **Web:**
  - Scene player: a line with a render plays it over the clip, in step with her voice (QA of 53be1c0, fixed on
    fix/lipsync-scenes):
    - the renders of the line playing, of the next line, and of the first line on each way he can answer are
      mounted (so loaded) ahead;
    - the render follows her voice clock every frame (`voiceTime`, the same one her room uses; `syncStep` in
      lib/lipsync.ts). It waits on its first
      frame until she sounds, starts with her, is put back in step past 40 ms, and if it is late it comes in mid-line
      at the right frame, never behind her;
    - it fades in over the clip in 180 ms. The clip underneath is then moved to the render's frame, so the hand
      back at the end shows no jump; the render holds its last frame until the clip is there.
    - **No pose change at the takeover** (QA of d53e8ba; the owner chose to align the clip, not to re-render): a
      render begins on its clip's frame 0, so her line starts lip-synced only with the clip there. Her talk loops are
      cut to their frame 0 as her line starts and held there until her voice sounds. A scene clip is timed at its cut
      to come round to frame 0 just as her line is due (`cutStartFor`), or her voice waits for its loop when it is
      within 0.3 s (`alignPlan`). Any other line plays her clip as it is, without its render. That covers lines after
      another line on the same clip, or after his answer.
      - Probe (the QA script, local stack), face difference at the clip → render cut, after vs before:
        - アリス confession close-up: 2.7 (was 12.8 / 23.3);
        - 奈奈 read-aloud: 2.5 (was 10.1);
        - welcome-home: 4.2;
        - night-greenhouse: 2.1;
        - normal frame to frame is 2.8–7.5.
    - **Phase renders** (owner's option b, 2026-10-03): every scene line with a render also has renders starting on
      every 7th frame of its clip (0.29 s), 720p.
      - Volume: 9,068 renders over 144 clips, 431 lines; R2 `v1/<clip>/<voice>-p<frame>-<w>x<h>.mp4`.
      - Index: apps/web/src/data/lipsync.phases.gen.json.
      - Batch: `modal_app.py::phases`, ≈ $14.7 (estimate from container time; the cap was $20).
      - Talk loops need no phases: they are cut to frame 0 at the line.
      - How it plays: where the clip is not at frame 0, her voice waits (≤ 0.29 s) for the clip to reach the next
        phase frame (`startPlan`). The clip is held there, and that phase's render begins on the very same frame. Her
        next line's phases are loaded ahead, for where the clip will be when she starts it.
      - Probe (QA's lip.mjs, local stack): every line with a render is lip-synced again. Lines lip-synced per scene,
        before #191 / after #191 / now:
        - welcome-home 5/8 → 2/7 → 5/8;
        - read-aloud 8/8 → 2/8 → 8/8;
        - confession 5/5 → 2/5 → 5/5;
        - night-greenhouse 2/6 → 2/6 → 2/6.
        The others play over clips with no render: detail shots where her face is too small or turned.
      - Face difference at every clip → render cut: 2.1–5.0 (normal frame to frame is 2.8–7.5). At every takeover,
        clip and render were within 20 ms of the same frame (phase takeovers within 14 ms). Drift max 25 ms, 0 black
        frames.
    - Measured in a real browser with real audio and local renders (`apps/web/tests/verify`, 5 runs): her mouth
      came 18–53 ms after her voice (QA had measured up to 1 s); drift p95 5–13 ms, max 25 ms; the pose difference
      at the hand back was 21–26 ms (QA had measured 0.7–6.5 s).
  - Her room: each signed sentence is rendered onto her talk loop and played with its audio when it is ready within
    3.5 s (first sentence) or 1.2 s (later ones); otherwise as before. A warm-up is sent when her room opens.
    Since her first sentence streams (docs/tts.md), it has no whole audio to render: it plays at once over her talk
    loop (no lip-sync, no wait), and lip-sync starts with her second sentence. Since QA on 53be1c0 (renders 2.0–6.8 s,
    one at a time, left 1.2 s silences): her voice never waits for a video (grace 0); renders run three at once, each
    asked for as soon as its sentence's audio is here, each from the loop frame her audio before it ends on; a render
    that comes mid-sentence is switched to at her voice's position (`RoomLipsync`, re-synced past 40 ms drift).
- **Worker:** see `infra/cloudflare/README.md`. The token on her `/v1/tts` answers means only her own sentence audio
  can be rendered.
- **UI/UX acceptance of 47b0fcb (2026-10-05), H3 and P1: no re-render, no mask change, Modal spend $0.**
  - H3, "an off-colour rectangle under her lips" on welcome-home's pout clip: it is in the Seedance clip itself
    (`mahiro-scene-welcome-home-pout-9x16`, frames ~25–110 of 143). Her chin's pout is drawn as a pale, wrinkled,
    roughly square patch, with glossy lips: QA's lang-welcome-home 09 (en) / 10 (ja) show the clip, not a render.
  - Her renders on that clip (e8f1031383c5, 5cff37399905; phase 0 at both sizes, all 40 phase renders) re-draw the
    chin smooth through the feathered ellipse. They are colour-matched: the mean Lab shift inside the mask against
    the clip is L +0.2, a −0.9, b +0.1. Contrast-boosted frames show no seam. So the patch shows only where the clip
    plays bare (before her render fades in, after the hand back, while he chooses). It comes and goes with her
    render. The fix belongs to the clip (a retouch or a new take), not to `core.py`.
  - P1, "the lip-sync layer is framed slightly differently": the renders are framed exactly as their clips. ECC on
    pout, read-aloud, talk loop and confession-wide, phase renders included: scale 1.0000–1.0002, offset under 1 px;
    AV1 and H.264 clip files match too. The difference is in the web layer: the close-shot push-in (`scn-push`) of
    the render is timed from the shot's start (`lip.delay`). The clip's own push restarts whenever its layer turns
    `.on`, e.g. her talk loop as she starts a line. Up to ~5 % scale apart.

## 1. Decision

| | Choice | Why |
|---|---|---|
| **A** Chat: per-sentence lip-sync | **MuseTalk 1.5, self-hosted on Modal** (serverless GPU, L40S, region `ap`), driven by avatars precomputed from our own talk loops | It keeps the Seedance look and loop motion; only the mouth changes. It is 10–100× cheaper than any hosted per-second API or streaming avatar (§ 5). The weights may be used commercially. One sentence of ~4 s is expected to take ~3 s on an L40S (§ 3). |
| **C** Scenes: 644 recorded lines, one-time | **The same MuseTalk service, run as a batch** (≈ $5 of GPU), output stored in R2. **Upgrade path:** sync.so lipsync-2-pro for the close-up premium lines, *only if* the owner judges MuseTalk too soft and sync.so signs a no-training agreement. | The pilot's close-ups are already convincing at 720p (§ 2). Scenes and chat then share one mouth model, so her mouth looks the same in both. The default sync.so terms allow training on uploaded content (§ 4). |
| **B** Real-time avatar | Fallback only: **Simli** (bring-your-own-audio, ≈ $0.01/min) | Only if A's latency is unacceptable after the step-7 test. It loses the Seedance loop motion and is billed per *session* minute. |
| **D** Client-side visemes | **Ruled out** | No credible photoreal result exists. Fish Audio returns word timestamps only, no visemes (§ 4D). |

Nothing private is needed. Avatars are built from the **public** Seedance clips (`apps/web/public/media/*`), and the
audio is her TTS or recorded lines. `assets/agency/` (her 10 minutes of voice, the silent 4K videos) is **not** used and
**never leaves this machine**. Its only possible future use would be training a custom streaming avatar under B, and
only with a vendor the owner approves.

## 2. The pilot on this Mac (MuseTalk 1.5, Apple M4 16 GB, MPS)

**Sample videos** (gitignored, local only; open them in QuickTime). Each side-by-side shows **today** on the left, her
loop playing while the audio plays, and the **MuseTalk lip-sync** on the right, with her audio:

| # | Talent | Clip (her loop / scene) | Audio | Length | Side-by-side (`tools/lipsync/out/`) |
|---|---|---|---|---|---|
| 1 | mahiro | `mahiro-talk-9x16` | scene line, ja (welcome-home `hello`) | 3.3 s | `mahiro-talk-ja-hello-sbs.mp4` |
| 2 | mahiro | `mahiro-talkclose-9x16` | scene line, ja (`rps-ask`) | 3.7 s | `mahiro-talkclose-ja-rps-sbs.mp4` (+ `-ellipse-cm-sbs.mp4`) |
| 3 | mahiro | `mahiro-scene-welcome-home-close-9x16` (the clip the line really plays over) | scene line, ja (`closer-line`) | 6.7 s | `mahiro-scene-close-ja-closer-sbs.mp4` (+ `-ellipse-cm-sbs.mp4`) |
| 4 | mahiro | `mahiro-talk-9x16` | **chat TTS, zh-Hant**: Fish Audio S2.1-Pro, her runtime voice | 4.1 s | `mahiro-talk-zh-fish-sbs.mp4` |
| 5 | nana | `nana-talk-9x16` | scene line, ja (read-aloud `open`) | 6.9 s | `nana-talk-ja-open-sbs.mp4` (+ `-ellipse-cm-sbs.mp4`) |
| 6 | nana | `nana-talkclose-9x16` | scene line, ja (`gentle-promise`) | 4.2 s | `nana-talkclose-ja-promise-sbs.mp4` |
| 7 | nana | `nana-scene-read-aloud-lookup-9x16` | scene line, ja (`done`) | 6.5 s | `nana-scene-lookup-ja-done-sbs.mp4` |
| 8 | nana | `nana-talkclose-9x16` | **chat TTS, zh-Hant**: Fish Audio S2.1-Pro | 6.8 s | `nana-talkclose-zh-fish-sbs.mp4` |

**About the zh-Hant lines:**
- They are Fish takes from the 2026-10-02 TTS pilot (`tools/voice/out/pilot-20261002-1735`, local): `mahiro-zh-Hant-0`
  (CER 0) and `nana-zh-Hant-3` (CER 9.5 %).
- I tried the local Qwen3-TTS clone for zh-Hant first, as the brief suggested. It produced unusable takes: Whisper
  heard noise for nana's and mangled mahiro's. This matches the Mandarin weakness that `docs/tts.md` records, so those
  takes were dropped.
- The Fish takes are also the more honest test of A, because they are what chat will actually send.

All of them in one file: `tools/lipsync/out/reel.mp4` (59 s, 11 clips). The lip-synced video alone is `<name>-lipsync.mp4`.

**What to look for:**
- On the right, her lips open, close and round with the syllables (ふ / う / お), and teeth show on open vowels. On the
  left, the Seedance mouth moves at random, unrelated to the words.
- Eyes, blinks, hair, head motion and light are untouched. MuseTalk re-draws only the lower half of the face.
- The weakness: the mouth area is a little softer than the rest of the face (MuseTalk works on a 256×256 face crop).
  This is barely visible at phone size and visible on a 1080p close-up on desktop.
- The VAE also pales the lower face and lips slightly (visible on nana, row 5).
- **`*-ellipse-cm-*` clips, the licence-clean variant:**
  - they use a feathered ellipse instead of MuseTalk's face-parsing model (§ 4A licence note);
  - they shift the colour back to the original (`--colour`), which fixes the paling;
  - they look at least as good as the default clips, and are what production should use.

**Timings on this Mac** (warm model; the machine was shared with other jobs and swapping, so treat these as an upper
bound):

| Clip (720×1280, 24 fps) | Audio | Frames | Face width | Avatar prep, once per clip (landmarks / latents / masks) | Per sentence: audio features / UNet+VAE / paste+encode | **× real time** |
|---|---|---|---|---|---|---|
| mahiro talk, ja | 3.3 s | 79 | 225 px | 182 / 73 / 48 s | 7.3 / 67.2 / 7.5 s | 25× |
| mahiro talkclose, ja | 3.7 s | 88 | 264 px | 169 / 58 / 26 s | 1.0 / 53.2 / 5.2 s | 16× |
| mahiro scene close, ja | 6.7 s | 159 | 316 px | 72 / 37 / 18 s | 5.3 / 82.9 / 7.1 s | 14× |
| mahiro talk, zh (Fish) | 4.1 s | 98 | 225 px | cached | 7.7 / 75.1 / 7.5 s | 23× |
| nana talk, ja | 6.9 s | 166 | 223 px | 202 / 53 / 53 s | 10.7 / 238.5 / 7.5 s | 37× |
| nana talkclose, ja | 4.2 s | 101 | 233 px | 346 / 96 / 39 s | 9.0 / 71.0 / 4.1 s | 20× |
| nana scene lookup, ja | 6.5 s | 155 | 223 px | 141 / 45 / 26 s | 5.5 / 287.1 / 5.5 s | 46× |
| nana talkclose, zh (Fish) | 6.8 s | 163 | 233 px | cached | 9.2 / 204.5 / 9.1 s | 33× |
| ellipse + colour (3 runs) | 3.7–6.9 s | | | masks 0.1–0.3 s (reuses the prep) | | 14–20× |

**What the numbers show:**
- In the pilot, the median is **≈ 20× real time**: about 1.4 frames/s of UNet+VAE, with the Mac shared and swapping.
- On an idle model, `bench.py` measures the core alone at **3.6 frames/s on MPS fp16** (278 ms/frame). MPS fp32 gives
  2.2 frames/s and the CPU 0.2 frames/s.
- Model load takes 15–90 s. Avatar prep takes 2–8 min per clip, but runs only once per clip.

**Mac verdict:** the Mac proves quality, not speed. At 1.4–3.6 frames/s, a 4 s sentence takes 30–90 s.
The Mac can pre-render scenes overnight (≈ 6–16 h for the 644 lines on their own clips, § 4C), but it cannot serve chat.

**Cloud estimate:**
- Published figures: MuseTalk's README claims "30fps+ on an NVIDIA Tesla V100" in real-time mode. A third-party RTX 4090
  test rendered 2 s of audio in 1.56–1.87 s. Both use precomputed avatars, as we do.
- **Planning number: ≈ 30 frames/s on an L40S or 4090-class GPU, about 1.25× real time at our 24 fps.** A 4 s sentence
  (96 frames) then takes ≈ 3.2 s of GPU plus ≈ 0.3 s of H.264 encode.
- On an H100, expect ≈ 2× that throughput. This is an estimate; step 1 of § 7 measures it with `tools/lipsync/bench.py`
  before anything is built.
- LatentSync was **not** run locally. 1.6 needs ~18 GB of VRAM, and its code hard-wires CUDA (InsightFace detector
  `ctx_id`, decord). 1.5 needs the same porting. That is not a 60–90 minute job on a 16 GB Mac, and it does not change
  the decision: LatentSync is ~10× *slower* than real time (§ 4A), so it cannot serve chat.

## 3. Chat architecture (A)

```
browser (room)                      Cloudflare (Worker + API container)            Modal (GPU, region ap)
──────────────                      ───────────────────────────────────            ──────────────────────
reply text streams in ─────────────▶ LLM (as today)
subtitle shows at once
sentence n: POST /v1/tts ──────────▶ tts.internal → Fish (WAV 24 kHz, as today)
             {video: true}           lipsync.internal ───────────── WAV + {star, look, startFrame} ──▶ musetalk.render
                                                                                                    (avatar cached in GPU RAM)
◀── MP4 (H.264 720×1280 + her audio, ~0.3–0.6 MB/sentence) ◀──────────────── MP4 ◀──────────────────┘
play the MP4 in the talk-video slot; ask for sentence n+1 while n plays (ttsQueue, as today)
fallback: no MP4 within the budget → play the WAV over the talk loop exactly as today
```

**Hosting plan (Modal):**
- **GPU:** one `L40S` (48 GB) per container. Start here; switch to `H100` only if step 1 of § 7 shows the L40S is under
  1.2× real time.
- **Region:** `region="ap"`, which costs a 1.15× price multiplier. The narrow `jp` region costs 1.75×. Whether the
  Starter plan allows region pinning is unverified; if it does not, use the default US pool, which adds ≈ 150 ms of
  RTT per sentence.
- **What a container holds:** the weights (UNet 3.2 GB, VAE, Whisper-tiny) are baked into the image. At start it loads
  the **avatars for all 5 stars × 3 talk looks** (`talk-9x16`, `talkclose-9x16`, `talk-16x9`; ~200 frames each):
  - decoded frames, face boxes, VAE latents and blend masks;
  - about 6 MB of latents and ≈ 0.5 GB of raw 720p frames per look, so ≈ 8 GB of RAM for all 15 looks (or decode the
    loop MP4 at start);
  - built offline by `avatar_prep` (step 3 of § 7) and stored in a Modal Volume.
- **Cold start:**
  - Expected ≈ 15–30 s: container start, plus loading ~4 GB of weights and the avatars. This is an estimate.
  - GPU memory snapshots (`enable_gpu_snapshot`, alpha) are reported to make starts 3–10× faster.
  - **Hide it:** the room sends a warm-up call when he opens her room, long before her first reply. Set
    `scaledown_window` to 300 s so the container stays up while rooms are open.
  - A cold container never blocks speech: the fallback is today's loop with her audio.
- **Concurrency:**
  - Each container renders one sentence at a time, because the GPU is the bottleneck. Encoding overlaps the next render
    (`@modal.concurrent(max_inputs=2)`).
  - Cap `max_containers` at 10 (the Starter plan's GPU limit) and keep `min_containers=0`. Optionally set
    `min_containers=1` from 19:00 to 01:00 JST once traffic justifies it (≈ $400/month).
  - One L40S at ~1.25× real time serves about 10–15 rooms that are open at once, since a room is speaking only ~5–10 %
    of the time.
- **Auth:** a Modal web endpoint with proxy auth (`requires_proxy_auth=True`). The Worker sends the `Modal-Key` and
  `Modal-Secret` headers from Worker secrets. The browser never talks to Modal.
- **Continuity:** each request carries `startFrame`, the loop frame where the previous sentence ended, so the loop
  continues across sentences without a jump. The response reports `endFrame`.

**Latency budget for her first sentence** (from his send; Fish figures from `docs/tts.md`'s pilot):

| Step | Today (voice only) | With lip-sync (L40S, whole-MP4 phase 1) |
|---|---|---|
| LLM reply complete | ~1.5–3 s | same |
| Fish TTS, first sentence (p50 1.7 s for a whole sentence) | 1.7 s | 1.7 s |
| Lip-sync of a ~3 s sentence + encode + 2 hops | — | ≈ 2.4 + 0.3 + 0.3 ≈ **3 s** |
| Her voice starts | ~3–5 s | **~6–8 s** |

Later sentences are ready before the previous one finishes, because the render runs faster than real time and the
queue already fetches n+1 while n plays.

**UX that hides the first-sentence wait** (the owner's "behind the subtitles"):
1. Her subtitle appears **as soon as the text exists**, the full first sentence, not typed out. Meanwhile she plays her
   **listening/idle loop**, which reads as her thinking for a beat before she says it aloud.
2. When the first MP4 arrives, the subtitle highlight (the existing per-sentence caption) starts with her voice.
3. **Shorten the wait at the source:** have the LLM open with a short first sentence (1.5–2 s of audio). Render time
   scales with audio length, so this saves ~1.5 s.
4. **Phase 2, if 6–8 s still feels slow:**
   - stream frames as they render (fragmented MP4 over MSE, or a WebSocket), so playback starts after the first
     8-frame batch (≈ 0.3 s) instead of after the whole sentence; this saves ~2.5 s;
   - also stream Fish audio into the renderer.
   - Together these bring it near today's latency. Only if that is still not enough does B (§ 4B) become the
     answer.

## 4. Options compared (research 2026-10-02)

Figures were read on 2026-10-02 unless a date is given. "EST" marks an estimate. Sources are in § 9.

### A. Video-to-video lip-sync per sentence

| | Quality | 3–5 s sentence | Price | Licence (commercial) | GPU |
|---|---|---|---|---|---|
| **MuseTalk 1.5** (2025-03-28) | Good mouth on a 256² face crop, slightly soft on 1080p close-ups (pilot) | ~3 s on L40S/4090 (EST from 30 fps); ~1 min on this M4 | GPU time only | Code MIT. Weights "any purpose, even commercially". sd-vae-ft-mse MIT, Whisper MIT. **BiSeNet face-parse weights: trained on CelebAMask-HQ (non-commercial)**; we can drop them (ellipse mask, pilot). S3FD/FAN are used only in offline prep; swap for Apple Vision (`tools/media/face`) or MediaPipe. | 4 GB works, 24 GB for real-time batches |
| LatentSync 1.5 / **1.6** (2025-06-11, 512²) | Sharper (1.6), better temporal consistency | ~10× slower than real time (4090: 100 s per 10 s; issue #94) | GPU time | Code Apache-2.0, weights openrail++. The 1.6 detector uses InsightFace buffalo_l, whose weights are **non-commercial**: swap it. | 8 GB (1.5), 18 GB (1.6) |
| sync.so lipsync-2 / **-2-pro** | Best hosted (512 face; pro adds super-resolution) | ~15–60 s per clip incl. queue (EST), no streaming product | $0.05/s / $0.083/s (Scale $0.04 / $0.067) | Hosted. **Privacy policy (2024-05-27): uploaded content used for training; no documented opt-out** | — |
| fal LatentSync | as LatentSync | not stated | $0.20 minimum per clip (≤ 40 s) | hosted | — |
| fal Kling lip-sync | good | ~12 min queue | $0.014/s, 5 s steps | hosted | — |
| InfiniteTalk (2025-08) | Re-generates head and body, not just the mouth | Very slow (~40 min per 10 s on a 4090) | — | Apache-2.0 | 14B |

### B. Real-time streaming avatars

| | First frame | Price | Custom avatar | Our audio? | Matches Seedance? | Web |
|---|---|---|---|---|---|---|
| **Simli** | "<300 ms" | ≈ $0.01/min (plans $10/1,000 min; secondary source) | from an image | yes (PCM16 16 kHz) | look yes, loop motion no | WebRTC + JS; token minted by a Worker |
| bitHuman | unverified | $0.01–0.04/min | photo/video → .imx (500 credits) | yes | look yes | Python/LiveKit; in-browser claim unverified |
| Tavus CVI (Phoenix-4.5) | 134 ms audio→video, <600 ms per turn | $0.32–0.37/min overage, 30 s minimum | one image or 1 min of video, few hours | yes (Echo mode) | yes | Daily WebRTC |
| HeyGen LiveAvatar LITE | "<300 ms" | ≈ $0.08–0.09/min | 2-min video or a 9:16 still; consent recording | yes | yes | LiveKit/Agora |
| Anam (Cara-4) | p50 < 1 s, p95 < 3 s; buffers 800 ms of audio | $0.11–0.16/min | image ≥ 1152² | yes (passthrough) | yes (768×1152) | JS SDK; does not train on sessions |

All of them bill **connected session minutes**, not minutes of speech, and none reproduces our Seedance loops. They
animate a still or their own idle.

### C. Pre-rendering all 644 recorded lines

Volume, measured: **644 MP3s, 2,931 s (48.9 min), mean 4.55 s.**
- 236 lines play in scenes over a scene clip.
- 408 are room lines (confession, wake-up, goodnight, weather, promises…) that play over her talk loop, in whichever of
  3 looks the room shows.
- Rendering every room line for all 3 looks makes ≈ **6,650 s of output**.

| Option | 644 lines × 1 clip (2,931 s) | Everything incl. 3 looks (≈ 6,650 s) | Quality |
|---|---|---|---|
| **MuseTalk on Modal L40S** | ≈ $2 GPU (EST) | ≈ $5 | pilot-grade (good at 720p, slightly soft at 1080p) |
| MuseTalk on this Mac (free, overnight) | ≈ 6–16 h | ≈ 12–37 h | same |
| LatentSync 1.6 self-hosted | ≈ $10–30 | ≈ $25–70 | sharper; needs the detector swap |
| sync.so lipsync-2 | $147 | $333 | high |
| sync.so lipsync-2-pro | $243 | $552 | highest |

### D. Client-side visemes: ruled out

- **No viseme data for our voice:**
  - Fish Audio returns word-level timestamps only (`/v1/tts/stream/with-timestamp`), with no phonemes or visemes.
  - Azure and Polly visemes describe *their* voices, not her cloned one.
  - Rhubarb and wawa-lipsync drive 2D/3D rigs.
- **No way to draw the mouth convincingly:** a browser would have to track her head every frame (MediaPipe) and warp a
  mouth sprite onto a moving, relit 1080×1920 photoreal face. I found no product or paper that does this credibly; every
  real-time avatar product renders on a server.
- **Best case:** an amplitude-driven jaw nudge as a stylised fallback. It is not "properly matched".

## 5. Cost per heavy user per month (60 min of her voice in chat)

| Approach | Basis | Per heavy user / month |
|---|---|---|
| **A: MuseTalk on Modal L40S, region ap** | $0.000542/s × 1.15 = $2.24/h; 60 min of audio ≈ 48 GPU-min at 1.25× real time | **≈ $1.80 of GPU busy time**; **≈ $3–7 realistic** with idle tails shared by 10–15 open rooms per container (EST) |
| + optional peak warm pool | 1 × L40S, 6 h/day | ≈ $400/month fixed, not per user |
| sync.so lipsync-2 per sentence | $3/min | $180, and too slow (no streaming) |
| fal LatentSync per sentence | ~900 sentences × $0.20 | $180, and too slow |
| B: Simli | ≈ $0.01 per **session** minute, ~30 min/day in the room | ≈ $9 (secondary-source price) |
| B: HeyGen LiveAvatar LITE | $0.08/session-min | ≈ $72 |
| B: Anam | $0.11–0.16/session-min | ≈ $100–145 |
| B: Tavus | $0.32/session-min | ≈ $290 |
| Fish TTS (already paid, for scale) | $15 per M bytes | ≈ $0.10–0.20 |

Scenes (C) are one-time: about **$5** on Modal, or free on the Mac. Storage of the rendered lines in R2 is ≈ 2–4 GB, which
costs cents per month; R2 egress is free.

## 6. Scenes (C) in practice

- **Render target.** Render each line onto the clip it actually plays over:
  - a scene `line` uses the most recent `clip` step's `media` (as `tools/lipsync/jobs.json` does by hand);
  - room lines use the room's three talk looks.
  - When a line is longer than its clip, the renderer keeps looping the clip forward. Our loops are seamless.
- **Face check.** Skip lines whose clip shows no face (e.g. `*-coffee`, `*-book` detail shots). Prep detects a missing
  face and the line stays voice-over.
- **Output and storage.**
  - Write `<voice-id>.<clip>.mp4`, video only, at 720×1280 and 1080×1920.
  - Store the files in an **R2 bucket** behind the existing Worker, **not in git**: media is already 1.9 GB in the repo.
  - Key the cache on `sha1(clip file + audio file + model version)`, so a re-recorded line re-renders by itself.
- **Playback.**
  - The scene player swaps the clip for the rendered one during the line, then goes back to the clip.
  - The audio stays the existing MP3. The video is muted, starts with the audio at the same frame, and is timed with
    `requestVideoFrameCallback`.
- **Where to render.** The Mac can do it overnight for free. Modal does it in under an hour for ≈ $5.

## 7. Implementation plan

Engineering can start step 1 as soon as the Modal key exists. Steps 1–6 add no product behaviour until the flag is on.

1. **Benchmark on Modal** (½ day):
   - run `tools/lipsync/bench.py --device cuda` and one `musetalk_pilot.py` job on L40S and H100, in region `ap`;
   - record frames/s, cold start with and without GPU snapshot, and the round trip from a Worker in Tokyo;
   - pick the GPU.
2. **Licence-clean pipeline** (½ day):
   - default to the ellipse mask (no BiSeNet);
   - replace face_alignment/S3FD in prep with Apple Vision landmarks (`tools/media/face/face.swift`) or MediaPipe;
   - record the licences in `config/models.json` (`lipsync` entry: MuseTalk 1.5, sd-vae-ft-mse, whisper-tiny).
3. **`tools/lipsync/avatar_prep`** (1 day): for each star × talk look, write frames, boxes, latents and masks to a Modal
   Volume, with a face-centre check per frame. This reuses `musetalk_pilot.prepare_avatar`.
4. **`infra/lipsync/` Modal app** (1–2 days):
   - `render(star, look, startFrame, wav) → mp4 (+endFrame)`, with weights in the image and avatars loaded at start;
   - the settings from § 3: L40S, `region="ap"`, `scaledown_window=300`, `max_containers=10`, proxy auth;
   - a `warm()` endpoint;
   - deployed from the Mac runner with `modal deploy`. No Docker is needed; it fits the CI/CD plan.
5. **Worker relay `lipsync.internal`** (1 day):
   - beside `tts.internal`; secrets `MODAL_KEY` and `MODAL_SECRET`, URL in `LIPSYNC_URL`;
   - `/v1/tts` gains `video: true`. After the WAV, it calls the relay with a hard budget (e.g. 6 s) and returns the MP4.
     Otherwise it returns the WAV alone, exactly as today.
   - Minutes stay charged on audio seconds (#74).
6. **Room** (`apps/web/src/lib/ttsQueue.ts`, `pages/roomV2.tsx`, `scene/stage.tsx`) (1–2 days):
   - play the sentence MP4 in the talk-video slot; carry `endFrame` → `startFrame`;
   - send `warm()` on room entry;
   - show the subtitle-first UX (§ 3);
   - fall back per sentence;
   - a feature flag per star (`LIPSYNC_STARS`, like `TTS_STARS`).
7. **Measure on test.jstarcards.ai** (½ day): run the e2e timing of first voice after send (p50/p90) on a phone over 4G.
   If p90 is over ~8 s, do phase-2 streaming (§ 3). If it is still unacceptable, pilot Simli (B).
8. **C batch** (1 day plus a review):
   - a `jobs` generator from the scene and line JSON (line → clip);
   - render to R2 (Mac overnight or Modal);
   - scene player support (§ 6);
   - the owner reviews a contact sheet of the 20 worst lines by SyncNet confidence.
   - Optionally re-render the premium close-ups with sync.so lipsync-2-pro (requires the sync.so terms below).
9. **Release:** the test site first; production only when the owner says so. Nest launches only
   after all v1.1 work is accepted.

## 8. Accounts and keys the owner must create

I created none of these, and they should not be created on her behalf.

| # | Account | Needed for | Key → where it goes |
|---|---|---|---|
| 1 | **Modal** (modal.com). Starter plan, $0 plus usage, $30/month free credit. Add a payment method and set a **budget limit** in the workspace settings. | A and C | `modal token new` → `MODAL_TOKEN_ID`, `MODAL_TOKEN_SECRET` in `.env.modal.local` and GitHub secrets (deploys). A **proxy-auth token** (Modal dashboard → Settings → Proxy Auth Tokens) → Worker secrets `MODAL_KEY`, `MODAL_SECRET`. |
| 2 | *(optional)* **sync.so**, only to upgrade premium scene close-ups | C upgrade | `SYNC_API_KEY` in `.env.sync.local`. **Before uploading anything, get written confirmation that uploads are not used for training** (or an Enterprise DPA), and the talent agency's consent. |
| 3 | *(fallback only)* **Simli** | B | `SIMLI_API_KEY` → Worker secret (it mints session tokens). Needs the agency's consent for an avatar of her likeness. |

Not needed: Hugging Face (public weights), fal, or Replicate.

## 9. Risks

- **Quality on 1080p close-ups.** The mouth is softer than the face. Mitigations:
  - render chat at 720p (phones);
  - for desktop close-ups, use the sync.so-pro upgrade, or try LatentSync 1.6 (512²) in the step-1 benchmark.
- **Skin and lip colour.** The SD VAE pales the re-drawn lower face a little. `--colour` (a mean Lab shift measured
  around the mouth) fixes it in the pilot; keep it on in production.
- **Expression mismatch.** Seedance loops already "talk" (random mouth motion); MuseTalk overrides only the lower face,
  so a smile in the eyes with a neutral mouth can read oddly. Mitigations:
  - generate dedicated **closed-mouth, low-motion talk loops** for the avatars (one Seedance run per look, ≈ $8 each);
  - this also gives the model a cleaner reference.
- **Latency.** The first sentence is ~3 s later than voice only, until phase-2 streaming is built. The subtitle-first UX
  covers it; the step-7 measurement decides.
- **Cold starts and the Modal region.** Mitigations: the warm-up on room entry and the fallback to today's playback. Also
  verify that the `ap` region is available on the plan.
- **Licences.**
  - BiSeNet (CelebAMask-HQ) and InsightFace weights are non-commercial: both are excluded by step 2.
  - S3FD/FAN weight licences are unverified: also replaced in step 2.
- **Likeness and consent.** Lip-sync makes her face "say" any LLM sentence. This needs the same agency consent and
  content rules as her cloned voice ("only her own words"). Keep watermark/AI labelling consistent with
  `docs/compliance-jp.md`.
- **Vendor terms.** sync.so trains on uploads by default. Simli's ToS lets it train on user content. Tavus uses
  anonymised data. Anam does not train on sessions. None of these is used by the default plan.
- **Cost runaway.** Set the Modal budget limit and `max_containers`, and keep the per-member voice minutes (#74) as the
  real cap.
- **v1.1 scope.** This is new infrastructure after the v1.1 "no digital human" decision. Confirm it ships in v1.1 or
  later, not in the launch branch.

## 10. Reproducing the pilot

```
tools/lipsync/setup.sh                                          # .lipsync/: MuseTalk @0a89dec, venv, weights (~3.8 GB)
.lipsync/venv-muse/bin/python tools/lipsync/musetalk_pilot.py tools/lipsync/jobs.json              # BiSeNet mask
.lipsync/venv-muse/bin/python tools/lipsync/musetalk_pilot.py tools/lipsync/jobs.json --mask ellipse --colour --only talkclose-ja-rps,nana-talk-ja-open,scene-close
.lipsync/venv-muse/bin/python tools/lipsync/bench.py [--device cuda]                              # core frames/s
tools/lipsync/reel.sh                                           # out/reel.mp4
```

Outputs and timings (`timings.jsonl`) go to `tools/lipsync/out/`, which is gitignored. The local model workspace
`.lipsync/` is gitignored too.

## Sources (read 2026-10-02 unless dated)

**MuseTalk**
- Code: https://github.com/TMElyralab/MuseTalk (v1.5 released 2025-03-28; pilot at commit 0a89dec, 2025-09-26)
- Weights: https://huggingface.co/TMElyralab/MuseTalk
- Third-party RTX 4090 test (2025-02-21):
  https://frankfu.blog/real-time-digital-human/digital-human-series-4-parameter-tuning-and-gpu-selection-for-a-real-time-digital-human-system-based-on-musetalk-realtime-api/
- BiSeNet face parser: https://github.com/zllrunning/face-parsing.PyTorch

**LatentSync**
- Code: https://github.com/bytedance/LatentSync (pilot looked at commit a229c39, 2025-06-20)
- 1.6 weights: https://huggingface.co/ByteDance/LatentSync-1.6
- Speed report, issue #94 (2025-01-17): https://github.com/bytedance/LatentSync/issues/94

**sync.so**
- Pricing: https://sync.so/pricing
- Lip-sync models: https://sync.so/docs/models/lipsync
- Privacy policy (effective 2024-05-27): https://sync.so/privacy

**fal**
- https://fal.ai/models/fal-ai/latentsync
- https://fal.ai/models/fal-ai/sync-lipsync/v2/pro
- https://fal.ai/models/fal-ai/kling-video/lipsync/audio-to-video

**InfiniteTalk:** https://github.com/MeiGen-AI/InfiniteTalk

**Simli**
- Homepage: https://www.simli.com/
- WebRTC docs: https://docs.simli.com/api-reference/simli-webrtc
- Pricing index (secondary, 2026-09-15): https://blog.akapulu.com/p/real-time-avatar-api-pricing-index/

**bitHuman:** https://www.bithuman.ai/pricing

**Tavus**
- Pricing: https://www.tavus.io/pricing
- Echo mode: https://docs.tavus.io/sections/conversational-video-interface/echo-mode
- Phoenix-4.5 (2026-09-10): https://www.tavus.io/blog/phoenix-4-5

**HeyGen LiveAvatar**
- LITE mode: https://docs.liveavatar.com/docs/lite-mode/overview
- Custom avatar guide: https://help.heygen.com/en/articles/9612935-liveavatar-custom-liveavatar-creation-guide

**Anam**
- Pricing: https://anam.ai/pricing
- Custom TTS: https://anam.ai/docs/javascript-sdk/examples/custom-tts
- Changelog: https://anam.ai/changelog

**Modal**
- Pricing: https://modal.com/pricing
- Memory snapshots: https://modal.com/docs/guide/memory-snapshot
- Region selection: https://modal.com/docs/guide/region-selection

**Fish Audio**
- Timestamps endpoint: https://docs.fish.audio/api-reference/endpoint/openapi-v1/text-to-speech-stream-with-timestamps
- Our own pilot: `docs/tts.md` (2026-10-02)

**Visemes**
- Azure: https://learn.microsoft.com/en-us/azure/ai-services/speech-service/language-support
- Rhubarb: https://github.com/DanielSWolf/rhubarb-lip-sync

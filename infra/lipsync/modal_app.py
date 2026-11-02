"""Her lip-sync on Modal (#73, docs/lipsync.md): MuseTalk 1.5, licence-clean (./core.py), on a serverless GPU.

    set -a && . ./.env.modal.local && set +a
    modal deploy infra/lipsync/modal_app.py                         # the chat endpoint (Chat) + the batch (Batch)
    modal run infra/lipsync/modal_app.py::bench --gpu L40S          # throughput + per-sentence latency
    python tools/lipsync/batch.py ...                               # the scene batch (C), see that file

Two classes share one image (weights baked in) and one Volume (`jstar-lipsync`: clips and avatars cached, batch
outputs):

- **Chat** — the web endpoint the Worker's lip-sync relay calls per sentence of her runtime voice:
  `POST /render?clip=<media id>&start=<loop frame>` with her sentence's audio (WAV/MP3) as the body →
  `video/mp4` (H.264, video only, the clip's 720p size), headers `x-start-frame`, `x-end-frame` (where the next
  sentence starts the loop), `x-frames`, `x-fps`, `x-render-ms`, `x-gpu-ms`. `POST /warm?star=<star>` loads her talk
  loops; `GET /health`. Every call needs `Authorization: Bearer <LIPSYNC_SECRET>` (Modal Secret `jstar-lipsync-auth`,
  Worker secret `LIPSYNC_SECRET`). Scales to zero; `scaledown_window` keeps a container up between sentences.
- **Batch** — renders recorded lines onto the clips they play over, both output sizes, into the Volume.

Clips and recorded lines are fetched from the public site (`MEDIA_BASE`): nothing private goes to Modal.
"""
import os
import threading
import time
from pathlib import Path

import modal

APP = "jstar-lipsync"
MUSE = "/opt/MuseTalk"
MUSE_REV = "0a89dec45a0192b824e3cf4daf96c239440c5ed8"
LANDMARKER = "/opt/models/face_landmarker.task"
MEDIA_BASE = os.environ.get("LIPSYNC_MEDIA_BASE", "https://test.jstarcards.ai")
VOL = Path("/vol")
STARS = ["mahiro", "nana", "unpai", "alice", "eimi"]
# Her talk loops in the room's three looks (apps/web/src/pages/roomV2.tsx talkClipFor).
TALK_LOOKS = ["talk-9x16", "talkclose-9x16", "talk-16x9"]
GPU = os.environ.get("LIPSYNC_GPU", "L40S")
# Chat: an L40S, else the next free GPU of these (a cold start waits for capacity, not for one model of GPU).
CHAT_GPUS = [GPU, "A100-40GB", "H100"]
# Region: Modal's default pool. Pinning "ap" (Asia-Pacific, 1.15x) was tried on 2026-10-02: L40S capacity there was
# scarce and a cold start waited ~150 s to be scheduled, against ~150 ms more round trip from Japan unpinned.
REGION = os.environ.get("LIPSYNC_REGION") or None


def _weights() -> None:
    from huggingface_hub import hf_hub_download
    m = f"{MUSE}/models"
    for f in ["musetalkV15/musetalk.json", "musetalkV15/unet.pth"]:
        hf_hub_download("TMElyralab/MuseTalk", f, local_dir=m)
    for f in ["config.json", "diffusion_pytorch_model.bin"]:
        hf_hub_download("stabilityai/sd-vae-ft-mse", f, local_dir=f"{m}/sd-vae")
    for f in ["config.json", "pytorch_model.bin", "preprocessor_config.json"]:
        hf_hub_download("openai/whisper-tiny", f, local_dir=f"{m}/whisper")


image = (
    modal.Image.debian_slim(python_version="3.11")
    .apt_install("ffmpeg", "git", "curl", "libgl1", "libglib2.0-0")
    .uv_pip_install("torch==2.5.1", "torchvision==0.20.1", "diffusers==0.30.2", "transformers==4.39.2",
                 "accelerate==0.28.0", "huggingface_hub==0.25.2", "numpy<2", "opencv-python-headless<4.11",
                 "einops", "omegaconf", "mediapipe==0.10.21", "fastapi[standard]", "requests")
    .run_commands(f"git clone https://github.com/TMElyralab/MuseTalk.git {MUSE} && cd {MUSE} && git checkout {MUSE_REV}",
                  "mkdir -p /opt/models && curl -sfL -o /opt/models/face_landmarker.task "
                  "https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task")
    .run_function(_weights)
    .add_local_python_source("core")
)
app = modal.App(APP, image=image)
vol = modal.Volume.from_name("jstar-lipsync", create_if_missing=True)
auth = modal.Secret.from_name("jstar-lipsync-auth")


# --- shared helpers (run inside the containers) -------------------------------------------------------------------

def fetch(path: str) -> bytes:
    """A public file of the site (`/media/...`, `/voice/...`), cached in the Volume. The site answers a missing file
    with its app page (200, text/html), so HTML never counts as the file."""
    import requests
    local = VOL / "cache" / path.lstrip("/")
    if local.exists() and not local.read_bytes()[:64].lstrip().startswith(b"<"):
        return local.read_bytes()
    tries = [path] + ([path.replace("-hq.mp4", ".mp4")] if "-hq.mp4" in path else [])  # older clips: no "-hq"
    for p in tries:
        r = requests.get(MEDIA_BASE + p, timeout=60)
        if r.ok and "text/html" not in r.headers.get("content-type", ""):
            local.parent.mkdir(parents=True, exist_ok=True)
            local.write_bytes(r.content)
            return r.content
    raise FileNotFoundError(MEDIA_BASE + path)


def clip_source(clip: str, small: bool) -> str:
    """The clip's H.264 file: its 720p one (chat) or its full-size one (batch)."""
    portrait = clip.endswith("9x16")
    size = ("720x1280" if portrait else "1280x720") if small else ("1080x1920" if portrait else "1920x1080")
    return f"/media/{clip}/h264-{size}-hq.mp4"


def avatar(models, clip: str, small: bool):
    """The prepared clip (frames + avatar), from the Volume or made now (and saved)."""
    import core
    frames, fps = core.read_frames(fetch(clip_source(clip, small)))
    path = VOL / "avatars" / f"{clip}-{frames[0].shape[0]}.npz"
    if path.exists():
        av = core.Avatar.load(clip, path)
        if av.n == len(frames):
            return av, frames
    av = models.prepare(clip, frames, fps, LANDMARKER)
    av.save(path)
    vol.commit()
    return av, frames


# --- chat -----------------------------------------------------------------------------------------------------------

@app.cls(gpu=CHAT_GPUS, region=REGION, volumes={"/vol": vol}, secrets=[auth], cpu=4.0, memory=24576, timeout=180,
         scaledown_window=300, min_containers=0, max_containers=10, enable_memory_snapshot=False)
@modal.concurrent(max_inputs=4)
class Chat:
    @modal.enter()
    def load(self):
        import core
        t = time.perf_counter()
        self.models = core.Models(MUSE)
        self.avatars: dict = {}
        self.gpu = threading.Lock()
        self.prep = threading.Lock()
        self.loaded_s = round(time.perf_counter() - t, 2)
        self.started = time.time()

    def _avatar(self, clip: str):
        with self.prep:
            if clip not in self.avatars:
                self.avatars[clip] = avatar(self.models, clip, small=True)
            return self.avatars[clip]

    @modal.method()
    def probe(self, clip: str = "mahiro-talk-9x16", seconds: float = 4.0) -> dict:
        """Cold/warm start and one sentence, for `modal run modal_app.py::coldstart` (no web endpoint needed)."""
        import core
        import numpy as np
        t = time.perf_counter()
        av, frames = self._avatar(clip)
        t1 = time.perf_counter()
        wav = core.load_audio(fetch("/voice/scene/mahiro/c4f4abf07f27.mp3"))
        wav = np.tile(wav, 3)[: int(seconds * core.SR)]
        with self.gpu:
            h = frames[0].shape[0]
            core.encode(self.models.render(av, frames, wav, start=0, batch=16), av.fps, av.width, av.height, [h], crf=23)
        return {"model_load_s": self.loaded_s, "avatar_s": round(t1 - t, 2), "sentence_s": round(time.perf_counter() - t1, 2),
                "up_s": round(time.time() - self.started, 1)}

    @modal.asgi_app(label="jstar-lipsync")
    def web(self):
        import hmac

        import core
        import numpy as np
        from fastapi import FastAPI, HTTPException, Request, Response

        api = FastAPI()
        secret = os.environ["LIPSYNC_SECRET"]

        def check(req: Request):
            got = req.headers.get("authorization", "")
            if not hmac.compare_digest(got, f"Bearer {secret}"):
                raise HTTPException(401, "unauthorized")

        @api.get("/health")
        def health(req: Request):
            check(req)
            return {"ok": True, "loaded_s": self.loaded_s, "up_s": round(time.time() - self.started), "avatars": sorted(self.avatars)}

        @api.post("/warm")
        def warm(req: Request, star: str):
            check(req)
            if star not in STARS:
                raise HTTPException(400, "star")
            t = time.perf_counter()
            for look in TALK_LOOKS:
                self._avatar(f"{star}-{look}")
            return {"ok": True, "ms": round((time.perf_counter() - t) * 1000)}

        @api.post("/render")
        async def render(req: Request, clip: str, start: int = 0):
            check(req)
            if not any(clip == f"{s}-{l}" for s in STARS for l in TALK_LOOKS):
                raise HTTPException(400, "clip")
            body = await req.body()
            if not body or len(body) > 4_000_000:
                raise HTTPException(400, "audio")
            t0 = time.perf_counter()
            av, frames = self._avatar(clip)
            wav = core.load_audio(body)
            if len(wav) < core.SR * 0.2 or len(wav) > core.SR * 30:
                raise HTTPException(400, "audio length")
            start = start % av.n
            t1 = time.perf_counter()
            n = core.frames_for(len(wav), av.fps)
            h = frames[0].shape[0]
            # Rendering streams straight into the encoder: frames are encoded while later ones are still on the GPU.
            with self.gpu:
                mp4 = core.encode(self.models.render(av, frames, wav, start=start, batch=16), av.fps, av.width,
                                  av.height, [h], crf=23, preset="veryfast")[h]
            t2 = time.perf_counter()
            return Response(mp4, media_type="video/mp4", headers={
                "x-start-frame": str(start), "x-end-frame": str((start + n) % av.n), "x-frames": str(n),
                "x-fps": f"{av.fps:g}", "x-prep-ms": str(round((t1 - t0) * 1000)),
                "x-gpu-ms": str(round((t2 - t1) * 1000)), "x-render-ms": str(round((t2 - t0) * 1000)),
                "x-audio-ms": str(round(len(wav) / core.SR * 1000)), "cache-control": "no-store"})

        return api


# --- the scene batch ------------------------------------------------------------------------------------------------

@app.cls(gpu=GPU, volumes={"/vol": vol}, cpu=8.0, memory=32768, timeout=3600, scaledown_window=30, max_containers=6)
class Batch:
    @modal.enter()
    def load(self):
        import core
        self.models = core.Models(MUSE)

    @modal.method()
    def render_clip(self, clip: str, voices: list[str], force: bool = False) -> dict:
        import traceback
        try:
            return self._render_clip(clip, voices, force)
        except Exception:
            return {"clip": clip, "error": traceback.format_exc()[-1500:], "done": [], "skipped": []}

    def _render_clip(self, clip: str, voices: list[str], force: bool = False) -> dict:
        """Every recording in `voices` (public paths) rendered onto `clip` at its full size and 2/3 of it, into
        /vol/out/<clip>/<voice id>-<w>x<h>.mp4. Recordings already rendered are skipped unless `force`."""
        import core
        t = time.perf_counter()
        av, frames = avatar(self.models, clip, small=False)
        prep_s = time.perf_counter() - t
        res = {"clip": clip, "frames": av.n, "coverage": round(av.coverage, 3), "face_px": av.face_px,
               "prep_s": round(prep_s, 2), "done": [], "skipped": [], "gpu_s": 0.0, "encode_s": 0.0, "audio_s": 0.0}
        if av.coverage < 0.8:
            res["skipped"] = [{"voice": v, "why": "no face"} for v in voices]
            return res
        H = frames[0].shape[0]
        sizes = [H, H * 2 // 3]
        for v in voices:
            vid = Path(v).stem
            outs = {s: VOL / "out" / clip / f"{vid}-{(av.width * s // H) // 2 * 2}x{s}.mp4" for s in sizes}
            if not force and all(p.exists() for p in outs.values()):
                res["skipped"].append({"voice": v, "why": "exists"})
                continue
            wav = core.load_audio(fetch(v))
            t1 = time.perf_counter()
            out = list(self.models.render(av, frames, wav, start=0, batch=32))
            self.models.sync()
            t2 = time.perf_counter()
            enc = core.encode(out, av.fps, av.width, av.height, sizes, crf=20)
            t3 = time.perf_counter()
            for s, p in outs.items():
                p.parent.mkdir(parents=True, exist_ok=True)
                p.write_bytes(enc[s])
            res["gpu_s"] += t2 - t1
            res["encode_s"] += t3 - t2
            res["audio_s"] += len(wav) / core.SR
            res["done"].append({"voice": v, "frames": len(out), "files": {s: str(p.relative_to(VOL / "out")) for s, p in outs.items()}})
        vol.commit()
        for k in ("gpu_s", "encode_s", "audio_s"):
            res[k] = round(res[k], 2)
        return res


# --- phase renders (scenes: her line starts wherever the clip is) ------------------------------------------------------

PHASE_STEP = 7  # frames between phases (0.29 s at 24 fps): her voice waits at most this long for the clip to get there


@app.cls(gpu=GPU, volumes={"/vol": vol}, cpu=8.0, memory=32768, timeout=3600, scaledown_window=20, max_containers=8)
class Phases:
    """Her recorded line rendered onto a scene clip from every PHASE_STEP-th frame of the clip, at 720p (the phone size),
    so the scene player can start her line where the clip is, on a render whose first frame is the clip's own
    (docs/lipsync.md § 6; QA of d53e8ba, owner's option b). Phase 0 is the scene batch's render."""

    @modal.enter()
    def load(self):
        import core
        self.models = core.Models(MUSE)

    @modal.method()
    def render_clip(self, clip: str, voices: list[str], step: int = PHASE_STEP, force: bool = False) -> dict:
        import traceback
        try:
            return self._render(clip, voices, step, force)
        except Exception:
            return {"clip": clip, "error": traceback.format_exc()[-1500:], "done": 0, "skipped": 0, "busy_s": 0.0}

    def _render(self, clip: str, voices: list[str], step: int, force: bool) -> dict:
        import core
        t0 = time.perf_counter()
        av, frames = avatar(self.models, clip, small=True)
        res = {"clip": clip, "frames": av.n, "coverage": round(av.coverage, 3), "prep_s": round(time.perf_counter() - t0, 2),
               "step": step, "done": 0, "skipped": 0, "voices": [], "audio_s": 0.0}
        if av.coverage < 0.8:
            res["skipped"] = len(voices)
            res["busy_s"] = round(time.perf_counter() - t0, 2)
            return res
        H, W = frames[0].shape[0], av.width
        for v in voices:
            vid = Path(v).stem
            wav = core.load_audio(fetch(v))
            for p in range(step, av.n, step):
                out = VOL / "phase" / clip / f"{vid}-p{p}-{W}x{H}.mp4"
                if not force and out.exists():
                    res["skipped"] += 1
                    continue
                mp4 = core.encode(self.models.render(av, frames, wav, start=p, batch=32), av.fps, W, H, [H], crf=22)[H]
                out.parent.mkdir(parents=True, exist_ok=True)
                out.write_bytes(mp4)
                res["done"] += 1
                res["audio_s"] += len(wav) / core.SR
            res["voices"].append(vid)
        vol.commit()
        res["audio_s"] = round(res["audio_s"], 2)
        res["busy_s"] = round(time.perf_counter() - t0, 2)
        return res


@app.local_entrypoint()
def phases(plan: str, out: str = "phase-result.json", only: str = "", limit: int = 0, cap_usd: float = 20.0):
    """Phase renders for every recorded line a scene plays over a scene clip (her talk loops are cut to their frame 0
    as her line starts: no phases needed). Stops sending work once the estimated spend (container busy time at the
    L40S + 8 CPU + 32 GB rate) reaches `cap_usd`."""
    import json
    import re
    from collections import defaultdict
    usd_per_s = (0.000542 + 8 * 0.0000131 + 32 * 0.00000222)  # L40S + CPU + memory, Modal list prices 2026-10-02
    p = json.loads(Path(plan).read_text())
    talk = re.compile(r"-(talk|talkclose)-(9x16|16x9)$")
    groups: dict[str, list[str]] = defaultdict(list)
    for j in p["jobs"]:
        if not talk.search(j["clip"]):
            groups[j["clip"]].append(j["voice"])
    items = sorted((c, sorted(set(v))) for c, v in groups.items() if not only or any(o in c for o in only.split(",")))
    if limit:
        items = items[:limit]
    print(f"{len(items)} clips, {sum(len(v) for _, v in items)} lines", flush=True)
    t = time.perf_counter()
    results, spent = [], 0.0
    for r in Phases().render_clip.starmap(items, return_exceptions=True, order_outputs=False):
        if isinstance(r, BaseException):
            r = {"clip": "?", "error": repr(r)[:400], "done": 0, "skipped": 0, "busy_s": 0.0}
        results.append(r)
        spent += r.get("busy_s", 0.0) * usd_per_s
        print(f"{r['clip']}: {r['done']} done, {r['skipped']} skipped, busy {r.get('busy_s')}s, est total ${spent:.2f}"
              + (f", ERROR {r['error'][-200:]}" if r.get("error") else ""), flush=True)
        Path(out).write_text(json.dumps({"wall_s": round(time.perf_counter() - t, 1), "est_usd": round(spent, 2), "results": results}, indent=1))
        if spent > cap_usd:
            print(f"STOP: estimated spend ${spent:.2f} over the cap ${cap_usd}", flush=True)
            break


# --- benchmark ------------------------------------------------------------------------------------------------------

def _bench_body(gpu: str) -> dict:
    import core
    import numpy as np
    import torch
    out: dict = {"gpu": gpu, "device": torch.cuda.get_device_name(0)}
    t = time.perf_counter()
    m = core.Models(MUSE)
    out["model_load_s"] = round(time.perf_counter() - t, 2)
    # Core throughput (as tools/lipsync/bench.py): UNet one step + VAE decode, warm.
    for b in (8, 16, 32):
        lat = torch.randn(b, 8, 32, 32, device=m.device, dtype=m.dtype)
        aud = torch.randn(b, 50, 384, device=m.device, dtype=m.dtype)
        with torch.no_grad():
            for i in range(4):
                if i == 1:
                    m.sync(); t = time.perf_counter()
                m.vae.decode_latents(m.unet(lat, m.t0, encoder_hidden_states=m.pe(aud)).sample)
            m.sync()
        out[f"core_fps_b{b}"] = round(b * 3 / (time.perf_counter() - t), 1)
    # A real sentence on her chat loop (720p), end to end: audio features, UNet+VAE, paste, encode.
    t = time.perf_counter()
    av, frames = avatar(m, "mahiro-talk-9x16", small=True)
    out["avatar_720_s"] = round(time.perf_counter() - t, 2)
    out["avatar_coverage"] = av.coverage
    out["face_px"] = av.face_px
    wav = core.load_audio(fetch("/voice/scene/mahiro/c4f4abf07f27.mp3"))
    wav = np.tile(wav, 3)
    for sec in (2, 4, 6):
        w = wav[: sec * core.SR]
        best = None
        for _ in range(2):
            t0 = time.perf_counter()
            fr = list(m.render(av, frames, w, start=17, batch=16))
            m.sync()
            t1 = time.perf_counter()
            core.encode(fr, av.fps, av.width, av.height, [frames[0].shape[0]], crf=23)
            t2 = time.perf_counter()
            t3 = time.perf_counter()
            core.encode(m.render(av, frames, w, start=17, batch=16), av.fps, av.width, av.height, [frames[0].shape[0]], crf=23)
            t4 = time.perf_counter()
            r = {"render_s": round(t1 - t0, 2), "encode_s": round(t2 - t1, 2), "total_s": round(t2 - t0, 2),
                 "streamed_s": round(t4 - t3, 2)}
            best = r if best is None or r["streamed_s"] < best["streamed_s"] else best
        out[f"sentence_{sec}s"] = best
    return out


@app.function(gpu="L40S", volumes={"/vol": vol}, cpu=4.0, memory=24576, timeout=900)
def bench_l40s() -> dict:
    return _bench_body("L40S")


@app.function(gpu="H100", volumes={"/vol": vol}, cpu=4.0, memory=24576, timeout=900)
def bench_h100() -> dict:
    return _bench_body("H100")


@app.local_entrypoint()
def bench(gpu: str = "L40S"):
    import json
    fn = bench_h100 if gpu.upper() == "H100" else bench_l40s
    t = time.perf_counter()
    r = fn.remote()
    r["call_wall_s"] = round(time.perf_counter() - t, 2)
    print(json.dumps(r, indent=1))


@app.local_entrypoint()
def coldstart(seconds: float = 4.0):
    """A cold container (first call), then the same container warm (second call), wall time seen from here."""
    import json
    c = Chat()
    for label in ("cold", "warm", "warm2"):
        t = time.perf_counter()
        r = c.probe.remote(seconds=seconds)
        r["wall_s"] = round(time.perf_counter() - t, 2)
        print(label, json.dumps(r))


@app.local_entrypoint()
def scenes(plan: str, out: str = "batch-result.json", only: str = "", room_looks: str = ",".join(TALK_LOOKS)):
    """The scene batch (C): every recorded line onto the clip(s) it plays over (`plan`: tools/lipsync/plan.ts's
    output), and each line no scene plays (her room lines) onto her talk loops in the room's looks. One Batch call
    per clip; results (what was rendered, skipped and timed) are written to `out`."""
    import json
    from collections import defaultdict
    p = json.loads(Path(plan).read_text())
    groups: dict[str, list[str]] = defaultdict(list)
    for j in p["jobs"]:
        groups[j["clip"]].append(j["voice"])
    for v in p["unplayed"]:
        star = v.split("/")[3]
        for look in filter(None, room_looks.split(",")):
            groups[f"{star}-{look}"].append(v)
    items = sorted((c, sorted(set(vs))) for c, vs in groups.items() if not only or any(o in c for o in only.split(",")))
    print(f"{len(items)} clips, {sum(len(v) for _, v in items)} renders")
    t = time.perf_counter()
    results = []
    for clip_voices, r in zip(items, Batch().render_clip.starmap(items, return_exceptions=True)):
        if isinstance(r, BaseException):
            r = {"clip": clip_voices[0], "error": repr(r)[:400], "done": [], "skipped": []}
        results.append(r)
        print(f"{r['clip']}: {len(r.get('done', []))} done, {len(r.get('skipped', []))} skipped"
              + (f", ERROR {r['error'][:120]}" if r.get("error") else f", gpu {r.get('gpu_s')}s / audio {r.get('audio_s')}s"), flush=True)
    Path(out).write_text(json.dumps({"wall_s": round(time.perf_counter() - t, 1), "results": results}, indent=1))

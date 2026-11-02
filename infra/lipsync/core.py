"""Her lip-sync (#73, docs/lipsync.md): MuseTalk 1.5 re-draws the lower half of her face in one of our clips so her
mouth says a line of audio. The licence-clean variant the memo settled on:

- face boxes from **MediaPipe Face Landmarker** (Apache-2.0), not DWPose / S3FD / FAN;
- the blend mask is a **feathered ellipse** over the lower face, not MuseTalk's BiSeNet parser (CelebAMask-HQ,
  non-commercial);
- the re-drawn face is **colour-matched** back to the original (the SD VAE pales skin and lips a little).

MuseTalk's own code supplies only the UNet / VAE / positional-encoding wrappers and Whisper-tiny (MIT; weights "any
purpose, even commercially"). Used by the Modal app (./modal_app.py) and runnable locally (tools/lipsync).

An *avatar* is a clip prepared once: its frame count and fps, a face box per frame (None where no face is found)
and the VAE latents of every face crop. Rendering a line then costs one UNet step + one VAE decode per frame.
"""
from __future__ import annotations

import io
import math
import subprocess
import time
from dataclasses import dataclass, field
from pathlib import Path

import cv2
import numpy as np
import torch

# MediaPipe face-mesh indices: the jaw line from cheek to cheek round the chin, and the lower nose bridge (the
# equivalent of the 68-point landmark 29 that MuseTalk's box is built around).
JAW = [234, 93, 132, 58, 172, 136, 150, 149, 176, 148, 152, 377, 400, 378, 379, 365, 397, 288, 361, 323, 454]
NOSE = 195
SR = 16000


@dataclass
class Avatar:
    clip: str
    fps: float
    width: int
    height: int
    boxes: list  # per frame: (x1, y1, x2, y2) or None
    latents: torch.Tensor  # (n, 8, 32, 32), fp16, on CPU
    face_px: int = 0
    timings: dict = field(default_factory=dict)

    @property
    def n(self) -> int:
        return len(self.boxes)

    @property
    def coverage(self) -> float:
        return sum(b is not None for b in self.boxes) / max(1, self.n)

    def save(self, path: Path) -> None:
        path.parent.mkdir(parents=True, exist_ok=True)
        boxes = np.array([b if b is not None else (-1, -1, -1, -1) for b in self.boxes], np.int32)
        buf = io.BytesIO()
        np.savez(buf, boxes=boxes, latents=self.latents.numpy(), meta=np.array([self.fps, self.width, self.height, self.face_px]))
        path.write_bytes(buf.getvalue())

    @classmethod
    def load(cls, clip: str, path: Path) -> "Avatar":
        z = np.load(io.BytesIO(path.read_bytes()))
        fps, w, h, face = z["meta"].tolist()
        boxes = [None if b[0] < 0 else tuple(int(v) for v in b) for b in z["boxes"]]
        return cls(clip, fps, int(w), int(h), boxes, torch.from_numpy(z["latents"]), int(face))


# --- video in / out -------------------------------------------------------------------------------------------------

def read_frames(src: str | Path | bytes) -> tuple[list[np.ndarray], float]:
    """Every frame (BGR) and the fps of an MP4, through ffmpeg (a path, or the file's bytes)."""
    probe = ["ffprobe", "-v", "error", "-select_streams", "v:0", "-show_entries", "stream=width,height,r_frame_rate",
             "-of", "csv=p=0"]
    if isinstance(src, (bytes, bytearray)):
        # A file, not a pipe: an MP4 whose index (moov) sits at the end cannot be read from a pipe.
        import tempfile
        with tempfile.NamedTemporaryFile(suffix=".mp4") as f:
            f.write(src)
            f.flush()
            return read_frames(f.name)
    data = None
    arg = str(src)
    w, h, rate = subprocess.run(probe + [arg], input=data, capture_output=True, check=True).stdout.decode().strip().split(",")[:3]
    num, den = (int(x) for x in rate.split("/"))
    w, h = int(w), int(h)
    raw = subprocess.run(["ffmpeg", "-v", "error", "-i", arg, "-f", "rawvideo", "-pix_fmt", "bgr24", "pipe:1"],
                         input=data, capture_output=True, check=True).stdout
    n = len(raw) // (w * h * 3)
    arr = np.frombuffer(raw, np.uint8)[: n * w * h * 3].reshape(n, h, w, 3)
    return [arr[i] for i in range(n)], num / den


def encode(frames, fps: float, width: int, height: int, sizes: list[int], crf: int = 20, preset: str = "veryfast") -> dict[int, bytes]:
    """H.264 MP4s (video only, +faststart) of the frames, one per output height in `sizes` (e.g. [1920, 1280]).
    `frames` may be a generator; everything is encoded in one ffmpeg pass."""
    import tempfile
    tmp = Path(tempfile.mkdtemp())
    outs = {s: tmp / f"{s}.mp4" for s in sizes}
    split = f"[0:v]split={len(sizes)}" + "".join(f"[s{i}]" for i in range(len(sizes))) + ";"
    chains = ";".join(f"[s{i}]scale=-2:{s}:flags=lanczos,format=yuv420p[o{i}]" for i, s in enumerate(sizes))
    cmd = ["ffmpeg", "-y", "-v", "error", "-f", "rawvideo", "-pix_fmt", "bgr24", "-s", f"{width}x{height}",
           "-r", f"{fps:g}", "-i", "pipe:0", "-filter_complex", split + chains]
    for i, s in enumerate(sizes):
        cmd += ["-map", f"[o{i}]", "-c:v", "libx264", "-preset", preset, "-crf", str(crf), "-profile:v", "high",
                "-movflags", "+faststart", "-an", str(outs[s])]
    p = subprocess.Popen(cmd, stdin=subprocess.PIPE)
    for f in frames:
        p.stdin.write(np.ascontiguousarray(f).tobytes())
    p.stdin.close()
    if p.wait() != 0:
        raise RuntimeError("ffmpeg encode failed")
    out = {s: outs[s].read_bytes() for s in sizes}
    for f in outs.values():
        f.unlink(missing_ok=True)
    tmp.rmdir()
    return out


def load_audio(data: bytes) -> np.ndarray:
    """Mono float32 at 16 kHz from WAV / MP3 bytes (ffmpeg decodes either)."""
    raw = subprocess.run(["ffmpeg", "-v", "error", "-i", "pipe:0", "-f", "f32le", "-ac", "1", "-ar", str(SR), "pipe:1"],
                         input=data, capture_output=True, check=True).stdout
    return np.frombuffer(raw, np.float32).copy()


# --- face boxes -----------------------------------------------------------------------------------------------------

def landmarker(model_path: str):
    from mediapipe.tasks.python import BaseOptions, vision
    opts = vision.FaceLandmarkerOptions(base_options=BaseOptions(model_asset_path=model_path, delegate=BaseOptions.Delegate.CPU),
                                        running_mode=vision.RunningMode.VIDEO, num_faces=1,
                                        min_face_detection_confidence=0.5, min_tracking_confidence=0.5)
    return vision.FaceLandmarker.create_from_options(opts)


def face_boxes(frames: list[np.ndarray], fps: float, model_path: str) -> list:
    """MuseTalk 1.5's face box (get_landmark_and_bbox) per frame, from MediaPipe landmarks: the jaw's width, from
    as far above the lower nose bridge as the chin is below it, down to the chin plus a margin. Smoothed over
    neighbouring frames (the loop wraps), so the pasted face does not jitter. None where no face is found."""
    import mediapipe as mp
    h, w = frames[0].shape[:2]
    pts: list = []
    with landmarker(model_path) as lm:
        for i, f in enumerate(frames):
            r = lm.detect_for_video(mp.Image(image_format=mp.ImageFormat.SRGB, data=np.ascontiguousarray(f[:, :, ::-1])),
                                    int(i * 1000 / fps))
            if not r.face_landmarks:
                pts.append(None)
                continue
            a = np.array([(p.x * w, p.y * h) for p in r.face_landmarks[0]], np.float32)
            pts.append(a)
    margin = round(10 * h / 1280)  # MuseTalk 1.5's extra_margin (10 px) at 720p, scaled
    raw = []
    for a in pts:
        if a is None:
            raw.append(None)
            continue
        jaw = a[JAW]
        half = a[NOSE][1]
        y2 = float(jaw[:, 1].max())
        raw.append(np.array([jaw[:, 0].min(), max(0.0, half - (y2 - half)), jaw[:, 0].max(), min(h, y2 + margin)]))
    n = len(raw)
    out = []
    for i in range(n):
        if raw[i] is None:
            out.append(None)
            continue
        near = [raw[(i + d) % n] for d in (-1, 0, 1) if raw[(i + d) % n] is not None]
        x1, y1, x2, y2 = np.mean(near, axis=0)
        x1, y1, x2, y2 = max(0, int(round(x1))), max(0, int(round(y1))), min(w, int(round(x2))), min(h, int(round(y2)))
        # A face cut by the frame edge (or too small to re-draw) is left as it is.
        out.append((x1, y1, x2, y2) if x2 - x1 >= 32 and y2 - y1 >= 32 else None)
    return out


# --- blending -------------------------------------------------------------------------------------------------------

def crop_box(box, expand: float = 1.5):
    """MuseTalk's get_crop_box: a square round the face box, `expand` times its longer side."""
    x, y, x1, y1 = box
    xc, yc = (x + x1) // 2, (y + y1) // 2
    s = int(max(x1 - x, y1 - y) // 2 * expand)
    return [xc - s, yc - s, xc + s, yc + s]


def ellipse_mask(box, crop) -> np.ndarray:
    """Feathered ellipse over mouth, chin and lower cheeks (the lower part of the face box), in crop coordinates."""
    x1, y1, x2, y2 = box
    xs, ys, xe, ye = crop
    w, h = x2 - x1, y2 - y1
    m = np.zeros((ye - ys, xe - xs), np.uint8)
    cv2.ellipse(m, (int((x1 + x2) / 2 - xs), int(y1 + 0.66 * h - ys)), (int(0.40 * w), int(0.34 * h)), 0, 0, 360, 255, -1)
    k = int(0.12 * w) // 2 * 2 + 1
    return cv2.GaussianBlur(m, (k, k), 0)


def match_colour(face: np.ndarray, orig: np.ndarray) -> np.ndarray:
    """Shift the re-drawn face's mean Lab colour to the original's, measured on cheeks and chin round the mouth (an
    open mouth is meant to be darker)."""
    h, w = face.shape[:2]
    ring = np.zeros((h, w), np.uint8)
    ring[h // 2:, :] = 255
    cv2.ellipse(ring, (w // 2, int(0.72 * h)), (int(0.24 * w), int(0.14 * h)), 0, 0, 360, 0, -1)
    sel = ring > 0
    fl = cv2.cvtColor(face, cv2.COLOR_BGR2LAB).astype(np.float32)
    ol = cv2.cvtColor(orig, cv2.COLOR_BGR2LAB).astype(np.float32)
    fl += ol[sel].mean(0) - fl[sel].mean(0)
    return cv2.cvtColor(np.clip(fl, 0, 255).astype(np.uint8), cv2.COLOR_LAB2BGR)


def paste(frame: np.ndarray, face: np.ndarray, box, colour: bool = True) -> np.ndarray:
    """The re-drawn face (256x256) back into the frame through the ellipse mask."""
    x1, y1, x2, y2 = box
    f = cv2.resize(face, (x2 - x1, y2 - y1), interpolation=cv2.INTER_LANCZOS4)
    if colour:
        f = match_colour(f, frame[y1:y2, x1:x2])
    crop = crop_box(box)
    mask = ellipse_mask(box, crop)
    xs, ys, xe, ye = crop
    H, W = frame.shape[:2]
    out = frame.copy()
    large = np.zeros((ye - ys, xe - xs, 3), np.uint8)
    sx0, sy0, sx1, sy1 = max(xs, 0), max(ys, 0), min(xe, W), min(ye, H)
    large[sy0 - ys:sy1 - ys, sx0 - xs:sx1 - xs] = frame[sy0:sy1, sx0:sx1]
    large[y1 - ys:y2 - ys, x1 - xs:x2 - xs] = f
    a = (mask.astype(np.float32) / 255.0)[sy0 - ys:sy1 - ys, sx0 - xs:sx1 - xs, None]
    region = out[sy0:sy1, sx0:sx1].astype(np.float32)
    lg = large[sy0 - ys:sy1 - ys, sx0 - xs:sx1 - xs].astype(np.float32)
    out[sy0:sy1, sx0:sx1] = (lg * a + region * (1 - a)).astype(np.uint8)
    return out


# --- the model ------------------------------------------------------------------------------------------------------

class Models:
    """MuseTalk 1.5 (UNet, SD VAE ft-mse, positional encoding) and Whisper-tiny, loaded once."""

    def __init__(self, muse_dir: str | Path, device: str | None = None, fp16: bool = True):
        import os
        import sys
        muse_dir = str(muse_dir)
        if muse_dir not in sys.path:
            sys.path.insert(0, muse_dir)
        self.device = torch.device(device or ("cuda" if torch.cuda.is_available() else
                                              "mps" if torch.backends.mps.is_available() else "cpu"))
        self.dtype = torch.float16 if fp16 and self.device.type != "cpu" else torch.float32
        cwd = os.getcwd()
        os.chdir(muse_dir)
        try:
            from transformers import AutoFeatureExtractor, WhisperModel
            from musetalk.utils.utils import load_all_model
            vae, unet, pe = load_all_model(unet_model_path="models/musetalkV15/unet.pth", vae_type="sd-vae",
                                           unet_config="models/musetalkV15/musetalk.json", device=self.device)
            self.features = AutoFeatureExtractor.from_pretrained("models/whisper")
            self.whisper = WhisperModel.from_pretrained("models/whisper").to(self.device, self.dtype).eval()
        finally:
            os.chdir(cwd)
        vae.vae = vae.vae.to(self.device, self.dtype)
        vae.device = self.device
        self.vae = vae
        self.unet = unet.model.to(self.device, self.dtype).eval()
        self.pe = pe.to(self.device, self.dtype)
        self.t0 = torch.tensor([0], device=self.device)
        self.paste_threads = max(1, min(8, (os.cpu_count() or 2)))

    def sync(self) -> None:
        if self.device.type == "cuda":
            torch.cuda.synchronize()
        elif self.device.type == "mps":
            torch.mps.synchronize()

    @torch.no_grad()
    def prepare(self, clip: str, frames: list[np.ndarray], fps: float, landmark_model: str) -> Avatar:
        t = time.perf_counter()
        boxes = face_boxes(frames, fps, landmark_model)
        t_lm = time.perf_counter() - t
        t = time.perf_counter()
        lat = []
        zero = None
        for f, b in zip(frames, boxes):
            if b is None:
                zero = zero if zero is not None else torch.zeros(1, 8, 32, 32, dtype=torch.float16)
                lat.append(zero)
                continue
            x1, y1, x2, y2 = b
            crop = cv2.resize(f[y1:y2, x1:x2], (256, 256), interpolation=cv2.INTER_LANCZOS4)
            lat.append(self.vae.get_latents_for_unet(crop).to(torch.float16).cpu())
        self.sync()
        h, w = frames[0].shape[:2]
        faces = [b[2] - b[0] for b in boxes if b is not None]
        return Avatar(clip, fps, w, h, boxes, torch.cat(lat), int(np.median(faces)) if faces else 0,
                      {"landmarks_s": round(t_lm, 2), "latents_s": round(time.perf_counter() - t, 2)})

    @torch.no_grad()
    def audio_chunks(self, wav: np.ndarray, fps: float) -> torch.Tensor:
        """MuseTalk's AudioProcessor.get_audio_feature + get_whisper_chunk, on an array: (frames, 50, 384)."""
        seg = 30 * SR
        feats = [self.features(wav[i:i + seg], return_tensors="pt", sampling_rate=SR).input_features
                 for i in range(0, max(1, len(wav)), seg)]
        hidden = []
        for f in feats:
            hs = self.whisper.encoder(f.to(self.device, self.dtype), output_hidden_states=True).hidden_states
            hidden.append(torch.stack(hs, dim=2))
        whisper_feature = torch.cat(hidden, dim=1)
        audio_fps, left, right = 50, 2, 2
        mult = audio_fps / fps
        n = math.floor(len(wav) / SR * fps)
        whisper_feature = whisper_feature[:, :math.floor(len(wav) / SR * audio_fps)]
        pad = math.ceil(mult)
        whisper_feature = torch.cat([torch.zeros_like(whisper_feature[:, :pad * left]), whisper_feature,
                                     torch.zeros_like(whisper_feature[:, :pad * 3 * right])], 1)
        per = 2 * (left + right + 1)
        chunks = [whisper_feature[:, math.floor(i * mult): math.floor(i * mult) + per] for i in range(n)]
        out = torch.cat(chunks, dim=0)  # n, 10, 5, 384
        return out.reshape(out.shape[0], -1, out.shape[-1])

    @torch.no_grad()
    def faces(self, av: Avatar, chunks: torch.Tensor, start: int = 0, batch: int = 16):
        """Yields (frame index in the clip, re-drawn 256x256 face or None) for each audio frame, the clip looping on
        from `start`."""
        n = av.n
        for i in range(0, len(chunks), batch):
            idx = [(start + i + k) % n for k in range(min(batch, len(chunks) - i))]
            w = chunks[i:i + len(idx)].to(self.device, self.dtype)
            lat = av.latents[idx].to(self.device, self.dtype)
            pred = self.unet(lat, self.t0, encoder_hidden_states=self.pe(w)).sample
            imgs = self.vae.decode_latents(pred)
            for j, k in enumerate(idx):
                yield k, (imgs[j] if av.boxes[k] is not None else None)

    def render(self, av: Avatar, frames: list[np.ndarray], wav: np.ndarray, start: int = 0, batch: int = 16,
               colour: bool = True):
        """Yields the lip-synced frames (BGR, the clip's size) for a line of audio (16 kHz mono), from loop frame
        `start`. One frame per 1/fps of audio."""
        from concurrent.futures import ThreadPoolExecutor
        chunks = self.audio_chunks(wav, av.fps)
        # Pasting (resize, colour match, blend) is CPU work that would otherwise idle the GPU: OpenCV and NumPy release
        # the GIL, so a few threads paste batch n while the GPU computes batch n+1. Order is kept.
        with ThreadPoolExecutor(max_workers=self.paste_threads) as pool:
            pending = []
            for k, face in self.faces(av, chunks, start, batch):
                pending.append(pool.submit(lambda k=k, face=face: frames[k] if face is None else paste(frames[k], face, av.boxes[k], colour)))
                while len(pending) > 2 * batch:
                    yield pending.pop(0).result()
            for f in pending:
                yield f.result()


def frames_for(n_audio_samples: int, fps: float) -> int:
    return math.floor(n_audio_samples / SR * fps)

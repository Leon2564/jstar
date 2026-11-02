"""MuseTalk 1.5 lip-sync pilot on Apple Silicon (MPS): her talk loop re-mouthed to a voice line, plus a side-by-side.

    .lipsync/venv-muse/bin/python tools/lipsync/musetalk_pilot.py jobs.json [--res 720] [--mask parse|ellipse]

jobs.json: [{"name": "mahiro-talk-hello", "clip": "mahiro-talk-9x16", "audio": "apps/web/public/voice/scene/..."}]
(paths relative to the checkout; "out/..." is under the output folder). Setup: tools/lipsync/setup.sh; results and plan: docs/lipsync.md.

It works like MuseTalk's realtime mode, split in the two phases a server would have:
1. avatar prep, once per clip and cached: frames, face box (face_alignment 68-point landmarks stand in for DWPose, which
   needs mmcv and does not build on macOS), VAE latents of the 256x256 face crop, the blend mask per frame;
2. per sentence: Whisper-tiny audio features -> UNet (one step) -> VAE decode -> paste into the frame -> H.264.

The loop plays forwards (our loops are seamless; MuseTalk's own script ping-pongs). Each phase is timed; timings are
appended to out/timings.jsonl. Outputs (gitignored, never committed): out/<name>-lipsync.mp4 and out/<name>-sbs.mp4
(left: today's loop while the audio plays; right: lip-synced).

--mask parse uses MuseTalk's BiSeNet face parser (weights trained on CelebAMask-HQ, a non-commercial dataset);
--mask ellipse is a feathered ellipse over the lower half of the face box, with no extra model.
--colour shifts the generated face's mean colour back to the original (the VAE pales skin and lips slightly).
"""
from __future__ import annotations

import argparse
import json
import os
import pickle
import subprocess
import sys
import time
from pathlib import Path

import cv2
import numpy as np
import torch

HERE = Path(__file__).resolve().parent
REPO = HERE.parent.parent


def main_checkout() -> Path:
    common = subprocess.check_output(["git", "rev-parse", "--path-format=absolute", "--git-common-dir"],
                                     cwd=HERE, text=True).strip()
    return Path(common).parent


MAIN = main_checkout()
MUSE = Path(os.environ.get("MUSETALK_HOME", MAIN / ".lipsync" / "MuseTalk"))
OUT = Path(os.environ.get("LIPSYNC_OUT", MAIN / "tools" / "lipsync" / "out"))
DEVICE = torch.device("mps" if torch.backends.mps.is_available() else
                      "cuda" if torch.cuda.is_available() else "cpu")
DTYPE = torch.float16 if DEVICE.type != "cpu" else torch.float32
EXTRA_MARGIN = 10  # MuseTalk 1.5 default (px below the chin, at the source resolution)


def sync() -> None:
    if DEVICE.type == "mps":
        torch.mps.synchronize()
    elif DEVICE.type == "cuda":
        torch.cuda.synchronize()


class Timer:
    def __init__(self) -> None:
        self.t: dict[str, float] = {}

    def __call__(self, key: str):
        timer = self

        class _Ctx:
            def __enter__(self):
                sync()
                self.t0 = time.perf_counter()

            def __exit__(self, *exc):
                sync()
                timer.t[key] = timer.t.get(key, 0.0) + time.perf_counter() - self.t0
        return _Ctx()


def clip_path(clip: str, res: int) -> Path:
    d = REPO / "apps" / "web" / "public" / "media" / clip
    want = "h264-720x1280-hq.mp4" if res == 720 else "h264-1080x1920-hq.mp4"
    return d / want


def read_frames(path: Path) -> tuple[list[np.ndarray], float]:
    cap = cv2.VideoCapture(str(path))
    fps = cap.get(cv2.CAP_PROP_FPS)
    frames = []
    while True:
        ok, f = cap.read()
        if not ok:
            break
        frames.append(f)
    cap.release()
    return frames, fps


def face_box(lm: np.ndarray, h: int) -> tuple[int, int, int, int]:
    """MuseTalk's get_landmark_and_bbox, on 68-point landmarks (DWPose face keypoints use the same layout)."""
    lm = lm.astype(np.int32)
    half = lm[29].copy()
    half_dist = np.max(lm[:, 1]) - half[1]
    upper = max(0, half[1] - half_dist)
    x1, y1, x2, y2 = int(np.min(lm[:, 0])), int(upper), int(np.max(lm[:, 0])), int(np.max(lm[:, 1]))
    return x1, y1, x2, min(y2 + EXTRA_MARGIN, h)


def ellipse_mask(box, crop_box: list[int]) -> np.ndarray:
    """Feathered ellipse over mouth, chin and lower cheeks (the lower half of the face box), in crop_box coordinates.
    No face-parsing model: the licence-clean alternative to MuseTalk's BiSeNet mask."""
    x1, y1, x2, y2 = box
    xs, ys, xe, ye = crop_box
    w, h = x2 - x1, y2 - y1
    m = np.zeros((ye - ys, xe - xs), np.uint8)
    centre = (int((x1 + x2) / 2 - xs), int(y1 + 0.66 * h - ys))
    cv2.ellipse(m, centre, (int(0.40 * w), int(0.34 * h)), 0, 0, 360, 255, -1)
    k = int(0.12 * w) // 2 * 2 + 1
    return cv2.GaussianBlur(m, (k, k), 0)


def prepare_avatar(clip: str, res: int, mask_mode: str, models, timer: Timer) -> dict:
    from musetalk.utils.blending import get_image_prepare_material, get_crop_box
    cache = OUT / "avatars" / f"{clip}-{res}-{mask_mode}.pkl"
    if cache.exists():
        with open(cache, "rb") as f:
            return pickle.load(f)
    other = OUT / "avatars" / f"{clip}-{res}-parse.pkl"
    if mask_mode == "ellipse" and other.exists():  # same frames, boxes and latents; only the mask differs
        with open(other, "rb") as f:
            av = pickle.load(f)
        with timer("prep_masks"):
            av["crops"] = [get_crop_box(list(b), 1.5)[0] for b in av["boxes"]]
            av["masks"] = [ellipse_mask(b, c) for b, c in zip(av["boxes"], av["crops"])]
        return av
    import face_alignment

    vae, _, _, _, fp = models
    frames, fps = read_frames(clip_path(clip, res))
    h = frames[0].shape[0]
    with timer("prep_landmarks"):
        fa = face_alignment.FaceAlignment(face_alignment.LandmarksType.TWO_D, flip_input=False,
                                          device="mps" if DEVICE.type == "mps" else "cpu")
        lms = []
        for fr in frames:
            pts = fa.get_landmarks_from_image(fr[:, :, ::-1])
            if not pts:
                raise RuntimeError(f"no face in a frame of {clip}")
            lms.append(pts[0])
        # light temporal smoothing so the paste box does not jitter
        arr = np.stack(lms)
        sm = arr.copy()
        for i in range(len(arr)):
            sm[i] = arr[max(0, i - 1):i + 2].mean(0)
        boxes = [face_box(l, h) for l in sm]
    with timer("prep_latents"):
        latents = []
        for fr, (x1, y1, x2, y2) in zip(frames, boxes):
            crop = cv2.resize(fr[y1:y2, x1:x2], (256, 256), interpolation=cv2.INTER_LANCZOS4)
            latents.append(vae.get_latents_for_unet(crop).cpu())
    with timer("prep_masks"):
        masks, crops = [], []
        for fr, box, lm in zip(frames, boxes, sm):
            if mask_mode == "parse":
                m, cb = get_image_prepare_material(fr, list(box), fp=fp, mode="jaw")
            else:
                cb, _ = get_crop_box(list(box), 1.5)
                m = ellipse_mask(box, cb)
            masks.append(m)
            crops.append(cb)
    av = {"clip": clip, "fps": fps, "frames": frames, "boxes": boxes, "latents": latents, "masks": masks,
          "crops": crops, "face_px": int(np.median([b[2] - b[0] for b in boxes]))}
    cache.parent.mkdir(parents=True, exist_ok=True)
    with open(cache, "wb") as f:
        pickle.dump(av, f)
    return av


def blend(frame: np.ndarray, face: np.ndarray, box, mask: np.ndarray, crop_box) -> np.ndarray:
    """MuseTalk's get_image_blending in numpy (no PIL round trips); handles crop boxes past the frame edge."""
    out = frame.copy()
    x1, y1, x2, y2 = box
    xs, ys, xe, ye = crop_box
    H, W = frame.shape[:2]
    large = np.zeros((ye - ys, xe - xs, 3), np.uint8)
    # source region inside the frame
    sx0, sy0, sx1, sy1 = max(xs, 0), max(ys, 0), min(xe, W), min(ye, H)
    large[sy0 - ys:sy1 - ys, sx0 - xs:sx1 - xs] = frame[sy0:sy1, sx0:sx1]
    large[y1 - ys:y2 - ys, x1 - xs:x2 - xs] = face
    a = (mask.astype(np.float32) / 255.0)[..., None]
    region = out[sy0:sy1, sx0:sx1].astype(np.float32)
    lg = large[sy0 - ys:sy1 - ys, sx0 - xs:sx1 - xs].astype(np.float32)
    am = a[sy0 - ys:sy1 - ys, sx0 - xs:sx1 - xs]
    out[sy0:sy1, sx0:sx1] = (lg * am + region * (1 - am)).astype(np.uint8)
    return out


def match_colour(face: np.ndarray, orig: np.ndarray) -> np.ndarray:
    """Shift the generated face's mean Lab colour to the original's, measured on the cheeks and chin around the mouth
    (the mouth itself is left out: an open mouth is meant to be darker). Undoes the VAE's slight paling of skin and lips."""
    h, w = face.shape[:2]
    ring = np.zeros((h, w), np.uint8)
    ring[h // 2:, :] = 255
    cv2.ellipse(ring, (w // 2, int(0.72 * h)), (int(0.24 * w), int(0.14 * h)), 0, 0, 360, 0, -1)
    sel = ring > 0
    fl = cv2.cvtColor(face, cv2.COLOR_BGR2LAB).astype(np.float32)
    ol = cv2.cvtColor(orig, cv2.COLOR_BGR2LAB).astype(np.float32)
    fl += ol[sel].mean(0) - fl[sel].mean(0)
    return cv2.cvtColor(np.clip(fl, 0, 255).astype(np.uint8), cv2.COLOR_LAB2BGR)


def label(img: np.ndarray, text: str) -> np.ndarray:
    img = img.copy()
    h, w = img.shape[:2]
    s = w / 720
    cv2.rectangle(img, (0, 0), (w, int(54 * s)), (0, 0, 0), -1)
    cv2.putText(img, text, (int(16 * s), int(38 * s)), cv2.FONT_HERSHEY_SIMPLEX, 1.0 * s, (255, 255, 255),
                max(1, int(2 * s)), cv2.LINE_AA)
    return img


def ffmpeg_writer(path: Path, w: int, h: int, fps: float, audio: Path, offset_frames: int = 0):
    cmd = ["ffmpeg", "-y", "-v", "error", "-f", "rawvideo", "-pix_fmt", "bgr24", "-s", f"{w}x{h}", "-r", str(fps),
           "-i", "-", "-i", str(audio), "-map", "0:v", "-map", "1:a", "-c:v", "libx264", "-preset", "veryfast",
           "-crf", "18", "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "160k", "-shortest", "-movflags", "+faststart",
           str(path)]
    return subprocess.Popen(cmd, stdin=subprocess.PIPE)


def load_models(mask_mode: str):
    os.chdir(MUSE)
    sys.path.insert(0, str(MUSE))
    from transformers import WhisperModel
    from musetalk.utils.utils import load_all_model
    from musetalk.utils.audio_processor import AudioProcessor
    vae, unet, pe = load_all_model(unet_model_path="models/musetalkV15/unet.pth", vae_type="sd-vae",
                                   unet_config="models/musetalkV15/musetalk.json", device=DEVICE)
    vae.vae = vae.vae.to(DEVICE, DTYPE)
    vae.device = DEVICE
    unet.model = unet.model.to(DEVICE, DTYPE)
    pe = pe.to(DEVICE, DTYPE)
    ap = AudioProcessor(feature_extractor_path="models/whisper")
    whisper = WhisperModel.from_pretrained("models/whisper").to(DEVICE, DTYPE).eval()
    fp = None
    if mask_mode == "parse":
        from musetalk.utils.face_parsing import FaceParsing
        fp = FaceParsing(left_cheek_width=90, right_cheek_width=90)
    return vae, unet, pe, (ap, whisper), fp


@torch.no_grad()
def run_job(job: dict, models, res: int, mask_mode: str, batch: int, colour: bool = False) -> dict:
    vae, unet, pe, (ap, whisper), _ = models
    timer = Timer()
    t_all = time.perf_counter()
    av = prepare_avatar(job["clip"], res, mask_mode, models, timer)
    prep = {k: round(v, 2) for k, v in timer.t.items()}
    timer.t.clear()

    a = job["audio"]
    audio = OUT / a[4:] if a.startswith("out/") else Path(a) if Path(a).is_absolute() else REPO / a
    fps = av["fps"]
    t_sentence = time.perf_counter()
    with timer("audio_features"):
        feats, n = ap.get_audio_feature(str(audio))
        chunks = ap.get_whisper_chunk(feats, DEVICE, DTYPE, whisper, n, fps=fps,
                                      audio_padding_length_left=2, audio_padding_length_right=2)
    seconds = n / 16000
    N = len(av["frames"])
    timesteps = torch.tensor([0], device=DEVICE)
    faces = []
    with timer("unet_vae"):
        for i in range(0, len(chunks), batch):
            w = chunks[i:i + batch].to(DEVICE)
            lat = torch.cat([av["latents"][(i + k) % N] for k in range(len(w))]).to(DEVICE, DTYPE)
            pred = unet.model(lat, timesteps, encoder_hidden_states=pe(w)).sample
            faces.extend(vae.decode_latents(pred))
    H, W = av["frames"][0].shape[:2]
    name = job["name"] + ("" if mask_mode == "parse" and not colour else f"-{mask_mode}" + ("-cm" if colour else ""))
    tag = "MuseTalk 1.5" + ("" if mask_mode == "parse" else " +ellipse") + (" +colour" if colour else "")
    OUT.mkdir(parents=True, exist_ok=True)
    lip = ffmpeg_writer(OUT / f"{name}-lipsync.mp4", W, H, fps, audio)
    sbs = ffmpeg_writer(OUT / f"{name}-sbs.mp4", W * 2, H, fps, audio)
    with timer("blend_encode"):
        for i, face in enumerate(faces):
            j = i % N
            x1, y1, x2, y2 = av["boxes"][j]
            f = cv2.resize(face, (x2 - x1, y2 - y1), interpolation=cv2.INTER_LANCZOS4)
            if colour:
                f = match_colour(f, av["frames"][j][y1:y2, x1:x2])
            out = blend(av["frames"][j], f, av["boxes"][j], av["masks"][j], av["crops"][j])
            lip.stdin.write(out.tobytes())
            sbs.stdin.write(np.hstack([label(av["frames"][j], "today: loop + audio"),
                                       label(out, tag)]).tobytes())
        lip.stdin.close()
        sbs.stdin.close()
        lip.wait()
        sbs.wait()
    sentence = time.perf_counter() - t_sentence
    rec = {"name": name, "clip": job["clip"], "audio": job["audio"], "res": res, "mask": mask_mode, "colour": colour,
           "device": DEVICE.type, "audio_s": round(seconds, 2), "frames": len(faces), "face_px": av["face_px"],
           "prep_s": prep, "sentence_s": {k: round(v, 2) for k, v in timer.t.items()},
           "sentence_total_s": round(sentence, 2), "per_audio_second": round(sentence / seconds, 2),
           "model_only_per_audio_second": round((timer.t["audio_features"] + timer.t["unet_vae"]) / seconds, 2),
           "wall_s": round(time.perf_counter() - t_all, 2)}
    with open(OUT / "timings.jsonl", "a") as f:
        f.write(json.dumps(rec) + "\n")
    print(json.dumps(rec), flush=True)
    return rec


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("jobs")
    ap.add_argument("--res", type=int, default=720, choices=[720, 1080])
    ap.add_argument("--mask", default="parse", choices=["parse", "ellipse"])
    ap.add_argument("--batch", type=int, default=8)
    ap.add_argument("--only", default="", help="comma-separated name fragments")
    ap.add_argument("--colour", action="store_true", help="match the generated face's mean colour to the original")
    a = ap.parse_args()
    jobs = json.loads(Path(a.jobs).resolve().read_text())
    t0 = time.perf_counter()
    models = load_models(a.mask)
    print(f"[load] {time.perf_counter() - t0:.1f}s on {DEVICE}", flush=True)
    for job in jobs:
        if a.only and not any(o in job["name"] for o in a.only.split(",")):
            continue
        run_job(job, models, a.res, a.mask, a.batch, a.colour)


if __name__ == "__main__":
    main()

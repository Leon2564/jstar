"""Master picked takes into the shipped MP3s.

    .voice/venv-prep/bin/python tools/voice/post.py [--picks PATH]

Per take: trim leading/trailing silence (keep 60 ms / 120 ms pads, 10 ms fades),
normalise to -16 LUFS integrated (pyloudnorm), limit peaks to -1.5 dBFS, encode
mono MP3 48 kbps CBR (LAME, 24 kHz: at 48 kbps LAME low-passes voice ~11 kHz
anyway, so 24 kHz spends the bits on the voice). Verifies loudness and length
of the encoded file and writes a manifest line per output.
Output: apps/web/public/voice/<id>.mp3 or apps/web/public/voice/greet/<star>-<slot>.mp3
(ids starting with "greet/").
"""
from __future__ import annotations

import argparse
import json
import subprocess
import tempfile
from pathlib import Path

import numpy as np
import pyloudnorm as pyln
import soundfile as sf

from common import PUBLIC_VOICE, REPO, WORK

TARGET_LUFS = -16.0
PEAK = 10 ** (-1.5 / 20)
MAX_S = 12.0


def trim(x: np.ndarray, sr: int) -> np.ndarray:
    thr = 10 ** (-42 / 20) * max(np.abs(x).max(), 1e-6)
    win = int(0.01 * sr)
    env = np.sqrt(np.convolve(x ** 2, np.ones(win) / win, mode="same"))
    idx = np.where(env > thr)[0]
    if not len(idx):
        return x
    s = max(0, idx[0] - int(0.06 * sr))
    e = min(len(x), idx[-1] + int(0.12 * sr))
    y = x[s:e].copy()
    f = int(0.01 * sr)
    y[:f] *= np.linspace(0, 1, f)
    y[-f:] *= np.linspace(1, 0, f)
    return y


def soft_limit(x: np.ndarray) -> np.ndarray:
    """Transparent for |x| < 0.7*PEAK, smooth tanh knee above, hard ceiling at PEAK."""
    knee = 0.7 * PEAK
    y = x.copy()
    over = np.abs(y) > knee
    y[over] = np.sign(y[over]) * (knee + (PEAK - knee) * np.tanh((np.abs(y[over]) - knee) / (PEAK - knee)))
    return y


def master(wav: str) -> tuple[np.ndarray, int]:
    x, sr = sf.read(wav, dtype="float64", always_2d=True)
    x = trim(x.mean(axis=1), sr)
    meter = pyln.Meter(sr, block_size=min(0.4, len(x) / sr / 2))
    for _ in range(3):  # gain -> limit -> re-measure (limiting lowers loudness slightly)
        x = x * 10 ** ((TARGET_LUFS - meter.integrated_loudness(x)) / 20)
        x = soft_limit(x)
    return x.astype(np.float32), sr


def encode(x: np.ndarray, sr: int, out: Path) -> None:
    out.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.NamedTemporaryFile(suffix=".wav") as t:
        sf.write(t.name, x, sr, subtype="FLOAT")
        subprocess.run(["ffmpeg", "-y", "-loglevel", "error", "-i", t.name, "-ac", "1", "-ar", "24000",
                        "-codec:a", "libmp3lame", "-b:a", "48k", "-map_metadata", "-1", str(out)],
                       check=True)


def measure(mp3: Path) -> dict:
    r = subprocess.run(["ffmpeg", "-hide_banner", "-nostats", "-i", str(mp3), "-af", "ebur128=peak=true",
                        "-f", "null", "-"], capture_output=True, text=True).stderr
    summ = r[r.rfind("Summary:"):]
    lufs = float(summ.split("I:")[1].split("LUFS")[0])
    tp = float(summ.split("Peak:")[1].split("dBFS")[0]) if "Peak:" in summ else None
    dur = float(subprocess.check_output(["ffprobe", "-v", "error", "-show_entries", "format=duration",
                                         "-of", "csv=p=0", str(mp3)], text=True))
    return {"lufs": lufs, "true_peak_db": tp, "dur": round(dur, 2)}


def out_path(id_: str, root: Path = PUBLIC_VOICE) -> Path:
    return root / f"{id_}.mp3"


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--picks", default=str(WORK / "picks.jsonl"))
    ap.add_argument("--out-root", default=str(PUBLIC_VOICE), help="for dry runs")
    a = ap.parse_args()
    root = Path(a.out_root)
    rows = [json.loads(l) for l in open(a.picks, encoding="utf-8") if l.strip()]
    log = open(WORK / "mastered.jsonl", "a", encoding="utf-8")
    bad = 0
    for r in rows:
        x, sr = master(r["wav"])
        out = out_path(r["id"], root)
        encode(x, sr, out)
        m = measure(out)
        ok = abs(m["lufs"] - TARGET_LUFS) <= 1.0 and m["dur"] <= MAX_S
        bad += not ok
        log.write(json.dumps({"id": r["id"], "out": str(out.relative_to(REPO)) if out.is_relative_to(REPO) else str(out),
                              **m, "ok": ok}, ensure_ascii=False) + "\n")
        print(f"{'ok ' if ok else 'BAD'} {r['id']} {m}")
    log.close()
    print(f"mastered {len(rows)} ({bad} out of spec)")


if __name__ == "__main__":
    main()

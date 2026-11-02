"""Data prep: loudness-normalise each talent's recording, slice it into
utterances with Silero VAD, and transcribe every slice with local Whisper (MLX).

    .voice/venv-prep/bin/python tools/voice/prep.py [star ...]

Writes .voice/data/<star>/{norm.wav, clips/NNNN.wav, manifest.jsonl}.
One star at a time; the Whisper model is loaded once and freed at exit.
"""
from __future__ import annotations

import gc
import json
import sys

import numpy as np
import pyloudnorm as pyln
import soundfile as sf
from scipy.signal import resample_poly

from common import DATA, STARS, local_model, source_wav

SR = 48000
TARGET_LUFS = -20.0
MIN_S, MAX_S = 1.5, 12.0
WHISPER = str(local_model("asr"))


def soft_limit(x: np.ndarray, ceil: float = 0.89) -> np.ndarray:
    knee = 0.7 * ceil
    y = x.copy()
    o = np.abs(y) > knee
    y[o] = np.sign(y[o]) * (knee + (ceil - knee) * np.tanh((np.abs(y[o]) - knee) / (ceil - knee)))
    return y


def normalise(x: np.ndarray, sr: int) -> np.ndarray:
    """Robust global gain. Integrated loudness is unusable here: the recordings
    are very quiet (~-50 dBFS speech) with rare loud bumps/handling noise, and a
    single bump dominates the gated measurement. Instead bring the 95th
    percentile of 50 ms speech-frame RMS to -20 dBFS, then soft-limit bumps."""
    x = x.astype(np.float64)
    x = x - x.mean()  # DC
    w = int(0.05 * sr)
    n = len(x) // w
    rms = np.sqrt((x[: n * w].reshape(n, w) ** 2).mean(axis=1)) + 1e-12
    db = 20 * np.log10(rms)
    active = db[db > np.percentile(db, 40)]  # drop the silent 40 %
    gain_db = -20.0 - np.percentile(active, 95)
    y = soft_limit(x * 10 ** (gain_db / 20))
    print(f"  gain {gain_db:+.1f} dB", flush=True)
    return y.astype(np.float32)


def clip_normalise(seg: np.ndarray) -> np.ndarray:
    """Per-utterance loudness to TARGET_LUFS so every slice has the same level."""
    meter = pyln.Meter(SR, block_size=min(0.4, len(seg) / SR / 2))
    loud = meter.integrated_loudness(seg.astype(np.float64))
    if not np.isfinite(loud):
        return seg
    return soft_limit(seg * 10 ** ((TARGET_LUFS - loud) / 20)).astype(np.float32)


def vad_segments(x48: np.ndarray) -> list[tuple[int, int]]:
    """Speech spans (in 48 kHz samples), merged/split to MIN_S..MAX_S."""
    import torch
    from silero_vad import get_speech_timestamps, load_silero_vad

    model = load_silero_vad()
    x16 = resample_poly(x48, 1, 3).astype(np.float32)
    ts = get_speech_timestamps(
        torch.from_numpy(x16), model, sampling_rate=16000,
        min_silence_duration_ms=350, speech_pad_ms=120,
        max_speech_duration_s=MAX_S, return_seconds=False)
    del model
    spans = [(t["start"] * 3, t["end"] * 3) for t in ts]
    # merge short neighbours separated by short gaps
    merged: list[list[int]] = []
    for s, e in spans:
        if merged and (e - merged[-1][0]) <= 10.0 * SR and (s - merged[-1][1]) < 0.5 * SR:
            merged[-1][1] = e
        else:
            merged.append([s, e])
    return [(s, e) for s, e in merged if MIN_S * SR <= (e - s) <= MAX_S * SR]


def main(stars: list[str]) -> None:
    import mlx_whisper

    for star in stars:
        out = DATA / star
        clips = out / "clips"
        clips.mkdir(parents=True, exist_ok=True)
        for old in clips.glob("*.wav"):
            old.unlink()
        x, sr = sf.read(source_wav(star), dtype="float32", always_2d=True)
        x = x.mean(axis=1)
        if sr != SR:
            x = resample_poly(x, SR, sr).astype(np.float32)
        y = normalise(x, SR)
        sf.write(out / "norm.wav", y, SR, subtype="PCM_16")
        segs = vad_segments(y)
        print(f"[{star}] {len(y)/SR/60:.1f} min, {len(segs)} segments", flush=True)
        rows = []
        for i, (s, e) in enumerate(segs):
            raw = y[s:e]
            crest_db = float(20 * np.log10(np.abs(raw).max() / (np.sqrt(np.mean(raw ** 2)) + 1e-9)))
            level_db = float(20 * np.log10(np.sqrt(np.mean(raw ** 2)) + 1e-9))
            seg = clip_normalise(raw)
            path = clips / f"{i:04d}.wav"
            sf.write(path, seg, SR, subtype="PCM_16")
            r = mlx_whisper.transcribe(
                resample_poly(seg, 1, 3).astype(np.float32), path_or_hf_repo=WHISPER,
                language="ja", condition_on_previous_text=False, temperature=0.0)
            text = r["text"].strip()
            segs_ = r.get("segments") or [{}]
            rows.append({
                "path": str(path), "start": s / SR, "dur": (e - s) / SR, "text": text,
                "avg_logprob": float(np.mean([g.get("avg_logprob", -9) for g in segs_])),
                "no_speech_prob": float(np.max([g.get("no_speech_prob", 1) for g in segs_])),
                "rms_db": level_db,      # level before per-clip normalisation
                "crest_db": crest_db,    # high = bump/handling noise inside the clip
            })
            if i % 25 == 0:
                print(f"  {i}/{len(segs)}", flush=True)
        with open(out / "manifest.jsonl", "w", encoding="utf-8") as f:
            for r in rows:
                f.write(json.dumps(r, ensure_ascii=False) + "\n")
        print(f"[{star}] wrote {len(rows)} clips", flush=True)
        gc.collect()


if __name__ == "__main__":
    main(sys.argv[1:] or STARS)

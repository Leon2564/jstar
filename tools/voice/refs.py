"""Pick reference clips (for cloning) and held-out clips (for likeness scoring)
from a talent's prepared manifest. Deterministic: same manifest -> same split."""
from __future__ import annotations

import json
from pathlib import Path

from common import DATA


def load_manifest(star: str) -> list[dict]:
    with open(DATA / star / "manifest.jsonl", encoding="utf-8") as f:
        return [json.loads(l) for l in f if l.strip()]


def _clean(rows: list[dict]) -> list[dict]:
    """Clips of the talent's own voice (speakers.py: dominant-voice similarity),
    which Whisper understood confidently, without bumps, of usable length."""
    return [r for r in rows
            if r.get("spk_sim", 1.0) >= 0.6 and r["avg_logprob"] > -0.6
            and r["no_speech_prob"] < 0.3 and 1.8 <= r["dur"] <= 11.0
            and len(r["text"]) >= 5 and r.get("crest_db", 0) < 24]


def split(star: str) -> tuple[list[dict], list[dict]]:
    """(reference pool, held-out eval pool): every 4th clean clip is held out."""
    ok = sorted(_clean(load_manifest(star)), key=lambda r: r["path"])
    held = ok[::4]
    pool = [r for i, r in enumerate(ok) if i % 4 != 0]
    return pool, held


def reference_clips(star: str, seconds: float = 60.0) -> list[Path]:
    """Most confident clips from the reference pool, spread over the recording,
    until `seconds` of audio is reached (Irodori v4 trained with concatenated
    short utterances; ~30 s captures most of the gain, 120 s is the cap)."""
    pool, _ = split(star)
    pool = sorted(pool, key=lambda r: -r["avg_logprob"])
    chosen, total = [], 0.0
    for r in pool:
        if total >= seconds:
            break
        chosen.append(r)
        total += r["dur"]
    chosen.sort(key=lambda r: r["start"])
    return [clip_path(r) for r in chosen]


def heldout_clips(star: str, n: int = 12) -> list[Path]:
    _, held = split(star)
    return [clip_path(r) for r in held[:n]]


def clip_path(r: dict) -> Path:
    """Denoised clip (denoise.py) when available, else the raw slice."""
    return Path(r.get("path_df") or r["path"])

"""Shared paths and helpers for the local voice pipeline.

Everything private (recordings, slices, transcripts, model weights) lives in the
main checkout's gitignored `.voice/` and `assets/agency/` trees and never leaves
this machine. Outputs that ship with the app go to `apps/web/public/voice/`.
"""
from __future__ import annotations

import json
import os
import subprocess
from pathlib import Path

STARS = ["mahiro", "nana", "unpai", "alice", "eimi"]
SLOTS = ["morning", "day", "evening", "night", "welcome", "return", "levelup", "gacha-ssr"]

TOOLS_DIR = Path(__file__).resolve().parent
REPO = TOOLS_DIR.parent.parent  # this checkout (worktree or main)


def _main_checkout() -> Path:
    """The main checkout (worktrees share it), where private material lives."""
    try:
        common = subprocess.check_output(
            ["git", "rev-parse", "--path-format=absolute", "--git-common-dir"],
            cwd=TOOLS_DIR, text=True).strip()
        return Path(common).parent
    except Exception:
        return REPO


MAIN = _main_checkout()
VOICE_HOME = Path(os.environ.get("JSTAR_VOICE_HOME", MAIN / ".voice"))
AGENCY = Path(os.environ.get("JSTAR_AGENCY", MAIN / "assets" / "agency"))
DATA = VOICE_HOME / "data"          # per-star slices + manifest
WORK = VOICE_HOME / "work"          # raw generations, candidates, eval logs
PUBLIC_VOICE = REPO / "apps" / "web" / "public" / "voice"
# Which models the voice pipeline runs: config/models.json (the one place every model is named).
MODELS = json.loads((REPO / "config" / "models.json").read_text(encoding="utf-8"))["voice"]


def local_model(role: str) -> Path:
    """Local weights for a voice role ("tts", "asr", "speaker"), fetched with fetch_hf.sh into .voice/models/<repo>."""
    return VOICE_HOME / "models" / MODELS[role]["model"]


def source_wav(star: str) -> Path:
    wavs = sorted((AGENCY / star).glob("*.wav"))
    if not wavs:
        raise FileNotFoundError(f"no recording for {star} in {AGENCY / star}")
    return wavs[0]


def rss_mb() -> float:
    """Resident memory of this process in MB (macOS ru_maxrss is bytes)."""
    import resource
    return resource.getrusage(resource.RUSAGE_SELF).ru_maxrss / 1e6

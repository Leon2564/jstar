"""Delivery likeness: compare pitch and speaking rate of generated takes with the
talent's real (denoised) clips. Timbre is scored by qa.py (ECAPA); this catches
"right voice, wrong delivery" (too fast/slow, flat or wrong pitch register).

    .voice/venv-prep/bin/python tools/voice/prosody.py [--tags -iro-df,-qwen-df]

Per take: median F0 (semitones re 100 Hz), F0 spread (IQR, semitones),
speaking rate (kana morae per voiced second). Reports |take - real| per talent.
"""
from __future__ import annotations

import argparse
import json

import librosa
import numpy as np

from common import STARS, WORK
from qa import kana, load16, read_jsonl
from refs import clip_path, split


def feats(path: str, text: str) -> dict:
    x = load16(path)
    f0, vflag, _ = librosa.pyin(x, fmin=110, fmax=700, sr=16000, frame_length=1024, hop_length=160)
    f0 = f0[vflag & np.isfinite(f0)]
    st = 12 * np.log2(f0 / 100.0) if len(f0) else np.array([np.nan])
    # speaking rate: kana count over the span between first and last energetic frame
    rms = librosa.feature.rms(y=x, frame_length=400, hop_length=160)[0]
    act = np.where(rms > rms.max() * 10 ** (-30 / 20))[0]
    span = (act[-1] - act[0] + 1) * 0.01 if len(act) else len(x) / 16000
    return {"f0_med": float(np.nanmedian(st)),
            "f0_iqr": float(np.nanpercentile(st, 75) - np.nanpercentile(st, 25)),
            "rate": len(kana(text)) / max(span, 0.3)}


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--tags", default=None)
    a = ap.parse_args()
    real = {}
    for s in STARS:
        pool, held = split(s)
        fs = [feats(str(clip_path(r)), r["text"]) for r in (pool + held)[:30]]
        real[s] = {k: float(np.nanmedian([f[k] for f in fs])) for k in fs[0]}
    rows = read_jsonl(WORK / "cands" / "scores.jsonl")
    tags = a.tags.split(",") if a.tags else sorted({r.get("tag", "") for r in rows})
    out = {"real": real, "tags": {}}
    print(f"{'':16}" + "".join(f"{s:>22}" for s in STARS))
    print(f"{'real f0/iqr/rate':16}" + "".join(
        f"{real[s]['f0_med']:8.1f}{real[s]['f0_iqr']:6.1f}{real[s]['rate']:7.1f} " for s in STARS))
    for t in tags:
        line, agg = f"{t:16}", {}
        for s in STARS:
            rs = [r for r in rows if r.get("tag", "") == t and r["star"] == s]
            if not rs:
                line += f"{'-':>22}"
                continue
            fs = [feats(r["wav"], r["text"]) for r in rs]
            m = {k: float(np.nanmedian([f[k] for f in fs])) for k in fs[0]}
            agg[s] = m
            line += f"{m['f0_med']:8.1f}{m['f0_iqr']:6.1f}{m['rate']:7.1f} "
        out["tags"][t] = agg
        err = [abs(agg[s]["f0_med"] - real[s]["f0_med"]) for s in agg]
        rerr = [abs(agg[s]["rate"] / real[s]["rate"] - 1) for s in agg]
        print(line + f"  |dF0|={np.mean(err):.2f}st |rate err|={100 * np.mean(rerr):.0f}%")
    json.dump(out, open(WORK / "prosody.json", "w"), indent=1)


if __name__ == "__main__":
    main()

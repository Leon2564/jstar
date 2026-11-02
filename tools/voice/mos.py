"""Naturalness proxy: UTMOSv2 predicted MOS (sarulab-speech, MIT) for takes and
for the talent's real denoised clips. Used in the model evaluation only.

    .voice/venv-mos/bin/python tools/voice/mos.py [--tags -iro-df,-qwen-df]

UTMOSv2 was trained mostly on English listening tests, so absolute values on
Japanese are indicative; the comparison between systems is what matters.
"""
from __future__ import annotations

import argparse
import json
from collections import defaultdict

import numpy as np

from common import STARS, VOICE_HOME, WORK
from refs import clip_path, split


def read_jsonl(p):
    return [json.loads(l) for l in open(p, encoding="utf-8") if l.strip()]


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--tags", default=None)
    a = ap.parse_args()
    import utmosv2
    model = utmosv2.create_model(
        pretrained=True, device="cpu",
        checkpoint_path=str(VOICE_HOME / "utmos" / "models" / "fusion_stage3" / "fold0_s42_best_model.pth"))

    def mos(path: str) -> float:
        return float(model.predict(input_path=path, device="cpu", verbose=False))

    out = {"real": {}, "tags": defaultdict(dict)}
    for s in STARS:
        pool, held = split(s)
        out["real"][s] = float(np.mean([mos(str(clip_path(r))) for r in (pool + held)[:12]]))
    rows = read_jsonl(WORK / "cands" / "scores.jsonl")
    tags = a.tags.split(",") if a.tags else sorted({r.get("tag", "") for r in rows})
    for t in tags:
        for s in STARS:
            rs = [r for r in rows if r.get("tag", "") == t and r["star"] == s]
            if rs:
                out["tags"][t][s] = float(np.mean([mos(r["wav"]) for r in rs]))
    print(f"{'':16}" + "".join(f"{s:>8}" for s in STARS) + "     mean")
    print(f"{'real (df)':16}" + "".join(f"{out['real'][s]:8.2f}" for s in STARS)
          + f"  {np.mean(list(out['real'].values())):7.2f}")
    for t, d in out["tags"].items():
        print(f"{t:16}" + "".join(f"{d.get(s, np.nan):8.2f}" for s in STARS) + f"  {np.mean(list(d.values())):7.2f}")
    json.dump(out, open(WORK / "mos.json", "w"), indent=1)


if __name__ == "__main__":
    main()

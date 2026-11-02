"""Tag every prepared clip with its similarity to the talent's dominant voice.

    .voice/venv-prep/bin/python tools/voice/speakers.py [star ...]

Recordings can contain other voices (staff, interviewer) or non-speech. We embed
each (denoised) clip with ECAPA, take the dominant cluster (iteratively re-centred on
the clips closest to the centroid), and write `spk_sim` into manifest.jsonl.
refs.py only uses clips close to the dominant voice as references / held-out.
"""
from __future__ import annotations

import json
import sys

import numpy as np

from common import DATA, STARS
from qa import Embedder, load16


def main(stars: list[str]) -> None:
    emb = Embedder("ecapa")
    for star in stars:
        man = DATA / star / "manifest.jsonl"
        rows = [json.loads(l) for l in open(man, encoding="utf-8") if l.strip()]
        E = np.stack([emb(load16(r.get("path_df") or r["path"])) for r in rows])
        c = np.median(E, axis=0)
        for _ in range(5):
            c = c / np.linalg.norm(c)
            s = E @ c
            core = s >= np.percentile(s, 40)  # re-centre on the closest 60 %
            c = E[core].mean(axis=0)
        c = c / np.linalg.norm(c)
        s = E @ c
        for r, v in zip(rows, s):
            r["spk_sim"] = round(float(v), 4)
        with open(man, "w", encoding="utf-8") as f:
            for r in rows:
                f.write(json.dumps(r, ensure_ascii=False) + "\n")
        hist = np.histogram(s, bins=[-1, 0.3, 0.4, 0.5, 0.6, 0.7, 1.01])[0]
        print(f"[{star}] spk_sim bins <.3/.3/.4/.5/.6/.7+: {hist.tolist()}", flush=True)


if __name__ == "__main__":
    main(sys.argv[1:] or STARS)

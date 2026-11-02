"""Speech enhancement of the prepared clips with DeepFilterNet3 (local, CPU).

    .voice/venv-df/bin/python tools/voice/denoise.py [star ...]

The agency recordings are quiet with a strong noise/background floor (after the
+9..+18 dB gain the floor sits only 15-30 dB under the voice). Zero-shot cloners
copy the reference acoustics, so references are denoised first. Writes
.voice/data/<star>/clips_df/NNNN.wav (48 kHz) and adds `path_df` to the manifest.
"""
from __future__ import annotations

import json
import sys

from df.enhance import enhance, init_df, load_audio, save_audio

from common import DATA, STARS


def main(stars: list[str]) -> None:
    model, st, _ = init_df()  # DeepFilterNet3, fetched from the official GitHub release
    for star in stars:
        man = DATA / star / "manifest.jsonl"
        rows = [json.loads(l) for l in open(man, encoding="utf-8") if l.strip()]
        out = DATA / star / "clips_df"
        out.mkdir(exist_ok=True)
        for r in rows:
            dst = out / (r["path"].rsplit("/", 1)[-1])
            audio, _ = load_audio(r["path"], sr=st.sr())
            save_audio(str(dst), enhance(model, st, audio), st.sr())
            r["path_df"] = str(dst)
        with open(man, "w", encoding="utf-8") as f:
            for r in rows:
                f.write(json.dumps(r, ensure_ascii=False) + "\n")
        print(f"[{star}] denoised {len(rows)} clips", flush=True)


if __name__ == "__main__":
    main(sys.argv[1:] or STARS)

"""Production backend: Qwen3-TTS-12Hz-1.7B-Base voice clone (ICL mode), local on MPS.
Chosen in the evaluation (REPORT.md); synth_irodori.py is the runner-up.

    .voice/venv-qwen/bin/python tools/voice/synth_qwen.py JOBS.jsonl [--cands 3] [--seed-base 1000]

Reference = ~30 s of the talent's cleanest own-voice clips (denoised, speaker-
verified; refs.py) concatenated with 250 ms gaps, with their Whisper transcripts
as ref_text (ICL mode needs the transcript). The prompt is built once per talent.
Candidates: .voice/work/cands/<id><tag>__s<seed>.wav, logged in index.jsonl.
"""
from __future__ import annotations

import argparse
import gc
import json
import time
from collections import defaultdict

import numpy as np
import soundfile as sf
import torch

from common import WORK, local_model, rss_mb
from refs import load_manifest, reference_clips

MODEL = local_model("tts")


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("jobs")
    ap.add_argument("--cands", type=int, default=3)
    ap.add_argument("--ref-seconds", type=float, default=30.0)
    ap.add_argument("--seed-base", type=int, default=1000)
    ap.add_argument("--tag", default="")
    a = ap.parse_args()

    from qwen_tts import Qwen3TTSModel
    t0 = time.time()
    tts = Qwen3TTSModel.from_pretrained(str(MODEL), device_map="mps", dtype=torch.bfloat16)
    print(f"[load] {time.time() - t0:.1f}s rss={rss_mb():.0f}MB", flush=True)

    jobs = [json.loads(l) for l in open(a.jobs, encoding="utf-8") if l.strip()]
    by_star = defaultdict(list)
    for j in jobs:
        by_star[j["star"]].append(j)
    out_dir = WORK / "cands"
    out_dir.mkdir(parents=True, exist_ok=True)
    index = open(out_dir / "index.jsonl", "a", encoding="utf-8")
    for star, rows in by_star.items():
        texts = {k: r["text"] for r in load_manifest(star) for k in (r["path"], r.get("path_df"))}
        clips = reference_clips(star, a.ref_seconds)
        wav = np.concatenate([np.concatenate([sf.read(p, dtype="float32")[0],
                                              np.zeros(int(0.25 * 48000), np.float32)]) for p in clips])
        ref_text = "".join(texts[str(p)] for p in clips)
        prompt = tts.create_voice_clone_prompt(ref_audio=(wav, 48000), ref_text=ref_text)
        for j in rows:
            t1 = time.time()
            for k in range(a.cands):
                seed = a.seed_base + k
                torch.manual_seed(seed)
                audios, sr = tts.generate_voice_clone(text=j["text"], language="Japanese",
                                                      voice_clone_prompt=prompt, max_new_tokens=240)
                path = out_dir / f"{j['id']}{a.tag}__s{seed}.wav"
                path.parent.mkdir(parents=True, exist_ok=True)
                sf.write(path, audios[0], sr)
                index.write(json.dumps({"id": j["id"], "star": star, "text": j["text"], "k": k,
                                        "seed": seed, "tag": a.tag, "wav": str(path),
                                        "backend": MODEL.name.lower(),
                                        "ref_seconds": a.ref_seconds}, ensure_ascii=False) + "\n")
            index.flush()
            print(f"[{j['id']}] {time.time() - t1:.1f}s rss={rss_mb():.0f}MB", flush=True)
        gc.collect()
        torch.mps.empty_cache()
    index.close()


if __name__ == "__main__":
    main()

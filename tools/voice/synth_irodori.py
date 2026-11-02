"""Generate candidate takes with Irodori-TTS v4.1-Small (zero-shot, multi-reference).

    .voice/venv-irodori/bin/python tools/voice/synth_irodori.py JOBS.jsonl [--cands 3]

JOBS.jsonl rows: {"id": "...", "star": "mahiro", "text": "...", "seed"?: int}
Writes .voice/work/cands/<id>__<k>.wav (48 kHz) and appends rows to
.voice/work/cands/index.jsonl. Rows are grouped by star; one model instance is
loaded for the whole run and each star's reference latents are encoded once.
"""
from __future__ import annotations

import argparse
import gc
import json
import sys
import time
from collections import defaultdict
from pathlib import Path

from common import VOICE_HOME, WORK, rss_mb
from refs import reference_clips

IRODORI_SRC = VOICE_HOME / "src" / "Irodori-TTS-main"
sys.path.insert(0, str(IRODORI_SRC))

import torch  # noqa: E402
from irodori_tts.inference_runtime import (  # noqa: E402
    InferenceRuntime, RuntimeKey, SamplingRequest, _load_audio, save_wav)

CKPT = VOICE_HOME / "models" / "Aratako" / "Irodori-TTS-v4.1-Small" / "model.safetensors"
CODEC = VOICE_HOME / "models" / "Aratako" / "Semantic-DACVAE-Japanese-32dim" / "weights.pth"

# Settings chosen in the evaluation (REPORT.md). Speaker CFG a bit above default
# for likeness; text CFG default; 40 RF steps.
SETTINGS = dict(cfg_scale_text=3.0, cfg_scale_speaker=5.0, num_steps=40)


def load_runtime(device: str, precision: str) -> InferenceRuntime:
    return InferenceRuntime.from_key(RuntimeKey(
        checkpoint=str(CKPT), model_device=device, codec_repo=str(CODEC),
        model_precision=precision, codec_device=device, codec_precision="fp32"))


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("jobs")
    ap.add_argument("--cands", type=int, default=3)
    ap.add_argument("--device", default="mps")
    ap.add_argument("--precision", default="fp32", choices=["fp32", "bf16"])  # bf16 is CUDA/XPU-only
    ap.add_argument("--ref-seconds", type=float, default=60.0)
    ap.add_argument("--caption", default=None)
    ap.add_argument("--speaker-cfg", type=float, default=None)
    ap.add_argument("--duration-scale", type=float, default=None,
                    help=">1 slower, <1 faster than the model's predicted duration")
    ap.add_argument("--tag", default="", help="suffix for candidate files (experiments)")
    args = ap.parse_args()

    jobs = [json.loads(l) for l in open(args.jobs, encoding="utf-8") if l.strip()]
    by_star: dict[str, list[dict]] = defaultdict(list)
    for j in jobs:
        by_star[j["star"]].append(j)

    out_dir = WORK / "cands"
    out_dir.mkdir(parents=True, exist_ok=True)
    index = open(out_dir / "index.jsonl", "a", encoding="utf-8")

    t0 = time.time()
    rt = load_runtime(args.device, args.precision)
    print(f"[load] {time.time() - t0:.1f}s rss={rss_mb():.0f}MB", flush=True)
    settings = dict(SETTINGS)
    if args.speaker_cfg is not None:
        settings["cfg_scale_speaker"] = args.speaker_cfg
    if args.duration_scale is not None:
        settings["duration_scale"] = args.duration_scale

    for star, rows in by_star.items():
        refs = [str(p) for p in reference_clips(star, args.ref_seconds)]
        # Encode references once per star into latents and reuse them.
        lat_dir = WORK / "reflat" / star
        lat_dir.mkdir(parents=True, exist_ok=True)
        latents = []
        for p in refs:
            lp = lat_dir / f"{Path(p).parent.name}-{Path(p).stem}.pt"
            if not lp.exists():
                wav, sr = _load_audio(p)
                with torch.inference_mode():
                    piece = rt.codec.encode_waveform(
                        wav.unsqueeze(0), sample_rate=int(sr), normalize_db=-16.0,
                        ensure_max=True).cpu()
                torch.save(piece[0].contiguous(), lp)
            latents.append(str(lp))
        for j in rows:
            t1 = time.time()
            req = SamplingRequest(
                text=j["text"], caption=j.get("caption", args.caption),
                ref_latents=latents,
                num_candidates=args.cands, seed=j.get("seed"), **settings)
            res = rt.synthesize(req, log_fn=None)
            for k, audio in enumerate(res.audios):
                wav = out_dir / f"{j['id']}{args.tag}__{k}.wav"
                save_wav(wav, audio, res.sample_rate)
                index.write(json.dumps({
                    "id": j["id"], "star": star, "text": j["text"], "k": k, "tag": args.tag,
                    "wav": str(wav), "seed": res.used_seed, "settings": settings,
                    "caption": req.caption, "ref_seconds": args.ref_seconds,
                    "precision": args.precision}, ensure_ascii=False) + "\n")
            index.flush()
            print(f"[{j['id']}] {len(res.audios)} cands {time.time() - t1:.1f}s "
                  f"rss={rss_mb():.0f}MB", flush=True)
        gc.collect()
        if args.device == "mps":
            torch.mps.empty_cache()
    index.close()
    print(f"[done] {len(jobs)} jobs in {time.time() - t0:.0f}s", flush=True)


if __name__ == "__main__":
    main()

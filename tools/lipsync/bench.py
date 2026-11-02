"""MuseTalk 1.5 core throughput: frames per second of UNet (one step) + VAE decode, warm, per device / dtype / batch.

    .lipsync/venv-muse/bin/python tools/lipsync/bench.py [--device mps|cpu|cuda] [--fp32] [--batch 8] [--iters 6]

This is the per-sentence GPU work once an avatar is prepared (musetalk_pilot.py measures the whole path). The same
script runs unchanged on a cloud GPU (--device cuda), which is how the latency table in docs/lipsync.md gets confirmed.
"""
from __future__ import annotations

import argparse
import os
import sys
import time
from pathlib import Path

import torch

sys.path.insert(0, str(Path(__file__).resolve().parent))
from musetalk_pilot import MUSE  # noqa: E402


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--device", default="mps" if torch.backends.mps.is_available() else "cuda")
    ap.add_argument("--fp32", action="store_true")
    ap.add_argument("--batch", type=int, default=8)
    ap.add_argument("--iters", type=int, default=6)
    a = ap.parse_args()
    dev = torch.device(a.device)
    dtype = torch.float32 if a.fp32 or dev.type == "cpu" else torch.float16
    os.chdir(MUSE)
    sys.path.insert(0, str(MUSE))
    from musetalk.utils.utils import load_all_model
    vae, unet, pe = load_all_model(unet_model_path="models/musetalkV15/unet.pth", vae_type="sd-vae",
                                   unet_config="models/musetalkV15/musetalk.json", device=dev)
    vae.vae = vae.vae.to(dev, dtype)
    unet.model = unet.model.to(dev, dtype)
    pe = pe.to(dev, dtype)
    lat = torch.randn(a.batch, 8, 32, 32, device=dev, dtype=dtype)
    aud = torch.randn(a.batch, 50, 384, device=dev, dtype=dtype)
    t = torch.tensor([0], device=dev)

    def sync():
        if dev.type == "mps":
            torch.mps.synchronize()
        elif dev.type == "cuda":
            torch.cuda.synchronize()

    with torch.no_grad():
        for i in range(a.iters + 1):
            if i == 1:
                sync()
                t0 = time.perf_counter()
            pred = unet.model(lat, t, encoder_hidden_states=pe(aud)).sample
            vae.decode_latents(pred)
        sync()
    dt = time.perf_counter() - t0
    fps = a.batch * a.iters / dt
    print(f"device={dev.type} dtype={str(dtype).split('.')[-1]} batch={a.batch}: {fps:.1f} frames/s "
          f"({1000 / fps:.0f} ms/frame; 24 fps playback needs >= 24)")


if __name__ == "__main__":
    main()

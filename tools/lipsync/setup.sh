#!/usr/bin/env bash
# Local MuseTalk 1.5 environment for the lip-sync pilot (docs/lipsync.md). Everything lands in the main checkout's
# gitignored .lipsync/ (code, venv, ~3.8 GB of weights). Public sources only; nothing of hers is uploaded.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
main="$(cd "$here" && git rev-parse --path-format=absolute --git-common-dir)"; main="${main%/.git}"
home="${LIPSYNC_HOME:-$main/.lipsync}"
mkdir -p "$home" && cd "$home"
[ -d MuseTalk ] || git clone --depth 1 https://github.com/TMElyralab/MuseTalk.git   # pilot ran at 0a89dec (2025-09-26)
[ -x venv-muse/bin/python ] || uv venv -p 3.11 venv-muse
VIRTUAL_ENV=venv-muse uv pip install torch torchvision torchaudio "diffusers==0.30.2" "transformers==4.39.2" \
  "accelerate==0.28.0" "numpy<2" opencv-python soundfile librosa einops omegaconf "huggingface_hub<0.26" \
  face-alignment gdown "imageio[ffmpeg]" ffmpeg-python
cd MuseTalk
hf=../venv-muse/bin/huggingface-cli
$hf download TMElyralab/MuseTalk --local-dir models --include "musetalkV15/musetalk.json" "musetalkV15/unet.pth"
$hf download stabilityai/sd-vae-ft-mse --local-dir models/sd-vae --include config.json diffusion_pytorch_model.bin
$hf download openai/whisper-tiny --local-dir models/whisper --include config.json pytorch_model.bin preprocessor_config.json
# Only for --mask parse (BiSeNet face parser; trained on CelebAMask-HQ, non-commercial — see docs/lipsync.md)
mkdir -p models/face-parse-bisent
[ -f models/face-parse-bisent/79999_iter.pth ] || ../venv-muse/bin/gdown 154JgKpzCPW82qINcVieuPH3fZ2e0P812 -O models/face-parse-bisent/79999_iter.pth
[ -f models/face-parse-bisent/resnet18-5c106cde.pth ] || curl -sL https://download.pytorch.org/models/resnet18-5c106cde.pth -o models/face-parse-bisent/resnet18-5c106cde.pth
# torch >= 2.6 refuses the legacy .tar format: re-save both as plain state dicts once
../venv-muse/bin/python - <<'PY'
import torch
for f in ["models/face-parse-bisent/resnet18-5c106cde.pth", "models/face-parse-bisent/79999_iter.pth"]:
    try:
        torch.load(f, weights_only=True)
    except Exception:
        torch.save(torch.load(f, weights_only=False, map_location="cpu"), f)
PY
echo "ready: $home"

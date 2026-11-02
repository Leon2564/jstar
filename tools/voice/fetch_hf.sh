#!/bin/bash
# Resumable download of files from an official Hugging Face model repo into
# .voice/models/<repo>/ (the hub client stalls on this network; curl -C - resumes).
#   tools/voice/fetch_hf.sh <org/repo> <file> [file ...]
set -u
repo="$1"; shift
dest="${JSTAR_VOICE_HOME:-$(git -C "$(dirname "$0")" rev-parse --path-format=absolute --git-common-dir | xargs dirname)/.voice}/models/$repo"
mkdir -p "$dest"
for f in "$@"; do
  mkdir -p "$dest/$(dirname "$f")"
  for attempt in $(seq 1 40); do
    if curl -sfL -C - --retry 5 --speed-limit 20000 --speed-time 20 \
         -o "$dest/$f" "https://huggingface.co/$repo/resolve/main/$f"; then
      echo "ok $repo/$f"; break
    fi
    echo "retry $attempt $repo/$f ($(stat -f %z "$dest/$f" 2>/dev/null || echo 0) bytes)"
    sleep 2
  done
done

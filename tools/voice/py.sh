#!/usr/bin/env bash
# Runs a tools/voice script with the local voice environment (.voice/venv-prep in the main checkout: Whisper, ECAPA,
# soundfile, pyloudnorm, requests). Used by `npm run voice:enroll` / `npm run voice:pilot`.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
main="$(cd "$here" && git rev-parse --path-format=absolute --git-common-dir)"; main="${main%/.git}"
py="${JSTAR_VOICE_HOME:-$main/.voice}/venv-prep/bin/python"
[ -x "$py" ] || { echo "no voice environment at $py (tools/voice/README.md › Pipeline)"; exit 1; }
cd "$here"
exec "$py" "$@"

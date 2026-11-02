#!/bin/bash
# Regenerate a list of ids (one per line in FILE) with new seeds, then score and re-pick.
#   tools/voice/redo.sh FILE SEED_BASE [CATALOG]
# Uses readings.json for TTS-only reading fixes. One model process at a time.
set -eu
cd "$(dirname "$0")"
V="${JSTAR_VOICE_HOME:-$(git rev-parse --path-format=absolute --git-common-dir | xargs dirname)/.voice}"
CAT="${3:-../../packages/shared/src/catalog.s1.json}"
python3 make_jobs.py ids --from "$1" --catalog "$CAT" > "$V/work/redo_jobs.jsonl"
echo "jobs: $(wc -l < "$V/work/redo_jobs.jsonl")"
"$V/venv-qwen/bin/python" synth_qwen.py "$V/work/redo_jobs.jsonl" --cands 4 --seed-base "$2" > "$V/work/redo.log" 2>&1
"$V/venv-prep/bin/python" qa.py score 2>&1 | tail -1
"$V/venv-prep/bin/python" qa.py pick --tag= --out "$V/work/picks.jsonl"

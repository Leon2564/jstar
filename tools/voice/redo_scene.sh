#!/bin/bash
# redo.sh for the scene lines (#83): regenerate the scene ids in FILE (one per line, "scene/<star>/<hash>") with new
# seeds, then score and re-pick. Uses readings.json for TTS-only reading fixes. One model process at a time.
#   tools/voice/redo_scene.sh FILE SEED_BASE
set -eu
cd "$(dirname "$0")"
V="${JSTAR_VOICE_HOME:-$(git rev-parse --path-format=absolute --git-common-dir | xargs dirname)/.voice}"
python3 make_scene_jobs.py ids --from "$1" > "$V/work/redo_scene_jobs.jsonl"
echo "jobs: $(wc -l < "$V/work/redo_scene_jobs.jsonl")"
"$V/venv-qwen/bin/python" synth_qwen.py "$V/work/redo_scene_jobs.jsonl" --cands 4 --seed-base "$2" > "$V/work/redo_scene.log" 2>&1
"$V/venv-prep/bin/python" qa.py score 2>&1 | tail -1
"$V/venv-prep/bin/python" make_scene_jobs.py pick

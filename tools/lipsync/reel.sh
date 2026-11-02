#!/usr/bin/env bash
# One MP4 of every side-by-side the pilot made (tools/lipsync/out/*-sbs.mp4 -> out/reel.mp4), for the owner to watch.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
main="$(cd "$here" && git rev-parse --path-format=absolute --git-common-dir)"; main="${main%/.git}"
out="${LIPSYNC_OUT:-$main/tools/lipsync/out}"
cd "$out"
files=(${@:-$(ls *-sbs.mp4)})
args=(); filt=""
for i in "${!files[@]}"; do args+=(-i "${files[$i]}"); filt+="[$i:v]scale=1440:1280,setsar=1,fps=24[v$i];[$i:a]aresample=44100,aformat=channel_layouts=stereo[a$i];"; done
for i in "${!files[@]}"; do filt+="[v$i][a$i]"; done
filt+="concat=n=${#files[@]}:v=1:a=1[v][a]"
ffmpeg -y -v error "${args[@]}" -filter_complex "$filt" -map "[v]" -map "[a]" -c:v libx264 -crf 20 -preset veryfast \
  -pix_fmt yuv420p -c:a aac -b:a 160k -movflags +faststart reel.mp4
echo "$out/reel.mp4 (${#files[@]} clips)"

#!/bin/bash
# encode.sh <in.wav> <out.m4a> <target LUFS> <kbps>
# One linear gain to the loudness target (never a dynamic normaliser, which would change the level across a loop and
# break its seam), then AAC-LC (AudioToolbox) in MP4, metadata stripped, moov first.
set -euo pipefail
in=$1; out=$2; target=$3; kbps=$4
I=$(nice ffmpeg -hide_banner -nostats -i "$in" -af ebur128 -f null - 2>&1 | sed -n '/Summary/,$p' | awk '/ I:/{print $2}')
gain=$(python3 -c "print(round($target - ($I), 2))")
mkdir -p "$(dirname "$out")"
nice ffmpeg -v error -y -i "$in" -af "volume=${gain}dB" -map_metadata -1 -c:a aac_at -b:a "${kbps}k" -movflags +faststart "$out"
echo "$out: $I LUFS in, ${gain} dB"

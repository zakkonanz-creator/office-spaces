#!/bin/sh
# demo.webm (from scripts/demo-video.ts) → docs/demo.gif for the README and docs/demo.mp4 for sharing.
#   sh scripts/demo-gif.sh /tmp/po-demo/demo.webm [start-seconds]
set -e
IN="${1:?path to demo.webm}"; START="${2:-5.6}"
HERE="$(cd "$(dirname "$0")/.." && pwd)"
ffmpeg -loglevel error -y -ss "$START" -i "$IN" -vf "fps=10,scale=800:-1:flags=lanczos,split[a][b];[a]palettegen=max_colors=96:stats_mode=diff[p];[b][p]paletteuse=dither=bayer:bayer_scale=4:diff_mode=rectangle" "$HERE/docs/demo.gif"
ffmpeg -loglevel error -y -ss "$START" -i "$IN" -c:v libx264 -pix_fmt yuv420p -crf 26 -preset slow -movflags +faststart -an "$HERE/docs/demo.mp4"
ls -lh "$HERE/docs/demo.gif" "$HERE/docs/demo.mp4"

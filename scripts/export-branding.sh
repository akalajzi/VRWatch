#!/usr/bin/env bash
# Package VectorCraft wordmarks and resize its transparent app icon export.
set -euo pipefail
cd "$(dirname "$0")/.."
command -v magick >/dev/null || { echo 'ImageMagick 7 is required (magick).' >&2; exit 1; }
mkdir -p extension/pages/branding
for size in 16 32 48 128 512; do
  magick branding/vrwatch-app-icon.png -filter Lanczos -resize "${size}x${size}" -strip "extension/icons/icon${size}.png"
done
for name in vrwatch-wordmark-color-light vrwatch-wordmark-mono; do
  cp "branding/${name}.svg" "extension/pages/branding/${name}.svg"
done

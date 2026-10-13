# VRWatch brand assets

The amber visor/play symbol and outlined wordmark were generated with imagegen,
then traced and edited in VectorCraft. Editable `.vectorcraft` masters and SVG/PNG
exports are included. No font installation is needed for outlined SVG text.
Private concept boards and prompts are excluded from public source.

App icon, symbol, color/light-lettered/monochrome wordmarks share the same paths.
Palette: amber `#F4BA54`, charcoal `#252624`, warm off-white `#F4F1E8`.
Keep aspect ratio and clear space. Original artwork is included under MPL-2.0;
that license does not grant trademark rights or imply official-fork endorsement.

Run `bash scripts/export-branding.sh` after exporting masters (ImageMagick 7).
The script resizes app icons and strips metadata, then copies page wordmarks.
The normal build copies the assets into `dist/`. `app.json` holds identity and
version checked against the extension/package. See [notices](../NOTICE.md).

Homepage site names identify link destinations. Tile illustrations use generic
geometry/system text rather than redistributed third-party logo image files.
The README screenshot is a fresh local preview with no private browsing state.

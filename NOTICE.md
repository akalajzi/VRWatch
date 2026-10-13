# Copyright and third-party notices

Original VRWatch application code and documentation:
Copyright (c) 2026 Ante Kalajzic and VRWatch contributors.

This Source Code Form is subject to the terms of the Mozilla Public License,
v. 2.0. If a copy of the MPL was not distributed with this file, You can obtain
one at https://mozilla.org/MPL/2.0/.

Original VRWatch source uses **MPL-2.0**, reproduced in `LICENSE`, unless a file
states another license. Upstream portions and dependencies retain their own
terms; this notice does not restrict their owners' grants. Chromium-derived
patch content preserves its Chromium BSD-style notices.

The source archive contains the complete VRWatch application source. Steam Frame
release packages also include it as `SOURCE.tar.gz`, with a separate source asset
on the matching release page. Build receipts identify the exact commit and input
hashes. Retain corresponding MPL-covered source when distributing modifications.

## Immersive video rendering

`extension/src/vr-player.js` and `extension/src/projections.js` are adapted from
[phit/video2webxr](https://github.com/phit/video2webxr), revision
`e5b6ac3df7d7c8bfc5655de0788527e0977dfbaa`. Copyright 2023 feedthedogs and 2026
phit, ISC. Preserve `licenses/video2webxr-ISC.txt` in distributions. Original
VRWatch modifications and its controller/browsing UI are MPL-covered; the
upstream portions remain available under ISC.

## Frame runtime integration

`frame/fetch-browser.py` and `frame/steam-shortcut.py` are adapted from [phit/chromium-webxr-steam-frame](https://github.com/phit/chromium-webxr-steam-frame/tree/google), revision `67291875697edfd3280daa6a9c26b3c9271762f7`. The launcher follows the same Steam overlay and systemd integration approach. Copyright 2026 saphid, BSD-3-Clause license. Full license: `licenses/chrome-xr-BSD-3-Clause.txt`.

Original VRWatch modifications are MPL-covered; upstream portions retain BSD.
The Python integration uses Valve's OpenVR API definitions and loads the user's
installed runtime libraries. The [OpenVR SDK](https://github.com/ValveSoftware/openvr)
is BSD-3-Clause, distinct from SteamVR itself. Its notice is reproduced in
`licenses/openvr-BSD-3-Clause.txt`. SteamVR runtime binaries are not bundled.

## Dependencies and runtime

three.js 0.186.1 is MIT licensed, Copyright 2010–2026 three.js authors; its text
is in `licenses/three-MIT.txt`. esbuild 0.28.2 is MIT licensed, Copyright 2020
Evan Wallace; its text is in `licenses/esbuild-MIT.txt`. It is a build tool,
not an application runtime. Production bundles preserve legal comments and
include these notices, VRWatch's MPL text and this NOTICE.

When used without `--bundled-runtime`, the source installer downloads Google Chrome ARM64 separately from Google's
repository, under Google's own terms. Google Chrome is not stored in Git or
relicensed by VRWatch.

The full Steam Frame package uses source-built ARM64 Chromium with Linux OpenXR and
V4L2 codec support. Chromium's BSD-style license is only part of its licensing:
dependencies include MIT, Apache-2.0, LGPL and other licenses. Preserve the
exact runtime's generated `chrome://credits` resources and source LICENSE.
The pinned OpenXR SDK metadata lists Apache-2.0 and MIT components. Its
notice is in `licenses/OpenXR-SDK-NOTICE.txt` and the Apache text is in
`licenses/Apache-2.0.txt`. Chromium patch content is covered by
`licenses/chromium-BSD.txt`. Reference LGPL text is included for FFmpeg;
these files do not replace a complete exact-runtime dependency inventory.

The pinned Linux ARM64 FFmpeg configuration declares **LGPL-2.1-or-later**,
with `CONFIG_GPL=0` and `CONFIG_NONFREE=0`. Public browser binaries need the
applicable corresponding FFmpeg source, modifications/build information and
the LGPL-required ability to modify/relink the library. Credits alone do not
complete those obligations. Review the exact linking configuration and other
shipped components before public binary distribution.

Browser source checkouts and compiled binaries remain excluded from Git. The
Steam Frame release includes exact generated browser credits, matching FFmpeg
source and application objects/relink materials as separate release assets.
`RELINKING.md` identifies the runtime and explains library modification/relinking.
The package is separate from Google Chrome and has no bundled Widevine.
See `docs/source-runtime.md` for the recipe and acceptance requirements.

## Branding

Current playback-control icons, including recenter, are original canvas
geometry.

The VRWatch visor concept was generated with imagegen, then traced and edited
in VectorCraft. Editable paths and approved exports are in `branding/`.
MPL-2.0 grants no trademark or logo rights. Do not imply an unofficial fork is
the original project. Third-party names identify link destinations; generic tile geometry and system
text replace third-party logo images. Names remain their owners' marks.
VRWatch is an independent project, not affiliated with Google or Valve.

File/portion scope and browser distribution requirements: `docs/licensing.md`.

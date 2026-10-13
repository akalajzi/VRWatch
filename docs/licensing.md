# License scope and distribution

The root [MPL-2.0 license](../LICENSE) and [NOTICE](../NOTICE.md) apply to original
VRWatch code, tests, build/install tooling, documentation and artwork unless
the following scope or a file notice identifies upstream content. Mixed files
preserve the upstream grant for inherited portions; original modifications are
MPL-covered. This does not relicense upstream code exclusively under MPL.

| Files/content | License and provenance |
| --- | --- |
| `extension/src/vr-player.js`, `projections.js` | Adapted video2webxr portions: ISC; original changes: MPL-2.0; pinned revision in NOTICE |
| `frame/fetch-browser.py`, `steam-shortcut.py`; inherited launcher approach | Chrome XR portions: BSD-3-Clause; original changes: MPL-2.0; pinned revision in NOTICE |
| `frame/runtime-patches/`, `frame/next-runtime-patches/`, `frame/native-tests/*.patch` | Chromium-derived patch content and BSD-marked new C++ files: Chromium BSD; preserve Chromium headers and `licenses/chromium-BSD.txt` |
| `frame/runtime-root.gn`, native test graph | Chromium build conventions; upstream portions retain Chromium BSD; original glue MPL-2.0 |
| OpenVR API definitions in Python integration | OpenVR BSD-3-Clause; SteamVR binaries/artwork are excluded |
| three.js imports/bundled dependency | MIT, with exact package license in `licenses/three-MIT.txt` |
| esbuild build tool | MIT, with package license in `licenses/esbuild-MIT.txt` |
| OpenXR SDK fetched by Chromium | Apache-2.0/MIT and transitive notices; SDK notice and Apache text included for reference; runtime source is fetched separately |
| VRWatch brand masters/exports and UI icon geometry | Original artwork, MPL-2.0; generation/tracing provenance in `branding/README.md`; no trademark grant |

Private design concepts, obsolete art, third-party logo images and screenshots
of browsing/media are excluded. Public screenshots show only the implemented
local UI with empty history and generic destination artwork.

The application build copies the entire `licenses/` directory, the MPL text and
NOTICE into `dist/licenses/`, and retains esbuild legal comments. These notices
must accompany downstream bundles. A source distribution must retain the notices
and identify the source of MPL-covered modifications; see
[Mozilla's FAQ](https://www.mozilla.org/en-US/MPL/2.0/FAQ/).

## Browser binary distribution

The Git source tree excludes browser, SteamVR, FFmpeg, Widevine and toolchain
binaries. The Steam Frame release separately includes Chromium and a source/relink
SDK. Building a browser locally does not by itself clear binary distribution.
For each exact runtime:

1. Inventory its shipped dependencies and preserve all applicable licenses,
   copyright notices and generated credits. Chromium's BSD license alone is
   insufficient for its third-party components.
2. Provide corresponding MPL-covered source for the application and modifications.
3. Confirm the exact FFmpeg configuration and linking. The pinned Linux ARM64
   configuration declares LGPL-2.1-or-later with GPL/nonfree disabled. Provide
   corresponding FFmpeg source, patches and build information for the delivered
   library, and satisfy the applicable LGPL modification/relinking requirements
   for the actual linked executable. A non-component build requires special
   attention to the objects/materials needed to relink.
4. Review other bundled LGPL/GPL components, source availability, source offers
   and installation/replacement requirements against their applicable versions.
   Verify notices/source retrieval and relinking on the delivered package.
5. Review separately downloaded Chrome's terms, platform/trademark conditions and
   codec patent obligations for the intended distribution.

The initial full browser release provides its generated credits and license texts,
matching FFmpeg source/configuration, corresponding source for compiled copyleft
portions, retained application objects, compiler/profile inputs and relink
instructions. An independent verification compiled a modified FFmpeg object and
relinked ARM64 Chromium, with the modification verified in the executable. The
delivered browser retains the original validated library. Source/relink materials
are served alongside that exact binary; the installer permits replacing the
installed executable and adds no signature restriction or EULA restricting
library modification/debugging.

This evidence addresses the reviewed runtime's source/relink requirements; it
is not a blanket compliance claim for every component or future binary. Retain
all upstream notices, review changes in dependencies and linking, and assess
codec patent and applicable distribution obligations for the intended audience.
Credits alone do not establish binary compliance. See
[FFmpeg's guidance](https://ffmpeg.org/legal.html),
[LGPL-2.1](https://www.gnu.org/licenses/old-licenses/lgpl-2.1.html) and
[release preparation](releases.md).

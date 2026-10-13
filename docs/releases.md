# Steam Frame release preparation

README is for people who want to browse. [INSTALL.md](../INSTALL.md) describes
installing the ready-made browser package. Development and distribution details
belong here and in [DEVELOPING.md](../DEVELOPING.md).

The full release combines the standard extension/host with the verified baseline
Chromium runtime and hardware H.264 decoding. Experimental native HUD candidates
are separate. Preserve frozen builds; prepare runtime and license material copies
in independent directories.

## Runtime and distribution inputs

The release runtime has a schema-3 `vrwatch-runtime.json` with architecture,
Chromium revision and per-file SHA-256 values. `frame/verify-runtime.py` checks
every file and ARM64 ELF architecture before installation. Runtime files must
have no symlinks, private build receipts or device-test metadata. Include the
exact generated credits, Chromium license and applicable library licenses.

The browser uses statically linked FFmpeg. Its release materials include the
exact library sources/configuration, the application objects, generated support,
compiler/profile inputs and relink instructions. A verification copy must
actually compile modified FFmpeg and relink an ARM64 Chromium executable.
Retain proof privately and ship the original validated runtime, not the test
modification. Include corresponding source for other compiled copyleft portions
and retain the exact runtime's third-party credits.

`distribution-materials.json` binds the source/relink assets to the browser hash
and records the relink result. Packaging verifies the material file hashes.
This is evidence for the reviewed artifact; it is not a blanket license or
patent clearance for future browser versions. See [license scope](licensing.md).

## Build the application package

Commit the final source, then build and run the source checks:

```sh
npm ci
npm run check
npm test
npm run build
python3 scripts/package-frame-release.py \
  --runtime /path/to/verified-runtime-copy \
  --license-materials /path/to/matching-distribution-materials \
  --output artifacts/releases/preview
```

The packager requires the current commit's standard build receipt. It uses an
explicit file allowlist for the host, includes the full app source and notices,
and writes the consumer package, source archive, source/relink materials and
SHA256SUMS. Private work directories, profiles and browser source checkouts are
never copied implicitly. Inspect/scans must cover the extracted final assets,
including generated source metadata, not only the Git tree.

Keep releases and the repository private until the owner explicitly authorizes
public visibility. A release can be prepared and reviewed privately. Consumer
release notes should describe installation, supported codecs and practical
limits; developer source/relink files belong under a separate release-note label.

Record device acceptance against the exact package before calling it a stable
release. A historical browser test does not establish the newest UI or installer
has passed physical Frame acceptance. Publish those limits as preview status.

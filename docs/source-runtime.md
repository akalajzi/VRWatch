# VRWatch ARM64 source runtime

The optional source-built runtime keeps Linux OpenXR and targets Frame's stateful
V4L2 decoder. It is separate from downloaded Google Chrome and is not selected by
a source installation that downloads Google Chrome. The full Steam Frame release
includes this baseline runtime. The recipe pins Chromium revision
`1cd9d5e8a79498099345785815a507f5d6e6811a` (157.0.8097.0) and pinned depot_tools;
Chromium's DEPS pins dependencies/toolchains/sysroots and optimization profiles.

## Build configuration

[runtime-args.gn](../frame/runtime-args.gn) enables V4L2/OpenXR, H.264 and software
fallbacks, disables VA-API and PDF, and keeps printing required by the desktop
graph. This is an optimized non-component ARM64 cross-build, not an official
Google package. [The runtime patches](../frame/runtime-patches/) guard disabled
PDF/watermark dependencies, select the build graph, enable accelerated decoding
and initialize the compressed output with known coded dimensions.

Prior device checks identified native H.264 Baseline/High decoding and matching
Canvas2D/WebGL readback. CPU conversion remained in the pipeline. VP9 native
decoder reopen/loop failures led the wrapper to apply
`--disable_accelerated_vp9_decode` and
`--disable_accelerated_vp9_profile2_decode`; VP9/AV1 use software paths. A HEVC
sample failed in the selected stateful path. Revalidate against the exact OS,
driver, firmware and runtime; capability advertising is not acceptance.

## Build and resume

Follow [Chromium's Linux prerequisites](https://chromium.googlesource.com/chromium/src/+/main/docs/linux/build_instructions.md)
on the build workstation. Expect a large download and lengthy cross-compilation.

```sh
python3 frame/build-runtime.py --work-dir runtime/my-candidate \
  --runtime-version my-candidate --jobs 12
```

Work directories, logs, dependencies, receipts and packages are ignored. A lock
prevents overlapping builds. `--phase prepare`, `--phase build`, and
`--phase package` resume stages. Reprepare after changing inputs. Use a new work
directory for other revisions or native patches; never overwrite a frozen build.
Inspect `status.json` and `build.log` in the chosen work directory privately.

Packaging requires successful prepared/compiled input receipts and a unique
runtime version. It checks source/patch/configuration identities and ARM64 ELF
headers, strips with the pinned toolchain, and writes checksummed local archives
and metadata. Local packaging is not binary-distribution clearance. Retain the
exact Chromium/dependency source, credits and obligations described in
[licensing](licensing.md#browser-binary-distribution).

## Device acceptance and rollback

Verify checksum, executable architecture, libraries and browser version before
launch. Unpack to a new candidate directory. Use separate state and profile:

```sh
VRWATCH_BROWSER=/path/to/candidate/vrwatch-chromium \
VRWATCH_PROFILE=/path/to/disposable/profile \
VRWATCH_STATE=/path/to/disposable/state \
VRWATCH_TEST_RELAY=9232 vrwatch
```

Disposable state needs the compatible installed extension/ID and host helpers.
Keep test relays on loopback. Compare synthetic clips with the preserved baseline;
identify actual decoder use and check readable textures, seeks, loop/end recovery,
source changes, repeated XR entry/exit, controller input and browser-panel return.
Measure visible/watched behavior separately from headless telemetry.

Before selection, close the browser and back up the profile and browser-path
selection to a private location. Test a closed profile copy using synthetic
storage/cookies; Chrome and Chromium may use different keyring identities. Do
not read existing credentials. Keep the original runtime and matching bundle.

To roll back, close VRWatch and restore the saved browser-path selection; retain
the current profile before restoring a closed backup if needed. The original
runtime may be necessary for PDF or Widevine, which this source runtime omits.
Native releases have explicit selection/rollback commands described by
`python3 frame/release.py --help`. Preserve prior compatible pairs.

See [verification scope](verification.md), [native work](native-runtime.md) and
[upstream review](upstream-adoptions.md). Current source checks do not rebuild
Chromium, modify a device or establish binary compliance.

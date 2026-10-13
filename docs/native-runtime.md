# Experimental native runtime

The native candidate adds a browser-owned top HUD, real tab integration and
authenticated window/document/XR lifecycle operations to pinned Chromium.
It is separate from the extension toolbar and standard installer. Compilation,
local staging and limited device checks were completed in private development;
broader executable and physical acceptance remains pending.

The standard build does not enable this path. Candidate inputs must be frozen in
a new ignored directory; never modify a preserved runtime or installed profile.

```sh
python3 frame/prepare-candidate.py --output artifacts/native-inputs
npm run build -- --candidate --outdir artifacts/native-bundle/extension
python3 frame/build-runtime.py --help
python3 frame/release.py --help
python3 frame/candidate-launcher.py --help
```

Pass the frozen patch directory, GN arguments and root graph explicitly to the
builder in a new work directory, with `--bridge-protocol 1` and a unique runtime
version. Bundle/stage/validate/select/rollback commands require explicit paths.
Inspect subcommand help and verify exact runtime/bundle compatibility before use.
The tools create local artifacts; no command here authorizes public binaries.

[Candidate patch scope](../frame/next-runtime-patches/README.md) and
[isolated native executable tests](../frame/native-tests/README.md) describe the
source and test targets. Patches 5–6 add message identity and the top overlay to
the initial four-patch candidate. Use an independent test checkout; the build
host cannot natively execute ARM64 browser tests.

Required acceptance includes unauthorized requests, document replacement,
window closure, modal/permission focus, fullscreen, tabs, XR cleanup and repeated
browser return; controller interaction and playback must also pass while worn.
A DOM prototype, compilation or passing unit tests does not establish this.
See [source-runtime acceptance](source-runtime.md#device-acceptance-and-rollback).

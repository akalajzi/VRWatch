# Isolated native executable tests

These targets compile the original six VRWatch browser tests (plus the native.2
HUD message-identity/tab-creation regression when its patch is applied) and the original
component-loader test source (run only its two `VRWatch*` cases). They use the
upstream Chrome browser/unit test runners and test support, with the unchanged
ARM64 production GN arguments. This is executable test scaffolding, not a
replacement runtime or a production patch.

The full upstream `browser_tests` graph fails with PDF disabled: first
`back_forward_cache:browser_tests` requires a PDF test helper; guarding that edge
then exposes `renderer_context_menu:browser_tests`, which also requires PDF.
The focused targets omit those unrelated suites instead of enabling PDF or
changing production sources. One test-only visibility entry permits the browser
fixture to include `browser.h`; direct dependencies pass `gn check`.

Use an independent, fully populated checkout of the verified patched source and
pinned dependencies. Never use a frozen production or symlinked review checkout.
Keep test output and logs in ignored directories.

From a fresh independent copy of the verified patched Chromium tree:

```sh
git apply /absolute/vrwatch/frame/native-tests/focused-suites.patch
mkdir -p out/VRWatchNativeTestsRoot
cp /absolute/vrwatch/frame/native-tests/root.gn out/VRWatchNativeTestsRoot/BUILD.gn
gn gen out/VRWatch --root-target=//out/VRWatchNativeTestsRoot --root-pattern=//out/VRWatchNativeTestsRoot:tests --fail-on-unused-args
gn check out/VRWatch //chrome/test:vrwatch_browser_tests --root-target=//out/VRWatchNativeTestsRoot --root-pattern=//out/VRWatchNativeTestsRoot:tests
gn check out/VRWatch //chrome/test:vrwatch_unit_tests --root-target=//out/VRWatchNativeTestsRoot --root-pattern=//out/VRWatchNativeTestsRoot:tests
env DEPOT_TOOLS_UPDATE=0 nice -n 10 autoninja -C out/VRWatch -j 12 vrwatch_browser_tests vrwatch_unit_tests
```

Put the independent checkout's pinned `depot_tools` on PATH. The output directory
name is retained only to reuse copied objects; its absolute path is in the
**test checkout**. Never package its `chrome` as the production candidate.
Preserve the existing test directory/logs on retries rather than copying over it.

On an ARM64 execution environment, stage the test runtime dependencies separately
from the immutable release, then run:

```sh
./vrwatch_browser_tests --gtest_filter=VrwatchRuntimeBrowserTest.*:VrwatchHudBrowserTest.* --test-launcher-jobs=1 --test-launcher-retry-limit=0
./vrwatch_unit_tests --gtest_filter=ComponentLoaderTest.VRWatch* --test-launcher-jobs=1 --test-launcher-retry-limit=0
```

Record exact additional execution flags, executable hashes, test counts and
results. The build host is x86_64; these ARM64 binaries cannot run there natively.
Browser tests provide their own component fixture; do not modify the verified
external bundle to accommodate tests. Passing these tests does not establish
headset smoothness, controller behavior, codec selection or real-site acceptance.

For native.2, apply its two additional runtime patches in this independent test
checkout before regenerating the graph. The expected filtered total is seven
browser and two component-loader tests. Do not run two concurrent 12-job builds;
resume the cached test compilation after the candidate runtime compilation.

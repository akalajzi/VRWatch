# Native candidate source patches

Pinned Chromium revision: `1cd9d5e8a79498099345785815a507f5d6e6811a`. Apply after the unchanged ten `../runtime-patches` patches. The default builder does not select these automatically.

1. `0001-external-component-loader.patch`: external component bundle, exact stable key/ID and changed-version loading; loader unit-test source.
2. `0002-bundled-native-host-lookup.patch`: exact bundled host name and registration path.
3. `0003-native-window-lifecycle.patch`: private API, authenticated browser window/document/XR ownership, lifecycle cleanup and browser-test source. Independently usable with `--vrwatch-native` and ordinary desktop chrome.
4. `0004-browser-owned-floating-hud.patch`: external extension child view, native shortcuts/security/focus handling, owned-window chrome/inset suppression, delayed-load visibility control and browser-test source. Enabled with `--vrwatch-native --vrwatch-hud`.

5. `0005-hud-message-document-identity.patch`: populate browser-derived message frame/document identity for non-tab extension views; add a real HUD → worker → native authorization → tab creation browser regression.
6. `0006-top-aligned-native-hud.patch`: full-width top overlay with bounded navigation/picker heights; extend the no-resize test with top-origin/full-width assertions.

Patches 1–4 define the initial candidate; patches 5–6 are a separate iteration.
Freeze each series in a new input directory. Never append to a preserved input
directory, checkout or archive. Prior compilation/staging and limited device
checks do not establish full native acceptance.

```sh
python3 frame/prepare-candidate.py --output artifacts/native-inputs
```

Pass those inputs to the builder explicitly in a new work directory. See
[native development](../../docs/native-runtime.md) and
[native executable tests](../native-tests/README.md).

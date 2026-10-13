# Contributing to VRWatch

VRWatch is an early preview for Steam Frame. Focused bug reports, site
compatibility fixes, controller improvements and measured playback work are
welcome. Read [the development guide](DEVELOPING.md) before changing runtime
or installation code.

## Report a problem

Include the VRWatch bundle/runtime versions, Frame OS build, SteamVR version,
steps to reproduce, expected behavior and what happened. For playback, include
codec, resolution, frame rate and projection when known. State whether a test
was headless, headset-visible or actually watched by someone wearing the headset.
Do not attach cookies, tokens, browser profiles, private media URLs or unredacted
device logs. Use a public sample or a synthetic clip when possible.

## Propose a change

Keep changes focused and describe their user-visible effect. Run:

```sh
npm ci
npm run check
npm test
npm run build
```

Application UI/player changes can often reuse the current runtime. Native API,
Chromium or platform-workaround changes require a separate candidate and the
applicable [upstream adoption record](docs/upstream-adoptions.md). Preserve
known working artifacts and profiles; passing browser-model tests does not
establish headset acceptance.

## License contributions

Submit original VRWatch contributions under MPL-2.0, unless the affected file
already states another license. Preserve upstream copyrights and license notices,
and identify the source and license of introduced third-party code/assets.
New dependencies must be reviewed for distribution obligations. Do not include
SteamVR runtime artwork merely because it is installed on a development device.

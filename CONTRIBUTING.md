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

## Keep contributions shareable

After cloning, run `python3 scripts/setup-privacy.py`. Commit hooks check the
exact staged files and commit message. The push hook checks every outgoing
commit's source, including files added and then deleted, and commit messages.
The pinned Gitleaks scanner uses its default rules; only the exact audited
public extension identity key is exempt. Missing/broken scanner checks block
the operation. Do not bypass hooks or add blanket secret-scanner exclusions.

The additional privacy rules reject private/generated directories, credentials,
raw captures/logs/databases, source-tree binary archives, personal home paths,
device network addresses and dated reports in documentation. Use loopback,
reserved documentation addresses and explicit runtime configuration. Keep
personal notes, site/device reports and raw evidence under ignored `private/`
or `docs/validation/`. An ignore rule does not remove an already tracked file.

New or changed images require visual review, metadata removal and established
redistribution permission. After review, append the file's SHA-256 to its approved
hash list and record its purpose in `scripts/public-assets.json`. Retain earlier
approved hashes so historical checks continue to pass. Do not approve screenshots
containing personal browsing, media names or account information.

Run `python3 scripts/privacy-check.py --history HEAD` before sharing a branch.
GitHub's **Privacy** workflow checks all branches, tags and pull requests with
read-only permissions and prints categories/locations without secret values.
It checks the upstream state branch too. CI runs after upload; local hooks are
the protection before a normal push. Hooks are local and can be bypassed, so
they are not a security boundary against a deliberate override.

Review diffs before committing. Scanners cannot reliably recognize personal
stories, every hostname or private information visible inside images. Release
assets, Actions logs and issue attachments require their own privacy review;
Git hooks do not inspect uploads made through GitHub's UI or API. Check the
exact final extracted release assets, rather than only the source tree.

## License contributions

Submit original VRWatch contributions under MPL-2.0, unless the affected file
already states another license. Preserve upstream copyrights and license notices,
and identify the source and license of introduced third-party code/assets.
New dependencies must be reviewed for distribution obligations. Do not include
SteamVR runtime artwork merely because it is installed on a development device.

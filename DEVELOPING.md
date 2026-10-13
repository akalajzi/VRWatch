# Developing VRWatch

VRWatch's browsing and video-player layer is a Manifest V3 extension. The
Steam Frame release combines it with a Python host, Steam Frame/SteamVR and the
bundled ARM64 Chromium runtime with hardware H.264 decoding. A source install can
also download Google Chrome. Building a new source runtime or native HUD requires
compiling Chromium; see
[runtime choices](#browser-runtime-choice) before choosing an installation path.

For the product overview, see [README.md](README.md).

## Requirements

- Node.js 22 or newer and npm.
- Git, including a local commit for build receipts and runtime-control tests.
- Python 3.11 or newer for development checks and release/runtime tooling.
  The host and installer helpers also require Python 3; release/runtime hashing
  uses `hashlib.file_digest`, available starting with Python 3.11.
- Bash for launcher syntax checks and installation.
- Steam Frame with its ARM64 SteamOS environment and SteamVR for device testing.

## Local setup

For an extracted source archive, create local source history first (a normal
clone already has it). No remote or GitHub account is required:

```sh
git init -b main
git add .
git -c user.name='Local source build' -c user.email='source@example.invalid' \
  commit -m 'Import source archive'
```

Install the commit/push checks once per clone:

```sh
python3 scripts/setup-privacy.py
```

This downloads the pinned, checksummed Gitleaks scanner and enables this clone's
Git hooks. Keep raw device evidence and personal configuration in ignored
locations. See [contribution checks](CONTRIBUTING.md#keep-contributions-shareable).

```sh
npm ci
npm run check
npm test
npm run build
```

`npm run check` validates app/extension/package metadata and checks JavaScript, shell, and Python syntax. `npm test` runs the automated regressions. `npm run build` bundles the extension into `dist/` and copies its pages, icons, and third-party license texts.

### Start-screen preview

```sh
npm run dev
```

Open `http://127.0.0.1:4178/home.html`. The development server watches the extension sources and rebuilds on changes.

This previews the start screen. It does not install the extension into the browser, inject controls into arbitrary websites, or establish that immersive playback works on Frame.

### Bookmarks, Quick Links, and previews

Home's **Settings** button opens `settings.html`; **Bookmarks** opens
`bookmarks.html`. Save/remove from the toolbar with one click and edit saved
URLs in the viewer. **Close** returns from Bookmarks to Home. Cards support folders, search, sorting, and confirmed deletion.
Pin up to five bookmarks and use **Arrange Home Quick Links** to order them.
Settings can independently hide Quick Links and Recently opened, choose card or
compact-list bookmarks, and enlarge text and controls on the owned pages.
Browsing settings select Google/DuckDuckGo/Bing, Home or previous-session startup,
history recording, and Never/7/30/90-day expiry. Clear history retains bookmarks.
Both VRWatch launchers use `home.html?startup=1` to restore the saved tab URLs and
selection once per browser session; normal Home/new-tab navigation stays Home.
Standalone extension installs retain Chromium’s own startup behavior. Session
snapshots are separate from recently opened sites and omit playback/XR state.

Bookmark previews are local 480 × 270 JPEGs in extension-origin IndexedDB, capped
at 100 KiB per image and 12 MiB total. Old images are evicted without removing
bookmarks. **Refresh preview** opens the saved page for a new capture; **Clear
saved previews** in Settings keeps all bookmark metadata. The desktop preview
supports management and image display but cannot capture other websites.

Latest management pages require physical Frame acceptance; see
[verification scope](docs/verification.md).

### Desktop extension testing

For browsers that support unpacked extension loading, open the browser's extensions page, enable **Developer mode**, choose **Load unpacked**, and select `dist/`. The manifest requires Chrome 157 or newer. Reload the extension and target page after rebuilding so content scripts use the current bundle.

The Frame launcher provisions the extension automatically on every launch; it does not require this manual desktop setup.

## Install on Steam Frame

For a ready-made release, use the consumer [installation guide](INSTALL.md).
The following commands describe installing an application built from source.

Build the extension on the development computer with `npm ci` and `npm run build`. Copy the project to Frame, including `dist/`, `frame/`, and `branding/`, but excluding `node_modules/`. Run the installer from the project directory on Frame as the normal `steamos` user:

```sh
# Fetch the most stable Google Chrome ARM64 channel with the required WebXR support.
frame/install.sh

# Alternatively, reuse an existing Chrome XR installation at ~/chrome-xr/chrome.
frame/install.sh --reuse-chrome-xr
```

The downloader checks the package's SHA-256 against Google's repository index. The installer adds the app files, desktop entry, icons, Steam shortcut, and SteamVR metadata. If automatic shortcut creation fails, add VRWatch through **Steam → Games → Add a Non-Steam Game** using `~/.local/bin/vrwatch`.

Launch **VRWatch** from Steam. It uses:

| Location | Purpose |
| --- | --- |
| `~/.config/vrwatch` | Dedicated browser profile |
| `~/.local/share/vrwatch` | Installed extension, host, metadata, and managed runtime |
| `~/.local/bin/vrwatch` | Launcher |

Reusing Chrome XR leaves its runtime managed by the original Chrome XR installer and keeps its profile separate. Fully close VRWatch before installing an update, then rebuild, copy the updated files, rerun the installer, and relaunch. Browser updates happen when the installer is rerun; a background updater is not implemented.

### Media library and NAS setup

The browser host starts `frame/library-server.py` on `127.0.0.1:4179` for its
lifetime. **Media library** on the homepage opens `/library/`. This loopback
origin supports WebXR without a LAN HTTP origin or certificate setup. The UI
lists folders on demand, filters their names, and plays selected videos through
the existing extension controls. Files are streamed in bounded chunks with
HTTP byte-range support for seeking; no complete-file copy or transcoding is
performed. Hidden/system folders and non-video files are omitted.

Configure explicitly accessible folders in `~/.config/vrwatch/library.json`:

```json
{
  "roots": [
    {
      "id": "nas",
      "label": "NAS",
      "path": "/home/steamos/Videos/NAS",
      "mountpoint": "/home/steamos/Videos/NAS"
    }
  ]
}
```

`mountpoint` is optional for local folders. For a NAS it prevents an unmounted
directory from appearing as an empty library. Mount the share root to browse
all its subfolders. The server accepts only paths within configured roots,
omits symlinks that escape them, validates the HTTP host/origin, and requires
a per-process capability for folder APIs and video URLs. It has no write API,
debugging API, or LAN listener. Avoid sharing media URLs: they contain the
temporary capability. Restarting VRWatch invalidates old media URLs; reload
the library page to reconnect.

For a key-based SSHFS mount, provision SSHFS in the user's home directory and
an SSH key authorized by the NAS. Keep the private key on the Frame; verify and
save the NAS host key before connecting. Then run:

```sh
python3 ~/.local/share/vrwatch/mount-nas.py \
  --remote 'user@nas.example:/path/to/share' \
  --sshfs /path/to/sshfs \
  --key ~/.ssh/vrwatch-nas_ed25519 \
  --known-hosts ~/.ssh/vrwatch-nas_known_hosts \
  --sftp-server ''
```

The helper creates and enables the `vrwatch-nas.service` user service, mounts
read-only at `~/Videos/NAS`, and registers the root after a successful mount.
It uses key authentication, server keepalives, reconnection, and user-service
restart on failure. It requires no sudo or stored NAS password. Stop/unmount
with `systemctl --user stop vrwatch-nas.service`; disable automatic mounting
with `systemctl --user disable vrwatch-nas.service`. Existing mounted drives
are registered without interruption; the service takes over at the next login.

Choose SSHFS and SFTP components appropriate to your device and NAS. The helper
uses ordinary SFTP by default; supply `--sftp-server` only when your NAS requires
a custom read-only helper. No device-specific addresses or helpers are supplied.

Run `python3 tests/library-server.py`, or `npm test`, for HTTP regressions.
For a desktop UI preview of an already mounted drive, use a temporary config:
`python3 frame/library-server.py --config /path/to/library.json --assets dist`.
This checks browsing/browser playback, not physical headset XR.

Prior isolated device checks covered H.264 browsing/play/seek/return. A HEVC
sample did not decode through the selected stateful path. File extensions and
advertised capabilities do not establish codec support; no transcoder is supplied.
See [verification scope](docs/verification.md).

### Automatic startup and app identity

The host opens Chrome in an app window, loads the bundled extension through a private DevTools pipe, and navigates to the start screen. The load is session-scoped and repeats on every launch. The manifest's stable public key keeps the extension ID consistent between updates. Normal launches expose no debugging network port.

The extension controls the site's existing video element and renders readable frames into its own WebXR scene. It preserves site sessions and media state rather than extracting the stream into another player.

The Steam launcher supervises a separate user service for browser-panel input
compatibility. It passes its PID and process start time to the host, which stops
the browser if that launcher exits, including a forced Steam termination that
cannot run shell signal traps. Ordinary launcher exit also requests a service
stop. The host gives a stuck browser three seconds before killing it.

VRWatch registers its own SteamVR identity (`vrwatch.app`) and icon. The identity helper targets only XR services descended from VRWatch's browser process. The browser host also tags the app window for Steam's browser panel and handles dashboard transitions on XR entry and exit.

## Runtime configuration

The launcher in `frame/vrwatch` accepts these environment overrides:

| Variable | Purpose |
| --- | --- |
| `VRWATCH_STATE` | Override the installed application directory |
| `VRWATCH_PROFILE` | Override the browser profile directory |
| `VRWATCH_BROWSER` | Override the browser executable |
| `VRWATCH_SECCOMP=1` | Keep the seccomp filter enabled on compatible SteamVR/OS versions |
| `VRWATCH_BASIC_PASSWORD_STORE=1` | Use the basic password store; saved passwords are stored unencrypted |
| `VRWATCH_STEAM_PANEL=1` | Launch directly inside Steam's process tree instead of the default user service |
| `VRWATCH_GPU_RASTERIZATION=1` | Opt back into GPU page-tile rasterization instead of the Frame noise-patch workaround |

The launcher defaults to the seccomp workaround used by the working Chrome XR installation. It also removes Steam's overlay preload library, which otherwise prevents Chrome's GPU process from starting on Frame. The standard password-store behavior is retained unless explicitly overridden.

VRWatch sets Chrome's VR permission default to **Allow** in its dedicated profile
before startup. Existing site blocks and all other permission defaults are
preserved. Entering VR still requires the player's button; this removes Chrome's
extra permission prompt. The host refuses to edit a profile used by a running
browser and preserves unreadable preferences instead of resetting them.

The launcher disables `NtpFooter` to remove Chrome's **Customize Chrome** footer
from the extension homepage. While the seccomp workaround is enabled,
`--test-type=vrwatch` suppresses Chrome's startup infobars. This hides the
unsupported-flag warning; it does not re-enable the seccomp filter. Setting
`VRWATCH_SECCOMP=1` removes both the workaround and that suppression switch.
These settings work with the existing prebuilt Chrome runtime and do not require
a Chromium build.

### Browser runtime choice

The ready-made Steam Frame package uses the validated source-built Chromium
runtime with V4L2 H.264 decoding. `frame/install.sh --bundled-runtime /path/to/browser`
installs a verified release copy. With no runtime argument, a source installation
downloads Google Chrome; hardware decoding has not been established for that path.
See [the source-runtime recipe](docs/source-runtime.md) to build a browser. The
[native HUD candidate](docs/native-runtime.md) remains experimental and separate
from the release runtime.

Evaluating a different runtime requires checking ARM64 availability, OpenXR/WebXR support, extension provisioning, media codecs and decoding, and an update path. See [ungoogled-chromium's project documentation](https://github.com/ungoogled-software/ungoogled-chromium) for its removal of Google service dependencies. Compatibility with VRWatch on Frame has not been established.

## Testing and current limits

Run the local checks before installing changes:

```sh
npm run check
npm test
npm run build
```

Device validation is documented separately:

- [Verification scope](docs/verification.md): completed desktop and physical Frame checks, with measurement limits.
- [Controller testing](docs/controller-testing.md): controller-ray replay and physical interaction checks.
- [Playback testing](docs/playback-testing.md): diagnostics, decoder identification, lifecycle checks, and remaining performance tests.

Physical Frame checks include app startup, real immersive session entry/exit, playback-state preservation, and SteamVR identity. Automated controller replay verifies hit geometry. Prior source-runtime checks identified H.264 hardware decoding and short watched XR playback; controller comfort, compositor timing, network recovery, high-resolution playback and thermal endurance need broader acceptance.

Keep these boundaries in mind when testing:

- DRM-protected video and some cross-origin streams cannot be read by the WebGL player. Availability indicators describe VRWatch playback capability, not native site WebXR support or whether the footage is immersive.
- The generic scanner handles regular video elements and eligible frames. Closed shadow roots and inaccessible embeds may need site adapters.
- Format selection uses saved per-video corrections, explicit site/video metadata, then accessible MP4 spatial metadata. Eporner's declared `VR` and `VRtype` distinguish ordinary and immersive footage; the existing YouTube spherical-player cue selects EAC. Unknown Eporner videos retain the user's 180° side-by-side fallback; other unknown videos use a cinema screen. Manual choices persist for up to 200 video identities and can be cleared with **Detect format automatically**. Detection never changes an active VR session's format. See [format detection](docs/format-detection.md) for coverage and limits.
- Third-party WebXR scenes own their controls. VRWatch's playback controls render inside its own scene.
- YouTube focus mode is cosmetic filtering. Network/ad blocking is deferred. The extension needs storage, tab management, and site access for its browsing and playback features.

## Project references

- [Architecture and milestones](docs/architecture.md)
- [Branding and app metadata](branding/README.md)
- [Third-party notices](NOTICE.md) and [project license](LICENSE)

The README screenshot at `docs/images/vrwatch-home.png` is a capture of the local start-screen preview at a desktop viewport, without simulated headset status or history. Refresh it when that interface changes; design concepts are not substitutes for a screenshot of the implemented app.

## Runtime implementation preparation and local release artifacts

The current source-built Frame runtime and its measured limits are recorded in
[the source-runtime record](docs/source-runtime.md). The earlier downloaded
Chrome path remains available for rollback.

The [native development guide](docs/native-runtime.md) describes the experimental
HUD path and remaining gates. `npm run build -- --outdir artifacts/my-bundle/extension`
writes an independent bundle/receipt. `frame/release.py` provides local
bundle/stage/validate/select/rollback commands with explicit paths; it does not
publish or replace the installer. New Chromium packaging requires compiled-input
receipts and an explicit unique version. Use a new work directory for experiments.

## Source and release materials

The Git tree includes the extension, host, runtime recipes and automated tests.
Browser source downloads, build outputs, profiles and runtime binaries are
excluded. Keep local planning, dated device/site tests and raw captures under
ignored `private/` or `docs/validation/`.

Full browser packaging, corresponding sources and relink verification are
documented in [release preparation](docs/releases.md). See also
[license scope](docs/licensing.md).

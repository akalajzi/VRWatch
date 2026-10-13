# VRWatch architecture

## Product

The primary flow is URL → site video → clear availability indicator → immersive video → reachable controls. VRWatch is primarily a video viewer/browser. The browsing interface should help find the next video and return from playback, with little general browser UI.

## Application layers

- `frame/`: downloaded Chrome installer, launch/Steam integration, and separate
  pinned Chromium build/release tooling. Browser packages and source checkouts
  stay outside Git. The source-built decoding runtime and native HUD candidate
  have separate evidence and activation paths.
- The application host explicitly tags Chrome's X11 window with the VRWatch `STEAM_GAME` app ID so gamescope retains a browser panel. A private CDP binding in the extension's isolated world hides the dashboard on XR entry and summons that browser panel on XR exit. No browser reload or video extraction is involved.
- `extension/pages/` and `extension/src/home.js`: the start screen with a shared toolbar, compact pinned Quick Links, Recently opened, and dedicated Bookmarks/Settings pages.
- `extension/src/navigation.js`: the top address bar while browsing in Chrome's app window.
- `extension/src/browser-hud.js` and `extension/pages/hud.css`: the Minimal dock and large tab-preview picker, shared by the start screen and browsed websites. A closed shadow root isolates site styling. Fullscreen reparents the HUD into the fullscreen element; Escape and focus trapping support keyboard use.
- `extension/src/background.js` and `browser-state.js`: session-scoped tab management and browser-owned screenshots. A normal browser installation uses native tabs in its current window. Chrome's app mode uses a group of chromeless popup page windows, preserving separate live WebContents without exposing a tab strip. Selection focuses the selected page; Home navigates the current page. New tabs open Home and closing the last tab returns Home. Target-blank links with an owned opener are adopted into the same app group.
- `extension/src/bookmarks.js`: normalized user bookmarks/folders and up to five ordered Quick Links in local extension storage. Fresh profiles receive starter links; upgrades preserve user edits. Bookmark previews use separate bounded IndexedDB storage.
- `extension/src/content.js`: site video discovery, capability checks, video-format selection, VR entry/exit, and optional YouTube focus filtering.
- `extension/src/vr-player.js`: shared immersive rendering adapted from video2webxr.
- `extension/src/xr-controls.js`: controller-visible controls drawn into that same XR scene.
- `extension/src/media.js`: seeking, DVR bounds, volume, time labels, and URL handling.
- `branding/`: transparent app mark and generation provenance.

The Steam Frame release bundles the baseline source-built browser. A source
installation can also download Google Chrome. Our source-runtime
track also builds ARM64 Chromium with decoder fixes and native integration;
that track carries its own build, update and patch-maintenance responsibilities.
Chromium source checkouts and compiled packages are excluded from Git.
See [the source-runtime record](source-runtime.md),
[native candidate](native-runtime.md) and
[upstream tracking](upstream-watch.md).

## Important boundaries

The extension sees and controls the site's existing `<video>` element. It renders readable frames into its own WebXR scene, preserving site sessions and playback continuity. Source URLs alone are not sufficient for adaptive streams and logged-in services, so extracting videos into a separate external player is not the default design.

Before Home, new-page creation, or page selection, the background service waits for the current content script to finish XR cleanup and pause videos. Switching never rebuilds or navigates the previous page. The native host installs its isolated-world return binding on each page and brings the page that ended XR to the front; all owned page windows receive the Frame panel tag.

Thumbnails are captured while a page is visible, with floating overlays hidden, then cropped below the address bar and reduced to at most 640 pixels wide. Captures are rate limited and checked against the tab's URL and active state after capture. Navigation invalidates a stale image. At most 40 previews live in session storage; they are never written to permanent bookmark/history storage. Restricted pages and uncaptured background pages show their title/domain and an explicit preview fallback. Page-supplied text is rendered as text, and the picker draws decoded previews into canvas so a website's image CSP cannot block its thumbnails.

Cinema screen and immersive source formats are separate. A flat video can be available on a virtual screen; it is not thereby 180°/360° footage. Format detection and metadata require per-site work, with a manual selection fallback.

Ordinary DOM controls and Chrome extension popups do not automatically become part of an immersive session. VRWatch's playback panel is rendered inside its own scene rather than relying on a generic HTML overlay appearing in VR.

Controller rays and cursor dots are scene geometry updated every XR frame. The panel's text/icon canvas updates separately, at up to about eight times per second for media values and immediately when a button hover changes. Pointer motion must never depend on canvas texture uploads.

The extension cannot guarantee uniform controls over arbitrary third-party XR scenes. Browser internals would only become relevant for a demonstrated need for a browser-owned universal media overlay, native compositor integration, or an engine/runtime defect. Hiding browser UI and page distractions alone does not justify a Chromium fork.

## Preferences and stored browsing information

`preferences.js`, `recent.js` and `browsing-session.js` manage display size,
search engine, history expiry/recording and previous-session startup. Both app
launchers request one-time restoration with `home.html?startup=1`; ordinary Home
navigation stays Home. Session URLs omit playback/XR state and are distinct from
history. `bookmark-previews.js` stores local 480 × 270 JPEGs with 100 KiB per-image
and 12 MiB total limits. Clearing previews keeps bookmark metadata. Refresh
opens the saved page; desktop preview cannot capture arbitrary sites.

See [development](../DEVELOPING.md) and [verification](verification.md).

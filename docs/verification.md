# Verification scope

This summary preserves useful results from private development records without
device addresses, media names, browsing captures, conversation excerpts or dates.
Raw reports belong in ignored `private/` or `docs/validation/` directories.

| Area | Evidence retained | Limits |
| --- | --- | --- |
| Extension/player | Automated regression coverage for projections, controls, lifecycle, tab ownership and media handling | Model/unit tests do not establish physical headset behavior |
| Home, Bookmarks, Settings | Automated storage/migration, pin ordering, search, history, previews and startup restoration checks; local desktop UI inspection | Latest management UI still needs physical Frame acceptance |
| Frame launcher | Prior device startup, SteamVR app identity, actual XR entry/exit and preserved playback state | Specific development runtime; not a public installer certification |
| H.264 source runtime | Prior Baseline/High decoder identification, device use and readable Canvas2D/WebGL textures; short watched XR comparisons | CPU improvement under those conditions; no zero-copy, sustained performance or compositor timing claim |
| Other codecs | Prior software VP9/AV1 playback; HEVC sample failed in the selected stateful decode path | Container support and advertised driver capabilities do not establish decoding support |
| Media library | HTTP range, containment, origin/capability and streaming regressions; prior isolated device H.264 browsing/play/seek/return | Does not establish network endurance, audio quality or every file format |
| Native candidate | Separate compilation/staging and limited controller/tab checks reported in private evidence | Broader native executable/device acceptance remains pending |

Run `npm ci`, `npm run check`, `npm test` and `npm run build` for the current
source. A publication validation report accompanies the source export; historical
test counts are not the current regression count. No headset or installed-runtime
changes are part of source publication validation.

Remaining acceptance includes prolonged watched playback, controller comfort,
network interruption, thermal behavior, HDR, high-resolution codecs and profile
migration against the exact candidate. See [playback testing](playback-testing.md),
[controller testing](controller-testing.md), [native work](native-runtime.md) and
[source-runtime acceptance](source-runtime.md#device-acceptance-and-rollback).

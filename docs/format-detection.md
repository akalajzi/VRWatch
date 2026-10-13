# Automatic video formats

Format selection gives a manual choice and a saved video correction priority
over site declarations, then MP4 spatial metadata. Unknown Eporner videos retain
the requested 180° 3D side-by-side preference. Other unknown videos stay flat.
The format selector remains available, and **Detect format automatically**
clears a saved correction. The latest 200 corrected video identities are stored
locally. Eporner and YouTube identities survive tracking parameters, embeds,
timestamps and page reloads.

Eporner's inline `EP.video.player.VR` and `VRtype` declarations identify ordinary
and immersive videos. The adapter reads these declarations without evaluating
website scripts and rejects an old video's declarations after navigation.
Supported `data-projection` declarations on the video are also recognized.
The existing YouTube spherical-player UI cue continues to select EAC; it does
not establish that every YouTube stereo/projection variant is detected.

Pornhub's main player uses a hidden `mgp_videoElement` behind a WebGL canvas
for VR footage. Discovery selects that source, including while it is loading,
and anchors VRWatch to the visible player container instead of a banner video.
Its JSON `VIDEO_SHOW` declaration identifies the player/video and declares
180°/360°, mono, side-by-side, or supported 360° top/bottom formats. Unsupported
layouts remain available for manual selection; no format is inferred from a
page title. Saved corrections follow the `viewkey` across watch and embed URLs.
In **⋯**, **Play source in browser** exposes the same video with native controls
and hides the site's VR canvas. **Use site player** restores the original view.
The browser source view shows the encoded stereo layout; it does not project
the footage or extract a new stream.

For direct HTTP(S) media sources without higher-priority information, the
background extension reads MP4 `st3d` and `sv3d/proj/equi` metadata. Range
requests skip the media payload to reach a `moov` atom at the end. Requests
omit credentials, have a 2.5-second timeout, and retain at most 512 KiB of
metadata. A server that ignores ranges is read only for a bounded initial
prefix. Missing, malformed, unavailable or unsupported metadata falls back
without preventing playback. No full-video download is required.

This parser covers supported equirectangular 180°/360° projections and their
supported mono, left/right and top/bottom layouts. Custom meshes, right/left
eye order, VR180 top/bottom, and WebM metadata are not automatically mapped to
the current renderer. MSE/blob sources require site declarations or a saved
correction; the extension does not intercept streaming requests. Resolution,
aspect ratio, page titles and navigation/category labels are not treated as
proof of a format.

Async results are scoped to the current video/source. Automatic changes occur
only before VR entry or after exit, never during an active session. A direct
source can briefly show **Checking video format…** while the bounded probe runs.

The metadata layout follows the [Spatial Media v2 specification](https://github.com/google/spatial-media/blob/master/docs/spherical-video-v2-rfc.md).

## Page rendering workaround

The launcher defaults to `--disable-gpu-rasterization` for reported page-tile
corruption while retaining GPU compositing, WebGL and OpenXR.
`VRWATCH_GPU_RASTERIZATION=1` restores GPU rasterization after restart. Prior
native-window synthetic captures were clean; intermittent worn-headset corruption
has not been conclusively resolved. See [verification scope](verification.md).

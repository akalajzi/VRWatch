# Install VRWatch on Steam Frame

Download the **Steam Frame package** from [Releases](https://github.com/akalajzi/VRWatch/releases).
It contains VRWatch and its hardware-decoding browser. You don't need the source
archive, Node.js, Git or a compiler to install it.

## Open Frame's desktop

On Frame, open **Steam Settings → System → Enable Developer Mode**. In the
Developer settings, choose **Set User Password**. This is needed to access the
desktop for installation; it doesn't require changing SteamOS's system files.

You can use Frame's desktop directly or connect from your computer. On Windows,
open **Remote Desktop Connection** and connect to `frame` (or the hostname shown
in Frame's settings). Choose **Xorg**, sign in as `steamos`, and enter the password
you just set. Keep Frame and your computer on the same network.

See Valve's [setup instructions](https://partner.steamgames.com/doc/steamhardware/steamframe/setup)
and [desktop access guide](https://partner.steamgames.com/doc/steamhardware/steamframe/debugging#remote-desktop)
if you need help connecting.

## Install

1. Download `VRWatch-0.1.1-Steam-Frame.tar.xz` onto Frame, or transfer the file
   there from your computer.
2. Extract it. Open the resulting `VRWatch-0.1.1` folder.
3. Close VRWatch if it is already running. Open a terminal in this folder and run:

   ```sh
   bash "Install VRWatch.sh"
   ```

4. Wait for **Installed VRWatch**. The installer adds its shortcut and icon.
5. Return to your Steam library and launch **VRWatch**.

Run the installer as the normal `steamos` user. It installs in your home folder
and checks the included browser's files before using them. It doesn't need sudo.

The included browser uses hardware decoding for compatible H.264 video. VP9 and
AV1 use software decoding; HEVC playback isn't supported by this release's
hardware path. Video compatibility also depends on the website and file format.

## Update

Close VRWatch, download the next Steam Frame package, extract it and run its
installer. Bookmarks, history and browsing settings stay in your browser profile.
Keep the previous package if you want to reinstall it later.

## If something doesn't work

- **Wrong computer:** run the installer on Frame, not your Windows PC or Steam Deck.
- **No shortcut:** close and reopen Steam's library. The installer also creates
  a desktop launcher. Include the installer error when reporting a missing shortcut.
- **No VR button:** start the site's video first. Some protected streams and
  embedded players can't be used by VRWatch.
- **Wrong picture:** open **⋯** beside the video and choose the matching 180°,
  360° or stereo format.
- **Stuttering video:** try a lower resolution or a compatible H.264 version.
  Other codecs may need more CPU work or may not play.

This is an early preview. For a bug report, include the VRWatch version, what you
clicked and what happened. Leave out passwords, private video links and personal
browser data. See [how to report a problem](CONTRIBUTING.md#report-a-problem).

The preview uses a Frame compatibility setting that reduces browser isolation.
Review the release notes before using it for sensitive accounts.

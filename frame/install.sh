#!/usr/bin/env bash
# Install the built application on Steam Frame. Does not build Chromium.
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd)
root=$(cd "$here/.." && pwd)
bundled_runtime=
if [[ ${1:-} == --bundled-runtime ]]; then
  [[ $# == 2 && -d $2 ]] || { echo 'usage: frame/install.sh --bundled-runtime BROWSER_DIRECTORY' >&2; exit 2; }
  bundled_runtime=$(cd "$2" && pwd)
  channel=bundled
else
  channel=${1:-auto}
  case $channel in auto|stable|beta|unstable|canary|--reuse-chrome-xr) ;; *) echo 'usage: frame/install.sh [auto|stable|beta|unstable|canary|--reuse-chrome-xr]' >&2; exit 2 ;; esac
  [[ $# -le 1 ]] || exit 2
fi
[[ $(uname -m) == aarch64 ]] || { echo 'Install this on the Steam Frame (ARM64).' >&2; exit 1; }
[[ -f $root/dist/manifest.json && -f $root/dist/content.js && -f $root/dist/icons/icon512.png && -f $root/branding/app.json ]] || { echo 'Run npm ci && npm run build before copying this project to the Frame.' >&2; exit 1; }
state=$HOME/.local/share/vrwatch
if [[ -n $bundled_runtime ]]; then
  python3 "$here/verify-runtime.py" "$bundled_runtime"
fi
mkdir -p "$state" "$HOME/.local/bin" "$HOME/.local/share/applications"

if [[ $channel == --reuse-chrome-xr ]]; then
  browser=$HOME/chrome-xr/chrome
  [[ -x $browser ]] || { echo 'Existing Chrome XR browser not found.' >&2; exit 1; }
  "$browser" --version
  printf '%s\n' 'Existing Chrome XR runtime (managed by its original installer)' > "$state/installed"
else
  stage=$(mktemp -d "$state/download.XXXXXX")
  trap 'rm -rf "$stage"' EXIT
  if [[ -n $bundled_runtime ]]; then
    cp -R "$bundled_runtime/." "$stage/browser"
    "$stage/browser/vrwatch-chromium" --version
    installed='Bundled VRWatch hardware-decoding Chromium runtime'
  else
    installed=$(python3 "$here/fetch-browser.py" "$channel" "$stage/browser")
    "$stage/browser/chrome" --version
  fi
  [[ ! -e $state/browser.previous ]] || { echo 'A previous browser backup exists; inspect it before updating.' >&2; exit 1; }
  if [[ -d $state/browser ]]; then mv "$state/browser" "$state/browser.previous"; fi
  if ! mv "$stage/browser" "$state/browser"; then
    [[ ! -d $state/browser.previous ]] || mv "$state/browser.previous" "$state/browser"
    exit 1
  fi
  rm -rf "$state/browser.previous"
  if [[ -n $bundled_runtime ]]; then browser=$state/browser/vrwatch-chromium
  else browser=$state/browser/chrome; fi
  printf '%s\n' "$installed" > "$state/installed"
fi

printf '%s\n' "$browser" > "$state/browser-path"
rm -rf "$state/extension.new"
cp -R "$root/dist/." "$state/extension.new"
rm -rf "$state/extension"
mv "$state/extension.new" "$state/extension"
install -m 644 "$here/extension-id" "$state/extension-id"
install -m 644 "$root/dist/icons/icon512.png" "$state/app-icon.png"
install -m 644 "$root/branding/app.json" "$state/app.json"
for size in 16 32 48 128 512; do
  icon_dir=$HOME/.local/share/icons/hicolor/${size}x${size}/apps
  mkdir -p "$icon_dir"
  install -m 644 "$root/dist/icons/icon${size}.png" "$icon_dir/vrwatch.png"
done
install -m 755 "$here/vrwatch" "$HOME/.local/bin/vrwatch"
install -m 755 "$here/steam-shortcut.py" "$state/steam-shortcut.py"
install -m 755 "$here/browser-host.py" "$state/browser-host.py"
install -m 755 "$here/library-server.py" "$state/library-server.py"
install -m 755 "$here/mount-nas.py" "$state/mount-nas.py"
install -m 755 "$here/app-identity.py" "$state/app-identity.py"
install -m 755 "$here/browser_input.py" "$state/browser_input.py"
mkdir -p "$state/browser-input"
install -m 644 "$here/browser-input/"*.json "$state/browser-input/"
install -m 644 "$here/frame_panel.py" "$state/frame_panel.py"
cat > "$HOME/.local/share/applications/vrwatch.desktop" <<EOF
[Desktop Entry]
Type=Application
Name=VRWatch
GenericName=VR Video Player
Comment=Video browser and immersive VR player
Exec="$HOME/.local/bin/vrwatch"
Icon=vrwatch
Terminal=false
Categories=AudioVideo;Video;
Keywords=VR;WebXR;Video;360;VR180;
StartupWMClass=VRWatch
EOF
if ! python3 "$here/steam-shortcut.py" ensure 'VRWatch' "$HOME/.local/bin/vrwatch" "$HOME" "$state/app-icon.png" "$state/steam-appid"; then
  echo 'Add VRWatch through Steam → Games → Add a Non-Steam Game.' >&2
fi
python3 "$state/app-identity.py" manifest "$state"
if ! python3 "$state/app-identity.py" register "$state"; then
  echo 'SteamVR app metadata will be registered automatically on launch.' >&2
fi
if command -v update-desktop-database >/dev/null; then update-desktop-database "$HOME/.local/share/applications"; fi
if command -v gtk-update-icon-cache >/dev/null; then gtk-update-icon-cache -f -t "$HOME/.local/share/icons/hicolor"; fi
echo 'Installed VRWatch. Launch VRWatch from Steam; its UI loads automatically.'
echo 'No extension setup or Chromium compilation is required.'

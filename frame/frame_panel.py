"""Keep the Chrome window associated with its Frame panel across WebXR sessions."""
import re
import subprocess
import time


def tag_browser_window(pid, appid):
    deadline = time.monotonic() + 5
    while time.monotonic() < deadline:
        tree = subprocess.check_output(['xwininfo', '-root', '-tree'], text=True, timeout=2)
        owned = []
        for window in re.findall(r'^\s+(0x[0-9a-fA-F]+) ', tree, re.MULTILINE):
            result = subprocess.run(['xprop', '-id', window, '_NET_WM_PID', 'WM_CLASS'], capture_output=True, text=True, timeout=2)
            if result.returncode:
                continue  # A transient window may close between enumeration and inspection.
            properties = result.stdout
            match = re.search(r'_NET_WM_PID\(CARDINAL\) = (\d+)', properties)
            if match and int(match[1]) == pid and re.search(r'WM_CLASS.*(?:chrome|VRWatch)', properties, re.IGNORECASE):
                subprocess.run(['xprop', '-id', window, '-f', 'STEAM_GAME', '32c', '-set', 'STEAM_GAME', str(appid)], check=True, timeout=2)
                owned.append(window)
        if owned:
            return owned[0]
        time.sleep(0.1)
    raise RuntimeError('Chrome app window not found for Frame panel registration')


def show_browser_panel(state, appid, helper_directory=None):
    subprocess.run(['python3', str((helper_directory or state) / 'steam-shortcut.py'), 'show-browser', str(appid)], check=True, timeout=10)


def hide_dashboard(state, helper_directory=None):
    subprocess.run(['python3', str((helper_directory or state) / 'steam-shortcut.py'), 'hide-dashboard'], check=True, timeout=10)

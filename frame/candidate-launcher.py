#!/usr/bin/env python3
"""Ordinary candidate launch; explicit staged release, closed profile and state.

No installer, component provisioning, Chromium DevTools or diagnostic relay.
Steam dashboard restoration retains the existing Steam-client transport.
The production launcher remains frame/vrwatch until device acceptance.
"""
import argparse
import fcntl
import json
import os
import signal
import subprocess
import sys
import time
import uuid
from pathlib import Path

# Release inventories are immutable, including helper directories.
sys.dont_write_bytecode = True


def command(release, profile, *, bridge_only=False):
    return [str(release / 'vrwatch-chromium'), '--user-data-dir=' + str(profile),
            '--enable-features=OpenXR', '--class=VRWatch', '--ozone-platform=x11',
            '--touch-events=enabled', '--no-first-run', '--no-default-browser-check',
            '--disable-features=NtpFooter', '--disable-gpu-rasterization',
            '--disable-seccomp-filter-sandbox', '--test-type=vrwatch',
            '--vrwatch-native', *([] if bridge_only else ['--vrwatch-hud']),
            '--new-window', 'chrome-extension://bkjijegjmneghekcknijmioimbahmfap/home.html?startup=1']


def validate(release, profile, state):
    # Helpers are packaged with the release's verifier and provenance module.
    from release import verify_tree, identity, EXTENSION_ID
    manifest = verify_tree(release, 'vrwatch-release.json')
    if manifest['bridgeProtocol'] != 1:
        raise ValueError('Candidate requires the integrated native protocol')
    extension = json.loads((release / 'vrwatch-extension/manifest.json').read_text())
    if identity(extension) != EXTENSION_ID or extension['version'] != manifest['bundleVersion']:
        raise ValueError('Candidate extension identity/version mismatch')
    host = json.loads((release / 'native-messaging/com.vrwatch.bridge.json').read_text())
    if host['path'] != str(release / 'helpers/native-host.py') or host['allowed_origins'] != ['chrome-extension://' + EXTENSION_ID + '/']:
        raise ValueError('Candidate native registration mismatch')
    if not all((release / name).is_file() for name in ('chrome', 'vrwatch-chromium', 'vrwatch-extension/hud.js')):
        raise ValueError('Candidate runtime/HUD missing')
    for path in (profile / 'SingletonLock',):
        if path.exists() or path.is_symlink():
            raise ValueError('Close the profile before candidate launch')
    if profile.is_relative_to(Path.home() / '.config/vrwatch') or state.is_relative_to(Path.home() / '.local/share/vrwatch'):
        raise ValueError('Use an isolated candidate profile and state until acceptance')
    if not (state / 'steam-appid').is_file() or not (state / 'app.json').is_file():
        raise ValueError('Candidate state needs steam-appid and app.json/artwork copied from the installation')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--release', type=Path, required=True)
    parser.add_argument('--profile', type=Path, required=True)
    parser.add_argument('--state', type=Path, required=True)
    parser.add_argument('--bridge-only', action='store_true', help='Native bridge with ordinary desktop chrome for independent comparison')
    parser.add_argument('--check', action='store_true', help='Validate and print argv without launching')
    args = parser.parse_args()
    release, profile, state = (p.resolve() for p in (args.release, args.profile, args.state))
    validate(release, profile, state)
    argv = command(release, profile, bridge_only=args.bridge_only)
    if args.check:
        print(json.dumps(argv)); return
    profile.mkdir(parents=True, exist_ok=True)
    with (profile / '.vrwatch-candidate.lock').open('a') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        validate(release, profile, state)
        environment = dict(os.environ, VRWATCH_STATE=str(state), CHROME_DESKTOP='vrwatch.desktop')
        token = uuid.uuid4().hex
        environment['VRWATCH_LAUNCH_TOKEN'] = token
        ready = state / ('native-ready-' + token + '.json')
        environment.pop('VRWATCH_TEST_RELAY', None)
        preload = environment.get('LD_PRELOAD', '').replace(':', ' ').split()
        environment['LD_PRELOAD'] = ':'.join(p for p in preload if 'gameoverlayrenderer.so' not in p)
        browser = subprocess.Popen(argv, env=environment, start_new_session=True)
        identity = subprocess.Popen([sys.executable, str(release / 'helpers/app-identity.py'), 'watch', str(state), str(browser.pid)], env=environment)
        def terminate(*_):
            try: os.killpg(browser.pid, signal.SIGTERM)
            except ProcessLookupError: pass
        for sig in (signal.SIGTERM, signal.SIGINT, signal.SIGHUP): signal.signal(sig, terminate)
        try:
            deadline = time.monotonic() + 30
            while browser.poll() is None and not ready.exists() and time.monotonic() < deadline:
                time.sleep(0.1)
            if not ready.exists() or json.loads(ready.read_text()) != {'protocol': 1, 'browserPid': browser.pid}:
                raise ValueError('Native startup handshake failed: inspect component/native-host diagnostics; preserved runtime remains selected')
            return browser.wait()
        finally:
            terminate()
            try: browser.wait(timeout=3)
            except subprocess.TimeoutExpired:
                try: os.killpg(browser.pid, signal.SIGKILL)
                except ProcessLookupError: pass
                browser.wait()
            identity.terminate()
            try: identity.wait(timeout=3)
            except subprocess.TimeoutExpired: identity.kill(); identity.wait()
            ready.unlink(missing_ok=True)


if __name__ == '__main__':
    try:
        sys.exit(main())
    except (OSError, ValueError, KeyError) as error:
        sys.exit('VRWatch candidate: ' + str(error))

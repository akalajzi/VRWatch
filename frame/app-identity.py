#!/usr/bin/env python3
"""Register VRWatch artwork and identify only its own XR service in SteamVR.

Uses Valve's IVRApplications_008 C function table (openvr_capi.h):
https://github.com/ValveSoftware/openvr/blob/master/headers/openvr_capi.h
Desktop
WM_CLASS and the Steam shortcut alone don't name Chrome's OpenXR process.
"""
import ctypes as C
import json
import os
import platform
import sys
import time
from pathlib import Path


def write_manifest(state):
    metadata = json.loads((state / 'app.json').read_text())
    app = {
        'app_key': metadata['steamvr_app_key'],
        'image_path': str(state / metadata['icon']),
        'strings': {'en_us': {'name': metadata['name'], 'description': metadata['description']}},
    }
    if (state / 'steam-appid').exists():
        appid = int((state / 'steam-appid').read_text().strip())
        if not 0 < appid <= 0xffffffff:
            raise ValueError('Invalid Steam app id')
        app.update(launch_type='url', url=f'steam://launch/{appid}/VR')
    else:
        app.update(launch_type='binary', binary_path_linux=str(Path.home() / '.local/bin/vrwatch'))
    manifest = state / 'vrwatch.vrmanifest'
    manifest.write_text(json.dumps({'source': 'vrwatch', 'applications': [app]}, indent=2) + '\n')
    return manifest, metadata['steamvr_app_key']


class Applications:
    def __init__(self):
        paths = json.loads((Path.home() / '.config/openvr/openvrpaths.vrpath').read_text())
        arch = 'linuxarm64' if platform.machine() == 'aarch64' else 'linux64'
        library = next((Path(runtime) / 'bin' / arch / 'libopenvr_api.so'
                        for runtime in paths['runtime']
                        if (Path(runtime) / 'bin' / arch / 'libopenvr_api.so').is_file()), None)
        if library is None:
            raise RuntimeError('SteamVR OpenVR library not found')
        self.lib = C.CDLL(str(library))
        self.lib.VR_InitInternal2.argtypes = [C.POINTER(C.c_int), C.c_int, C.c_char_p]
        self.lib.VR_InitInternal2.restype = C.c_uint32
        self.lib.VR_ShutdownInternal.argtypes = []
        self.lib.VR_ShutdownInternal.restype = None
        self.lib.VR_GetGenericInterface.argtypes = [C.c_char_p, C.POINTER(C.c_int)]
        self.lib.VR_GetGenericInterface.restype = C.c_void_p
        error = C.c_int()
        # Background clients neither take over the scene nor start SteamVR.
        self.lib.VR_InitInternal2(C.byref(error), 3, None)
        if error.value:
            raise RuntimeError(f'SteamVR initialization failed ({error.value})')
        table = self.lib.VR_GetGenericInterface(b'FnTable:IVRApplications_008', C.byref(error))
        if error.value or not table:
            self.close()
            raise RuntimeError(f'SteamVR application interface unavailable ({error.value})')
        functions = C.cast(table, C.POINTER(C.c_void_p))
        self.add_manifest = C.CFUNCTYPE(C.c_int, C.c_char_p, C.c_bool)(functions[0])
        self.get_key = C.CFUNCTYPE(C.c_int, C.c_uint32, C.c_char_p, C.c_uint32)(functions[5])
        self.identify = C.CFUNCTYPE(C.c_int, C.c_uint32, C.c_char_p)(functions[11])
        self.get_property = C.CFUNCTYPE(C.c_uint32, C.c_char_p, C.c_int, C.c_char_p,
                                       C.c_uint32, C.POINTER(C.c_int))(functions[14])

    def close(self):
        self.lib.VR_ShutdownInternal()

    def register(self, manifest):
        error = self.add_manifest(os.fsencode(manifest), False)
        if error:
            raise RuntimeError(f'SteamVR manifest registration failed ({error})')

    def identify_if_connected(self, pid, key):
        current = C.create_string_buffer(128)
        if self.get_key(pid, current, len(current)):
            return False  # The XR service has not connected to SteamVR yet.
        if current.value == key.encode():
            return False
        error = self.identify(pid, key.encode())
        if error:
            raise RuntimeError(f'SteamVR process identification failed ({error})')
        print(f'VRWatch identified XR process {pid} as {key}.', file=sys.stderr, flush=True)
        return True


def xr_processes(browser_pid, proc=Path('/proc')):
    """Use ancestry, not executable name: Chrome XR and VRWatch share a binary."""
    parents = {}
    candidates = []
    for directory in proc.iterdir():
        if not directory.name.isdigit():
            continue
        try:
            pid = int(directory.name)
            parents[pid] = int((directory / 'stat').read_text().rsplit(')', 1)[1].split()[1])
            # Chromium rewrites its process title into one space-separated
            # argv entry. Handle that as well as normal NUL-separated argv.
            args = (directory / 'cmdline').read_bytes().replace(b'\0', b' ').split()
            if b'--utility-sub-type=device.mojom.XRDeviceService' in args:
                candidates.append(pid)
        except (OSError, ValueError, IndexError):
            continue  # Processes can exit while /proc is being read.
    owned = []
    for pid in candidates:
        parent = pid
        visited = set()
        while parent in parents and parent not in visited:
            visited.add(parent)
            parent = parents[parent]
            if parent == browser_pid:
                owned.append(pid)
                break
    return owned


def watch(state, browser_pid):
    manifest, key = write_manifest(state)
    applications = None
    warned = False
    try:
        while Path(f'/proc/{browser_pid}').exists():
            try:
                if applications is None:
                    applications = Applications()
                    applications.register(manifest)
                for pid in xr_processes(browser_pid):
                    applications.identify_if_connected(pid, key)
                time.sleep(0.5)
            except (OSError, ValueError, RuntimeError) as error:
                if not warned:
                    print(f'VRWatch SteamVR identity: {error}; retrying.', file=sys.stderr, flush=True)
                    warned = True
                if applications is not None:
                    applications.close()
                    applications = None
                time.sleep(5)
    finally:
        if applications is not None:
            applications.close()


def main():
    state = Path(sys.argv[2]).resolve()
    if sys.argv[1] == 'manifest':
        print(write_manifest(state)[0])
    elif sys.argv[1] == 'register':
        manifest, _ = write_manifest(state)
        applications = Applications()
        try:
            applications.register(manifest)
        finally:
            applications.close()
    elif sys.argv[1] == 'watch':
        watch(state, int(sys.argv[3]))
    else:
        raise ValueError('Usage: app-identity.py manifest|register|watch STATE [BROWSER_PID]')


if __name__ == '__main__':
    main()

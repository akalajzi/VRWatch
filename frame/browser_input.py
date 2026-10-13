#!/usr/bin/env python3
"""Read Frame thumbsticks as an OpenVR overlay client; emit no scene or window.

ABI: Valve's openvr_capi.h, IVRInput_010 / IVRApplications_008.
The browser receives samples only in its private extension execution worlds.
"""
import ctypes as C
import json
import math
import os
import platform
import select
import signal
import sys
import time
from pathlib import Path


class ActiveSet(C.Structure):
    _fields_ = [('action_set', C.c_uint64), ('restricted', C.c_uint64),
                ('secondary', C.c_uint64), ('padding', C.c_uint32), ('priority', C.c_int32)]


class Analog(C.Structure):
    _fields_ = [('active', C.c_bool), ('origin', C.c_uint64),
                ('x', C.c_float), ('y', C.c_float), ('z', C.c_float),
                ('dx', C.c_float), ('dy', C.c_float), ('dz', C.c_float), ('time', C.c_float)]


def sample_pad(index, value):
    # OpenVR Y points up; browser gamepad Y points down. Never relay NaN.
    axis = -value.y if value.active and math.isfinite(value.y) else 0
    return {'index': index, 'mapping': 'standard', 'connected': bool(value.active),
            'axes': [0, max(-1, min(1, axis))]}


class Thumbsticks:
    def __init__(self, state, action_directory=None, app_key='vrwatch.browser-input'):
        paths = json.loads((Path.home() / '.config/openvr/openvrpaths.vrpath').read_text())
        arch = 'linuxarm64' if platform.machine() == 'aarch64' else 'linux64'
        library = next((Path(runtime) / 'bin' / arch / 'libopenvr_api.so'
                        for runtime in paths['runtime']
                        if (Path(runtime) / 'bin' / arch / 'libopenvr_api.so').is_file()), None)
        if library is None:
            raise RuntimeError('SteamVR OpenVR library not found')
        self.lib = C.CDLL(str(library))
        self.lib.VR_InitInternal2.argtypes = [C.POINTER(C.c_int), C.c_int, C.c_char_p]
        self.lib.VR_GetGenericInterface.argtypes = [C.c_char_p, C.POINTER(C.c_int)]
        self.lib.VR_GetGenericInterface.restype = C.c_void_p
        self.lib.VR_ShutdownInternal.argtypes = []
        error = C.c_int()
        self.lib.VR_InitInternal2(C.byref(error), 2, None)  # Overlay, never scene.
        if error.value:
            raise RuntimeError(f'SteamVR initialization failed ({error.value})')
        try:
            def table(name):
                pointer = self.lib.VR_GetGenericInterface(('FnTable:' + name).encode(), C.byref(error))
                if error.value or not pointer:
                    raise RuntimeError(f'{name} unavailable ({error.value})')
                return C.cast(pointer, C.POINTER(C.c_void_p))
            applications = table('IVRApplications_008')
            add = C.CFUNCTYPE(C.c_int, C.c_char_p, C.c_bool)(applications[0])
            identify = C.CFUNCTYPE(C.c_int, C.c_uint32, C.c_char_p)(applications[11])
            self.remove = C.CFUNCTYPE(C.c_int, C.c_char_p)(applications[1])
            manifest = state / 'browser-input.vrmanifest'
            actions = (action_directory or state / 'browser-input') / 'actions.json'
            # This companion has no separate launch UI; its URL reopens VRWatch.
            manifest.write_text(json.dumps({'source': 'vrwatch', 'applications': [{
                'app_key': app_key, 'launch_type': 'url',
                'url': 'steam://launch/' + (state / 'steam-appid').read_text().strip() + '/VR',
                'action_manifest_path': str(actions), 'is_dashboard_overlay': True,
                'strings': {'en_us': {'name': 'VRWatch browser input'}},
            }]}))
            self.manifest = os.fsencode(manifest)
            self.check(add(self.manifest, True), 'Register browser input')
            self.check(identify(os.getpid(), app_key.encode()), 'Identify browser input')
            inputs = table('IVRInput_010')
            self.input_functions = inputs
            set_manifest = C.CFUNCTYPE(C.c_int, C.c_char_p)(inputs[0])
            get_set = C.CFUNCTYPE(C.c_int, C.c_char_p, C.POINTER(C.c_uint64))(inputs[1])
            get_action = C.CFUNCTYPE(C.c_int, C.c_char_p, C.POINTER(C.c_uint64))(inputs[2])
            self.update = C.CFUNCTYPE(C.c_int, C.POINTER(ActiveSet), C.c_uint32, C.c_uint32)(inputs[4])
            self.read = C.CFUNCTYPE(C.c_int, C.c_uint64, C.POINTER(Analog), C.c_uint32, C.c_uint64)(inputs[6])
            self.check(set_manifest(os.fsencode(actions)), 'Load thumbstick actions')
            handle = C.c_uint64()
            self.check(get_set(b'/actions/browser', C.byref(handle)), 'Get browser action set')
            self.active = ActiveSet(action_set=handle.value)
            self.actions = []
            for hand in ('left', 'right'):
                self.check(get_action(('/actions/browser/in/' + hand).encode(), C.byref(handle)), 'Get thumbstick action')
                self.actions.append(handle.value)
        except Exception:
            self.close()
            raise

    @staticmethod
    def check(error, operation):
        if error:
            raise RuntimeError(f'{operation} failed ({error})')

    def sample(self, enabled=True):
        if not enabled:
            error = self.update(None, C.sizeof(ActiveSet), 0)
            if error != 8:  # VRInputError_NoActiveActionSet is the intended disabled state.
                self.check(error, 'Release browser input')
            return []
        self.check(self.update(C.byref(self.active), C.sizeof(self.active), 1), 'Update thumbsticks')
        pads = []
        for index, action in enumerate(self.actions):
            value = Analog()
            self.check(self.read(action, C.byref(value), C.sizeof(value), 0), 'Read thumbstick')
            pads.append(sample_pad(index, value))
        return pads

    def close(self):
        if getattr(self, 'manifest', None):
            self.remove(self.manifest)
            self.manifest = None
        self.lib.VR_ShutdownInternal()


def main():
    signal.signal(signal.SIGTERM, lambda *_: sys.exit(0))
    reader = None
    warned = False
    enabled = False
    commands = b''
    try:
        while True:
            try:
                if reader is None:
                    reader = Thumbsticks(Path(sys.argv[1]).resolve())
                # The host enables the action set only while one of its pages
                # is focused and outside XR; disabled samples keep the relay alive.
                if select.select([sys.stdin], [], [], 0)[0]:
                    chunk = os.read(sys.stdin.fileno(), 4096)
                    if not chunk:
                        return
                    commands += chunk
                    while b'\n' in commands:
                        command, commands = commands.split(b'\n', 1)
                        enabled = command.strip() == b'1'
                print(json.dumps(reader.sample(enabled), separators=(',', ':')), flush=True)
                time.sleep(0.05)
                warned = False
            except (OSError, ValueError, RuntimeError) as error:
                if not warned:
                    print('VRWatch thumbstick input: ' + str(error) + '; retrying.', file=sys.stderr, flush=True)
                    warned = True
                if reader is not None:
                    reader.close()
                    reader = None
                print('[]', flush=True)
                time.sleep(5)
    except BrokenPipeError:
        pass
    finally:
        if reader is not None:
            reader.close()


if __name__ == '__main__':
    main()

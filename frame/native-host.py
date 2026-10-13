#!/usr/bin/env python3
"""Candidate native-messaging host. Never installs or launches a browser.

Bounded length-prefixed JSON protocol; stdout is reserved for messages.
The existing OpenVR and window helpers remain external and reusable.
"""
import json
import fcntl
import os
import queue
import struct
import sys
import threading
import signal
import re
from pathlib import Path

# Native helper imports must not add cache files to the immutable release.
sys.dont_write_bytecode = True

ORIGIN = 'chrome-extension://bkjijegjmneghekcknijmioimbahmfap/'
MAX_MESSAGE = 65536


def read_exact(stream, count):
    data = b''
    while len(data) < count:
        chunk = stream.read(count - len(data))
        if not chunk:
            if not data:
                return None
            raise ValueError('Truncated native message')
        data += chunk
    return data


def read_message(stream):
    header = read_exact(stream, 4)
    if header is None:
        return None
    size, = struct.unpack('=I', header)
    if not 0 < size <= MAX_MESSAGE:
        raise ValueError('Native message size out of bounds')
    payload = read_exact(stream, size)
    if payload is None:
        raise ValueError('Truncated native message')
    value = json.loads(payload)
    if not isinstance(value, dict) or value.get('protocol') != 1:
        raise ValueError('Unsupported native protocol')
    return value


def write_message(stream, value):
    data = json.dumps({'protocol': 1, **value}, allow_nan=False, separators=(',', ':')).encode()
    if len(data) > MAX_MESSAGE:
        raise ValueError('Native message too large')
    stream.write(struct.pack('=I', len(data)) + data)
    stream.flush()


def browser_parent():
    # Native messaging is launched by the browser. No page-supplied PID or path.
    pid = os.getppid()
    expected = Path(__file__).resolve().parent.parent / 'chrome'
    if Path(f'/proc/{pid}/exe').resolve() != expected.resolve():
        raise RuntimeError('Native host parent is not the staged Chromium')
    return pid


class HostState:
    """Reconnect reconciliation; EOF never becomes an XR exit."""
    def __init__(self, hide, restore, restored=0):
        self.hide = hide
        self.restore = restore
        self.restored = restored
        self.xr = False
        self.enabled = False

    def update(self, message):
        if (message.get('type') != 'state' or type(message.get('enabled')) is not bool
                or type(message.get('xr')) is not bool
                or type(message.get('restoreSequence')) is not int
                or not 0 <= message['restoreSequence'] <= 2147483647):
            raise ValueError('Invalid native state')
        next_xr = message['xr']
        if next_xr and not self.xr:
            self.hide()
        self.xr = next_xr
        self.enabled = message['enabled'] and not self.xr
        sequence = message['restoreSequence']
        if self.enabled and sequence > self.restored:
            self.restore(sequence)
            self.restored = sequence


def main():
    if len(sys.argv) != 2 or sys.argv[1] != ORIGIN:
        raise RuntimeError('Native host origin rejected')
    from native_input import NativeInput
    from frame_panel import tag_browser_window, hide_dashboard, show_browser_panel
    state = Path(os.environ['VRWATCH_STATE'])
    appid = int((state / 'steam-appid').read_text().strip())
    if not 0 < appid <= 0xffffffff:
        raise ValueError('Invalid Steam app id')
    pid = browser_parent()
    launch_token = os.environ.get('VRWATCH_LAUNCH_TOKEN', '')
    if not re.fullmatch(r'[0-9a-f]{32}', launch_token):
        raise ValueError('Candidate launch token missing')
    # A reconnect cannot register duplicate OpenVR actions while an old helper
    # is still unwinding. Browser process exit closes the native pipe.
    lock = (state / 'native-input.lock').open('a')
    fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
    signal.signal(signal.SIGTERM, lambda *_: sys.exit(0))
    tag_browser_window(pid, appid)
    messages = queue.Queue(maxsize=64)
    def receive():
        try:
            # A daemon blocked in BufferedReader.read holds the stdin lock at
            # interpreter shutdown, causing _enter_buffered_busy on startup
            # failure or SIGTERM. Raw reads preserve framing without that lock.
            with os.fdopen(os.dup(sys.stdin.fileno()), 'rb', buffering=0) as stream:
                while (message := read_message(stream)) is not None:
                    messages.put(message)
        finally:
            messages.put(None)
    threading.Thread(target=receive, daemon=True).start()
    reader = None
    start = Path(f'/proc/{pid}/stat').read_text().rsplit(')', 1)[1].split()[19]
    receipt = state / f'native-restore-{pid}-{start}.json'
    restored = json.loads(receipt.read_text()) if receipt.exists() else 0
    def restore(sequence):
        show_browser_panel(state, appid, Path(__file__).parent)
        temporary = receipt.with_suffix('.tmp')
        temporary.write_text(json.dumps(sequence))
        temporary.replace(receipt)
    host = HostState(lambda: hide_dashboard(state, Path(__file__).parent), restore, restored)
    announced = False
    try:
        reader = NativeInput(state)
        write_message(sys.stdout.buffer, {'type': 'hello', 'capabilities': ['pads', 'dashboard', 'hud']})
        while True:
            try:
                message = messages.get(timeout=0.05)
                if message is None:
                    break
                host.update(message)
                if not announced:
                    ready = state / ('native-ready-' + launch_token + '.json')
                    temporary = ready.with_suffix('.tmp')
                    temporary.write_text(json.dumps({'protocol': 1, 'browserPid': pid}))
                    temporary.replace(ready)
                    announced = True
            except queue.Empty:
                pass
            write_message(sys.stdout.buffer, {'type': 'pads', 'pads': reader.sample(host.enabled)})
            for view in reader.hud_actions(host.enabled):
                write_message(sys.stdout.buffer, {'type': 'hud', 'view': view})
    finally:
        if reader:
            reader.close()
        lock.close()
        # Disconnect releases input; it is not an XR-ended signal. Do not focus
        # arbitrary windows or restore the dashboard on a lost transport.


if __name__ == '__main__':
    try:
        main()
    except (ValueError, OSError, RuntimeError) as error:
        print(f'VRWatch native bridge: {error}', file=sys.stderr)
        sys.exit(1)

#!/usr/bin/env python3
# SPDX-License-Identifier: MPL-2.0
"""Verify a release runtime before installation. Reads files without executing them."""
import hashlib
import json
import stat
import sys
from pathlib import Path, PurePosixPath


def verify(root):
    root = Path(root)
    manifest = json.loads((root / 'vrwatch-runtime.json').read_text())
    if manifest.get('schema') != 3 or manifest.get('architecture') != 'linux-arm64':
        raise ValueError('Unsupported browser package')
    expected = manifest.get('files')
    if not isinstance(expected, dict) or not expected:
        raise ValueError('Missing browser file checksums')
    actual = {}
    for path in root.rglob('*'):
        if path.is_symlink():
            raise ValueError('Browser package contains a symlink')
        if path.is_file() and path != root / 'vrwatch-runtime.json':
            with path.open('rb') as stream:
                actual[path.relative_to(root).as_posix()] = hashlib.file_digest(stream, 'sha256').hexdigest()
        elif not path.is_dir() and path != root / 'vrwatch-runtime.json':
            raise ValueError('Browser package contains a special file')
    for name in expected:
        path = PurePosixPath(name)
        if path.is_absolute() or '..' in path.parts or path.as_posix() != name:
            raise ValueError('Unsafe browser checksum path')
    if actual != expected:
        raise ValueError('Browser checksum mismatch; extract a fresh package')
    chrome = root / 'chrome'
    with chrome.open('rb') as stream:
        header = stream.read(20)
    if header[:6] != b'\x7fELF\x02\x01' or header[18:20] != b'\xb7\x00':
        raise ValueError('Browser is not an ARM64 Linux executable')
    for name in ('chrome', 'vrwatch-chromium'):
        if not (root / name).stat().st_mode & stat.S_IXUSR:
            raise ValueError('Browser executable permission is missing')
    return manifest


if __name__ == '__main__':
    try:
        if len(sys.argv) != 2:
            raise ValueError('Usage: verify-runtime.py BROWSER_DIRECTORY')
        verify(sys.argv[1])
        print('Included browser checksums and architecture verified.')
    except (OSError, ValueError, KeyError) as error:
        raise SystemExit(f'Browser verification failed: {error}')

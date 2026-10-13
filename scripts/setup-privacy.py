#!/usr/bin/env python3
# SPDX-License-Identifier: MPL-2.0
"""Install a checksummed secret scanner and enable this clone's Git hooks."""
import argparse
import hashlib
import io
import platform
import subprocess
import tarfile
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
CHECKSUMS = {
    'linux_x64': '551f6fc83ea457d62a0d98237cbad105af8d557003051f41f3e7ca7b3f2470eb',
    'linux_arm64': 'e4a487ee7ccd7d3a7f7ec08657610aa3606637dab924210b3aee62570fb4b080',
    'darwin_x64': 'dfe101a4db2255fc85120ac7f3d25e4342c3c20cf749f2c20a18081af1952709',
    'darwin_arm64': 'b40ab0ae55c505963e365f271a8d3846efbc170aa17f2607f13df610a9aeb6a5',
}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--repo', type=Path, default=ROOT)
    parser.add_argument('--scanner-only', action='store_true')
    args = parser.parse_args()
    machine = {'x86_64': 'x64', 'aarch64': 'arm64', 'arm64': 'arm64'}.get(platform.machine())
    target = platform.system().lower() + '_' + str(machine)
    if target not in CHECKSUMS:
        raise SystemExit('Use Linux, macOS or WSL for the privacy hooks.')
    cache = Path.home() / '.cache/vrwatch-tools/gitleaks-8.30.1' / target
    cache.mkdir(parents=True, exist_ok=True)
    archive = cache / 'release.tar.gz'
    if not archive.exists() or hashlib.sha256(archive.read_bytes()).hexdigest() != CHECKSUMS[target]:
        name = 'gitleaks_8.30.1_' + target + '.tar.gz'
        with urllib.request.urlopen('https://github.com/gitleaks/gitleaks/releases/download/v8.30.1/' + name, timeout=60) as response:
            data = response.read()
        if hashlib.sha256(data).hexdigest() != CHECKSUMS[target]:
            raise SystemExit('Scanner download checksum mismatch')
        archive.write_bytes(data)
    with tarfile.open(fileobj=io.BytesIO(archive.read_bytes()), mode='r:gz') as tar:
        member = tar.getmember('gitleaks')
        if not member.isfile():
            raise SystemExit('Unexpected scanner archive')
        binary = cache / 'gitleaks'
        binary.write_bytes(tar.extractfile(member).read())
        binary.chmod(0o755)
    subprocess.run(['git', '-C', str(args.repo), 'config', '--local', 'privacy.scanner', str(binary)], check=True)
    if not args.scanner_only:
        existing = subprocess.run(['git', '-C', str(args.repo), 'config', '--get', 'core.hooksPath'], capture_output=True, text=True).stdout.strip()
        hooks = str(ROOT / '.githooks')
        if existing and existing != hooks:
            raise SystemExit('Existing hooksPath retained; integrate the privacy hooks before proceeding')
        if not existing:
            default = subprocess.check_output(['git', '-C', str(args.repo), 'rev-parse', '--git-path', 'hooks'], text=True).strip()
            folder = Path(default)
            if not folder.is_absolute():
                folder = args.repo / folder
            if folder.exists() and any(p.is_file() and not p.name.endswith('.sample') for p in folder.iterdir()):
                raise SystemExit('Existing Git hooks retained; integrate the privacy hooks before proceeding')
        subprocess.run(['git', '-C', str(args.repo), 'config', '--local', 'core.hooksPath', hooks], check=True)
    print('Pinned scanner installed.' if args.scanner_only else 'Pinned scanner and commit/push privacy hooks installed for this clone.')


if __name__ == '__main__':
    main()

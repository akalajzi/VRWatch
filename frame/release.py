#!/usr/bin/env python3
"""Local immutable release preparation. No network, publishing, or production defaults."""
import argparse
import base64
import fcntl
import hashlib
import json
import os
import re
import shutil
import sys
import tarfile
import tempfile
from pathlib import Path

# Validation/launch must leave every byte of a staged release unchanged.
sys.dont_write_bytecode = True

from runtime_provenance import digest

REPO = Path(__file__).resolve().parent.parent
EXTENSION_ID = 'bkjijegjmneghekcknijmioimbahmfap'


def identity(manifest):
    key = base64.b64decode(manifest['key'], validate=True)
    return ''.join(chr(ord('a') + int(n, 16)) for n in hashlib.sha256(key).hexdigest()[:32])


def inventory(root, exclude=()):
    result = {}
    for path in sorted(root.rglob('*')):
        name = path.relative_to(root).as_posix()
        if path.is_symlink():
            raise ValueError('Symlinks are not allowed in artifacts')
        if path.is_file() and name not in exclude:
            result[name] = {'sha256': digest(path), 'size': path.stat().st_size}
    return result


def write_json(path, value):
    path.write_text(json.dumps(value, indent=2, sort_keys=True) + '\n')


def version(value):
    if not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9._-]{0,80}', value):
        raise ValueError('Unsafe version')
    return value


def archive(root, output):
    if output.exists():
        raise ValueError('Immutable artifact already exists')
    output.parent.mkdir(parents=True, exist_ok=True)
    descriptor, name = tempfile.mkstemp(prefix='.' + output.name, suffix='.tmp', dir=output.parent)
    os.close(descriptor)
    temporary = Path(name)
    try:
        with tarfile.open(temporary, 'w:xz', preset=3) as tar:
            for path in sorted(root.rglob('*')):
                if not path.is_file():
                    continue
                info = tar.gettarinfo(str(path), arcname=path.relative_to(root).as_posix())
                info.uid = info.gid = 0
                info.uname = info.gname = ''
                info.mtime = 0
                info.mode = 0o755 if os.access(path, os.X_OK) else 0o644
                with path.open('rb') as stream:
                    tar.addfile(info, stream)
        # Exclusive creation also protects two concurrent packaging processes.
        os.link(temporary, output)
        output.with_suffix(output.suffix + '.sha256').write_text(digest(output) + '  ' + output.name + '\n')
    finally:
        temporary.unlink(missing_ok=True)


def extract(archive_path, destination):
    with tarfile.open(archive_path, 'r:xz') as tar:
        names = set()
        for member in tar.getmembers():
            path = Path(member.name)
            if path.is_absolute() or '..' in path.parts or member.name in names or not member.isfile():
                raise ValueError('Unsafe or duplicate archive member')
            names.add(member.name)
            target = destination / path
            target.parent.mkdir(parents=True, exist_ok=True)
            with tar.extractfile(member) as source, target.open('xb') as output:
                shutil.copyfileobj(source, output)
            target.chmod(0o755 if member.mode & 0o111 else 0o644)


def verify_tree(root, manifest_name):
    manifest = json.loads((root / manifest_name).read_text())
    if manifest.get('files') != inventory(root, [manifest_name]):
        raise ValueError('Artifact file inventory/hash mismatch')
    return manifest


def bundle(dist, output, bundle_version):
    receipt = json.loads((dist / 'vrwatch-bundle-build.json').read_text())
    if receipt.get('schema') != 1:
        raise ValueError('Unsupported bundle build receipt')
    current_inputs = {}
    for directory in ['extension', 'licenses']:
        for name, value in inventory(REPO / directory).items():
            current_inputs[directory + '/' + name] = value['sha256']
    for name in ['package.json', 'package-lock.json', 'scripts/build.mjs', 'LICENSE', 'NOTICE.md']:
        current_inputs[name] = digest(REPO / name)
    if current_inputs != receipt['inputs']:
        raise ValueError('Extension build inputs changed; rebuild the bundle')
    actual = {name: value['sha256'] for name, value in inventory(dist, ['vrwatch-bundle-build.json']).items()}
    if actual != receipt['files']:
        raise ValueError('Stale extension output')
    manifest = json.loads((dist / 'manifest.json').read_text())
    if identity(manifest) != EXTENSION_ID:
        raise ValueError('Extension identity changed')
    # A bundle version must equal the manifest version. Chromium uses this to
    # invalidate the persisted component worker, including version downgrades.
    if bundle_version != manifest['version']:
        raise ValueError('Bundle and extension manifest versions must match')
    with tempfile.TemporaryDirectory(prefix='vrwatch-bundle-') as temporary:
        root = Path(temporary)
        shutil.copytree(dist, root / 'vrwatch-extension')
        for name in ['native-host.py', 'native_input.py', 'browser_input.py', 'frame_panel.py', 'app-identity.py', 'steam-shortcut.py',
                     'candidate-launcher.py', 'release.py', 'runtime_provenance.py']:
            target = root / 'helpers' / name
            target.parent.mkdir(exist_ok=True)
            shutil.copy2(REPO / 'frame' / name, target)
        shutil.copytree(REPO / 'frame/browser-input', root / 'helpers/browser-input')
        shutil.copytree(REPO / 'frame/native-input', root / 'helpers/native-input')
        write_json(root / 'vrwatch-bundle.json', {'schema': 1, 'bundleVersion': version(bundle_version),
            'extensionId': EXTENSION_ID, 'minimumChromiumMajor': int(manifest['minimum_chrome_version']),
            'bridgeProtocol': receipt['bridgeProtocol'], 'build': receipt,
            'helperSources': inventory(root / 'helpers'), 'files': inventory(root)})
        archive(root, output)


def stage(runtime_archive, bundle_archive, destination):
    if destination.exists():
        raise ValueError('Stage into a new immutable directory')
    destination.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix='.vrwatch-stage-', dir=destination.parent) as temporary:
        temporary = Path(temporary)
        runtime, app, merged = temporary / 'runtime', temporary / 'bundle', temporary / 'merged'
        runtime.mkdir(); app.mkdir(); merged.mkdir()
        extract(runtime_archive, runtime); extract(bundle_archive, app)
        rm = verify_tree(runtime, 'vrwatch-runtime.json')
        bm = verify_tree(app, 'vrwatch-bundle.json')
        if rm.get('schema') != 2 or bm.get('schema') != 1:
            raise ValueError('Runtime requires a compiled-inputs receipt; legacy packages remain preserved')
        if rm.get('extensionId') != EXTENSION_ID or bm.get('extensionId') != EXTENSION_ID:
            raise ValueError('Extension identity mismatch')
        if rm.get('bridgeProtocol') != bm.get('bridgeProtocol'):
            raise ValueError('Incompatible native bridge versions')
        major = rm.get('chromiumMajor')
        if not isinstance(major, int) or major < bm['minimumChromiumMajor']:
            raise ValueError('Incompatible Chromium version')
        extension = json.loads((app / 'vrwatch-extension/manifest.json').read_text())
        if identity(extension) != EXTENSION_ID or extension['version'] != bm['bundleVersion']:
            raise ValueError('Bundle identity/version does not match payload')
        shutil.copytree(runtime, merged, dirs_exist_ok=True)
        if set(inventory(runtime)) & set(inventory(app)):
            raise ValueError('Runtime and bundle paths overlap')
        shutil.copytree(app, merged, dirs_exist_ok=True)
        native = merged / 'native-messaging'; native.mkdir()
        write_json(native / 'com.vrwatch.bridge.json', {'name': 'com.vrwatch.bridge',
            'description': 'VRWatch Frame bridge', 'type': 'stdio',
            'path': str((destination / 'helpers/native-host.py').absolute()),
            'allowed_origins': ['chrome-extension://' + EXTENSION_ID + '/']})
        write_json(merged / 'vrwatch-release.json', {'schema': 1,
            'runtimeVersion': rm['runtimeVersion'], 'bundleVersion': bm['bundleVersion'],
            'extensionId': EXTENSION_ID, 'bridgeProtocol': bm['bridgeProtocol'],
            'artifacts': {'runtime': digest(runtime_archive), 'bundle': digest(bundle_archive)},
            'validation': 'pending', 'files': inventory(merged)})
        verify_tree(merged, 'vrwatch-release.json')
        merged.rename(destination)
    return destination


def select(root, candidate, profile):
    root.mkdir(parents=True, exist_ok=True)
    with (root / '.selection.lock').open('a') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        _select(root, candidate, profile)


def _select(root, candidate, profile):
    # Explicit local staging selector. No default installation path and no
    # process killing. Conservatively reject even stale Chromium profile locks.
    if (profile / 'SingletonLock').exists() or (profile / 'SingletonLock').is_symlink():
        raise ValueError('Close the browser before switching a release')
    candidate = candidate.resolve()
    if not candidate.is_relative_to(root.resolve()) or candidate == root.resolve():
        raise ValueError('Candidate must be inside the staging root')
    selected = verify_tree(candidate, 'vrwatch-release.json')
    current = root / 'current'
    old = current.resolve() if current.is_symlink() else None
    if current.exists() and not current.is_symlink():
        raise ValueError('Refusing to replace a real installation directory')
    if old:
        # Recovery must still work when the currently selected files are damaged.
        # Validate the destination fully; use the old manifest only for version
        # reuse detection, never make intact old binaries a rollback prerequisite.
        try:
            prior = json.loads((old / 'vrwatch-release.json').read_text())
            if not isinstance(prior, dict): prior = {}
        except (OSError, ValueError):
            prior = {}
        for kind in ['runtime', 'bundle']:
            if prior.get(kind + 'Version') == selected[kind + 'Version'] and prior.get('artifacts', {}).get(kind) != selected['artifacts'][kind]:
                raise ValueError('Changed bytes require a new ' + kind + ' version')
        previous = root / '.previous-new'
        previous.unlink(missing_ok=True)
        previous.symlink_to(old)
        previous.replace(root / 'previous')
    pending = root / '.current-new'
    pending.unlink(missing_ok=True)
    pending.symlink_to(candidate)
    pending.replace(current)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest='command', required=True)
    build = sub.add_parser('bundle')
    build.add_argument('--dist', type=Path, required=True)
    build.add_argument('--output', type=Path, required=True)
    build.add_argument('--version', required=True)
    staging = sub.add_parser('stage')
    staging.add_argument('--runtime', type=Path, required=True)
    staging.add_argument('--bundle', type=Path, required=True)
    staging.add_argument('--destination', type=Path, required=True)
    validation = sub.add_parser('validate'); validation.add_argument('directory', type=Path)
    for name in ['select', 'rollback']:
        selection = sub.add_parser(name)
        selection.add_argument('--root', type=Path, required=True)
        selection.add_argument('--profile', type=Path, required=True)
        if name == 'select': selection.add_argument('--candidate', type=Path, required=True)
    args = parser.parse_args()
    if args.command == 'bundle': bundle(args.dist, args.output, args.version)
    elif args.command == 'stage': stage(args.runtime, args.bundle, args.destination)
    elif args.command == 'validate': verify_tree(args.directory, 'vrwatch-release.json')
    elif args.command == 'select': select(args.root, args.candidate, args.profile)
    else:
        previous = args.root / 'previous'
        if not previous.is_symlink(): raise ValueError('No previous staged release')
        select(args.root, previous.resolve(), args.profile)
    print('Local release operation complete; no publication performed.')


if __name__ == '__main__':
    main()

#!/usr/bin/env python3
# SPDX-License-Identifier: MPL-2.0
"""Package the built app with a verified ARM64 browser and matching license materials."""
import argparse
import hashlib
import importlib.util
import json
import os
import shutil
import subprocess
import tarfile
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent


def digest(path):
    with Path(path).open('rb') as stream:
        return hashlib.file_digest(stream, 'sha256').hexdigest()


def package(runtime, materials, destination):
    if destination.exists():
        raise ValueError('Use a new release output directory')
    if subprocess.check_output(['git', 'status', '--porcelain', '--untracked-files=normal'], cwd=ROOT).strip():
        raise ValueError('Commit the source before making a release')
    commit = subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=ROOT, text=True).strip()
    spec = importlib.util.spec_from_file_location('runtime_check', ROOT / 'frame/verify-runtime.py')
    check = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(check)
    browser = check.verify(runtime)
    license_manifest = json.loads((materials / 'distribution-materials.json').read_text())
    if license_manifest.get('runtimeChromeSHA256') != digest(runtime / 'chrome'):
        raise ValueError('License/relink materials do not match the included browser')
    if license_manifest.get('relinkVerification') != 'passed':
        raise ValueError('Complete relink verification before packaging')
    for name, checksum in license_manifest['files'].items():
        path = Path(name)
        if path.is_absolute() or '..' in path.parts or digest(materials / name) != checksum:
            raise ValueError('License materials inventory mismatch')
    receipt = json.loads((ROOT / 'dist/vrwatch-bundle-build.json').read_text())
    if receipt.get('sourceCommit') != commit or receipt.get('bridgeProtocol') != 0:
        raise ValueError('Build the standard app from the current committed source')
    app_files = {path.relative_to(ROOT / 'dist').as_posix() for path in (ROOT / 'dist').rglob('*') if path.is_file() and path.name != 'vrwatch-bundle-build.json'}
    if app_files != set(receipt['files']):
        raise ValueError('Unexpected or missing app bundle files')
    for name, checksum in receipt['files'].items():
        path = Path(name)
        if path.is_absolute() or '..' in path.parts or digest(ROOT / 'dist' / name) != checksum:
            raise ValueError('App bundle changed after building')
    version = json.loads((ROOT / 'package.json').read_text())['version']
    folder = 'VRWatch-' + version
    destination.mkdir(parents=True)
    source_archive = destination / f'VRWatch-{version}-Source.tar.gz'
    subprocess.run(['git', 'archive', '--format=tar.gz', '--prefix=' + folder + '/',
                    '--output=' + str(source_archive), commit], cwd=ROOT, check=True)
    with tempfile.TemporaryDirectory(prefix='vrwatch-release-') as temporary:
        root = Path(temporary) / folder
        root.mkdir()
        shutil.copytree(ROOT / 'dist', root / 'dist')
        shutil.copytree(runtime, root / 'browser')
        frame = root / 'frame'
        frame.mkdir()
        for name in ('install.sh', 'verify-runtime.py', 'vrwatch', 'extension-id',
                     'steam-shortcut.py', 'browser-host.py', 'library-server.py',
                     'mount-nas.py', 'app-identity.py', 'browser_input.py', 'frame_panel.py'):
            shutil.copy2(ROOT / 'frame' / name, frame / name)
        shutil.copytree(ROOT / 'frame/browser-input', frame / 'browser-input')
        (root / 'branding').mkdir()
        shutil.copy2(ROOT / 'branding/app.json', root / 'branding/app.json')
        for name in ('README.md', 'INSTALL.md', 'LICENSE', 'NOTICE.md'):
            shutil.copy2(ROOT / name, root / name)
        for name in ('README.md', 'INSTALL.md'):
            document = root / name
            text = document.read_text()
            for target in ('DEVELOPING.md', 'CONTRIBUTING.md'):
                text = text.replace('](' + target, '](https://github.com/akalajzi/VRWatch/blob/' + commit + '/' + target)
            document.write_text(text)
        for name in ('branding/vrwatch-wordmark-color.svg',
                     'branding/vrwatch-wordmark-color-light.svg',
                     'docs/images/vrwatch-home.png'):
            path = root / name
            path.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(ROOT / name, path)
        shutil.copytree(ROOT / 'licenses', root / 'licenses')
        shutil.copy2(source_archive, root / 'SOURCE.tar.gz')
        (root / 'BROWSER-NOTICES.txt').write_text(
            'This browser uses FFmpeg under LGPL-2.1-or-later. Full notices and credits\n'
            'are included in browser/licenses/ and browser/about_credits.html.\n'
            'Matching library source and relink materials are provided alongside this\n'
            'download. See the release file RELINKING.md. You may modify this browser\n'
            'for your own use and reverse engineer it to debug library modifications.\n'
            'Application source is included in SOURCE.tar.gz.\n')
        installer = root / 'Install VRWatch.sh'
        installer.write_text('#!/usr/bin/env bash\nset -euo pipefail\n'
                             'here=$(cd "$(dirname "$0")" && pwd)\n'
                             'exec bash "$here/frame/install.sh" --bundled-runtime "$here/browser"\n')
        installer.chmod(0o755)
        (root / 'release.json').write_text(json.dumps({
            'version': version, 'sourceCommit': commit,
            'browserSHA256': digest(runtime / 'chrome'),
            'chromiumRevision': browser['revision'],
            'sourceArchiveSHA256': digest(source_archive),
        }, indent=2) + '\n')
        archive = destination / f'VRWatch-{version}-Steam-Frame.tar.xz'
        print('Writing Steam Frame package', flush=True)
        with tarfile.open(archive, 'w:xz', preset=3) as tar:
            for path in sorted(root.rglob('*')):
                if path.is_symlink():
                    raise ValueError('Unexpected release symlink')
                if not path.is_file():
                    continue
                info = tar.gettarinfo(str(path), arcname=folder + '/' + path.relative_to(root).as_posix())
                info.uid = info.gid = 0
                info.uname = info.gname = ''
                info.mtime = 0
                info.mode = 0o755 if os.access(path, os.X_OK) else 0o644
                with path.open('rb') as stream:
                    tar.addfile(info, stream)
    for name in [*license_manifest['files'], 'distribution-materials.json']:
        path = materials / name
        if path.is_symlink() or not path.is_file():
            raise ValueError('License materials must be regular files')
        shutil.copy2(path, destination / path.name)
    sums = ''.join(digest(path) + '  ' + path.name + '\n'
                   for path in sorted(destination.iterdir()) if path.is_file())
    (destination / 'SHA256SUMS').write_text(sums)
    return destination


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--runtime', type=Path, required=True)
    parser.add_argument('--license-materials', type=Path, required=True)
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    try:
        print(package(args.runtime.resolve(), args.license_materials.resolve(), args.output.resolve()))
    except (OSError, ValueError, KeyError) as error:
        raise SystemExit(f'Release packaging failed: {error}')

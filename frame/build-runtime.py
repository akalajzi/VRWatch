#!/usr/bin/env python3
"""Build a pinned, isolated Chromium ARM64 candidate. Does not install it.

The checkout, dependencies, logs and build outputs stay in the ignored runtime/
directory. Preparation/build/package phases are resumable. Inspect status.json
and build.log there; a successful build is still subject to device validation.
"""
import argparse
import fcntl
import hashlib
import json
import os
import re
import shutil
import subprocess
import sys
import tarfile
import tempfile
import time
from pathlib import Path
from runtime_provenance import DEPOT_REVISION, inputs, output_hashes, verify_receipt, write_receipt

REVISION = '1cd9d5e8a79498099345785815a507f5d6e6811a'
ORIGIN = 'https://chromium.googlesource.com/chromium/src.git'
REPO = Path(__file__).resolve().parent.parent


def applied_patch_count(src, patches):
    """Match the working tree against ordered prefixes without modifying it."""
    paths = sorted({line[6:].split('\t', 1)[0]
                    for patch in patches for line in patch.read_text().splitlines()
                    if line.startswith(('+++ b/', '--- a/'))})
    actual = {}
    for name in paths:
        path = src / name
        if path.is_symlink():
            data = os.readlink(path).encode()
            mode = '120000'
        elif path.is_file():
            data = path.read_bytes()
            mode = '100755' if path.stat().st_mode & 0o111 else '100644'
        elif path.exists():
            raise RuntimeError('Patch source path is not a file: ' + name)
        else:
            continue
        actual[name] = (mode, hashlib.sha1(b'blob ' + str(len(data)).encode() + b'\0' + data).hexdigest())
    with tempfile.TemporaryDirectory(prefix='patch-index-') as temporary:
        env = {**os.environ, 'GIT_INDEX_FILE': str(Path(temporary) / 'index')}
        def git(*args, **kwargs):
            return subprocess.run(['git', *args], cwd=src, env=env,
                                  capture_output=True, **kwargs)
        git('read-tree', 'HEAD', check=True)
        matched = None
        for count in range(len(patches) + 1):
            expected = {}
            for entry in git('ls-files', '--stage', '-z', '--', *paths, check=True).stdout.decode().split('\0'):
                if entry:
                    metadata, name = entry.split('\t', 1)
                    mode, digest, stage = metadata.split()
                    expected[name] = (mode, digest)
            if actual == expected:
                matched = count
            if count < len(patches):
                git('apply', '--cached', str(patches[count]), check=True)
        if matched is None:
            raise RuntimeError('Candidate source does not match an ordered patch prefix; preserve and inspect local edits')
        return matched


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--work-dir', type=Path, default=REPO / 'runtime/chromium-v4l2')
    parser.add_argument('--jobs', type=int, default=min(12, os.cpu_count() or 1))
    parser.add_argument('--phase', choices=['all', 'prepare', 'build', 'package'], default='all')
    parser.add_argument('--runtime-version', help='Immutable candidate version; required for packaging')
    parser.add_argument('--patch-dir', type=Path, default=REPO / 'frame/runtime-patches')
    parser.add_argument('--gn-args', type=Path, default=REPO / 'frame/runtime-args.gn')
    parser.add_argument('--root-gn', type=Path, default=REPO / 'frame/runtime-root.gn')
    parser.add_argument('--bridge-protocol', type=int, choices=[0, 1], default=0)
    args = parser.parse_args()
    if args.phase in ('all', 'package') and (not args.runtime_version or not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9._-]{0,80}', args.runtime_version)):
        parser.error('--runtime-version is required for a new immutable package')
    args.patch_dir = args.patch_dir.resolve()
    args.gn_args = args.gn_args.resolve()
    args.root_gn = args.root_gn.resolve()
    if args.bridge_protocol == 1:
        patch_text = '\n'.join(p.read_text() for p in args.patch_dir.glob('*.patch'))
        for required in ('vrwatch_private_api.cc', 'vrwatch_runtime.cc', 'vrwatch_hud_controller.cc'):
            if required not in patch_text:
                parser.error('Protocol 1 requires the complete candidate patch series: ' + required)
    if args.jobs < 1:
        parser.error('--jobs must be positive')
    work = args.work_dir.resolve()
    if any(c.isspace() for c in str(work)):
        parser.error('Chromium requires a checkout path without spaces')
    work.mkdir(parents=True, exist_ok=True)
    lock = (work / 'build.lock').open('w')
    try:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except BlockingIOError:
        parser.error('Another runtime build is using this directory')
    log = (work / 'build.log').open('a', buffering=1)
    src = work / 'src'
    out = src / 'out/VRWatch'
    gn_root = ['--root-target=//vrwatch_runtime', '--root-pattern=//vrwatch_runtime:runtime']
    env = {**os.environ, 'PATH': str(work / 'depot_tools') + os.pathsep + os.environ['PATH'],
           'DEPOT_TOOLS_METRICS': '0', 'DEPOT_TOOLS_UPDATE': '0'}
    stage_name = 'starting'
    receipt = work / 'compiled-inputs.json'
    prepared = work / 'prepared-inputs.json'
    def current_inputs():
        return {**inputs(REPO, work, args.patch_dir, args.gn_args, args.root_gn),
                'bridgeProtocol': args.bridge_protocol}


    def status(stage, **details):
        nonlocal stage_name
        stage_name = stage
        value = {'stage': stage, 'revision': REVISION, 'pid': os.getpid(),
                 'timeUTC': time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime()), **details}
        (work / 'status.json').write_text(json.dumps(value, indent=2) + '\n')
        message = json.dumps(value)
        print(message, flush=True)
        log.write(message + '\n')

    def run(command, cwd=work):
        # Retain complete diagnostics without flooding the agent/user transcript.
        log.write(json.dumps({'command': command, 'cwd': str(cwd)}) + '\n')
        subprocess.run(command, cwd=cwd, env=env, stdout=log, stderr=log, check=True)

    def disk_guard():
        if shutil.disk_usage(work).free < 25 * 1024**3:
            raise RuntimeError('Less than 25 GiB free; preserve the resumable build and free space')

    try:
        status('starting', phase=args.phase)
        disk_guard()
        if args.phase in ('all', 'prepare'):
            if not (work / 'depot_tools/gclient').is_file():
                status('fetching-depot-tools')
                run(['git', 'init', 'depot_tools'])
                run(['git', 'remote', 'add', 'origin', 'https://chromium.googlesource.com/chromium/tools/depot_tools.git'], work / 'depot_tools')
                run(['git', 'fetch', '--depth', '1', 'origin', DEPOT_REVISION], work / 'depot_tools')
                run(['git', 'checkout', '--detach', DEPOT_REVISION], work / 'depot_tools')
            if subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=work / 'depot_tools', text=True).strip() != DEPOT_REVISION:
                raise RuntimeError('Use the pinned depot_tools revision in a separate candidate directory')
            if not (work / 'depot_tools/python3_bin_reldir.txt').is_file():
                status('bootstrapping-build-tools')
                run([str(work / 'depot_tools/ensure_bootstrap')])
                if not (work / 'depot_tools/python3_bin_reldir.txt').is_file():
                    raise RuntimeError('depot_tools Python bootstrap did not complete; inspect build.log')
            if not (src / '.git').is_dir():
                run(['git', 'init', str(src)])
                run(['git', 'remote', 'add', 'origin', ORIGIN], src)
            head = subprocess.run(['git', 'rev-parse', '--verify', 'HEAD'], cwd=src,
                                  capture_output=True, text=True)
            if head.returncode or head.stdout.strip() != REVISION:
                if subprocess.check_output(['git', 'status', '--porcelain'], cwd=src):
                    raise RuntimeError('Source checkout has local changes; refusing to replace it')
                status('fetching-chromium')
                run(['git', 'fetch', '--depth', '1', 'origin', REVISION], src)
                run(['git', 'checkout', '--detach', REVISION], src)
            config = '''solutions = [{"name": "src", "url": %r, "managed": False,
  "custom_deps": {}, "custom_vars": {"checkout_openxr": True, "checkout_pgo_profiles": True}}]
target_os = ["linux"]
target_cpu = ["arm64"]
''' % ORIGIN
            config_path = work / '.gclient'
            if config_path.exists() and config_path.read_text() != config:
                raise RuntimeError('Existing .gclient differs; inspect it before replacing the configuration')
            config_path.write_text(config)
            synced = work / 'dependencies-ready'
            # This revision manages sysroots as first-class GCS dependencies.
            # The legacy installer replaces their GCS receipt; a later gclient
            # revinfo then deletes the directory while parsing dependencies.
            # Resync missing sysroots through gclient, never that installer.
            sysroots = [src / 'build/linux' / f'debian_bullseye_{arch}-sysroot'
                        for arch in ('amd64', 'arm64')]
            if (not synced.exists() or synced.read_text().strip() != REVISION
                    or any(not path.is_dir() for path in sysroots)):
                status('syncing-dependencies')
                # HEAD was pinned above. Leave the unmanaged root in place so
                # dependency repair also works after candidate patches apply.
                run(['gclient', 'sync', '--nohooks', '--no-history', '--shallow',
                     '-j', '8'])
                disk_guard()
                status('running-hooks')
                run(['gclient', 'runhooks'])
                if any(not path.is_dir() for path in sysroots):
                    raise RuntimeError('Pinned GCS sysroots missing after dependency sync; inspect build.log')
                synced.write_text(REVISION + '\n')
            out.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(args.gn_args, out / 'args.gn')
            patches = sorted(args.patch_dir.glob('*.patch'))
            for patch in patches[applied_patch_count(src, patches):]:
                run(['git', 'apply', '--check', str(patch)], src)
                run(['git', 'apply', str(patch)], src)
            root_dir = src / 'vrwatch_runtime'
            root_dir.mkdir(exist_ok=True)
            shutil.copyfile(args.root_gn, root_dir / 'BUILD.gn')
            status('generating-build')
            # Generate the browser's runtime graph, excluding unrelated test
            # targets (some upstream print tests require the omitted PDF UI).
            run(['gn', 'gen', 'out/VRWatch', *gn_root, '--fail-on-unused-args'], src)
            run(['gn', 'args', 'out/VRWatch', '--list=use_v4l2_codec', '--short', *gn_root], src)
            run(['gn', 'args', 'out/VRWatch', '--list=enable_openxr', '--short', *gn_root], src)
            run(['gn', 'desc', 'out/VRWatch', '//media/gpu/v4l2:v4l2', 'sources', *gn_root], src)
            prepared.write_text(json.dumps(current_inputs(), sort_keys=True))
            status('prepared')
        if args.phase in ('all', 'build'):
            if not (out / 'build.ninja').is_file():
                raise RuntimeError('Prepare the runtime before building')
            disk_guard()
            build_inputs = current_inputs()
            if not prepared.exists() or json.loads(prepared.read_text()) != build_inputs:
                raise RuntimeError('Prepared inputs changed; prepare again before building')
            receipt.unlink(missing_ok=True)
            status('building', jobs=args.jobs)
            # Keep the desktop responsive; limit jobs instead of using every core.
            run(['nice', '-n', '10', 'autoninja', '-C', 'out/VRWatch', '-j', str(args.jobs), '-k', '0',
                 'chrome', 'chrome_sandbox', 'chrome_crashpad_handler'], src)
            if current_inputs() != build_inputs:
                raise RuntimeError('Build inputs changed during compilation; no receipt written')
            write_receipt(receipt, build_inputs, output_hashes(out))
            status('built')
        if args.phase in ('all', 'package'):
            if not (out / 'chrome').is_file():
                raise RuntimeError('Build the runtime before packaging')
            disk_guard()
            compiled = verify_receipt(receipt, current_inputs(), output_hashes(out))
            head = subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=src,
                                           text=True).strip()
            if head != REVISION:
                raise RuntimeError('Refusing to label a package from another source revision')
            if (out / 'args.gn').read_bytes() != args.gn_args.read_bytes():
                raise RuntimeError('Build arguments changed; prepare and build before packaging')
            patches = sorted(args.patch_dir.glob('*.patch'))
            if applied_patch_count(src, patches) != len(patches):
                raise RuntimeError('Runtime source does not match the complete ordered patch series')
            for binary in ('chrome', 'chrome_sandbox', 'chrome_crashpad_handler'):
                with (out / binary).open('rb') as executable:
                    header = executable.read(20)
                # ELF64, little endian, EM_AARCH64. Never package host tools as
                # the target runtime, even if the expected filenames exist.
                if header[:6] != b'\x7fELF\x02\x01' or header[18:20] != b'\xb7\x00':
                    raise RuntimeError(f'{binary} is not an ARM64 Linux executable')
            status('packaging')
            package = work / f'vrwatch-runtime-{args.runtime_version}-arm64.tar.xz'
            if package.exists():
                raise RuntimeError('Immutable package already exists; choose a new version')
            files = {out / 'chrome', out / 'chrome_sandbox', out / 'chrome_crashpad_handler',
                     out / 'icudtl.dat', out / 'locales/en-US.pak', out / 'vrwatch-runtime.json',
                     out / 'vrwatch-chromium'}
            files.update((out / 'locales').glob('*.pak'))
            for pattern in ('*.pak', '*.bin', '*.so', '*.so.*', '*swiftshader*.json'):
                files.update(out.glob(pattern))
            # These are Vulkan test/validation drivers, not the application
            # driver or its software-rendering fallback.
            files = {p for p in files if not p.name.endswith('.TOC') and p.name not in
                     ('libVkICD_mock_icd.so', 'libVkLayer_khronos_validation.so')}
            with tempfile.TemporaryDirectory(prefix='package-', dir=work) as temporary:
                staged = {}
                wrapper = Path(temporary) / 'vrwatch-chromium'
                shutil.copyfile(REPO / 'frame/runtime-browser', wrapper)
                wrapper.chmod(0o755)
                staged[out / 'vrwatch-chromium'] = wrapper
                staged[out / 'vrwatch-runtime.json'] = Path(temporary) / 'vrwatch-runtime.json'
                strip = src / 'third_party/llvm-build/Release+Asserts/bin/llvm-strip'
                for path in sorted(files):
                    if path.name in ('vrwatch-runtime.json', 'vrwatch-chromium'):
                        continue
                    with path.open('rb') as resource:
                        is_elf = resource.read(4) == b'\x7fELF'
                    if is_elf:
                        target = Path(temporary) / path.relative_to(out)
                        target.parent.mkdir(parents=True, exist_ok=True)
                        # Keep original build outputs for diagnosis/resume.
                        # Dynamic symbols and build IDs survive this operation.
                        run([str(strip), '--strip-unneeded', '-o', str(target), str(path)])
                        staged[path] = target
                with staged[out / 'chrome'].open('rb') as browser:
                    browser_hash = hashlib.file_digest(browser, 'sha256').hexdigest()
                manifest = {'schema': 2, 'runtimeVersion': args.runtime_version, 'chromiumMajor': 157,
                            'extensionId': 'bkjijegjmneghekcknijmioimbahmfap',
                            'bridgeProtocol': args.bridge_protocol,
                            'componentBundle': 'vrwatch-extension',
                            'compiledInputs': compiled['inputs'],
                            'compiledOutputs': compiled['outputs'],
                            'revision': REVISION, 'gnArgs': (out / 'args.gn').read_text(),
                            'chromeSHA256': browser_hash, 'elfStrip': 'llvm-strip --strip-unneeded',
                            'launcher': 'vrwatch-chromium',
                            'launcherSHA256': hashlib.sha256(wrapper.read_bytes()).hexdigest(),
                            'runtimeWorkarounds': ['disable_accelerated_vp9_decode',
                                                   'disable_accelerated_vp9_profile2_decode'],
                            'sourcePatches': {p.name: hashlib.sha256(p.read_bytes()).hexdigest()
                                              for p in sorted(args.patch_dir.glob('*.patch'))},
                            'deviceValidation': 'pending; not automatically selected by VRWatch'}
                manifest['files'] = {path.relative_to(out).as_posix(): {
                    'sha256': hashlib.sha256(staged.get(path, path).read_bytes()).hexdigest(),
                    'size': staged.get(path, path).stat().st_size}
                    for path in sorted(files) if path.name != 'vrwatch-runtime.json'}
                manifest['files']['LICENSE'] = {'sha256': hashlib.sha256((src / 'LICENSE').read_bytes()).hexdigest(),
                                               'size': (src / 'LICENSE').stat().st_size}
                staged[out / 'vrwatch-runtime.json'].write_text(json.dumps(manifest, indent=2) + '\n')
                with tarfile.open(package.with_suffix('.xz.tmp'), 'w:xz', preset=3) as archive:
                    for path in sorted(files):
                        archive.add(staged.get(path, path), arcname=path.relative_to(out).as_posix())
                    archive.add(src / 'LICENSE', arcname='LICENSE')
            package.with_suffix('.xz.tmp').replace(package)
            with package.open('rb') as archive:
                package_hash = hashlib.file_digest(archive, 'sha256').hexdigest()
            package.with_suffix(package.suffix + '.sha256').write_text(
                package_hash + '  ' + package.name + '\n')
            package.with_suffix('.manifest.json').write_text(json.dumps(manifest, indent=2) + '\n')
            status('packaged', package=str(package), bytes=package.stat().st_size,
                   sha256=package_hash)
    except Exception as error:
        status('failed', failedStage=stage_name, error=str(error))
        raise
    finally:
        log.close()


if __name__ == '__main__':
    main()

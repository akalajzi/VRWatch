"""Build receipts are written only after a successful compile, never at package time."""
import hashlib
import json
import os
import subprocess
from pathlib import Path

DEPOT_REVISION = '21ae2d24f8ee0ca3459bda416129d7791c4313f1'
BINARIES = ('chrome', 'chrome_sandbox', 'chrome_crashpad_handler')


def digest(path):
    with Path(path).open('rb') as stream:
        return hashlib.file_digest(stream, 'sha256').hexdigest()


def git(src, *args):
    return subprocess.check_output(['git', *args], cwd=src).decode().strip()


def inputs(repo, work, patches, args_file, root_file):
    src = work / 'src'
    if git(work / 'depot_tools', 'rev-parse', 'HEAD') != DEPOT_REVISION:
        raise RuntimeError('depot_tools revision differs from the pinned build tools')
    if git(work / 'depot_tools', 'status', '--porcelain'):
        raise RuntimeError('depot_tools working tree differs from the pinned build tools')
    # Include source edits, including new candidate files. Generated runtime root
    # is explicitly hashed. Reject other untracked source instead of omitting it.
    untracked = git(src, 'ls-files', '--others', '--exclude-standard').splitlines()
    patch_paths = {line.removeprefix('+++ b/').split('\t', 1)[0]
                   for patch in patches.glob('*.patch') for line in patch.read_text().splitlines()
                   if line.startswith('+++ b/')}
    if any(name != 'vrwatch_runtime/BUILD.gn' and name not in patch_paths for name in untracked):
        raise RuntimeError('Untracked Chromium source must be recorded in the patch series')
    changes = subprocess.check_output(['git', 'diff', 'HEAD', '--binary'], cwd=src)
    environment = {**os.environ, 'PATH': str(work / 'depot_tools') + os.pathsep + os.environ['PATH'],
                   'DEPOT_TOOLS_UPDATE': '0', 'DEPOT_TOOLS_METRICS': '0'}
    resolved = subprocess.check_output([str(work / 'depot_tools/gclient'), 'revinfo', '--actual'], cwd=work, env=environment).decode()
    dependency_diffs = {}
    for line in resolved.splitlines():
        name = line.split(': ', 1)[0].strip()
        checkout = work / name
        if name == 'src' or not name.startswith('src/') or not (checkout / '.git').exists():
            continue
        if git(checkout, 'ls-files', '--others', '--exclude-standard'):
            raise RuntimeError('Untracked dependency source must be reviewed before building: ' + name)
        diff = subprocess.check_output(['git', 'diff', 'HEAD', '--binary'], cwd=checkout)
        if diff:
            dependency_diffs[name] = hashlib.sha256(diff).hexdigest()
    return {
        'revision': git(src, 'rev-parse', 'HEAD'),
        'vrwatchCommit': git(repo, 'rev-parse', 'HEAD'),
        'sourceDiffSHA256': hashlib.sha256(changes).hexdigest(),
        'newSourceFiles': {name: digest(src / name) for name in untracked},
        'depotToolsRevision': DEPOT_REVISION,
        'depsSHA256': digest(src / 'DEPS'),
        'gnArgsSHA256': digest(args_file),
        'effectiveArgsSHA256': digest(src / 'out/VRWatch/args.gn'),
        'rootSHA256': digest(root_file),
        'effectiveRootSHA256': digest(src / 'vrwatch_runtime/BUILD.gn'),
        'patches': {path.name: digest(path) for path in sorted(patches.glob('*.patch'))},
        'builderSHA256': digest(repo / 'frame/build-runtime.py'),
        'provenanceSHA256': digest(repo / 'frame/runtime_provenance.py'),
        # DEPS pins sysroots/PGO; record resolved dependency revisions too. This
        # reads the existing checkout and performs no fetch or synchronization.
        'resolvedDependencies': resolved,
        'dependencyDiffs': dependency_diffs,
        'clangSHA256': digest(src / 'third_party/llvm-build/Release+Asserts/bin/clang'),
    }


def output_files(out):
    files = {out / name for name in (*BINARIES, 'icudtl.dat')}
    files.update((out / 'locales').glob('*.pak'))
    for pattern in ('*.pak', '*.bin', '*.so', '*.so.*', '*swiftshader*.json'):
        files.update(out.glob(pattern))
    return sorted(path for path in files if not path.name.endswith('.TOC') and path.name not in
                  ('libVkICD_mock_icd.so', 'libVkLayer_khronos_validation.so'))


def output_hashes(out):
    return {path.relative_to(out).as_posix(): digest(path) for path in output_files(out)}


def write_receipt(path, build_inputs, outputs):
    temporary = path.with_suffix('.tmp')
    temporary.write_text(json.dumps({'schema': 1, 'inputs': build_inputs, 'outputs': outputs}, indent=2) + '\n')
    temporary.replace(path)


def verify_receipt(path, build_inputs, outputs):
    if not path.is_file():
        raise RuntimeError('No successful compilation receipt; rebuild in a candidate work directory')
    receipt = json.loads(path.read_text())
    if receipt.get('schema') != 1 or receipt.get('inputs') != build_inputs or receipt.get('outputs') != outputs:
        raise RuntimeError('Stale runtime: compiled inputs or output hashes differ from the successful build')
    return receipt

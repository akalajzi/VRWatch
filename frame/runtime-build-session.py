#!/usr/bin/env python3
"""Preview or run the existing runtime builder from pinned, frozen inputs.

No checkout, downloads or compilation occur without --execute. Existing Chromium
outputs and Siso/ThinLTO caches are retained; the builder still verifies receipts.
"""
import argparse
from collections import Counter
import fcntl
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import time
import uuid

sys.dont_write_bytecode = True
REPO = Path(__file__).resolve().parent.parent


def git(repo, *args):
    return subprocess.check_output(['git', *args], cwd=repo, text=True).strip()


def frozen_files(patches, gn_args, root_gn):
    files = {'runtime-args.gn': gn_args.read_bytes(), 'runtime-root.gn': root_gn.read_bytes()}
    files.update({'patches/' + p.name: p.read_bytes() for p in sorted(patches.glob('*.patch'))})
    if not any(name.startswith('patches/') for name in files):
        raise RuntimeError('Patch directory contains no patches')
    return files


def inventory(files):
    return {name: hashlib.sha256(data).hexdigest() for name, data in sorted(files.items())}


def validate_work(repo, work):
    # Check the lexical path too: resolving a review symlink must not grant access
    # to the preserved baseline. Other external build directories remain usable.
    if work.is_symlink() or (work / 'src').is_symlink():
        raise RuntimeError('Never build through a symlinked work/source directory')
    resolved = work.resolve()
    for name in ('chromium-v4l2', 'chromium-candidate'):
        protected = (repo / 'runtime' / name).resolve()
        if resolved == protected or protected in resolved.parents:
            raise RuntimeError('Preserved baseline/review checkout is not a build destination')
    if any(c.isspace() for c in str(resolved)):
        raise RuntimeError('Chromium requires a checkout path without spaces')
    return resolved


def siso_summary(path):
    """Use execution time, not duration_nanos (which includes scheduler queues)."""
    if not path.is_file():
        return None
    counts, execution, cpu = Counter(), Counter(), Counter()
    build_id = None
    chrome_link = None
    total_steps = 0
    with path.open() as stream:
        for line in stream:
            row = json.loads(line)
            build_id = row.get('build_id', build_id)
            if 'step_id' not in row:
                continue
            total_steps += 1
            rule = row.get('rule', 'other')
            counts[rule] += 1
            execution[rule] += row.get('exec_nanos', 0) / 1e9
            cpu[rule] += (row.get('utime_nanos', 0) + row.get('stime_nanos', 0)) / 1e9
            if 'chrome' in row.get('outputs', []) and rule == 'clang/link':
                chrome_link = row.get('exec_nanos', 0) / 1e9
    return {'buildId': build_id, 'recordedSteps': total_steps,
            'chromeLinkExecutionSeconds': chrome_link,
            'executionWorkerSeconds': round(sum(execution.values()), 6),
            'cpuSeconds': round(sum(cpu.values()), 6),
            'rules': {rule: {'steps': counts[rule],
                             'executionWorkerSeconds': round(execution[rule], 6),
                             'cpuSeconds': round(cpu[rule], 6)}
                      for rule in counts},
            'limit': 'Parallel worker/CPU totals are not additive wall-clock phases; cached/no-exec steps may have zero execution time.'}


def materialize(repo, control, commit, snapshot, files):
    # Serialize shared control/snapshot creation; the existing builder separately
    # locks its work directory for prepare/build/package.
    control.parent.mkdir(parents=True, exist_ok=True)
    with (control.parent / '.session.lock').open('a') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        if not control.exists():
            subprocess.run(['git', 'worktree', 'add', '--detach', str(control), commit],
                           cwd=repo, check=True)
        if git(control, 'rev-parse', 'HEAD') != commit or git(control, 'status', '--porcelain'):
            raise RuntimeError('Pinned control checkout changed; preserve and inspect it')
        if snapshot.exists():
            actual = {p.relative_to(snapshot).as_posix(): p.read_bytes()
                      for p in snapshot.rglob('*') if p.is_file()}
            if actual != files:
                raise RuntimeError('Frozen input snapshot changed; preserve and inspect it')
        else:
            snapshot.mkdir(parents=True)
            for name, data in files.items():
                path = snapshot / name
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_bytes(data)


def retain_receipts(work, destination):
    destination.mkdir(parents=True)
    for name in ('prepared-inputs.json', 'compiled-inputs.json', 'status.json'):
        path = work / name
        if path.is_file():
            shutil.copyfile(path, destination / name)


def invoked_build(log, start, end, pid):
    if not log.is_file():
        return False
    with log.open('rb') as stream:
        stream.seek(start)
        while stream.tell() < end:
            line = stream.readline()
            if line.startswith(b'{"stage":'):
                try:
                    row = json.loads(line)
                except ValueError:
                    continue
                if row.get('stage') == 'building' and row.get('pid') == pid:
                    return True
    return False


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--commit', required=True, help='Explicit committed VRWatch revision')
    parser.add_argument('--work-dir', required=True, type=Path)
    parser.add_argument('--patch-dir', required=True, type=Path)
    parser.add_argument('--gn-args', required=True, type=Path)
    parser.add_argument('--root-gn', required=True, type=Path)
    parser.add_argument('--bridge-protocol', type=int, choices=[0, 1], required=True)
    parser.add_argument('--runtime-version', required=True)
    parser.add_argument('--jobs', type=int, default=12)
    parser.add_argument('--phase', choices=['prepare', 'build', 'package', 'all'], default='build')
    parser.add_argument('--execute', action='store_true', help='Execute the displayed phase')
    args = parser.parse_args()
    if args.jobs < 1:
        parser.error('--jobs must be positive')
    try:
        work = validate_work(REPO, args.work_dir.absolute())
        commit = git(REPO, 'rev-parse', '--verify', args.commit + '^{commit}')
        git(REPO, 'cat-file', '-e', commit + ':frame/build-runtime.py')
        files = frozen_files(args.patch_dir, args.gn_args, args.root_gn)
        hashes = inventory(files)
        profile = hashlib.sha256(json.dumps(hashes, sort_keys=True).encode()).hexdigest()
        control = REPO / 'runtime/build-controls' / commit
        snapshot = REPO / 'runtime/build-inputs' / profile
        command = [sys.executable, str(control / 'frame/build-runtime.py'),
                   '--work-dir', str(work), '--patch-dir', str(snapshot / 'patches'),
                   '--gn-args', str(snapshot / 'runtime-args.gn'),
                   '--root-gn', str(snapshot / 'runtime-root.gn'),
                   '--bridge-protocol', str(args.bridge_protocol),
                   '--runtime-version', args.runtime_version,
                   '--jobs', str(args.jobs), '--phase', args.phase]
        plan = {'schema': 1, 'execute': args.execute, 'commit': commit,
                'sessionRunnerSHA256': hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),
                'controlCheckout': str(control), 'frozenInputs': str(snapshot),
                'inputHashes': hashes, 'workDirectory': str(work), 'phase': args.phase,
                'jobs': args.jobs, 'command': command,
                'existingBuildGraph': (work / 'src/out/VRWatch/build.ninja').is_file(),
                'existingChrome': (work / 'src/out/VRWatch/chrome').is_file(),
                'cachePolicy': 'Retain existing outputs and Siso/ThinLTO caches; never clean.',
                'receiptPolicy': 'Underlying builder verifies prepared/compiled inputs and output hashes.'}
        print(json.dumps(plan, indent=2), flush=True)
        if not args.execute:
            return 0
        materialize(REPO, control, commit, snapshot, files)
        work.mkdir(parents=True, exist_ok=True)
        # The native builder owns build.lock. A separate wrapper lock prevents
        # overlapping session calls and mixed timing records in this directory.
        with (work / 'session.lock').open('a') as lock:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            metrics = work / 'src/out/VRWatch/siso_metrics.json'
            def metrics_hash():
                if not metrics.is_file():
                    return None
                with metrics.open('rb') as stream:
                    return hashlib.file_digest(stream, 'sha256').hexdigest()
            previous = metrics_hash()
            log = work / 'build.log'
            log_offset = log.stat().st_size if log.exists() else 0
            started_utc = time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime())
            history = work / 'build-run-history' / uuid.uuid4().hex
            retain_receipts(work, history / 'before')
            started = time.monotonic()
            result = subprocess.Popen(command, cwd=control)
            result.wait()
            elapsed = time.monotonic() - started
            retain_receipts(work, history / 'after')
            summary = None
            metrics_error = None
            log_end = log.stat().st_size if log.exists() else log_offset
            owns_build = invoked_build(log, log_offset, log_end, result.pid)
            if owns_build and args.phase in ('build', 'all') and metrics.is_file() and metrics_hash() != previous:
                try:
                    summary = siso_summary(metrics)
                except (OSError, ValueError, TypeError) as error:
                    # A partial Siso log must not hide the builder's exit status
                    # or lose the run record after a failed compile.
                    metrics_error = str(error)
            record = {**plan, 'startedAtUTC': started_utc,
                      'finishedAtUTC': time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime()),
                      'elapsedSeconds': round(elapsed, 6), 'exitCode': result.returncode,
                      'builderPID': result.pid, 'buildInvoked': owns_build,
                      'receiptHistory': str(history),
                      'logStartByte': log_offset, 'logEndByte': log_end,
                      'siso': summary, 'metricsError': metrics_error,
                      'limit': 'Session phase wall time includes builder checks. Existing outputs do not guarantee cache hits. This timing record is not a compiled-output receipt.'}
            with (work / 'build-runs.jsonl').open('a') as receipt:
                receipt.write(json.dumps(record, sort_keys=True) + '\n')
            (history / 'run.json').write_text(json.dumps(record, indent=2) + '\n')
            print(json.dumps(record, indent=2), flush=True)
            return result.returncode
    except (OSError, RuntimeError, subprocess.CalledProcessError) as error:
        parser.exit(1, str(error) + '\n')


if __name__ == '__main__':
    sys.exit(main())

#!/usr/bin/env python3
# SPDX-License-Identifier: MPL-2.0
"""Check exact Git snapshots; never print secret values or scanner output."""
import argparse
import hashlib
import ipaddress
import json
import re
import struct
import subprocess
import tempfile
from pathlib import Path, PurePosixPath

ROOT = Path(__file__).resolve().parent.parent
PUBLIC_KEYS = {'471ccb53f75e90cc11679683fd0af36d5ff934e022156014a54b1508307b0ddd'}
PRIVATE_DIRS = {'private', 'runtime', 'downloads', 'artifacts', 'output', 'profiles',
                'node_modules', 'dist', '__pycache__', 'User Data'}
PRIVATE_SUFFIXES = {'.log', '.har', '.pcap', '.pcapng', '.pem', '.key', '.sqlite',
                    '.sqlite3', '.db', '.zip', '.gz', '.xz', '.7z', '.pyc'}
GENERIC_USERS = {'steamos', 'user', 'example', 'runner', 'test'}
RASTERS = {'.png', '.jpg', '.jpeg', '.webp', '.gif'}


def git(repo, *args):
    return subprocess.check_output(['git', '-C', str(repo), *args], stderr=subprocess.DEVNULL)


def entries(repo, revision=None):
    result = {}
    command = ('ls-tree', '-rz', revision) if revision else ('ls-files', '--stage', '-z')
    for row in git(repo, *command).split(b'\0'):
        if not row:
            continue
        metadata, path = row.split(b'\t', 1)
        fields = metadata.decode().split()
        mode, oid = (fields[0], fields[2]) if revision else (fields[0], fields[1])
        if not revision and fields[2] != '0':
            raise ValueError('Resolve the index conflict before checking')
        result[path.decode()] = (mode, oid)
    return result


def path_problem(name):
    path = PurePosixPath(name)
    if path.is_absolute() or '..' in path.parts:
        return 'unsafe path'
    if set(path.parts) & PRIVATE_DIRS or name.startswith(('docs/validation/', 'branding/concepts/')):
        return 'private/generated directory'
    if path.suffix.lower() in PRIVATE_SUFFIXES or path.name.startswith('.env'):
        return 'credential, capture, database or generated archive'
    if name == 'branding/production-prompts.md' or re.search(r'(?:conversation|transcript|chat-export)', path.name, re.I):
        return 'conversation/planning material'
    return None


def content_problems(name, content, assets):
    problems = []
    if len(content) > 5 * 1024 * 1024:
        return ['file exceeds source-review size limit']
    if content.startswith((b'\x7fELF', b'MZ', b'PK\x03\x04', b'\x1f\x8b', b'\xfd7zXZ')):
        problems.append('binary executable/archive belongs in reviewed release assets')
    if Path(name).suffix.lower() in RASTERS:
        record = assets.get(name, {})
        approved = record.get('sha256', [])
        if isinstance(approved, str):
            approved = [approved]
        if hashlib.sha256(content).hexdigest() not in approved or not record.get('purpose'):
            problems.append('new/changed image requires visual, metadata and provenance review')
        if content.startswith(b'\xff\xd8') and any(marker in content for marker in (b'\xff\xe1', b'\xff\xed', b'\xff\xfe')):
            problems.append('JPEG contains EXIF/XMP/IPTC/comment metadata')
        if content.startswith(b'RIFF') and any(marker in content for marker in (b'EXIF', b'XMP ')):
            problems.append('WebP contains EXIF/XMP metadata')
        if content.startswith(b'GIF') and b'!\xfe' in content:
            problems.append('GIF contains comment metadata')
        if content.startswith(b'\x89PNG\r\n\x1a\n'):
            offset = 8
            while offset + 12 <= len(content):
                length = struct.unpack('>I', content[offset:offset + 4])[0]
                kind = content[offset + 4:offset + 8]
                if kind not in {b'IHDR', b'PLTE', b'IDAT', b'IEND', b'tRNS', b'gAMA', b'cHRM', b'sRGB'}:
                    problems.append('PNG contains unreviewed metadata')
                    break
                offset += length + 12
            if offset != len(content):
                problems.append('invalid PNG structure')
        return problems
    try:
        text = content.decode('utf-8')
    except UnicodeError:
        return problems + ['unreviewed binary source file']
    for match in re.finditer(r'/(?:home|Users)/([A-Za-z0-9_.-]+)', text):
        if match[1] not in GENERIC_USERS:
            problems.append('personal absolute path')
            break
    if re.search(r'(?i)\b[A-Z]:\\Users\\(?!user\b|example\b|runner\b)[^\\\s]+', text):
        problems.append('personal Windows path')
    for candidate in re.findall(r'(?<![\w.])(?:\d{1,3}\.){3}\d{1,3}(?![\w.])', text):
        try:
            address = ipaddress.IPv4Address(candidate)
        except ipaddress.AddressValueError:
            continue
        networks = [(10 << 24, 8), ((172 << 24) | (16 << 16), 12),
                    ((192 << 24) | (168 << 16), 16), ((169 << 24) | (254 << 16), 16)]
        if any(address in ipaddress.ip_network(network) for network in networks):
            problems.append('device/LAN address; use a documentation address or configuration')
            break
    if re.search(r'(?i)(?<![\w:])(?:[0-9a-f]{2}:){5}[0-9a-f]{2}(?![\w:])', text):
        problems.append('device MAC address')
    if re.search(r'(?i)(?<![\w:])(?:f[cd][0-9a-f]{2}|fe80):[0-9a-f:%]+', text):
        problems.append('private/link-local IPv6 address')
    if name.startswith('docs/') and name.endswith('.md') and re.search(r'(?<!\d)(?:19|20)\d{2}-\d{2}-\d{2}(?!\d)', text):
        problems.append('dated report belongs in ignored private evidence')
    return problems


def scan(scanner, folder):
    # Ignore repository-provided suppressions, baselines and inline allow comments.
    with tempfile.TemporaryDirectory(prefix='vrwatch-secret-check-') as temporary:
        root = Path(temporary)
        config = root / 'rules.toml'
        config.write_text('[extend]\nuseDefault = true\n')
        ignore = root / 'ignore'
        ignore.write_text('')
        report = root / 'report.json'
        result = subprocess.run([scanner, 'dir', str(folder), '--config', str(config),
                                 '--gitleaks-ignore-path', str(ignore), '--ignore-gitleaks-allow',
                                 '--report-format', 'json', '--report-path', str(report),
                                 '--no-banner', '--no-color', '--log-level', 'error'],
                                stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        if result.returncode not in (0, 1) or not report.exists():
            raise ValueError('Secret scanner failed; scan must pass before proceeding')
        findings = json.loads(report.read_text())
        # Only the exact audited DER public key is exempt; no file/rule-wide exclusion.
        return [(Path(item['File']).relative_to(folder).as_posix(), item['RuleID'])
                for item in findings if not (item['RuleID'] == 'generic-api-key' and
                    hashlib.sha256(item['Secret'].encode()).hexdigest() in PUBLIC_KEYS)]


def check(repo, snapshots, scanner, messages=()):
    assets = json.loads((ROOT / 'scripts/public-assets.json').read_text())
    issues = []
    seen = set()
    with tempfile.TemporaryDirectory(prefix='vrwatch-source-check-') as temporary:
        folder = Path(temporary)
        for revision in snapshots:
            for name, (mode, oid) in entries(repo, revision).items():
                if (name, oid, mode) in seen:
                    continue
                seen.add((name, oid, mode))
                problem = path_problem(name)
                if problem:
                    issues.append(('file name withheld', problem))
                    continue
                if mode not in {'100644', '100755'}:
                    issues.append((name, 'symlinks/submodules require review'))
                    continue
                content = git(repo, 'cat-file', 'blob', oid)
                issues.extend((name, problem) for problem in content_problems(name, content, assets))
                # Multiple historical versions remain separate scanner inputs.
                path = folder / str(len(seen)) / name
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_bytes(content)
        if messages:
            (folder / 'commit-messages.txt').write_bytes(b'\n'.join(messages))
        issues.extend(scan(scanner, folder))
    if issues:
        for name, category in sorted(set(issues))[:30]:
            # Omit snapshot IDs, secret contents, scanner excerpts and commit messages.
            clean_name = re.sub(r'^\d+/', '', name)
            print(f'Blocked: {clean_name}: {category}')
        if len(set(issues)) > 30:
            print('Additional findings omitted; review the source privately.')
        raise ValueError('Keep private evidence ignored; review and fix the listed categories')
    print(f'Privacy check passed: {len(seen)} source versions; secrets and private-material rules checked.')


def revisions(repo, revision):
    commits = git(repo, 'rev-list', revision).decode().splitlines()
    return commits, [git(repo, 'show', '-s', '--format=%B', commit) for commit in commits]


def main():
    import sys
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--repo', type=Path, default=Path.cwd())
    mode = parser.add_mutually_exclusive_group(required=True)
    mode.add_argument('--staged', action='store_true')
    mode.add_argument('--history', metavar='REVISION')
    mode.add_argument('--push', action='store_true')
    mode.add_argument('--message-file', type=Path)
    args = parser.parse_args()
    scanner = git(args.repo, 'config', '--get', 'privacy.scanner').decode().strip()
    if not scanner or subprocess.check_output([scanner, 'version'], text=True).strip() != '8.30.1':
        raise ValueError('Install the pinned scanner: python3 scripts/setup-privacy.py')
    snapshots, messages = [None], []
    if args.message_file:
        messages = [args.message_file.read_bytes()]
    elif args.history:
        snapshots, messages = revisions(args.repo, args.history)
    elif args.push:
        snapshots, messages = [], []
        for line in sys.stdin:
            local_ref, local_oid, remote_ref, remote_oid = line.split()
            if set(local_oid) == {'0'}:
                continue
            messages.append((local_ref + '\n' + remote_ref).encode())
            if git(args.repo, 'cat-file', '-t', local_oid).strip() == b'tag':
                messages.append(git(args.repo, 'cat-file', '-p', local_oid))
            if remote_oid.strip('0') and subprocess.run(['git', '-C', str(args.repo), 'cat-file', '-e', remote_oid], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL).returncode == 0:
                commits = git(args.repo, 'rev-list', local_oid, '^' + remote_oid).decode().splitlines()
            else:
                commits, _ = revisions(args.repo, local_oid)
            # Inspect the tip even if an old-history rollback has no new ancestors.
            tip = git(args.repo, 'rev-parse', local_oid + '^{commit}').decode().strip()
            snapshots.extend([tip, *commits])
            messages.extend(git(args.repo, 'show', '-s', '--format=%B', c) for c in commits)
        if not snapshots:
            return
    check(args.repo, snapshots, scanner, messages)


if __name__ == '__main__':
    try:
        main()
    except (OSError, ValueError, subprocess.CalledProcessError):
        import sys
        print('Privacy check failed. Fix findings or run python3 scripts/setup-privacy.py; do not bypass the check.', file=sys.stderr)
        raise SystemExit(1)

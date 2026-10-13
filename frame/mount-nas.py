#!/usr/bin/env python3
"""Mount a NAS using an existing SSH key and register it in VRWatch."""
import argparse
import json
import re
import subprocess
import time
from pathlib import Path


def systemd_argument(value):
    return '"' + str(value).replace(chr(92), chr(92) * 2).replace('"', chr(92) + '"').replace('%', '%%') + '"'


def main():
    home = Path.home()
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--remote', required=True, help='user@server:/folder')
    parser.add_argument('--mountpoint', type=Path, default=home / 'Videos/NAS')
    parser.add_argument('--label', default='NAS')
    parser.add_argument('--sshfs', type=Path, required=True, help='Path to the SSHFS executable')
    parser.add_argument('--key', type=Path, default=home / '.ssh/vrwatch-nas_ed25519')
    parser.add_argument('--known-hosts', type=Path, default=home / '.ssh/vrwatch-nas_known_hosts')
    parser.add_argument('--sftp-server', default='', help='Optional remote SFTP command; ordinary SFTP by default')
    args = parser.parse_args()
    if not re.fullmatch(r'[A-Za-z0-9_.-]+@[A-Za-z0-9.-]+:/[^\r\n]*', args.remote):
        parser.error('Use user@server:/folder for the remote drive.')
    if any('\n' in str(value) or '\r' in str(value) for value in vars(args).values()):
        parser.error('Settings must be on one line.')
    for filename in [args.sshfs, args.key, args.known_hosts]:
        if not filename.expanduser().is_file():
            raise RuntimeError(f'Required file is missing: {filename}. Complete SSHFS/key setup first.')
    point = args.mountpoint.expanduser().absolute()
    point.mkdir(parents=True, exist_ok=True)
    if not point.is_mount() and any(point.iterdir()):
        raise RuntimeError('The mount folder is not empty. Choose an empty folder.')
    options = ['ro', 'reconnect', 'ServerAliveInterval=15', 'ServerAliveCountMax=3',
               'ConnectTimeout=10', 'BatchMode=yes', 'IdentitiesOnly=yes', 'StrictHostKeyChecking=yes',
               f'IdentityFile={args.key.expanduser().absolute()}',
               f'UserKnownHostsFile={args.known_hosts.expanduser().absolute()}', 'nosuid', 'nodev', 'noexec']
    command = [str(args.sshfs.expanduser().absolute()), '-f', args.remote, str(point), '-o', ','.join(options)]
    if args.sftp_server:
        command += ['-o', f'sftp_server={args.sftp_server}']
    unit = home / '.config/systemd/user/vrwatch-nas.service'
    unit.parent.mkdir(parents=True, exist_ok=True)
    unit.write_text('[Unit]\nDescription=VRWatch NAS (read-only SSHFS)\n\n[Service]\nType=simple\n'
                    'ExecStart=' + ' '.join(systemd_argument(part) for part in command) + '\n'
                    'ExecStop=/usr/bin/fusermount3 -u ' + systemd_argument(point) + '\n'
                    'Restart=on-failure\nRestartSec=5\nTimeoutStopSec=10\n\n[Install]\nWantedBy=default.target\n')
    subprocess.run(['systemctl', '--user', 'daemon-reload'], check=True)
    subprocess.run(['systemctl', '--user', 'enable', 'vrwatch-nas.service'], check=True)
    if not point.is_mount():
        subprocess.run(['systemctl', '--user', 'restart', 'vrwatch-nas.service'], check=True)
        deadline = time.monotonic() + 15
        while not point.is_mount() and time.monotonic() < deadline:
            time.sleep(0.1)
        if not point.is_mount():
            raise RuntimeError('NAS did not mount. Inspect: journalctl --user -u vrwatch-nas.service')
    config = home / '.config/vrwatch'
    config.mkdir(parents=True, exist_ok=True)
    filename = config / 'library.json'
    data = json.loads(filename.read_text()) if filename.exists() else {'roots': []}
    root = {'id': 'nas', 'label': args.label, 'path': str(point), 'mountpoint': str(point)}
    data['roots'] = [root, *[item for item in data.get('roots', []) if item.get('id') != 'nas']]
    temporary = filename.with_suffix('.new')
    temporary.write_text(json.dumps(data, indent=2) + '\n')
    temporary.chmod(0o600)
    temporary.replace(filename)
    print(f'NAS mounted at {point}. Open Media library in VRWatch.')
    print('The user service reconnects the drive at login and after connection failures.')


if __name__ == '__main__':
    try:
        main()
    except (OSError, RuntimeError, subprocess.CalledProcessError) as error:
        raise SystemExit(f'NAS setup failed: {error}')

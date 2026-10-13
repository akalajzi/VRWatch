#!/usr/bin/env python3
"""Read-only, loopback media library for explicitly configured folders."""
import argparse
import hmac
import json
import mimetypes
import os
import re
import secrets
import stat
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, unquote, urlsplit

VIDEO_TYPES = {'.mp4': 'video/mp4', '.m4v': 'video/mp4', '.webm': 'video/webm',
               '.mkv': 'video/x-matroska', '.mov': 'video/quicktime', '.avi': 'video/x-msvideo',
               '.mpg': 'video/mpeg', '.mpeg': 'video/mpeg', '.ts': 'video/mp2t', '.ogv': 'video/ogg'}
ASSETS = {'library.js', 'library.css', 'scrollbars.css', 'icons/icon32.png', 'icons/icon128.png'}


class LibraryError(Exception):
    def __init__(self, message, status=400):
        super().__init__(message)
        self.status = status


def byte_range(header, size):
    """Return inclusive bounds. Reject multipart and unsatisfiable ranges."""
    match = re.fullmatch(r'bytes=(\d*)-(\d*)', header)
    if len(header) > 128 or not match or not any(match.groups()) or size == 0:
        raise LibraryError('Invalid byte range.', 416)
    first, last = match.groups()
    if not first:
        count = int(last)
        if count == 0:
            raise LibraryError('Invalid byte range.', 416)
        return max(0, size - count), size - 1
    start = int(first)
    end = min(int(last), size - 1) if last else size - 1
    if start >= size or end < start:
        raise LibraryError('Invalid byte range.', 416)
    return start, end


class Library:
    def __init__(self, config, assets):
        self.config = Path(config)
        self.assets = Path(assets)
        self.token = secrets.token_urlsafe(32)

    def roots(self):
        try:
            data = json.loads(self.config.read_text()) if self.config.exists() else {'roots': []}
            roots = data['roots']
            if not isinstance(roots, list) or len(roots) > 32:
                raise ValueError()
            ids = set()
            for root in roots:
                if (not isinstance(root, dict) or not re.fullmatch(r'[a-zA-Z0-9_-]{1,64}', root.get('id', ''))
                        or root['id'] in ids or not isinstance(root.get('label'), str)
                        or not isinstance(root.get('path'), str) or not Path(root['path']).is_absolute()
                        or ('mountpoint' in root and (not isinstance(root['mountpoint'], str)
                            or not Path(root['mountpoint']).is_absolute()))):
                    raise ValueError()
                ids.add(root['id'])
            return roots
        except (OSError, ValueError, KeyError, TypeError):
            raise LibraryError('The media folder configuration could not be read.', 503)

    def path(self, root_id, relative):
        root = next((item for item in self.roots() if item['id'] == root_id), None)
        if not root:
            raise LibraryError('This media folder is not configured.', 404)
        if root.get('mountpoint') and not Path(root['mountpoint']).is_mount():
            raise LibraryError(f'{root["label"]} is not mounted. Reconnect the drive and try again.', 503)
        if relative.startswith('/') or '\x00' in relative or '..' in Path(relative).parts:
            raise LibraryError('Invalid folder path.', 403)
        base = Path(root['path']).resolve(strict=True)
        target = (base / relative).resolve(strict=True)
        if not target.is_relative_to(base):
            raise LibraryError('This path is outside the media folder.', 403)
        return root, base, target

    def listing(self, root_id, relative):
        root, base, target = self.path(root_id, relative)
        if not target.is_dir():
            raise LibraryError('This is not a folder.', 400)
        entries = []
        with os.scandir(target) as directory:
            for entry in directory:
                if entry.name.startswith(('.', '#', '@')):
                    continue
                try:
                    path = Path(entry.path)
                    resolved = path.resolve(strict=True)
                    if not resolved.is_relative_to(base):
                        continue
                    info = entry.stat()
                    folder = stat.S_ISDIR(info.st_mode)
                    if not folder and (not stat.S_ISREG(info.st_mode) or path.suffix.lower() not in VIDEO_TYPES):
                        continue
                    entries.append({'name': entry.name, 'folder': folder,
                                    'path': path.relative_to(base).as_posix(),
                                    'size': None if folder else info.st_size})
                except (OSError, ValueError):
                    continue
        entries.sort(key=lambda item: (not item['folder'], item['name'].casefold()))
        return {'root': root['id'], 'label': root['label'],
                'path': '' if target == base else target.relative_to(base).as_posix(), 'entries': entries}


def create_server(config, assets, port=4179):
    library = Library(config, assets)

    class Handler(BaseHTTPRequestHandler):
        protocol_version = 'HTTP/1.1'

        def log_message(self, *_):
            pass  # Media names and access tokens do not belong in logs.

        def headers_for(self, code, mime, length, extra=None):
            self.response_started = True
            self.send_response(code)
            self.send_header('Content-Type', mime)
            self.send_header('Content-Length', str(length))
            self.send_header('Cache-Control', 'no-store')
            self.send_header('X-Content-Type-Options', 'nosniff')
            self.send_header('Cross-Origin-Resource-Policy', 'same-origin')
            self.send_header('Referrer-Policy', 'no-referrer')
            self.send_header('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; "
                             "img-src 'self' data:; media-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'")
            for key, value in (extra or {}).items():
                self.send_header(key, value)
            self.end_headers()

        def respond(self, value, code=200, extra=None):
            data = json.dumps(value).encode()
            self.headers_for(code, 'application/json; charset=utf-8', len(data), extra)
            if self.command != 'HEAD':
                self.wfile.write(data)

        def do_HEAD(self):
            self.do_GET()

        def do_GET(self):
            self.response_started = False
            try:
                port = self.server.server_address[1]
                hosts = {f'127.0.0.1:{port}', f'localhost:{port}'}
                if self.headers.get('Host') not in hosts:
                    raise LibraryError('Invalid library host.', 403)
                origin = self.headers.get('Origin')
                if origin and origin not in {f'http://{host}' for host in hosts} | {
                        'chrome-extension://bkjijegjmneghekcknijmioimbahmfap'}:
                    raise LibraryError('Cross-origin library access is unavailable.', 403)
                url = urlsplit(self.path)
                if url.path in ('/', '/library', '/library/'):
                    data = (library.assets / 'library.html').read_text().replace(
                        '<meta name="library-token" content="">',
                        f'<meta name="library-token" content="{library.token}">').encode()
                    self.headers_for(200, 'text/html; charset=utf-8', len(data))
                    if self.command != 'HEAD':
                        self.wfile.write(data)
                    return
                if url.path.startswith('/assets/') and url.path[8:] in ASSETS:
                    filename = library.assets / url.path[8:]
                    data = filename.read_bytes()
                    self.headers_for(200, mimetypes.guess_type(filename)[0] or 'application/octet-stream', len(data))
                    if self.command != 'HEAD':
                        self.wfile.write(data)
                    return
                if url.path.startswith('/api/'):
                    if not hmac.compare_digest(self.headers.get('X-VRWatch-Library-Token', '').encode(), library.token.encode()):
                        raise LibraryError('Reload the media library to reconnect.', 403)
                    if self.headers.get('Sec-Fetch-Site', 'none') not in ('same-origin', 'none'):
                        raise LibraryError('Cross-site library access is unavailable.', 403)
                    if url.path == '/api/roots':
                        self.respond({'roots': [{'id': root['id'], 'label': root['label']} for root in library.roots()]})
                        return
                    if url.path == '/api/list':
                        query = parse_qs(url.query)
                        self.respond(library.listing(query.get('root', [''])[0], query.get('path', [''])[0]))
                        return
                if url.path.startswith('/media/'):
                    parts = url.path.split('/', 4)
                    if len(parts) != 5 or not hmac.compare_digest(parts[2].encode(), library.token.encode()):
                        raise LibraryError('Reload the media library to reconnect.', 403)
                    _, base, filename = library.path(unquote(parts[3]), unquote(parts[4]))
                    mime = VIDEO_TYPES.get(filename.suffix.lower())
                    if not mime:
                        raise LibraryError('This is not a video file.', 415)
                    # A bounded chunk copy supports large NAS files and efficient seeking.
                    descriptor = os.open(filename, os.O_RDONLY | os.O_NONBLOCK | os.O_NOFOLLOW)
                    with os.fdopen(descriptor, 'rb') as stream:
                        info = os.fstat(stream.fileno())
                        actual = Path(f'/proc/self/fd/{stream.fileno()}').resolve()
                        if not stat.S_ISREG(info.st_mode) or not actual.is_relative_to(base):
                            raise LibraryError('This is not a regular file.', 403)
                        size = info.st_size
                        etag = f'"{info.st_mtime_ns:x}-{size:x}"'
                        start, end, code = 0, size - 1, 200
                        header = self.headers.get('Range')
                        if header and self.headers.get('If-Range', etag) == etag:
                            try:
                                start, end = byte_range(header, size)
                            except LibraryError:
                                self.respond({'error': 'This video range is unavailable.'}, 416,
                                             {'Content-Range': f'bytes */{size}', 'Accept-Ranges': 'bytes'})
                                return
                            code = 206
                        extra = {'Accept-Ranges': 'bytes', 'ETag': etag}
                        if code == 206:
                            extra['Content-Range'] = f'bytes {start}-{end}/{size}'
                        remaining = max(0, end - start + 1)
                        self.headers_for(code, mime, remaining, extra)
                        if self.command == 'HEAD':
                            return
                        stream.seek(start)
                        while remaining:
                            data = stream.read(min(256 * 1024, remaining))
                            if not data:
                                self.close_connection = True
                                break
                            self.wfile.write(data)
                            remaining -= len(data)
                    return
                raise LibraryError('Library page not found.', 404)
            except LibraryError as error:
                self.respond({'error': str(error)}, error.status)
            except FileNotFoundError:
                self.respond({'error': 'This file or folder is no longer available. Refresh and try again.'}, 404)
            except PermissionError:
                self.respond({'error': 'This folder or file cannot be read with the current NAS account.'}, 403)
            except (BrokenPipeError, ConnectionResetError):
                pass
            except OSError:
                if self.response_started:
                    self.close_connection = True
                else:
                    self.respond({'error': 'The drive could not be read. Check its connection and try again.'}, 503)

    server = ThreadingHTTPServer(('127.0.0.1', port), Handler)
    server.daemon_threads = True
    server.library = library
    return server


def start_library(config, assets):
    server = create_server(config, assets)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    return server


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--config', type=Path, default=Path.home() / '.config/vrwatch/library.json')
    parser.add_argument('--assets', type=Path, required=True)
    parser.add_argument('--port', type=int, default=4179)
    args = parser.parse_args()
    server = create_server(args.config, args.assets, args.port)
    print(f'Media library: http://127.0.0.1:{server.server_address[1]}/library/', flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()

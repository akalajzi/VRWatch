"""Exercise real HTTP listing, mounted-drive checks, and video range reads."""
import http.client
import importlib.util
import json
import os
import tempfile
import threading
import unittest
from pathlib import Path
from urllib.parse import quote, urlencode

spec = importlib.util.spec_from_file_location('library', Path(__file__).parents[1] / 'frame/library-server.py')
library = importlib.util.module_from_spec(spec)
spec.loader.exec_module(library)


class LibraryTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.base = Path(self.temp.name)
        self.drive = self.base / 'drive'
        self.drive.mkdir()
        (self.drive / 'Movies & trips').mkdir()
        (self.drive / 'Movies & trips/č clip #1.mp4').write_bytes(bytes(range(256)) * 8)
        (self.drive / 'movie.WEBM').write_bytes(b'video')
        (self.drive / 'notes.txt').write_text('private')
        (self.drive / '.hidden.mp4').write_bytes(b'hidden')
        (self.drive / '@eaDir').mkdir()
        (self.base / 'outside.mp4').write_bytes(b'outside')
        (self.drive / 'escape.mp4').symlink_to(self.base / 'outside.mp4')
        (self.drive / 'escape-folder').symlink_to(self.base)
        os.mkfifo(self.drive / 'pipe.mp4')
        self.config = self.base / 'library.json'
        self.root = {'id': 'nas', 'label': 'NAS', 'path': str(self.drive)}
        self.configure()
        self.assets = self.base / 'assets'
        self.assets.mkdir()
        (self.assets / 'library.html').write_text('<meta name="library-token" content="">')
        self.server = library.create_server(self.config, self.assets, port=0)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        self.token = self.server.library.token

    def configure(self):
        self.config.write_text(json.dumps({'roots': [self.root]}))

    def tearDown(self):
        self.server.shutdown()
        self.server.server_close()
        self.thread.join()
        self.temp.cleanup()

    def request(self, path, headers=None, method='GET', authenticated=True):
        conn = http.client.HTTPConnection('127.0.0.1', self.server.server_address[1], timeout=3)
        values = {'X-VRWatch-Library-Token': self.token} if authenticated else {}
        values.update(headers or {})
        try:
            conn.request(method, path, headers=values)
            response = conn.getresponse()
            return response.status, dict(response.getheaders()), response.read()
        finally:
            conn.close()

    def media(self, name):
        return f'/media/{self.token}/nas/{quote(name)}'

    def test_browse_root_subfolders_and_filter_files(self):
        code, _, body = self.request('/api/roots')
        self.assertEqual(code, 200)
        self.assertEqual(json.loads(body), {'roots': [{'id': 'nas', 'label': 'NAS'}]})
        code, _, body = self.request('/api/list?root=nas')
        data = json.loads(body)
        self.assertEqual(code, 200)
        self.assertEqual(data['path'], '')
        self.assertEqual([x['name'] for x in data['entries']], ['Movies & trips', 'movie.WEBM'])
        code, _, body = self.request('/api/list?' + urlencode({'root': 'nas', 'path': 'Movies & trips'}))
        self.assertEqual(code, 200)
        self.assertEqual(json.loads(body)['entries'][0]['path'], 'Movies & trips/č clip #1.mp4')

    def test_authentication_host_origin_and_path_boundaries(self):
        self.assertEqual(self.request('/api/list?root=nas', authenticated=False)[0], 403)
        self.assertEqual(self.request('/api/roots', {'Host': 'evil.example'})[0], 403)
        self.assertEqual(self.request('/api/roots', {'Origin': 'https://evil.example'})[0], 403)
        self.assertEqual(self.request('/api/roots', {'Sec-Fetch-Site': 'cross-site'})[0], 403)
        for path in ['../outside.mp4', '/etc', 'escape-folder']:
            self.assertEqual(self.request('/api/list?' + urlencode({'root': 'nas', 'path': path}))[0], 403)
        self.assertEqual(self.request(self.media('escape.mp4'))[0], 403)
        self.assertEqual(self.request(self.media('notes.txt'))[0], 415)
        self.assertEqual(self.request(self.media('pipe.mp4'))[0], 403)
        self.assertEqual(self.request('/media/wrong/nas/movie.WEBM')[0], 403)

    def test_range_reads_head_and_if_range_for_real_file(self):
        path = self.media('Movies & trips/č clip #1.mp4')
        contents = bytes(range(256)) * 8
        code, headers, data = self.request(path)
        self.assertEqual((code, data), (200, contents))
        self.assertEqual(headers['Accept-Ranges'], 'bytes')
        for header, expected in [('bytes=1000-1023', contents[1000:1024]),
                                 ('bytes=2040-', contents[2040:]), ('bytes=-12', contents[-12:]),
                                 ('bytes=2040-99999', contents[2040:])]:
            code, fields, body = self.request(path, {'Range': header})
            self.assertEqual(code, 206)
            self.assertEqual(body, expected)
            self.assertEqual(int(fields['Content-Length']), len(expected))
            self.assertTrue(fields['Content-Range'].endswith('/2048'))
        code, fields, body = self.request(path, method='HEAD')
        self.assertEqual((code, body, fields['Content-Length']), (200, b'', '2048'))
        self.assertEqual(self.request(path, {'Range': 'bytes=1-5', 'If-Range': 'stale'})[0], 200)
        self.assertEqual(self.request(path, {'Range': 'bytes=1-5', 'If-Range': headers['ETag']})[0], 206)

    def test_invalid_ranges_and_mount_disconnect(self):
        for header in ['bytes=9000-', 'bytes=9-1', 'bytes=-0', 'bytes=0-1,3-4', 'nonsense']:
            code, headers, _ = self.request(self.media('movie.WEBM'), {'Range': header})
            self.assertEqual(code, 416)
            self.assertEqual(headers['Content-Range'], 'bytes */5')
        self.root['mountpoint'] = str(self.drive)
        self.configure()
        self.assertEqual(self.request('/api/list?root=nas')[0], 503)
        self.assertEqual(self.request(self.media('movie.WEBM'))[0], 503)
        del self.root['mountpoint']
        self.configure()
        self.assertEqual(self.request('/api/list?root=nas')[0], 200)

    def test_page_issues_token_and_missing_config_is_empty(self):
        code, headers, body = self.request('/library/', authenticated=False)
        self.assertEqual(code, 200)
        self.assertIn(self.token.encode(), body)
        self.assertEqual(headers['Cache-Control'], 'no-store')
        self.assertIn("frame-ancestors 'none'", headers['Content-Security-Policy'])
        self.config.unlink()
        self.assertEqual(json.loads(self.request('/api/roots')[2]), {'roots': []})


if __name__ == '__main__':
    unittest.main()

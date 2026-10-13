import { test } from 'node:test';
import { execFileSync } from 'node:child_process';

test('media library lists folders, confines access, detects unmounted drives and streams seek ranges', () => {
  execFileSync('python3', ['tests/library-server.py'], { stdio: 'pipe', timeout: 15000 });
});

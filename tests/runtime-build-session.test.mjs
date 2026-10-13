import { test } from 'node:test';
import { execFileSync } from 'node:child_process';

test('pinned runtime sessions preserve caches, isolate source drift and record real execution timing', () => {
  execFileSync('python3', ['tests/runtime-build-session.py'], { stdio: 'inherit' });
});

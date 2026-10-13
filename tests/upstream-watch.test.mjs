import { test } from 'node:test';
import { execFileSync } from 'node:child_process';

test('upstream observations preserve pending reviews, crash recovery and health evidence', () => {
  execFileSync('python3', ['tests/upstream-watch.py'], { stdio: 'inherit' });
});

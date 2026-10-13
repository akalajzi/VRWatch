import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeUrl, seekTo, seekBounds, formatTime, setVolume } from '../extension/src/media.js';

test('address entry accepts bare domains and local hosts, rejects executable schemes', () => {
  assert.equal(normalizeUrl('youtube.com/watch?v=123'), 'https://youtube.com/watch?v=123');
  assert.equal(normalizeUrl('http://localhost:4178/'), 'http://localhost:4178/');
  assert.equal(normalizeUrl('localhost:4178/video'), 'https://localhost:4178/video');
  for (const url of ['', 'javascript:alert(1)', 'data:text/html,hello', 'file:///tmp/video', 'not a url']) {
    assert.throws(() => normalizeUrl(url));
  }
});

test('seeking clamps file playback and avoids invalid time values', () => {
  const video = { duration: 100, currentTime: 50, seekable: { length: 0 } };
  assert.equal(seekTo(video, -10), true);
  assert.equal(video.currentTime, 0);
  seekTo(video, 200);
  assert.equal(video.currentTime, 100);
  assert.equal(seekTo(video, NaN), false);
});

test('live seeking follows the available DVR window and handles gaps', () => {
  const video = { duration: Infinity, currentTime: 115, seekable: { length: 2, start: i => [100, 140][i], end: i => [120, 160][i] } };
  assert.deepEqual(seekBounds(video), { start: 100, end: 160 });
  seekTo(video, 90);
  assert.equal(video.currentTime, 100);
  seekTo(video, 135);
  assert.equal(video.currentTime, 140);
  assert.equal(seekTo({ duration: Infinity, seekable: { length: 0 } }, 10), false);
});

test('volume changes clamp and unmute, while zero preserves mute state', () => {
  const video = { volume: 0.4, muted: true };
  setVolume(video, 1.5);
  assert.equal(video.volume, 1);
  assert.equal(video.muted, false);
  setVolume(video, -1);
  assert.equal(video.volume, 0);
});

test('time labels cover hours and live streams', () => {
  assert.equal(formatTime(65), '1:05');
  assert.equal(formatTime(3661), '1:01:01');
  assert.equal(formatTime(Infinity), 'LIVE');
});

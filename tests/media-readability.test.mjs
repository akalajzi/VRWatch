import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createReadabilityProbe } from '../extension/src/media-readability.js';

test('a tainted source cannot poison later readable videos; checks cache and invalidate', () => {
  let tainted = false, reads = 0;
  const canvas = {
    set width(_) { tainted = false; }, set height(_) { tainted = false; },
    getContext: () => ({
      drawImage(video) { tainted ||= video.blocked; },
      getImageData() { reads++; if (tainted) throw new DOMException('Tainted', 'SecurityError'); },
    }),
  };
  const probe = createReadabilityProbe(canvas);
  const video = { readyState: 4, videoWidth: 1920, currentSrc: 'blocked.mp4', blocked: true };
  assert.equal(probe.check(video).state, 'blocked');
  video.currentSrc = 'readable.mp4'; video.blocked = false;
  assert.equal(probe.check(video).state, 'ready');
  for (let i = 0; i < 100; i++) probe.check(video);
  assert.equal(reads, 2);
  video.readyState = 0;
  assert.equal(probe.check(video).state, 'pending');
  video.readyState = 4; video.blocked = true; probe.invalidate();
  assert.equal(probe.check(video).state, 'blocked');
  video.blocked = false; video.srcObject = {};
  assert.equal(probe.check(video).state, 'ready');
  video.mediaKeys = {};
  assert.equal(probe.check(video).state, 'blocked');
});

test('transient readback errors can recover without a source change', () => {
  let fail = true;
  const probe = createReadabilityProbe({ getContext: () => ({ drawImage() { if (fail) throw new Error('not ready'); }, getImageData() {} }) });
  const video = { readyState: 4, videoWidth: 1920 };
  assert.equal(probe.check(video).state, 'blocked');
  fail = false;
  assert.equal(probe.check(video).state, 'ready');
});

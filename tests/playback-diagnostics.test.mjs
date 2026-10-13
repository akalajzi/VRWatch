import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bufferAhead, PlaybackDiagnostics } from '../extension/src/playback-diagnostics.js';

function videoFixture() {
  const video = new EventTarget();
  Object.assign(video, { currentTime: 5, videoWidth: 3840, videoHeight: 2160, paused: false, ended: false, seeking: false, readyState: 4 });
  const ranges = [[0, 10], [20, 40]];
  video.buffered = { length: ranges.length, start: i => ranges[i][0], end: i => ranges[i][1] };
  let frames = { totalVideoFrames: 100, droppedVideoFrames: 10 };
  video.getVideoPlaybackQuality = () => ({ ...frames });
  let now = 0;
  const diagnostics = new PlaybackDiagnostics(video, () => now);
  return { video, diagnostics, time: t => { now = t; }, quality: v => { frames = v; }, event: name => video.dispatchEvent(new Event(name)) };
}

test('buffer measurement stops at the current contiguous range', () => {
  const { video, diagnostics } = videoFixture();
  assert.equal(bufferAhead(video), 5);
  video.currentTime = 15;
  assert.equal(bufferAhead(video), 0);
  video.currentTime = 25;
  assert.equal(bufferAhead(video), 15);
  diagnostics.dispose();
});

test('buffering excludes paused playback, seeks and mere network stalls', () => {
  const { video, diagnostics: d, time, event } = videoFixture();
  event('stalled'); time(1000);
  assert.equal(d.snapshot().bufferingSeconds, 0);
  event('waiting'); event('waiting'); time(2500);
  assert.equal(d.snapshot().bufferingSeconds, 1.5);
  event('playing'); time(5000);
  assert.equal(d.snapshot().bufferingSeconds, 1.5);
  video.paused = true; event('waiting'); time(6000);
  video.paused = false; video.seeking = true; event('waiting'); time(7000);
  assert.equal(d.snapshot().bufferingCount, 1);
  video.seeking = false; video.readyState = 2; event('seeked'); time(7500); event('pause');
  assert.equal(d.snapshot().bufferingSeconds, 2);
  assert.equal(d.snapshot().stalls, 1);
  d.dispose(); event('waiting'); time(9000);
  assert.equal(d.snapshot().bufferingSeconds, 2);
});

test('video and XR rates stay separate and reset across source/session changes', () => {
  const { diagnostics: d, time, quality, event } = videoFixture();
  quality({ totalVideoFrames: 160, droppedVideoFrames: 12 }); time(1000);
  for (let i = 0; i <= 90; i++) d.xrFrame(i * 1000 / 90);
  let s = d.snapshot();
  assert.equal(s.videoFPS, 58);
  assert.equal(s.droppedFrames, 2);
  assert.ok(Math.abs(s.xrFPS - 90) < 0.001);
  assert.ok(Math.abs(s.xrP95Ms - 1000 / 90) < 0.001);
  d.resetXR(); assert.equal(d.snapshot().xrFPS, null);
  quality({ totalVideoFrames: 0, droppedVideoFrames: 0 }); event('emptied');
  assert.equal(d.snapshot().droppedFrames, 0);
  assert.equal(d.snapshot().videoFPS, null);
  d.dispose();
});

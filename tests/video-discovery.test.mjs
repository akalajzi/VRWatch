import { test } from 'node:test';
import assert from 'node:assert/strict';
import { findVideo } from '../extension/src/video-discovery.js';
import { parsePornhubMetadata, pornhubMetadata } from '../extension/src/pornhub.js';
import { detectSiteProjection, projectionPreferenceKey } from '../extension/src/projection-detection.js';
import { showSourceInBrowser } from '../extension/src/browser-playback.js';

const url = 'https://www.pornhub.com/view_video.php?viewkey=ph123';
const data = (vr = { enabled: true, projection: 3, stereoSrc: true, stereoType: 1 }, key = 'ph123') =>
  `var VIDEO_SHOW = ${JSON.stringify({ videoId: 'playerDiv_123', vkey: key, vr: JSON.stringify(vr), unused: 'escaped " } text' })};`;
const rect = (width, height, top = 0) => ({ width, height, top, bottom: top + height, left: 0, right: width });
function fixture() {
  const main = { dataset: {}, getBoundingClientRect: () => rect(0, 0), readyState: 0 };
  const advert = { getBoundingClientRect: () => rect(950, 250), readyState: 4 };
  const anchor = { getBoundingClientRect: () => rect(656, 369), querySelector: selector => selector === 'video.mgp_videoElement' ? main : null };
  const document = {
    defaultView: { innerWidth: 1280, innerHeight: 800 }, scripts: [{ src: '', textContent: data() }],
    getElementById: id => id === 'playerDiv_123' ? anchor : null,
    querySelector: selector => selector === '#player .mgp_container' ? anchor : null,
    querySelectorAll: () => [main, advert],
  };
  return { document, main, advert, anchor };
}

test('hidden Pornhub VR source wins over a larger, playing advert, even before it loads', () => {
  const { document, main, anchor } = fixture();
  assert.deepEqual(findVideo(document, url), { video: main, anchor, projection: '180_LR' });
  assert.equal(detectSiteProjection(document, url, main), '180_LR');
  assert.equal(findVideo(document, 'https://example.com/watch').video, document.querySelectorAll()[1]);
});

test('missing, detached, and offscreen main players do not expose an advert VR button', () => {
  const { document, anchor } = fixture();
  document.getElementById = () => null;
  assert.equal(findVideo(document, url), null);
  document.getElementById = () => anchor;
  anchor.querySelector = () => null;
  assert.equal(findVideo(document, url), null);
  const next = fixture();
  next.anchor.getBoundingClientRect = () => rect(656, 369, 900);
  assert.equal(findVideo(next.document, url), null);
});

test('declared projection follows the main source, never a banner or stale video', () => {
  const { document, main, advert } = fixture();
  assert.equal(detectSiteProjection(document, url, advert), null);
  assert.equal(pornhubMetadata(document, url.replace('ph123', 'ph456')), null);
  document.scripts[0].textContent = data({ enabled: false });
  assert.equal(detectSiteProjection(document, url, main), 'FLAT');
  assert.equal(pornhubMetadata(document, 'https://pornhub.com.evil.example/view_video.php?viewkey=ph123'), null);
});

test('Pornhub formats use explicit projection and stereo declarations', () => {
  for (const [vr, expected] of [
    [{ enabled: true, projection: 1, stereoSrc: false }, '180'],
    [{ enabled: true, projection: 2, stereoSrc: false }, '360'],
    [{ enabled: true, projection: 2, stereoSrc: true, stereoType: 1 }, '360_LR'],
    [{ enabled: true, projection: 2, stereoSrc: true, stereoType: 2 }, '360_TB'],
    [{ enabled: true, projection: 3, stereoSrc: true, stereoType: 2 }, null],
    [{ enabled: true, projection: 99, stereoSrc: true, stereoType: 1 }, null],
  ]) assert.equal(parsePornhubMetadata(data(vr)).projection, expected);
});

test('metadata is parsed as JSON, not executable JavaScript', () => {
  assert.equal(parsePornhubMetadata('// var VIDEO_SHOW = {};'), null);
  assert.equal(parsePornhubMetadata('var VIDEO_SHOW = {videoId: runCode()};'), null);
  assert.equal(parsePornhubMetadata(data().slice(0, -5)), null);
  assert.equal(parsePornhubMetadata('var VIDEO_SHOW = {"videoId":"other","vkey":"ph123"};'), null);
  assert.equal(parsePornhubMetadata(data()).key, 'ph123');
});

test('saved format follows Pornhub video identity across tracking and embeds', () => {
  assert.equal(projectionPreferenceKey(url + '&utm_source=example'), 'pornhub:ph123');
  assert.equal(projectionPreferenceKey('https://pornhub.com/embed/ph123'), 'pornhub:ph123');
  assert.notEqual(projectionPreferenceKey(url), projectionPreferenceKey(url.replace('ph123', 'ph456')));
});

test('browser source view exposes the existing video and restores the site view without resetting media', () => {
  function style(initial = {}) {
    const properties = new Map(Object.entries(initial).map(([key, value]) => [key, [value, '']]));
    return { getPropertyValue: key => properties.get(key)?.[0] ?? '', getPropertyPriority: key => properties.get(key)?.[1] ?? '',
      setProperty: (key, value, priority = '') => properties.set(key, [value, priority]), removeProperty: key => properties.delete(key) };
  }
  const video = { style: style({ display: 'none', width: '80%' }), controls: false, currentSrc: 'blob:original',
    currentTime: 42, volume: 0.5, muted: false, paused: true };
  const canvas = { style: style({ display: 'block' }) };
  const restore = showSourceInBrowser(video, { querySelector: () => canvas });
  assert.equal(video.style.getPropertyValue('display'), 'block');
  assert.equal(canvas.style.getPropertyValue('display'), 'none');
  assert.equal(video.controls, true);
  video.style.setProperty('border', '1px solid red');
  restore();
  assert.equal(video.style.getPropertyValue('display'), 'none');
  assert.equal(video.style.getPropertyValue('width'), '80%');
  assert.equal(video.style.getPropertyValue('border'), '1px solid red');
  assert.equal(canvas.style.getPropertyValue('display'), 'block');
  assert.equal(video.controls, false);
  assert.deepEqual([video.currentSrc, video.currentTime, video.volume, video.muted, video.paused], ['blob:original', 42, 0.5, false, true]);
});

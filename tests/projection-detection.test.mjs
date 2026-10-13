import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseEpornerMetadata, detectSiteProjection, projectionPreferenceKey, chooseProjection } from '../extension/src/projection-detection.js';
import { createProjectionPreferences, cleanProjectionPreferences } from '../extension/src/projection-preferences.js';

const declarations = (vr, type, id = 'abc123') => `EP.video.player.vid = '${id}';\nEP.video.player.VR = ${vr};\nEP.video.player.VRtype = '${type}';`;
const documentFor = text => ({ scripts: [{ src: '', textContent: text }], querySelector: () => null });

test('Eporner declares each video format, including ordinary videos and unsupported projections', () => {
  for (const type of ['180_LR', '180', '360_LR', '360_TB', 'EAC']) {
    assert.equal(parseEpornerMetadata(declarations(true, type)).projection, type);
  }
  assert.equal(parseEpornerMetadata(declarations(false, '180_LR')).projection, 'FLAT');
  assert.equal(parseEpornerMetadata(declarations(true, 'SPHERE')).projection, '360');
  assert.equal(parseEpornerMetadata(declarations(true, 'unsupported')).projection, null);
  assert.equal(parseEpornerMetadata(`EP.video.player.VR = true; EP.video.player.VRtype = runCode();`).projection, null);
  assert.equal(parseEpornerMetadata('// EP.video.player.VR = false;'), null);
});

test('site detection rejects stale page metadata and foreign domains, and follows changed declarations', () => {
  const document = documentFor(declarations(true, '180_LR'));
  const url = 'https://www.eporner.com/video-abc123/example/';
  assert.equal(detectSiteProjection(document, url), '180_LR');
  assert.equal(detectSiteProjection(document, 'https://eporner.com/video-other/example/'), null);
  assert.equal(detectSiteProjection(document, 'https://eporner.com.evil.example/video-abc123/example/'), null);
  document.scripts[0].textContent = declarations(false, '180_LR');
  assert.equal(detectSiteProjection(document, url), 'FLAT');
  assert.equal(detectSiteProjection(document, url, { dataset: { projection: '360_TB' } }), '360_TB');
  assert.equal(detectSiteProjection({ scripts: [], querySelector: () => ({}) }, 'https://youtube.com/watch?v=abc'), 'EAC');
});

test('manual and saved corrections override metadata, which overrides site fallback', () => {
  assert.equal(chooseProjection({ manual: 'FLAT', saved: '180_LR', site: '360', file: '360_TB', hostname: 'eporner.com' }), 'FLAT');
  assert.equal(chooseProjection({ saved: '180', site: '360', file: '360_TB', hostname: 'eporner.com' }), '180');
  assert.equal(chooseProjection({ site: 'FLAT', file: '360_TB', hostname: 'eporner.com' }), 'FLAT');
  assert.equal(chooseProjection({ file: '360_TB', hostname: 'example.com' }), '360_TB');
  assert.equal(chooseProjection({ hostname: 'www.eporner.com' }), '180_LR');
  assert.equal(chooseProjection({ hostname: 'eporner.com.example.com' }), 'FLAT');
});

test('saved choices follow video identity across tracking, titles, embedding, and timestamps', () => {
  assert.equal(projectionPreferenceKey('https://eporner.com/video-abc123/title/?utm_source=test'), 'eporner:abc123');
  assert.equal(projectionPreferenceKey('https://www.eporner.com/embed/abc123/'), 'eporner:abc123');
  assert.equal(projectionPreferenceKey('https://youtube.com/watch?v=abc&t=10&list=xyz'), 'youtube:abc');
  assert.equal(projectionPreferenceKey('https://youtube.com/embed/abc'), 'youtube:abc');
  assert.notEqual(projectionPreferenceKey('https://youtube.com/watch?v=abc'), projectionPreferenceKey('https://youtube.com/watch?v=def'));
});

test('manual corrections persist after reload and preserve newer choices from another tab', async () => {
  let value = {};
  const storage = { get: async () => ({ videoProjections: structuredClone(value) }), set: async next => { value = next.videoProjections; } };
  const preferences = createProjectionPreferences(storage);
  await preferences.load(); await preferences.save('eporner:abc', '180_LR');
  const reloaded = createProjectionPreferences(storage);
  await reloaded.load(); assert.equal(reloaded.get('eporner:abc'), '180_LR');
  value['eporner:abc'] = { projection: '360', updated: Date.now() + 1000 };
  await preferences.save('youtube:def', 'EAC');
  assert.equal(value['eporner:abc'].projection, '360');
  assert.equal(value['youtube:def'].projection, 'EAC');
  await preferences.save('unknown', 'invalid'); assert.equal(value.unknown, undefined);
  await preferences.reset('eporner:abc');
  assert.equal(preferences.get('eporner:abc'), null);
  assert.equal(value['eporner:abc'], undefined);
  assert.equal(value['youtube:def'].projection, 'EAC');
  await Promise.all([preferences.save('eporner:abc', '180_LR'), preferences.reset('eporner:abc')]);
  assert.equal(preferences.get('eporner:abc'), null);
  assert.equal(value['eporner:abc'], undefined);
});

test('correction storage is bounded and filters invalid data', () => {
  const entries = Object.fromEntries(Array.from({ length: 220 }, (_, i) => [String(i), { projection: '180_LR', updated: i }]));
  entries.invalid = { projection: 'other', updated: 300 };
  const cleaned = cleanProjectionPreferences(entries);
  assert.equal(Object.keys(cleaned).length, 200);
  assert.equal(cleaned['0'], undefined); assert.equal(cleaned['219'].projection, '180_LR');
  assert.equal(cleaned.invalid, undefined);
});

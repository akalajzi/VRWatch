import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readBookmarkState, changeBookmarks, toggleBookmark, migrateBookmarkState, DEFAULT_BOOKMARKS, saveBookmarkPreview } from '../extension/src/bookmarks.js';
import { previewEvictions, PREVIEW_BUDGET, MAX_PREVIEW_BYTES } from '../extension/src/bookmark-previews.js';
import { createBookmarkCapture } from '../extension/src/bookmark-capture.js';
import { relevantBookmarkVideo } from '../extension/src/bookmark-capture-content.js';
import { currentNativeDocument } from '../extension/src/native-document.js';

let data;
beforeEach(() => {
  data = new Map();
  globalThis.localStorage = { getItem: key => data.get(key) ?? null, setItem: (key, value) => data.set(key, value) };
});

test('fresh profile seeds four links once, old profiles retain edited starters and removals', async () => {
  const fresh = await readBookmarkState();
  assert.deepEqual(fresh.quickLinks, DEFAULT_BOOKMARKS.map(item => item.url));
  const existing = migrateBookmarkState({ bookmarks: [{ ...DEFAULT_BOOKMARKS[0], title: 'My search' }, { url: 'https://deovr.com/', title: 'My old starter' }], bookmarkDefaultsVersion: 1 });
  assert.equal(existing.bookmarks.length, 2);
  assert.equal(existing.bookmarks[0].title, 'My search');
  assert.deepEqual(existing.quickLinks, ['https://www.google.com/']);
  assert.deepEqual(migrateBookmarkState({ bookmarks: [], bookmarkDefaultsVersion: 2 }).quickLinks, []);
  for (const item of fresh.bookmarks) await changeBookmarks('delete', { url: item.url });
  assert.deepEqual((await readBookmarkState()).bookmarks, []);
  assert.deepEqual((await readBookmarkState()).quickLinks, []);
});

test('concurrent saves survive and never auto-pin; duplicates and executable URLs fail', async () => {
  await Promise.all(Array.from({ length: 8 }, (_, i) => changeBookmarks('save', { url: `https://example.com/${i}`, title: `Title ${i}` })));
  assert.equal((await readBookmarkState()).bookmarks.length, 12);
  assert.equal((await readBookmarkState()).quickLinks.length, 4);
  await assert.rejects(changeBookmarks('save', { url: 'https://example.com/1' }), /already bookmarked/);
  await assert.rejects(changeBookmarks('save', { url: 'javascript:alert(1)' }), /http/);
});

test('pin cap, ordering, hiding and edited/deleted URLs remain consistent across reads', async () => {
  await changeBookmarks('save', { url: 'https://example.com/one', title: 'One' });
  await changeBookmarks('save', { url: 'https://example.com/two', title: 'Two' });
  await changeBookmarks('pin', { url: 'https://example.com/one' });
  await assert.rejects(changeBookmarks('pin', { url: 'https://example.com/two' }), /five/);
  await changeBookmarks('move', { url: 'https://example.com/one', direction: -1 });
  const before = await readBookmarkState();
  await changeBookmarks('visibility', { visible: false });
  const hidden = await readBookmarkState();
  assert.equal(hidden.showQuickLinks, false);
  assert.deepEqual(hidden.quickLinks, before.quickLinks);
  const old = before.bookmarks.find(item => item.title === 'One');
  await changeBookmarks('save', { originalUrl: old.url, url: 'https://example.com/new', title: 'Edited', folder: 'Travel' });
  const edited = await readBookmarkState();
  assert.equal(edited.quickLinks[3], 'https://example.com/new');
  assert.notEqual(edited.bookmarks.find(item => item.title === 'Edited').previewKey, old.previewKey);
  assert.equal(await saveBookmarkPreview(old, new Blob()), false, 'late old capture cannot replace an edited bookmark');
  await toggleBookmark('https://example.com/new');
  assert.equal((await readBookmarkState()).quickLinks.length, 4);
});

test('folder removal keeps bookmarks, title edits keep previews, clearing invalidates in-flight images', async () => {
  const result = await changeBookmarks('save', { url: 'https://example.com/', title: 'Original', folder: 'Travel' });
  await changeBookmarks('save', { originalUrl: result.bookmark.url, url: result.bookmark.url, title: 'Renamed', folder: 'Travel' });
  let state = await readBookmarkState();
  assert.equal(state.bookmarks.at(-1).previewKey, result.bookmark.previewKey);
  await changeBookmarks('deleteFolder', { name: 'Travel' });
  state = await readBookmarkState();
  assert.equal(state.bookmarks.at(-1).folder, '');
  await changeBookmarks('clearPreviews');
  assert.equal(await saveBookmarkPreview(result.bookmark, new Blob()), false);
  assert.equal((await readBookmarkState()).bookmarks.length, 5);
});

test('image eviction removes orphans and oldest images within the fixed budget', () => {
  const size = MAX_PREVIEW_BYTES;
  const images = Array.from({ length: Math.floor(PREVIEW_BUDGET / size) }, (_, i) => ({ key: String(i), created: i, blob: { size } }));
  const incoming = { key: 'new', blob: { size } };
  const keys = [...images.map(item => item.key), incoming.key];
  assert.deepEqual(previewEvictions(images, keys, incoming), ['0']);
  assert.deepEqual(previewEvictions(images, ['1', '2']), images.filter(item => !['1', '2'].includes(item.key)).map(item => item.key));
});

function captureFixture() {
  const tab = { id: 1, windowId: 10, url: 'https://example.com/video', active: true };
  const bookmark = { url: tab.url, previewKey: 'key' }, calls = [];
  const api = { tabs: { get: async () => ({ ...tab }), sendMessage: async (_id, message) => {
    calls.push(message.type);
    return message.type === 'vrwatch:bookmark-prepare' ? { url: tab.url, video: false } : {};
  } }, windows: { get: async () => ({ focused: true }) } };
  const options = { captureVisible: async () => { calls.push('screenshot'); return 'data:image/jpeg;base64,YWJj'; },
    compress: async () => new Blob(['jpeg'], { type: 'image/jpeg' }),
    store: { read: async () => [bookmark], get: async () => null, save: async () => { calls.push('saved'); return true; } } };
  return { api, tab, calls, options };
}

test('ordinary pages use visible capture, restore overlays, and avoid repeated capture', async () => {
  const f = captureFixture(), service = createBookmarkCapture(f.api, f.options);
  assert.equal(await service.capture(f.tab), true);
  assert.deepEqual(f.calls, ['vrwatch:bookmark-prepare', 'screenshot', 'saved', 'vrwatch:bookmark-restore']);
  assert.equal(await service.capture(f.tab), false);
});

test('video frames take precedence and protected video has no screenshot fallback', async () => {
  const f = captureFixture();
  f.api.tabs.sendMessage = async () => ({ url: f.tab.url, video: true, image: 'data:image/jpeg;base64,YWJj' });
  assert.equal(await createBookmarkCapture(f.api, f.options).capture(f.tab), true);
  assert.deepEqual(f.calls, ['saved']);
  f.api.tabs.sendMessage = async () => ({ url: f.tab.url, video: true, poster: '' });
  assert.equal(await createBookmarkCapture(f.api, f.options).capture(f.tab), false);
  assert.deepEqual(f.calls, ['saved']);
});

test('navigation, changed content URLs, inactive tabs, and native HUD/XR reject capture', async () => {
  const f = captureFixture(), service = createBookmarkCapture(f.api, f.options);
  const interrupted = createBookmarkCapture(f.api, { ...f.options, compress: async () => { interrupted.invalidate(); return new Blob(['jpeg']); } });
  assert.equal(await interrupted.capture(f.tab), false);
  assert.ok(!f.calls.includes('saved'));
  f.api.tabs.sendMessage = async () => ({ url: 'https://elsewhere.example/' });
  assert.equal(await service.capture(f.tab), false);
  f.tab.active = false;
  assert.equal(await createBookmarkCapture(f.api, f.options).capture(f.tab), false);
  f.tab.active = true;
  const native = { state: async () => ({ windowId: 10, activeTabId: 1, hudView: 'tabs' }) };
  assert.equal(await createBookmarkCapture(f.api, { ...f.options, native }).capture(f.tab), false);
});

test('image storage failure is optional; bookmark toggle stays saved', async () => {
  const result = await toggleBookmark('https://example.com/new', 'New');
  assert.equal(result.saved, true);
  const f = captureFixture(); f.options.store.save = async () => { throw new Error('Quota'); };
  assert.equal(await createBookmarkCapture(f.api, f.options).capture(f.tab), false);
  assert.equal((await readBookmarkState()).bookmarks.at(-1).title, 'New');
});

test('new extension pages use exact native document ownership and reject stale identities', () => {
  for (const page of ['settings.html', 'bookmarks.html']) {
    const owned = { activeTabId: 1, documentId: 'current' };
    const sender = { frameId: 0, tab: { id: 1 }, documentId: 'current', url: `chrome-extension://vrwatch/${page}` };
    assert.equal(currentNativeDocument(owned, sender, null, 'chrome-extension://vrwatch/'), true);
    assert.equal(currentNativeDocument(owned, { ...sender, documentId: 'stale' }, null, 'chrome-extension://vrwatch/'), false);
    assert.equal(currentNativeDocument(owned, { ...sender, tab: { id: 2 } }, null, 'chrome-extension://vrwatch/'), false);
  }
});

test('retrievable posters are used when a video frame is unavailable', async t => {
  const f = captureFixture();
  f.api.tabs.sendMessage = async () => ({ url: f.tab.url, video: true, poster: 'https://cdn.example.com/poster.jpg' });
  let fetched;
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    fetched = { url: String(url), credentials: options.credentials };
    return new Response(new Blob(['poster'], { type: 'image/jpeg' }), { headers: { 'Content-Type': 'image/jpeg' } });
  });
  assert.equal(await createBookmarkCapture(f.api, f.options).capture(f.tab), true);
  assert.deepEqual(fetched, { url: 'https://cdn.example.com/poster.jpg', credentials: 'omit' });
  assert.deepEqual(f.calls, ['saved']);
});

test('metadata reads do not rewrite Chrome values returned in another property order', async t => {
  let stored = structuredClone(await readBookmarkState()), writes = 0;
  const reverse = value => Array.isArray(value) ? value.map(reverse) : value && typeof value === 'object'
    ? Object.fromEntries(Object.entries(value).reverse().map(([key, item]) => [key, reverse(item)])) : value;
  globalThis.chrome = { storage: { local: { get: async () => reverse(stored), set: async value => { writes++; stored = value; } } } };
  t.after(() => { delete globalThis.chrome; });
  await readBookmarkState(); await readBookmarkState();
  assert.equal(writes, 0);
});


test('preview selection ignores linked feed videos and advertising videos', () => {
  const video = { duration: 90, getBoundingClientRect: () => ({ width: 640, height: 360, top: 0, bottom: 360, left: 0, right: 640 }), closest: () => null };
  const doc = { defaultView: { innerWidth: 1280, innerHeight: 800 }, querySelectorAll: () => [video] };
  assert.equal(relevantBookmarkVideo(doc, 'https://example.com/watch'), video);
  video.closest = selector => selector === 'a[href]' ? { href: 'https://example.com/another-video' } : null;
  assert.equal(relevantBookmarkVideo(doc, 'https://example.com/watch'), null);
  video.closest = selector => selector.includes('[data-ad]') ? {} : null;
  assert.equal(relevantBookmarkVideo(doc, 'https://example.com/watch'), null);
  video.closest = () => null; video.duration = 6;
  assert.equal(relevantBookmarkVideo(doc, 'https://example.com/watch'), null);
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_PREFERENCES, cleanPreferences, readPreferences, updatePreferences, addressURL, localStore } from '../extension/src/preferences.js';
import { createRecentStore } from '../extension/src/recent.js';
import { createBrowsingSession, cleanSession } from '../extension/src/browsing-session.js';

function storage(seed = {}) {
  const data = structuredClone(seed);
  return { data, get: async key => structuredClone(data[key]), set: async (key, value) => { data[key] = structuredClone(value); } };
}
test('preferences default safely, preserve existing data, and merge simultaneous changes', async () => {
  const store = storage({ bookmarks: [{ url: 'https://saved.example/' }], showQuickLinks: false, recent: [] });
  assert.deepEqual(await readPreferences(store), DEFAULT_PREFERENCES);
  assert.deepEqual(cleanPreferences({ uiSize: 'tiny', historyExpiryDays: -1, showRecent: 'false', startup: 'invalid' }), DEFAULT_PREFERENCES);
  await Promise.all([updatePreferences({ showRecent: false, uiSize: 'large' }, store), updatePreferences({ searchEngine: 'bing' }, store)]);
  assert.equal((await readPreferences(store)).showRecent, false);
  assert.equal((await readPreferences(store)).searchEngine, 'bing');
  assert.equal((await readPreferences(store)).uiSize, 'large');
  assert.equal(store.data.showQuickLinks, false);
  assert.deepEqual(store.data.bookmarks, [{ url: 'https://saved.example/' }]);
  assert.deepEqual(store.data.recent, []);
});
test('desktop preview and extension storage persist the same preferences', async () => {
  const data = new Map();
  globalThis.localStorage = { getItem: key => data.get(key) ?? null, setItem: (key, value) => data.set(key, value) };
  try {
    await updatePreferences({ bookmarkView: 'list', uiSize: 'extra-large' }, localStore(null));
    assert.equal((await readPreferences(localStore(null))).bookmarkView, 'list');
    data.set('vrwatch.preferences', '{broken');
    assert.deepEqual(await readPreferences(localStore(null)), DEFAULT_PREFERENCES);
  } finally { delete globalThis.localStorage; }
  const saved = {};
  const api = { storage: { local: { get: async key => ({ [key]: saved[key] }), set: async values => Object.assign(saved, values) } } };
  await updatePreferences({ startup: 'restore' }, localStore(api));
  assert.equal((await readPreferences(localStore(api))).startup, 'restore');
});
test('address searches use the selected engine and keep URLs and unsafe schemes distinct', () => {
  for (const [engine, base] of Object.entries({ google: 'https://www.google.com/search?q=', duckduckgo: 'https://duckduckgo.com/?q=', bing: 'https://www.bing.com/search?q=' })) {
    assert.equal(addressURL('  vr videos & cats  ', engine), base + 'vr%20videos%20%26%20cats');
    assert.equal(addressURL('cats', engine), base + 'cats');
    assert.equal(addressURL('example.com/path?q=one', engine), 'https://example.com/path?q=one');
    assert.equal(addressURL('http://localhost:4179/library/', engine), 'http://localhost:4179/library/');
    assert.equal(addressURL('localhost:4179/video', engine), 'https://localhost:4179/video');
    for (const value of ['', 'javascript:alert(1)', 'data:text/html,test', 'file:///tmp/test']) assert.throws(() => addressURL(value, engine));
  }
});
test('history migrates in place, expires at the boundary, and disables all new writes without hiding old entries', async () => {
  const now = 100 * 86400000;
  const store = storage({ recent: [{ url: 'https://old.example/', opened: now - 7 * 86400000 }, { url: 'https://fresh.example/', opened: now - 1000 }, { url: 'javascript:bad', opened: now }, null] });
  const history = createRecentStore(store, () => now);
  assert.equal((await history.read()).length, 2);
  await updatePreferences({ historyExpiryDays: 7, rememberHistory: false, showRecent: false }, store);
  assert.deepEqual(await history.read(), [{ url: 'https://fresh.example/', opened: now - 1000 }]);
  await history.remember('https://ignored.example/');
  assert.equal(store.data.recent.length, 1);
  await updatePreferences({ rememberHistory: true }, store);
  await history.remember('https://new.example/');
  assert.equal(store.data.recent[0].url, 'https://new.example/');
  await history.remove('https://fresh.example/');
  assert.equal(store.data.recent.length, 1);
  await history.clear();
  assert.deepEqual(store.data.recent, []);
});
test('concurrent history saves, removals, clear, and disabling cannot revive stale entries', async () => {
  const store = storage();
  const a = createRecentStore(store, () => 1000), b = createRecentStore(store, () => 1001);
  await Promise.all([a.remember('https://a.example/'), b.remember('https://b.example/')]);
  assert.equal((await a.read()).length, 2);
  await Promise.all([a.remember('https://c.example/'), b.remove('https://a.example/')]);
  assert.deepEqual((await a.read()).map(item => item.url).sort(), ['https://b.example/', 'https://c.example/']);
  await Promise.all([a.remember('https://d.example/'), b.clear()]);
  assert.deepEqual(await a.read(), []);
  await Promise.all([updatePreferences({ rememberHistory: false }, store), b.remember('https://ignored.example/')]);
  assert.deepEqual(await a.read(), []);
});
test('history remains capped and expiry applies again after time passes without new navigation', async () => {
  let now = 100 * 86400000;
  const store = storage({ preferences: { historyExpiryDays: 7 } });
  const history = createRecentStore(store, () => now);
  for (let index = 0; index < 205; index++) await history.remember(`https://example.com/${index}`);
  assert.equal((await history.read()).length, 200);
  now += 7 * 86400000;
  assert.deepEqual(await history.read(), []);
});
test('session snapshots are opt-in, filter unsafe pages, preserve selection and survive launch/shutdown placeholders', async () => {
  const home = 'chrome-extension://vrwatch/home.html';
  const store = storage(), sessions = createBrowsingSession(store, home);
  const tabs = [{ id: 1, url: 'https://a.example/' }, { id: 2, url: 'https://b.example/' }];
  await sessions.save(tabs, 2);
  assert.equal(store.data.lastSession, undefined);
  await updatePreferences({ startup: 'restore', rememberHistory: false }, store);
  await sessions.save(tabs, 2);
  assert.deepEqual(await sessions.read(), { urls: tabs.map(tab => tab.url), active: 1 });
  await sessions.save([], 1);
  await sessions.save([{ id: 1, url: home + '?startup=1' }], 1);
  assert.deepEqual(await sessions.read(), { urls: tabs.map(tab => tab.url), active: 1 });
  assert.deepEqual(cleanSession({ urls: ['javascript:bad', home.replace('home.html', 'settings.html'), 'https://a.example/', 'chrome://settings/'], active: 2 }, home), { urls: [home, 'https://a.example/'], active: 1 });
  await updatePreferences({ startup: 'home' }, store);
  await sessions.save(tabs, 1);
  assert.equal(store.data.lastSession, null);
});

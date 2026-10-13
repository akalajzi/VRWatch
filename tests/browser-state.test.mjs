import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createBrowserState } from '../extension/src/browser-state.js';
import { cleanBookmarks, DEFAULT_BOOKMARKS, migrateBookmarks } from '../extension/src/bookmarks.js';

function fixture({ app = false, native = null } = {}) {
  const home = 'chrome-extension://vrwatch/home.html';
  const tabs = new Map([
    [1, { id: 1, windowId: 10, index: 0, active: true, url: 'https://youtube.com/watch?v=one', title: 'Video one' }],
    [2, { id: 2, windowId: 10, index: 1, active: false, url: 'https://deovr.com/', title: 'DeoVR' }],
    [99, { id: 99, windowId: 99, index: 0, active: true, url: 'https://example.com/', title: 'Unrelated' }],
  ]);
  const windows = new Map([[10, { id: 10, type: app ? 'app' : 'normal', state: 'normal', left: 10, top: 20, width: 1280, height: 800 }],
    [99, { id: 99, type: 'normal', state: 'normal' }]]);
  const session = {};
  let bookmarks = [];
  const calls = [];
  let serial = 100;
  let time = 1000;
  const api = {
    runtime: { id: 'vrwatch', getURL: path => 'chrome-extension://vrwatch/' + path },
    webNavigation: { getFrame: async ({ tabId }) => ({ documentId: 'doc-' + tabId }) },
    storage: { session: { get: async key => ({ [key]: structuredClone(session[key]) }),
      set: async value => Object.assign(session, structuredClone(value)) } },
    tabs: {
      get: async id => { if (!tabs.has(id)) throw new Error('Missing tab'); return { ...tabs.get(id) }; },
      query: async query => [...tabs.values()].filter(tab => query.windowId == null || tab.windowId === query.windowId).map(tab => ({ ...tab })),
      update: async (id, changes) => { calls.push(['update', id, changes]);
        if (changes.active) for (const tab of tabs.values()) if (tab.windowId === tabs.get(id).windowId) tab.active = false;
        Object.assign(tabs.get(id), changes); return { ...tabs.get(id) }; },
      create: async properties => { calls.push(['create', properties]); const tab = { id: ++serial, index: tabs.size, ...properties };
        for (const old of tabs.values()) if (old.windowId === tab.windowId) old.active = false;
        tabs.set(tab.id, tab); return tab; },
      remove: async id => { calls.push(['remove', id]); tabs.delete(id); },
      sendMessage: async (id, message) => { calls.push(['leave', id, message]); },
      goBack: async id => { calls.push(['back', id]); },
      goForward: async id => { calls.push(['forward', id]); },
      captureVisibleTab: async windowId => { calls.push(['capture', windowId]); return 'data:image/jpeg;base64,cHJldmlldw=='; },
    },
    windows: {
      get: async id => ({ ...windows.get(id) }),
      update: async (id, changes) => { calls.push(['window', id, changes]); Object.assign(windows.get(id), changes); },
      create: async properties => { calls.push(['popup', properties]); const window = { id: ++serial, ...properties };
        windows.set(window.id, window);
        const tab = properties.tabId ? tabs.get(properties.tabId) : { id: ++serial, index: 0, url: properties.url, title: 'VRWatch', active: true };
        tab.windowId = window.id; tabs.set(tab.id, tab); window.tabs = [{ ...tab }]; return window; },
    },
  };
  const options = { native, now: () => time, bookmarkStore: { read: async () => bookmarks,
    toggle: async (url, title) => { bookmarks = [{ url, title }]; return { saved: true }; } } };
  const manager = createBrowserState(api, options);
  const sender = id => ({ id: 'vrwatch', frameId: 0, documentId: 'doc-' + id, tab: { id } });
  const request = (action, extra = {}, id = 1) => manager.request({ action, ...extra }, sender(id));
  return { api, manager, options, request, sender, tabs, windows, calls, session, home, advance: ms => time += ms, bookmarks: () => bookmarks };
}

test('native HUD uses browser ownership and preserves OAuth/script popup windows', async () => {
  let current = 1;
  const native = { state: async () => ({ windowId: 10, activeTabId: current, hudView: 'closed' }),
    authorizeHud: async sender => {
      if (sender.documentId !== 'trusted-hud') throw new Error('Unowned HUD');
      return { windowId: 10, activeTabId: current };
    } };
  const f = fixture({ native });
  const hud = { id: 'vrwatch', url: 'chrome-extension://vrwatch/hud.html', documentId: 'trusted-hud' };
  assert.deepEqual((await f.manager.request({ action: 'state' }, hud)).tabs.map(tab => tab.id), [1, 2]);
  await assert.rejects(f.manager.request({ action: 'state', windowId: 10 }, { ...hud, documentId: 'forged' }));
  await assert.rejects(f.request('state', {}, 99), /Unowned/);
  f.tabs.set(100, { id: 100, windowId: 100, openerTabId: 1, active: true, url: 'https://login.example/' });
  await f.manager.created(f.tabs.get(100));
  assert.equal(f.tabs.get(100).windowId, 100);
  await assert.rejects(f.manager.request({ action: 'activate', tabId: 100 }, hud), /no longer open/);
  await f.manager.request({ action: 'activate', tabId: 2 }, hud);
  current = 2;
  assert.equal((await f.manager.request({ action: 'state' }, hud)).currentId, 2);
  await f.manager.request({ action: 'create' }, hud);
  assert.ok(f.calls.some(call => call[0] === 'create' && call[1].windowId === 10));
  assert.ok(!f.calls.some(call => call[0] === 'popup'));
});

test('native Home browser actions use the native active document when webNavigation omits extension pages', async () => {
  const f = fixture({ native: { state: async () => ({ windowId: 10, activeTabId: 1, documentId: 'doc-1' }) } });
  f.api.webNavigation.getFrame = async () => null;
  const home = { ...f.sender(1), url: f.home };
  await f.manager.request({ action: 'create' }, home);
  assert.equal(f.calls.filter(call => call[0] === 'create').length, 1);
  for (const sender of [{ ...home, documentId: 'old' }, { ...home, url: 'https://example.com/' }, { ...f.sender(2), url: f.home }])
    await assert.rejects(f.manager.request({ action: 'create' }, sender), /Stale VRWatch document/);
  assert.equal(f.calls.filter(call => call[0] === 'create').length, 1);
});

test('native capture is suppressed during HUD and XR and navigation rejects executable schemes', async () => {
  const owned = { windowId: 10, activeTabId: 1, hudView: 'tabs' };
  const f = fixture({ native: { state: async () => owned } });
  await f.request('capture');
  owned.hudView = 'closed'; owned.xr = { session: 'one' };
  await f.request('capture');
  assert.ok(!f.calls.some(call => call[0] === 'capture'));
  await assert.rejects(f.request('navigate', { url: 'javascript:alert(1)' }), /http/);
  assert.ok(!f.calls.some(call => call[0] === 'update'));
});

test('tab switching waits for media/VR cleanup and never touches another window group', async () => {
  const f = fixture();
  const state = await f.request('state');
  assert.deepEqual(state.tabs.map(tab => tab.id), [1, 2]);
  await assert.rejects(f.request('activate', { tabId: 99 }), /no longer open/);
  await assert.rejects(f.request('close', { tabId: 99 }), /no longer open/);
  await f.request('activate', { tabId: 2 });
  assert.deepEqual(f.calls.map(call => call[0]), ['leave', 'update', 'window']);
  assert.equal(f.calls[0][1], 1);
  assert.equal(f.tabs.get(2).active, true);
  assert.equal(f.tabs.get(1).url, 'https://youtube.com/watch?v=one');
  assert.ok(f.tabs.has(99));
});

test('Back and Forward navigate only the caller tab after media cleanup, and report empty history', async () => {
  const f = fixture();
  await f.request('back', { tabId: 99 });
  await f.request('forward', { tabId: 99 });
  assert.deepEqual(f.calls.map(call => call.slice(0, 2)), [['leave', 1], ['back', 1], ['leave', 1], ['forward', 1]]);
  f.api.tabs.goBack = async () => { throw new Error('Cannot go back'); };
  await assert.rejects(f.request('back'), /No previous page/);
});

test('app pages stay chromeless and remain grouped after a service-worker restart', async () => {
  const f = fixture({ app: true });
  await f.request('create');
  const popup = f.calls.find(call => call[0] === 'popup')[1];
  assert.equal(popup.type, 'popup');
  assert.equal(popup.url, f.home);
  assert.equal(popup.width, 1280);
  assert.ok(!f.calls.some(call => call[0] === 'create'));
  const restarted = createBrowserState(f.api, f.options);
  const state = await restarted.request({ action: 'state' }, f.sender(1));
  assert.equal(state.tabs.length, 3);
  assert.equal(state.tabs.at(-1).home, true);
});

test('normal extension installs create a real tab in the current browser window', async () => {
  const f = fixture();
  await f.request('create');
  assert.equal(f.calls.find(call => call[0] === 'create')[1].windowId, 10);
  assert.ok(!f.calls.some(call => call[0] === 'popup'));
});

test('Home navigates the current page; closing the last page keeps the app open at Home', async () => {
  const f = fixture();
  await f.request('home');
  assert.equal(f.tabs.get(1).url, f.home);
  await f.request('close', { tabId: 2 });
  f.tabs.get(1).url = 'https://youtube.com/watch?v=two';
  const result = await f.request('close', { tabId: 1 });
  assert.equal(result.navigated, true);
  assert.equal(f.tabs.get(1).url, f.home);
  assert.ok(f.tabs.has(99));
});

test('closing the current page focuses its replacement before destroying it', async () => {
  const f = fixture();
  await f.request('close', { tabId: 1 });
  assert.deepEqual(f.calls.map(call => call[0]), ['leave', 'update', 'window', 'remove']);
  assert.equal(f.tabs.get(2).active, true);
});

test('preview captures are rate limited, session scoped, and invalidated on navigation', async () => {
  const f = fixture();
  await f.request('capture');
  await f.request('capture');
  assert.equal(f.calls.filter(call => call[0] === 'capture').length, 1);
  assert.ok((await f.request('state')).tabs[0].previewVersion);
  await f.manager.changed(1, { url: 'https://youtube.com/watch?v=two' });
  f.tabs.get(1).url = 'https://youtube.com/watch?v=two';
  assert.equal((await f.request('state')).tabs[0].previewVersion, null);
  f.advance(1000);
  f.api.tabs.captureVisibleTab = async () => { f.tabs.get(1).active = false; return 'data:image/jpeg;base64,cHJldmlldw=='; };
  await f.request('capture');
  assert.equal((await f.request('state')).tabs[0].previewVersion, null);
});

test('bookmarks use browser-owned metadata and reject iframe or foreign senders', async () => {
  const f = fixture();
  await f.request('bookmark', { url: 'https://attacker.example/', title: 'fake' });
  assert.deepEqual(f.bookmarks(), [{ url: 'https://youtube.com/watch?v=one', title: 'Video one' }]);
  await assert.rejects(f.manager.request({ action: 'state' }, { ...f.sender(1), frameId: 3 }), /sender/);
  await assert.rejects(f.manager.request({ action: 'state' }, { ...f.sender(1), id: 'another-extension' }), /sender/);
});

test('links that open a new app page are moved into a chromeless popup and retained in the group', async () => {
  const f = fixture({ app: true });
  await f.request('state');
  f.tabs.set(3, { id: 3, windowId: 30, index: 0, url: 'https://example.org/', title: 'Opened link', active: true, openerTabId: 1 });
  f.windows.set(30, { id: 30, type: 'normal' });
  await f.manager.created(f.tabs.get(3));
  assert.equal(f.calls.at(-1)[0], 'popup');
  assert.equal(f.calls.at(-1)[1].tabId, 3);
  assert.ok((await f.request('state')).tabs.some(tab => tab.id === 3));
});

test('bookmarks use the starter shortcuts, reject executable URLs, and deduplicate', () => {
  assert.deepEqual(cleanBookmarks().map(item => item.url), DEFAULT_BOOKMARKS.map(item => item.url));
  assert.deepEqual(cleanBookmarks([]), []);
  const bookmarks = cleanBookmarks([{ url: 'https://example.com/', title: '<img onerror=alert(1)>' },
    { url: 'https://example.com/', title: 'Duplicate' }, { url: 'javascript:alert(1)' }]);
  assert.equal(bookmarks.length, 1);
  assert.equal(bookmarks[0].title, '<img onerror=alert(1)>');
});

test('starter shortcut upgrade keeps custom bookmarks and only runs once', () => {
  const stored = [
    { url: 'https://www.dailymotion.com/360_official', title: 'Dailymotion 360' },
    { url: 'https://deovr.com/', title: 'DeoVR' },
    { url: 'https://www.youtube.com/@360/videos', title: 'YouTube VR' },
    { url: 'https://example.com/saved', title: 'My saved video' },
  ];
  const migrated = migrateBookmarks(stored);
  assert.deepEqual(migrated.map(item => item.url), stored.map(item => item.url));
  assert.equal(migrated[0].title, 'Dailymotion 360');
  // User removals or re-added destinations after migration must stick.
  assert.deepEqual(migrateBookmarks([], 2), []);
  assert.deepEqual(migrateBookmarks(stored, 2), cleanBookmarks(stored));
  assert.deepEqual(migrateBookmarks(migrated, 2), migrated);
});

const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const promptly = promise => Promise.race([promise, new Promise((_, reject) => { const timer = setTimeout(() => reject(new Error('Interaction blocked')), 300); timer.unref(); })]);

test('hung capture never queues metadata or concurrent select/close/create commands', async () => {
  const f = fixture();
  const gate = deferred();
  f.api.tabs.captureVisibleTab = () => gate.promise;
  const capture = f.request('capture');
  await new Promise(setImmediate);
  const snapshot = await promptly(f.request('state'));
  assert.equal(snapshot.tabs.length, 2);
  await promptly(Promise.all([f.request('activate', { tabId: 2 }), f.request('close', { tabId: 2 }), f.request('create')]));
  assert.ok(f.tabs.has(99));
  assert.equal(f.tabs.has(2), false);
  gate.resolve('old image'); await capture;
  assert.equal((await f.request('state')).tabs[0].previewVersion, null);
  assert.ok(!JSON.stringify(f.session).includes('image'));
});

test('slow encoder cannot resurrect previews after navigation or close', async () => {
  for (const action of ['home', 'close']) {
    const f = fixture(); const gate = deferred();
    const manager = createBrowserState(f.api, { ...f.options, resizePreview: () => gate.promise });
    const request = (action, extra = {}) => manager.request({ action, ...extra }, f.sender(1));
    const capture = request('capture'); await new Promise(setImmediate);
    await promptly(request(action, { tabId: 1 }));
    gate.resolve('stale image'); await capture;
    const state = await manager.request({ action: 'state' }, f.sender(action === 'close' ? 2 : 1));
    assert.ok(state.tabs.every(tab => tab.previewVersion === null));
  }
});

test('failed captures release their lane; previews are separate and ownership checked', async () => {
  const f = fixture();
  f.api.tabs.captureVisibleTab = async () => { throw new Error('protected'); };
  await f.request('capture'); await f.request('back'); f.advance(1500);
  f.api.tabs.captureVisibleTab = async () => 'small image';
  await f.request('capture');
  const state = await f.request('state');
  const version = state.tabs[0].previewVersion;
  assert.ok(version);
  assert.ok(!JSON.stringify(state).includes('small image'));
  assert.equal((await f.request('preview', { tabId: 1, version })).image, 'small image');
  assert.equal((await f.request('preview', { tabId: 1, version }, 99)).image, null);
  assert.equal((await f.request('preview', { tabId: 1, version: version + 1 })).image, null);
});

test('only one capture runs, and focus/XR cancellation discards its result', async () => {
  const f = fixture(); const gate = deferred(); let captures = 0;
  f.api.tabs.captureVisibleTab = () => { captures++; return gate.promise; };
  const first = f.request('capture'); await new Promise(setImmediate);
  f.advance(5000); await promptly(f.request('capture'));
  await f.request('cancelCapture');
  gate.resolve('stale'); await first;
  assert.equal(captures, 1);
  assert.equal((await f.request('state')).tabs[0].previewVersion, null);
});

test('metadata does not wait for XR cleanup and activation still does', async () => {
  const f = fixture(); const gate = deferred();
  f.api.tabs.sendMessage = () => gate.promise;
  const select = f.request('activate', { tabId: 2 }); await new Promise(setImmediate);
  assert.equal((await promptly(f.request('state'))).tabs.length, 2);
  assert.equal(f.tabs.get(2).active, false);
  gate.resolve(); await select;
  assert.equal(f.tabs.get(2).active, true);
});

test('closing a background popup cleans up that page without moving focus', async () => {
  const f = fixture({ app: true }); await f.request('create');
  const target = [...f.tabs.values()].find(tab => tab.id > 99);
  f.calls.length = 0;
  await f.request('close', { tabId: target.id });
  assert.deepEqual(f.calls.map(call => call.slice(0, 2)), [['leave', target.id], ['remove', target.id]]);
});

test('concurrent real-tab selections clean up each actually active page in order', async () => {
  const f = fixture();
  await Promise.all([f.request('activate', { tabId: 2 }), f.request('activate', { tabId: 1 })]);
  assert.deepEqual(f.calls.filter(call => call[0] === 'leave').map(call => call[1]), [1, 2]);
  assert.equal(f.tabs.get(1).active, true);
});

test('thumbnail versions cannot collide across service-worker restarts', async () => {
  const f = fixture(); await f.request('capture');
  const old = (await f.request('state')).tabs[0].previewVersion;
  const restarted = createBrowserState(f.api, f.options);
  await restarted.request({ action: 'capture' }, f.sender(1));
  const fresh = (await restarted.request({ action: 'state' }, f.sender(1))).tabs[0].previewVersion;
  assert.notEqual(fresh, old);
  assert.equal((await restarted.request({ action: 'preview', tabId: 1, version: old }, f.sender(1))).image, null);
});

test('bookmark saving and browser commands never wait for optional persistent capture', async () => {
  const f = fixture(), gate = deferred(); let captured;
  const manager = createBrowserState(f.api, { ...f.options, bookmarkCapture: { capture: tab => { captured = tab; return gate.promise; } } });
  assert.deepEqual(await promptly(manager.request({ action: 'bookmark', url: 'https://fake.example/' }, f.sender(1))), { saved: true });
  assert.equal(captured.url, f.tabs.get(1).url);
  await promptly(manager.request({ action: 'home' }, f.sender(1)));
  gate.resolve(false);
});

function withLocal(f, data = {}) {
  f.api.storage.local = { get: async key => ({ [key]: structuredClone(data[key]) }), set: async values => Object.assign(data, structuredClone(values)) };
  return data;
}

test('both address bars navigate via shared engine and history preferences', async () => {
  const f = fixture();
  const data = withLocal(f, { preferences: { searchEngine: 'duckduckgo', rememberHistory: false } });
  await f.request('navigate', { url: 'vr videos' });
  assert.equal(f.tabs.get(1).url, 'https://duckduckgo.com/?q=vr%20videos');
  assert.equal(data.recent, undefined);
  data.preferences.rememberHistory = true;
  await f.request('navigate', { url: 'https://example.org/video' });
  assert.equal(data.recent[0].url, 'https://example.org/video');
  await f.manager.changed(99, { status: 'complete' });
  assert.equal(data.recent.length, 1, 'unrelated windows do not enter app history');
  f.tabs.get(1).url = 'https://example.org/next';
  await f.manager.changed(1, { status: 'complete' });
  assert.equal(data.recent[0].url, 'https://example.org/next');
});

test('launcher restores tabs once, preserves the active tab, and never restores on ordinary Home', async () => {
  const f = fixture();
  f.tabs.delete(2);
  f.tabs.get(1).url = f.home + '?startup=1';
  const previous = { urls: ['https://a.example/', 'https://b.example/'], active: 1 };
  const data = withLocal(f, { preferences: { startup: 'restore' }, lastSession: previous });
  await f.request('state');
  assert.deepEqual(data.lastSession, previous, 'initial HUD read must not erase last session');
  const sender = { ...f.sender(1), url: f.home + '?startup=1' };
  await f.manager.request({ action: 'startup' }, sender);
  assert.equal(f.tabs.get(1).url, previous.urls[0]);
  const created = [...f.tabs.values()].find(tab => tab.url === previous.urls[1]);
  assert.equal(created.windowId, 10);
  assert.equal(created.active, true);
  assert.ok(f.tabs.has(99));
  await assert.rejects(f.manager.request({ action: 'startup' }, sender), /launcher Home/);
  f.tabs.get(1).url = f.home + '?startup=1';
  const restarted = createBrowserState(f.api, f.options);
  await restarted.request({ action: 'startup' }, sender);
  assert.equal(f.calls.filter(call => call[0] === 'create').length, 1);
  assert.equal(f.tabs.get(1).url, f.home);
});

test('Home default bypasses restoration and app restoration uses owned popup windows', async () => {
  for (const restore of [false, true]) {
    const f = fixture({ app: true }); f.tabs.delete(2);
    f.tabs.get(1).url = f.home + '?startup=1';
    withLocal(f, { preferences: { startup: restore ? 'restore' : 'home' }, lastSession: { urls: ['https://a.example/', 'https://b.example/'], active: 1 } });
    await f.manager.request({ action: 'startup' }, { ...f.sender(1), url: f.home + '?startup=1' });
    assert.equal(f.tabs.get(1).url, restore ? 'https://a.example/' : f.home);
    assert.equal(f.calls.filter(call => call[0] === 'popup').length, restore ? 1 : 0);
    if (restore) assert.equal(f.session.browserSession.groups[0].windows.length, 2);
  }
});

test('closing a browser window retains its restore snapshot, while closing an individual tab updates it', async () => {
  const f = fixture();
  const data = withLocal(f, { preferences: { startup: 'restore' } });
  await f.request('state');
  await f.manager.activity(1);
  assert.equal(data.lastSession.urls.length, 2);
  f.tabs.delete(2);
  await f.manager.removed(2, { windowId: 10, isWindowClosing: false });
  assert.equal(data.lastSession.urls.length, 1);
  f.tabs.delete(1);
  await f.manager.removed(1, { windowId: 10, isWindowClosing: true });
  assert.equal(data.lastSession.urls.length, 1);
  assert.notEqual(data.lastSession.urls[0], f.tabs.get(99).url);
});


test('native startup restores only into its authenticated window and rejects stale launch documents', async () => {
  const owned = { windowId: 10, activeTabId: 1, documentId: 'doc-1' };
  const f = fixture({ native: { state: async () => owned } }); f.tabs.delete(2);
  f.tabs.get(1).url = f.home + '?startup=1';
  f.api.webNavigation.getFrame = async () => null;
  withLocal(f, { preferences: { startup: 'restore' }, lastSession: { urls: ['https://one.example/', 'https://two.example/'], active: 1 } });
  const sender = { ...f.sender(1), url: f.home + '?startup=1' };
  await assert.rejects(f.manager.request({ action: 'startup' }, { ...sender, documentId: 'old' }), /Stale/);
  await f.manager.request({ action: 'startup' }, sender);
  assert.equal(f.calls.filter(call => call[0] === 'create').length, 1);
  assert.equal(f.calls.find(call => call[0] === 'create')[1].windowId, 10);
  assert.equal(f.calls.filter(call => call[0] === 'popup').length, 0);
});

test('explicitly closing an app popup removes it from the saved session', async () => {
  const f = fixture({ app: true });
  const data = withLocal(f, { preferences: { startup: 'restore' } });
  await f.request('create');
  const popup = [...f.tabs.values()].find(tab => tab.id > 100);
  await f.manager.activity(1);
  assert.equal(data.lastSession.urls.length, 3);
  await f.request('close', { tabId: popup.id });
  assert.equal(data.lastSession.urls.length, 2);
});

test('background tab metadata cannot overwrite the selected restore tab', async () => {
  const f = fixture();
  const data = withLocal(f, { preferences: { startup: 'restore' } });
  await f.request('state', {}, 2);
  await f.manager.activity(2);
  assert.equal(data.lastSession.active, 0);
});

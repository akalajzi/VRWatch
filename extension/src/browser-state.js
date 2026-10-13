import { readBookmarks, toggleBookmark } from './bookmarks.js';
import { addressURL, localStore, readPreferences } from './preferences.js';
import { createRecentStore } from './recent.js';
import { createBrowsingSession } from './browsing-session.js';
import { currentNativeDocument } from './native-document.js';

const KEY = 'browserSession';
const MAX_PREVIEWS = 40;

// Window IDs keep the app's pages separate from unrelated profile windows.
// In app mode a page lives in a chromeless popup; normal extension installs
// use the existing browser window's native tabs.
export function createBrowserState(api, { now = Date.now, resizePreview = async image => image,
  notify = () => {}, native = null, bookmarkCapture = null, captureVisible = windowId => api.tabs.captureVisibleTab(windowId, { format: 'jpeg', quality: 65 }), bookmarkStore = { read: readBookmarks, toggle: toggleBookmark } } = {}) {
  const store = localStore(api);
  const recent = createRecentStore(store, now);
  const sessions = createBrowsingSession(store, api.runtime.getURL('home.html'));
  let queue = Promise.resolve();
  let lastCapture = -Infinity;
  let capturePending = false;
  let generation = 0;
  let previewVersion = 0;
  const previewEpoch = crypto.randomUUID();
  const previews = new Map();
  let loaded;
  let commands = 0;
  const invalidate = () => { generation++; notify(); };
  const serialize = operation => {
    const result = queue.then(operation);
    queue = result.catch(() => {});
    return result;
  };
  async function load() {
    // Share ownership state; thumbnails are disposable and never persisted with it.
    loaded ??= api.storage.session.get(KEY).then(async value => {
      const state = { groups: value[KEY]?.groups ?? [], startupDone: value[KEY]?.startupDone ?? false };
      if (value[KEY]?.previews) await save(state); // Drop the legacy base64 cache once.
      return state;
    });
    return loaded;
  }
  const save = state => api.storage.session.set({ [KEY]: state });
  async function checkpoint(state, group, activeId) {
    if (!api.storage.local) return;
    const tabs = await groupTabs(group);
    if (group.app) {
      const windows = await Promise.all(group.windows.map(id => api.windows.get(id).catch(() => null)));
      activeId = tabs.find(tab => tab.active && windows.some(window => window?.id === tab.windowId && window.focused))?.id ?? group.activeTabId ?? activeId;
      group.activeTabId = activeId;
    } else activeId = tabs.find(tab => tab.active)?.id ?? activeId;
    await sessions.save(tabs, activeId);
  }
  async function trackedGroup(state, tab) {
    if (native) {
      const owned = await native.state();
      return owned.windowId === tab.windowId ? { windows: [owned.windowId], app: false } : null;
    }
    return state.groups.find(group => group.windows.includes(tab.windowId));
  }
  async function caller(sender) {
    if (sender.id !== api.runtime.id || sender.frameId && sender.frameId !== 0) throw new Error('Unsupported HUD sender.');
    if (native) {
      if (!sender.tab) {
        const owned = await native.authorizeHud(sender);
        const tab = await api.tabs.get(owned.activeTabId);
        if (tab.windowId !== owned.windowId) throw new Error('VRWatch window changed.');
        return tab;
      }
      const [owned, tab, frame] = await Promise.all([native.state(), api.tabs.get(sender.tab.id),
        api.webNavigation.getFrame({ tabId: sender.tab.id, frameId: 0 })]);
      if (tab.windowId !== owned.windowId) throw new Error('Unowned VRWatch window.');
      if (!currentNativeDocument(owned, sender, frame, api.runtime.getURL(''))) throw new Error('Stale VRWatch document.');
      return tab;
    }
    if (sender.tab?.id != null) return api.tabs.get(sender.tab.id);
    if (!sender.url?.startsWith(api.runtime.getURL(''))) throw new Error('Unsupported HUD sender.');
    // Extension pages do not always include sender.tab.
    const [tab] = await api.tabs.query({ active: true, lastFocusedWindow: true });
    if (!tab || !tab.url?.startsWith(api.runtime.getURL(''))) throw new Error('VRWatch page is not active.');
    return tab;
  }
  async function groupFor(state, tab) {
    if (native) return { windows: [tab.windowId], app: false };
    let group = state.groups.find(group => group.windows.includes(tab.windowId));
    if (!group) {
      const window = await api.windows.get(tab.windowId);
      group = { windows: [tab.windowId], app: window.type !== 'normal' };
      // Metadata and commands can discover the same window concurrently.
      const existing = state.groups.find(item => item.windows.includes(tab.windowId));
      if (existing) return existing;
      state.groups.push(group);
      await save(state);
    }
    return group;
  }
  async function groupTabs(group) {
    return (await api.tabs.query({})).filter(tab => group.windows.includes(tab.windowId)).sort((a, b) => a.windowId - b.windowId || a.index - b.index);
  }
  async function snapshot(state, group, current) {
    const bookmarks = await bookmarkStore.read();
    const tabs = await groupTabs(group);
    return { currentId: current.id, saved: bookmarks.some(item => item.url === current.url),
      home: current.url === api.runtime.getURL('home.html'), tabs: tabs.map(tab => ({ id: tab.id,
        title: tab.title || tab.url || 'New tab', url: tab.url || '', current: tab.id === current.id,
        home: tab.url === api.runtime.getURL('home.html'),
        loading: tab.status === 'loading', audible: !!tab.audible, favicon: tab.favIconUrl || '',
        previewVersion: previews.get(tab.id)?.url === tab.url ? previews.get(tab.id).version : null })) };
  }
  async function leave(tab) {
    if (native?.leave) return native.leave(tab);
    try { await api.tabs.sendMessage(tab.id, { type: 'vrwatch:leave' }); }
    catch { /* Home and restricted pages may have no video content script. */ }
  }
  async function focus(tab) {
    await api.tabs.update(tab.id, { active: true });
    const window = await api.windows.get(tab.windowId);
    await api.windows.update(tab.windowId, { focused: true, ...(window.state === 'minimized' ? { state: 'normal' } : {}) });
  }
  async function newTab(state, group, current) {
    await leave(current);
    const url = api.runtime.getURL('home.html');
    let tab;
    if (group.app) {
      const window = await api.windows.get(current.windowId);
      const bounds = window.state === 'maximized' ? { state: 'maximized' } :
        { left: window.left, top: window.top, width: window.width, height: window.height };
      const created = await api.windows.create({ url, type: 'popup', focused: true, ...bounds });
      group.windows.push(created.id);
      [tab] = created.tabs || await api.tabs.query({ windowId: created.id });
    } else tab = await api.tabs.create({ url, windowId: current.windowId, active: true });
    await save(state);
    return tab;
  }
  async function handle(message, sender) {
    const current = await caller(sender);
    const state = await load();
    const group = await groupFor(state, current);
    switch (message.action) {
      case 'back':
      case 'forward':
        await leave(current);
        try { await api.tabs[message.action === 'back' ? 'goBack' : 'goForward'](current.id); }
        catch { throw new Error(message.action === 'back' ? 'No previous page in this tab.' : 'No next page in this tab.'); }
        return {};
      case 'state':
        void serialize(() => checkpoint(state, group, current.id)).catch(() => {});
        return snapshot(state, group, current);
      case 'preview': {
        const tabs = await groupTabs(group);
        const target = tabs.find(tab => tab.id === message.tabId);
        const preview = previews.get(message.tabId);
        return { image: target && preview?.url === target.url && preview.version === message.version ? preview.image : null };
      }
      case 'bookmark': {
        // Ignore URL/title supplied by a page. The browser owns this metadata.
        const result = await bookmarkStore.toggle(current.url, current.title);
        if (result.saved) void bookmarkCapture?.capture(current, { force: true });
        return { saved: result.saved };
      }
      case 'home': await leave(current); await api.tabs.update(current.id, { url: api.runtime.getURL('home.html') }); return {};
      case 'navigate': {
        const url = addressURL(message.url, (await readPreferences(store)).searchEngine);
        await leave(current); await api.tabs.update(current.id, { url });
        await recent.remember(url).catch(() => {});
        await checkpoint(state, group, current.id).catch(() => {});
        return {};
      }
      case 'startup': {
        const home = api.runtime.getURL('home.html');
        if (current.url !== home + '?startup=1' || sender.url !== home + '?startup=1') throw new Error('Startup requires the launcher Home page.');
        if (state.startupDone) { await api.tabs.update(current.id, { url: home }); return {}; }
        const preferences = await readPreferences(store);
        const previous = preferences.startup === 'restore' ? await sessions.read() : { urls: [], active: 0 };
        // Mark before creating tabs: reloads and worker restarts cannot duplicate a restore.
        state.startupDone = true; await save(state);
        const restored = [current];
        for (const url of previous.urls.slice(1)) {
          if (group.app) {
            const window = await api.windows.get(current.windowId);
            const created = await api.windows.create({ url, type: 'popup', focused: false,
              left: window.left, top: window.top, width: window.width, height: window.height });
            group.windows.push(created.id);
            restored.push((created.tabs || await api.tabs.query({ windowId: created.id }))[0]);
          } else restored.push(await api.tabs.create({ url, windowId: current.windowId, active: false }));
        }
        await save(state);
        await api.tabs.update(current.id, { url: previous.urls[0] || home });
        await focus(restored[previous.active] || current);
        await checkpoint(state, group, (restored[previous.active] || current).id).catch(() => {});
        return {};
      }
      case 'reload': await leave(current); await api.tabs.reload(current.id); return {};
      case 'stop':
        if (!native) throw new Error('Stop requires the native browser.');
        await api.vrwatchPrivate.request({ operation: 'stop' }); return {};
      case 'create': await newTab(state, group, current); return {};
      case 'activate':
      case 'close': {
        const tabs = await groupTabs(group);
        const target = tabs.find(tab => tab.id === message.tabId);
        if (!target) throw new Error('This tab is no longer open.');
        if (message.action === 'activate') {
          const active = tabs.find(tab => tab.active && tab.windowId === current.windowId) ?? current;
          if (target.id !== active.id) await leave(active);
          await focus(target);
          return {};
        }
        const replacingActive = target.id === current.id || target.active && target.windowId === current.windowId;
        if (replacingActive) {
          if (tabs.length === 1) {
            // Closing the last page returns home instead of exiting the app.
            await leave(current);
            await api.tabs.update(current.id, { url: api.runtime.getURL('home.html') });
            previews.delete(current.id);
            await save(state);
            return { navigated: true };
          }
          await leave(target);
          await focus(tabs.find(tab => tab.id !== target.id));
        }
        if (!replacingActive) await leave(target);
        previews.delete(target.id);
        await save(state);
        await api.tabs.remove(target.id);
        const remaining = await groupTabs(group);
        await checkpoint(state, group, remaining.find(tab => tab.active)?.id).catch(() => {});
        return { closedCurrent: target.id === current.id };
      }
      default: throw new Error('Unknown VRWatch action.');
    }
  }
  async function capture(message, sender) {
    // No capture/readback/encode promise ever enters the command queue. A hung
    // compositor occupies only this optional lane; do not accumulate retries.
    const current = await caller(sender);
    if (capturePending || commands || now() - lastCapture < 1200) return {};
    if (native) {
      const owned = await native.state();
      if (owned.xr || owned.hudView !== 'closed') return {};
    }
    const window = await api.windows.get(current.windowId);
    if (!current.active || window.focused === false || window.state === 'minimized') return {};
    if (capturePending || commands) return {};
    capturePending = true;
    lastCapture = now();
    const token = generation;
    const valid = async () => {
      if (token !== generation || commands) return false;
      const tab = await api.tabs.get(current.id);
      const window = await api.windows.get(current.windowId);
      return token === generation && tab.active && tab.windowId === current.windowId
        && tab.url === current.url && window.focused !== false && window.state !== 'minimized';
    };
    try {
      // This optional lane never delays navigation or bookmark metadata writes.
      await bookmarkCapture?.capture(current);
      if (!await valid()) return {};
      const raw = await captureVisible(current.windowId);
      if (!await valid()) return {};
      const image = await resizePreview(raw, message.viewport);
      if (!await valid()) return {};
      previews.delete(current.id);
      previews.set(current.id, { url: current.url, image, version: `${previewEpoch}:${++previewVersion}` });
      while (previews.size > MAX_PREVIEWS) previews.delete(previews.keys().next().value);
      notify();
    } catch { /* Protected pages and failed captures retain their fallback. */ }
    finally { capturePending = false; }
    return {};
  }
  return {
    request: (message, sender) => {
      if (message.action === 'capture') return capture(message, sender);
      if (message.action === 'state' || message.action === 'preview') return handle(message, sender);
      if (message.action === 'cancelCapture') return caller(sender).then(() => { generation++; return {}; });
      commands++;
      invalidate();
      return serialize(() => handle(message, sender)).finally(() => { commands--; invalidate(); });
    },
    invalidate,
    activity: id => serialize(async () => {
      if (!api.storage.local) return;
      const state = await load();
      const tab = await api.tabs.get(id);
      const group = await trackedGroup(state, tab);
      if (group) await checkpoint(state, group, tab.id);
    }),
    removed: (id, info = {}) => {
      previews.delete(id); invalidate();
      return serialize(async () => { const state = await load();
        const allTabs = await api.tabs.query({});
        if (!info.isWindowClosing && api.storage.local) {
          const group = native ? { windows: [(await native.state()).windowId], app: false } : state.groups.find(group => group.windows.includes(info.windowId));
          if (group) await checkpoint(state, group, allTabs.find(tab => tab.active && group.windows.includes(tab.windowId))?.id);
        }
        const windows = new Set(allTabs.map(tab => tab.windowId));
        state.groups = state.groups.map(group => ({ ...group, windows: group.windows.filter(id => windows.has(id)) })).filter(group => group.windows.length);
        await save(state); notify();
      });
    },
    changed: (id, changes) => serialize(async () => {
      if (changes.url || changes.status === 'loading') previews.delete(id);
      invalidate();
      if (!api.storage.local) return;
      const state = await load(), tab = await api.tabs.get(id);
      const group = await trackedGroup(state, tab);
      if (!group) return;
      if (changes.url || changes.status === 'complete') await recent.remember(tab.url).catch(() => {});
      const active = (await groupTabs(group)).find(item => item.active);
      await checkpoint(state, group, active?.id).catch(() => {});
    }),
    created: tab => serialize(async () => {
      invalidate();
      // Native target=_blank already uses real tabs. Script/OAuth popups retain
      // their browser chrome and opener semantics; never adopt their windows.
      if (native) return;
      if (tab.openerTabId == null) return;
      let opener; try { opener = await api.tabs.get(tab.openerTabId); } catch { return; }
      const state = await load();
      const group = state.groups.find(group => group.windows.includes(opener.windowId));
      if (!group || group.windows.includes(tab.windowId)) return;
      if (group.app) {
        const window = await api.windows.get(opener.windowId);
        const created = await api.windows.create({ tabId: tab.id, type: 'popup', focused: false,
          left: window.left, top: window.top, width: window.width, height: window.height });
        group.windows.push(created.id);
      } else group.windows.push(tab.windowId);
      await save(state); notify();
    }),
  };
}

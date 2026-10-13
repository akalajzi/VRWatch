import { readPreferences } from './preferences.js';

// Persist URLs only: never previews, document identities, XR, or playback state.
export function sessionURL(value, home) {
  try {
    const url = new URL(value);
    if (url.protocol === 'http:' || url.protocol === 'https:') return url.href;
    if (['home.html', 'bookmarks.html', 'settings.html'].some(page => url.href === new URL(page, home).href)) return home;
  } catch { /* Unsupported pages cannot be restored. */ }
  return null;
}
export function cleanSession(value, home) {
  const entries = (Array.isArray(value?.urls) ? value.urls : []).slice(0, 200)
    .map((url, index) => ({ url: sessionURL(url, home), index })).filter(item => item.url);
  return { urls: entries.map(item => item.url), active: Math.max(0, entries.findIndex(item => item.index === value?.active)) };
}
export function createBrowsingSession(store, home) {
  return {
    async read() { return cleanSession(await store.get('lastSession'), home); },
    async save(tabs, activeId) {
      if ((await readPreferences(store)).startup !== 'restore') {
        if (await store.get('lastSession')) await store.set('lastSession', null);
        return;
      }
      // Launcher Home must not replace the previous session before restoration.
      if (!tabs.length || tabs.some(tab => tab.url === home + '?startup=1' || tab.pendingUrl === home + '?startup=1')) return;
      const entries = tabs.map(tab => ({ ...tab, url: sessionURL(tab.pendingUrl || tab.url, home) })).filter(tab => tab.url).slice(0, 200);
      if (!entries.length) return;
      const snapshot = { urls: entries.map(tab => tab.url), active: Math.max(0, entries.findIndex(tab => tab.id === activeId)) };
      if (JSON.stringify(await store.get('lastSession')) !== JSON.stringify(snapshot)) await store.set('lastSession', snapshot);
    },
  };
}

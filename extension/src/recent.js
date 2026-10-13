import { localStore, readPreferences, withPreferencesLock } from './preferences.js';
import { normalizeUrl } from './media.js';

export function cleanRecent(value, days = 0, now = Date.now()) {
  const seen = new Set();
  return (Array.isArray(value) ? value : []).flatMap(item => {
    try {
      const url = normalizeUrl(item.url);
      if (!Number.isFinite(item.opened) || item.opened < 0 || (days && item.opened <= now - days * 86400000) || seen.has(url)) return [];
      seen.add(url); return [{ url, opened: item.opened }];
    } catch { return []; }
  }).sort((a, b) => b.opened - a.opened).slice(0, 200);
}
export function createRecentStore(store = localStore(), now = Date.now) {
  const mutate = operation => withPreferencesLock(async () => {
    const preferences = await readPreferences(store);
    const raw = await store.get('recent');
    const recent = cleanRecent(raw, preferences.historyExpiryDays, now());
    const result = operation ? operation(recent, preferences) : recent;
    if (JSON.stringify(raw ?? []) !== JSON.stringify(result)) await store.set('recent', result);
    return result;
  });
  return {
    read: () => mutate(),
    clear: () => mutate(() => []),
    remove: url => mutate(recent => recent.filter(item => item.url !== url)),
    remember: url => mutate((recent, preferences) => {
      if (!preferences.rememberHistory) return recent;
      try { url = normalizeUrl(url); } catch { return recent; }
      return [{ url, opened: now() }, ...recent.filter(item => item.url !== url)].slice(0, 200);
    }),
  };
}
export const readRecent = () => createRecentStore().read();
export const clearRecent = () => createRecentStore().clear();
export const removeRecent = url => createRecentStore().remove(url);
export const remember = url => createRecentStore().remember(url);

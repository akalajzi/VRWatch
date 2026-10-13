import { normalizeUrl } from './media.js';

export const DEFAULT_PREFERENCES = Object.freeze({ showRecent: true, bookmarkView: 'cards', uiSize: 'standard',
  searchEngine: 'google', startup: 'home', rememberHistory: true, historyExpiryDays: 0 });
const choices = { bookmarkView: ['cards', 'list'], uiSize: ['standard', 'large', 'extra-large'],
  searchEngine: ['google', 'duckduckgo', 'bing'], startup: ['home', 'restore'], historyExpiryDays: [0, 7, 30, 90] };
export function cleanPreferences(value = {}) {
  return Object.fromEntries(Object.entries(DEFAULT_PREFERENCES).map(([key, fallback]) => [key,
    choices[key] ? (choices[key].includes(value?.[key]) ? value[key] : fallback) : typeof value?.[key] === 'boolean' ? value[key] : fallback]));
}
export function localStore(api = globalThis.chrome) {
  return {
    async get(key) {
      if (api?.storage?.local) return (await api.storage.local.get(key))[key];
      try { return JSON.parse(localStorage.getItem('vrwatch.' + key)); } catch { return undefined; }
    },
    async set(key, value) {
      if (api?.storage?.local) await api.storage.local.set({ [key]: value });
      else {
        localStorage.setItem('vrwatch.' + key, JSON.stringify(value));
        if (key === 'preferences') globalThis.window?.dispatchEvent(new Event('vrwatch:preferences-changed'));
      }
    },
  };
}
let queue = Promise.resolve();
export function withPreferencesLock(work) {
  if (globalThis.navigator?.locks) return navigator.locks.request('vrwatch.preferences-history', work);
  const result = queue.then(work); queue = result.catch(() => {}); return result;
}
export const readPreferences = async (store = localStore()) => cleanPreferences(await store.get('preferences'));
export const updatePreferences = (patch, store = localStore()) => withPreferencesLock(async () => {
  const preferences = cleanPreferences({ ...await readPreferences(store), ...patch });
  await store.set('preferences', preferences);
  return preferences;
});
export function addressURL(input, engine = 'google') {
  const text = typeof input === 'string' ? input.trim() : '';
  if (!text) throw new Error('Enter a website or search term.');
  // An explicit scheme must still pass URL validation, including unsafe schemes.
  if (/^[a-z][a-z\d+.-]*:/i.test(text) || (!/\s/.test(text) && /[./:]/.test(text))) return normalizeUrl(text);
  const base = { google: 'https://www.google.com/search?q=', duckduckgo: 'https://duckduckgo.com/?q=', bing: 'https://www.bing.com/search?q=' };
  return (base[engine] || base.google) + encodeURIComponent(text);
}

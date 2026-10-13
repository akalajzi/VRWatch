import { normalizeUrl } from './media.js';

export const DEFAULT_BOOKMARKS = [
  { url: 'https://www.google.com/', title: 'Google', description: 'Search the web', format: '', icon: 'google' },
  { url: 'https://www.youtube.com/@360/videos', title: 'YouTube VR', description: 'Virtual Reality channel', format: '360° · VR180', icon: 'youtube' },
  { url: 'https://www.airpano.com/360video_list.php', title: 'AirPano 360', description: 'Immersive travel videos', format: '360°', icon: 'airpano' },
  { url: 'http://127.0.0.1:4179/library/', title: 'Media Library', description: 'Connected drives and NAS', format: '', icon: 'library' },
];
// Metadata stays small; image bytes live in bookmark-previews.js.
const DEFAULTS_VERSION = 3;
const KEYS = ['bookmarks', 'bookmarkDefaultsVersion', 'quickLinks', 'showQuickLinks', 'bookmarkFolders'];
const token = () => crypto.randomUUID();

export function cleanBookmarks(value) {
  const seen = new Set();
  return (Array.isArray(value) ? value : DEFAULT_BOOKMARKS).flatMap(item => {
    try {
      const url = normalizeUrl(item.url);
      if (seen.has(url)) return [];
      seen.add(url);
      const preset = DEFAULT_BOOKMARKS.find(bookmark => bookmark.url === url);
      return [{ url, title: String(item.title || preset?.title || new URL(url).hostname).slice(0, 120),
        description: preset?.description || new URL(url).hostname.replace(/^www\./, ''),
        format: preset?.format || '', icon: preset?.icon || 'website',
        folder: String(item.folder || '').trim().slice(0, 60),
        previewKey: typeof item.previewKey === 'string' ? item.previewKey : '',
        added: Number.isFinite(item.added) ? item.added : 0 }];
    } catch { return []; }
  });
}

export function migrateBookmarks(value, version) {
  // Only a fresh profile gets defaults. Never replace an existing starter,
  // restore a removed bookmark, or erase a user's edited title on upgrade.
  return cleanBookmarks(value);
}

export function migrateBookmarkState(stored) {
  const bookmarks = migrateBookmarks(stored.bookmarks, stored.bookmarkDefaultsVersion)
    .map(item => ({ ...item, previewKey: item.previewKey || token() }));
  const urls = new Set(bookmarks.map(item => item.url));
  const selection = Array.isArray(stored.quickLinks) ? stored.quickLinks : DEFAULT_BOOKMARKS.map(item => item.url);
  return { bookmarks, bookmarkDefaultsVersion: DEFAULTS_VERSION,
    quickLinks: [...new Set(selection)].filter(url => urls.has(url)).slice(0, 5),
    showQuickLinks: stored.showQuickLinks !== false,
    bookmarkFolders: [...new Set([...(Array.isArray(stored.bookmarkFolders) ? stored.bookmarkFolders : []),
      ...bookmarks.map(item => item.folder)].map(name => String(name).trim().slice(0, 60)).filter(Boolean))] };
}

async function readRaw() {
  if (globalThis.chrome?.storage?.local) return chrome.storage.local.get(KEYS);
  const result = {};
  for (const key of KEYS) {
    const value = localStorage.getItem('vrwatch.' + key);
    if (value !== null) result[key] = JSON.parse(value);
  }
  return result;
}
async function write(state) {
  if (globalThis.chrome?.storage?.local) await chrome.storage.local.set(state);
  else for (const [key, value] of Object.entries(state)) localStorage.setItem('vrwatch.' + key, JSON.stringify(value));
}
let queue = Promise.resolve();
export function withBookmarkLock(work) {
  // Web Locks serialize worker + extension pages (and preview tabs).
  if (globalThis.navigator?.locks) return navigator.locks.request('vrwatch.bookmarks', work);
  const result = queue.then(work); queue = result.catch(() => {}); return result;
}
async function load() {
  const raw = await readRaw();
  const state = migrateBookmarkState(raw);
  if (raw.bookmarkDefaultsVersion !== DEFAULTS_VERSION || KEYS.some(key => raw[key] === undefined) || !Array.isArray(raw.bookmarks)
      || state.bookmarks.some(item => !raw.bookmarks?.some(old => old?.previewKey === item.previewKey))) await write(state);
  return state;
}
export const readBookmarkState = () => withBookmarkLock(load);
export const readBookmarks = async () => (await readBookmarkState()).bookmarks;

export async function changeBookmarks(action, values = {}) {
  return withBookmarkLock(async () => {
    const state = await load();
    const index = state.bookmarks.findIndex(item => item.url === values.originalUrl);
    let result = {};
    switch (action) {
      case 'save': {
        const url = normalizeUrl(values.url);
        if (values.originalUrl && index < 0) throw new Error('This bookmark was removed.');
        if (state.bookmarks.some((item, i) => item.url === url && i !== index)) throw new Error('That URL is already bookmarked.');
        const old = state.bookmarks[index];
        const folder = String(values.folder || '').trim().slice(0, 60);
        const [item] = cleanBookmarks([{ ...old, url, title: values.title, folder,
          added: old?.added || Date.now(), previewKey: old?.url === url ? old.previewKey : token() }]);
        if (old) state.bookmarks[index] = item; else state.bookmarks.push(item);
        if (old) state.quickLinks = state.quickLinks.map(link => link === old.url ? url : link);
        if (folder && !state.bookmarkFolders.includes(folder)) state.bookmarkFolders.push(folder);
        result.bookmark = item;
        break;
      }
      case 'delete':
        state.bookmarks = state.bookmarks.filter(item => item.url !== values.url);
        state.quickLinks = state.quickLinks.filter(url => url !== values.url);
        break;
      case 'toggle': {
        const url = normalizeUrl(values.url);
        const old = state.bookmarks.find(item => item.url === url);
        if (old) {
          state.bookmarks = state.bookmarks.filter(item => item !== old);
          state.quickLinks = state.quickLinks.filter(link => link !== url);
        } else {
          const [item] = cleanBookmarks([{ url, title: values.title, added: Date.now(), previewKey: token() }]);
          state.bookmarks.push(item); result.bookmark = item;
        }
        result.saved = !old;
        break;
      }
      case 'pin':
        if (!state.bookmarks.some(item => item.url === values.url)) throw new Error('This bookmark was removed.');
        if (state.quickLinks.includes(values.url)) state.quickLinks = state.quickLinks.filter(url => url !== values.url);
        else {
          if (state.quickLinks.length >= 5) throw new Error('Home has five Quick Links. Unpin one first.');
          state.quickLinks.push(values.url);
        }
        break;
      case 'move': {
        const from = state.quickLinks.indexOf(values.url), to = from + (values.direction < 0 ? -1 : 1);
        if (from >= 0 && to >= 0 && to < state.quickLinks.length)
          [state.quickLinks[from], state.quickLinks[to]] = [state.quickLinks[to], state.quickLinks[from]];
        break;
      }
      case 'visibility': state.showQuickLinks = !!values.visible; break;
      case 'folder': {
        const name = String(values.name || '').trim().slice(0, 60);
        if (!name) throw new Error('Enter a folder name.');
        if (state.bookmarkFolders.includes(name)) throw new Error('That folder already exists.');
        state.bookmarkFolders.push(name); break;
      }
      case 'deleteFolder':
        state.bookmarkFolders = state.bookmarkFolders.filter(name => name !== values.name);
        state.bookmarks = state.bookmarks.map(item => item.folder === values.name ? { ...item, folder: '' } : item);
        break;
      case 'refreshPreview':
        state.bookmarks = state.bookmarks.map(item => item.url === values.url ? { ...item, previewKey: token() } : item); break;
      case 'clearPreviews':
        state.bookmarks = state.bookmarks.map(item => ({ ...item, previewKey: token() })); break;
      default: throw new Error('Unknown bookmark action.');
    }
    await write(state);
    // Deleting metadata must succeed even when IndexedDB is unavailable.
    try {
      const { prunePreviews } = await import('./bookmark-previews.js');
      await prunePreviews(state.bookmarks.map(item => item.previewKey));
    } catch { /* Next successful mutation/startup retries orphan cleanup. */ }
    return { ...result, ...state };
  });
}
export const toggleBookmark = (url, title) => changeBookmarks('toggle', { url, title });

export async function saveBookmarkPreview(bookmark, blob) {
  return withBookmarkLock(async () => {
    const state = await load();
    if (!state.bookmarks.some(item => item.url === bookmark.url && item.previewKey === bookmark.previewKey)) return false;
    const { putPreview } = await import('./bookmark-previews.js');
    await putPreview(bookmark.previewKey, blob, state.bookmarks.map(item => item.previewKey));
    return true;
  });
}

export const cleanupBookmarkPreviews = () => withBookmarkLock(async () => {
  const state = await load();
  const { prunePreviews } = await import('./bookmark-previews.js');
  await prunePreviews(state.bookmarks.map(item => item.previewKey));
});

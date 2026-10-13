import { readBookmarks, saveBookmarkPreview } from './bookmarks.js';
import { getPreview, compressPreview, MAX_PREVIEW_BYTES } from './bookmark-previews.js';

export function createBookmarkCapture(api, { native = null, captureVisible, store = { read: readBookmarks, save: saveBookmarkPreview, get: getPreview }, compress = compressPreview } = {}) {
  let busy = false;
  let epoch = 0;
  const attempts = new Map();
  async function capture(tab, { force = false } = {}) {
    if (busy || !/^https?:/.test(tab.url)) return false;
    busy = true;
    const generation = epoch;
    const token = crypto.randomUUID();
    let prepared = false;
    const timed = async promise => {
      let timer;
      try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Capture timed out.')), 2000); })]); }
      finally { clearTimeout(timer); }
    };
    const valid = async () => {
      const current = await api.tabs.get(tab.id), window = await api.windows.get(tab.windowId);
      if (current.url !== tab.url || current.pendingUrl && current.pendingUrl !== tab.url || !current.active || current.windowId !== tab.windowId || window.focused === false || window.state === 'minimized') return false;
      if (native) {
        const state = await native.state();
        if (state.activeTabId !== tab.id || state.windowId !== tab.windowId || state.xr || state.hudView !== 'closed') return false;
      }
      return generation === epoch;
    };
    try {
      const bookmark = (await store.read()).find(item => item.url === tab.url);
      if (!bookmark || !await valid()) return false;
      if (!force && (Date.now() - (attempts.get(bookmark.previewKey) || 0) < 60000 || await store.get(bookmark.previewKey))) return false;
      attempts.set(bookmark.previewKey, Date.now());
      if (attempts.size > 200) attempts.delete(attempts.keys().next().value);
      prepared = true;
      const content = await timed(api.tabs.sendMessage(tab.id, { type: 'vrwatch:bookmark-prepare', url: tab.url, token }, { frameId: 0 }));
      if (content?.url !== tab.url || !await valid()) return false;
      let source;
      if (typeof content.image === 'string' && content.image.startsWith('data:image/jpeg;base64,') && content.image.length <= MAX_PREVIEW_BYTES * 2) {
        source = await (await fetch(content.image)).blob();
      } else if (content.video) {
        // No screenshot fallback for protected video: save no unrelated image.
        const poster = new URL(content.poster);
        if (!['https:', 'http:'].includes(poster.protocol)) return false;
        const response = await fetch(poster, { credentials: 'omit', signal: AbortSignal.timeout(2000) });
        if (!response.ok || !response.headers.get('content-type')?.startsWith('image/')) return false;
        // Stream with a hard input cap, even if the server omits Content-Length.
        const reader = response.body.getReader(); const chunks = []; let size = 0;
        try {
          for (;;) {
            const { done, value } = await reader.read(); if (done) break;
            size += value.length; if (size > 4 * 1024 * 1024) return false; chunks.push(value);
          }
        } finally { await reader.cancel(); }
        source = new Blob(chunks, { type: response.headers.get('content-type') });
      } else {
        const raw = await captureVisible(tab.windowId);
        source = await (await fetch(raw)).blob();
      }
      const blob = await compress(source);
      if (!await valid()) return false;
      return await store.save(bookmark, blob);
    } catch { return false; }
    finally {
      if (prepared) void api.tabs.sendMessage(tab.id, { type: 'vrwatch:bookmark-restore', token }, { frameId: 0 }).catch(() => {});
      busy = false;
    }
  }
  return { capture, invalidate: () => { epoch++; } };
}

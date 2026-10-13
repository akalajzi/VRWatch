import { readBookmarks, toggleBookmark } from './bookmarks.js';
import { addressURL, readPreferences } from './preferences.js';
import { remember } from './recent.js';

export function createHUDClient() {
  const extension = !!globalThis.chrome?.runtime?.id;
  const homeURL = extension ? chrome.runtime.getURL('home.html') : new URL('home.html', location.href).href;
  return {
    homeURL,
    subscribe(listener) {
      if (!extension) return () => {};
      let port;
      let stopped = false;
      let retry;
      const connect = () => {
        if (stopped) return;
        port = chrome.runtime.connect({ name: 'vrwatch:hud' });
        port.onMessage.addListener(listener);
        port.onDisconnect.addListener(() => {
          // Reconnect only while the HUD is subscribed, including worker restart.
          void chrome.runtime.lastError;
          if (!stopped) retry = setTimeout(connect, 500);
        });
        listener(); // Reconcile events missed during a disconnect.
      };
      connect();
      return () => { stopped = true; clearTimeout(retry); port?.disconnect(); };
    },
    async request(action, extra = {}) {
      if (extension) {
        const reply = await chrome.runtime.sendMessage({ type: 'vrwatch:browser', action, ...extra });
        if (!reply) throw new Error('VRWatch browser service did not respond.');
        if (reply.error) throw new Error(reply.error);
        return reply.value;
      }
      // The local start-screen server shows the same UI without pretending
      // that it can enumerate or capture an uninstalled browser extension.
      switch (action) {
        case 'back': history.back(); return {};
        case 'forward': history.forward(); return {};
        case 'reload': location.reload(); return {};
        case 'navigate': {
          const url = addressURL(extra.url, (await readPreferences()).searchEngine);
          await remember(url).catch(() => {}); location.assign(url); return {};
        }
        case 'state': return { currentId: 0, home: location.href === homeURL,
          saved: (await readBookmarks()).some(item => item.url === location.href),
          tabs: [{ id: 0, title: document.title, url: location.href, home: location.href === homeURL, current: true, preview: null }] };
        case 'bookmark': return toggleBookmark(location.href, document.title);
        case 'home': location.assign(homeURL); return {};
        case 'create': window.open(homeURL, '_blank', 'noopener'); return {};
        case 'close': location.assign(homeURL); return { navigated: true };
        default: return {};
      }
    },
  };
}

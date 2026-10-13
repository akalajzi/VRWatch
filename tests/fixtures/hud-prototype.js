import { mountBrowserHUD } from '../../extension/src/browser-hud.js';
import { mountBrowserScroll } from '../../extension/src/browser-scroll.js';
// Local deterministic DOM regression fixture; no extension/device claims.
const attach = Element.prototype.attachShadow;
let root;
Element.prototype.attachShadow = function (options) { const value = attach.call(this, options); if (this.id === 'vrwatch-hud') root = value; return value; };
let listener;
let tabs = Array.from({ length: 10 }, (_, i) => ({ id: i + 1, title: `Test page ${i + 1}`, url: `https://example.com/${i}`, current: i === 0, previewVersion: null }));
const requests = [];
mountBrowserScroll();
mountBrowserHUD({ home: new URLSearchParams(location.search).has('home'), client: {
  homeURL: location.href,
  subscribe(fn) { listener = fn; return () => { listener = null; }; },
  async request(action, extra = {}) {
    requests.push(action);
    if (action === 'state') return { tabs: structuredClone(tabs), saved: false, home: false, currentId: 1 };
    if (action === 'capture') return new Promise(() => {});
    if (action === 'close') { tabs = tabs.filter(tab => tab.id !== extra.tabId); listener?.(); }
    return {};
  },
} });
Element.prototype.attachShadow = attach;
window.hudTest = { root, requests, update(id, title) { tabs.find(tab => tab.id === id).title = title; listener?.(); },
  count(n) { tabs = tabs.slice(0, n); listener?.(); } };

// Real external HUD code with a deterministic browser API fixture. This does
// not simulate native focus, security, Chromium layout or Frame acceptance.
const listeners = new Set(), subscribers = new Set();
const owned = { windowId: 10, activeTabId: 1, hudView: 'tabs' };
const tabs = Array.from({ length: 10 }, (_, index) => ({ id: index + 1, title: ['Mountain film', 'Forest walk', 'Night sky'][index % 3],
  url: `https://example.com/video/${index + 1}`, current: index === 0, loading: index === 3, audible: index === 0,
  previewVersion: null, favicon: '' }));
let reads = 0;
function changed() { for (const fn of listeners) fn(); for (const fn of subscribers) fn(); }
const event = set => ({ addListener: fn => set.add(fn), removeListener: fn => set.delete(fn) });
globalThis.chrome = {
  vrwatchPrivate: { request: async request => {
    if (request.operation === 'hud') { owned.hudView = request.view; changed(); }
    return { ...owned };
  }, onChanged: event(listeners) },
  runtime: { id: 'fixture', getURL: name => 'chrome-extension://fixture/' + name,
    onMessage: { addListener() {} },
    connect: () => ({ onMessage: event(subscribers), onDisconnect: { addListener() {} }, disconnect: () => subscribers.clear() }),
    sendMessage: async request => {
      reads++;
      if (request.action === 'activate') { owned.activeTabId = request.tabId; for (const tab of tabs) tab.current = tab.id === request.tabId; changed(); }
      if (request.action === 'close') { tabs.splice(tabs.findIndex(tab => tab.id === request.tabId), 1); changed(); }
      return { value: { currentId: owned.activeTabId, tabs: structuredClone(tabs), saved: false } };
    } },
};
globalThis.fixture = {
  show: view => chrome.vrwatchPrivate.request({ operation: 'hud', view }),
  updateTitle: () => { tabs[1].title = 'Updated forest walk'; changed(); },
  get reads() { return reads; },
};
await import('../../extension/src/native-hud.js');

// Deterministic DOM fixture, not a native/device acceptance test.
const listeners = new Set(), subscribers = new Set();
const state = { hudView: 'navigation' };
let tabs = [{ id: 1, title: 'VRWatch', url: 'chrome-extension://fixture/home.html', home: true, current: true, previewVersion: null }];
let serial = 1, nextError = null;
const calls = [];
const changed = () => { for (const fn of listeners) fn(); for (const fn of subscribers) fn(); };
globalThis.chrome = {
  vrwatchPrivate: {
    onChanged: { addListener: fn => listeners.add(fn) },
    async request(request) {
      if (request.operation === 'hud' && state.hudView !== request.view) { state.hudView = request.view; changed(); }
      return { ...state };
    },
  },
  runtime: {
    id: 'fixture', getURL: name => new URL(name, location.href).href,
    onMessage: { addListener() {} },
    connect() { let listener; return { onMessage: { addListener(fn) { listener = fn; subscribers.add(fn); } }, onDisconnect: { addListener() {} }, disconnect() { subscribers.delete(listener); } }; },
    async sendMessage(message) {
      calls.push(message);
      if (message.action === 'state') return { value: { tabs: structuredClone(tabs), saved: false } };
      if (nextError) { const error = nextError; nextError = null; return { error }; }
      if (message.action === 'create') {
        tabs.forEach(tab => { tab.current = false; });
        tabs.push({ id: ++serial, title: 'VRWatch', url: 'chrome-extension://fixture/home.html', home: true, current: true, previewVersion: null });
      }
      if (message.action === 'close') tabs = tabs.filter(tab => tab.id !== message.tabId);
      if (message.action === 'activate') tabs.forEach(tab => { tab.current = tab.id === message.tabId; });
      changed();
      return { value: {} };
    },
  },
};
window.nativeHudTest = { calls, get count() { return tabs.length; }, get view() { return state.hudView; }, fail(message) { nextError = message; }, open(view) { state.hudView = view; changed(); } };

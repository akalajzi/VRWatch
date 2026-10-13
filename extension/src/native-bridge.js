import { currentNativeDocument } from './native-document.js';

// Native browser state survives worker/host restarts. Page messages only carry
// requests; Chromium supplies the authoritative window, tab and document IDs.
export function createNativeSession(api, { notify = () => {}, schedule = setTimeout, cancel = clearTimeout } = {}) {
  let port, retry, stopped = false, hasWindow = false, epoch = 0, backoff = 250;
  let queue = Promise.resolve(), pendingPads, routing = false;
  const native = request => api.vrwatchPrivate.request(request);
  const serialize = work => {
    const result = queue.then(work);
    queue = result.catch(() => {});
    return result;
  };
  const state = () => native({ operation: 'state' });
  async function authenticate(sender, xr = false) {
    if (sender.id !== api.runtime.id || !Number.isInteger(sender.frameId) || sender.frameId < 0 || (!xr && sender.frameId !== 0) || !sender.tab || !sender.documentId) throw new Error('Unowned bridge sender');
    const [owned, tab, frame] = await Promise.all([state(), api.tabs.get(sender.tab.id),
      api.webNavigation.getFrame({ tabId: sender.tab.id, frameId: sender.frameId })]);
    if (tab.windowId !== owned.windowId || !currentNativeDocument(owned, sender, frame, api.runtime.getURL(''))) throw new Error('Stale bridge document');
    return { owned, tab };
  }
  async function reconcile() {
    const connection = port;
    let owned;
    try { owned = await state(); }
    catch (error) {
      hasWindow = false; cancel(retry);
      port = null; epoch++; connection?.disconnect();
      throw error;
    }
    hasWindow = true;
    if (!port && !stopped) connect();
    if (connection && port === connection) connection.postMessage({ protocol: 1, type: 'state',
      enabled: owned.focused && !owned.xr, xr: !!owned.xr, restoreSequence: owned.restoreSequence });
    notify();
    return owned;
  }
  async function route() {
    if (routing) return;
    routing = true;
    try {
      while (pendingPads) {
        const pads = pendingPads; pendingPads = null;
        const token = epoch, owned = await state();
        if (token !== epoch || !port || owned.xr || !owned.focused) continue;
        if (owned.hudView !== 'closed') {
          await api.runtime.sendMessage({ type: 'vrwatch:hud-pads', pads }).catch(() => {});
        } else {
          // Document targeting prevents samples queued before a navigation from
          // reaching its replacement renderer. The adapter also checks focus.
          await api.tabs.sendMessage(owned.activeTabId, { type: 'vrwatch:native-pads', pads },
            { documentId: owned.documentId }).catch(() => {});
        }
      }
    } finally { routing = false; }
  }
  function disconnected(connection) {
    if (port !== connection) return;
    void api.runtime.lastError;
    port = null; epoch++; pendingPads = null;
    if (!stopped && hasWindow) { retry = schedule(connect, backoff); backoff = Math.min(backoff * 2, 10000); }
    notify(); // A transport loss is never an XR-ended event.
  }
  function connect() {
    if (stopped || !hasWindow || port) return;
    let connection;
    try { connection = api.runtime.connectNative('com.vrwatch.bridge'); }
    catch { retry = schedule(connect, backoff); backoff = Math.min(backoff * 2, 10000); return; }
    port = connection;
    connection.onDisconnect.addListener(() => disconnected(connection));
    connection.onMessage.addListener(message => {
      if (port !== connection || message?.protocol !== 1) return;
      if (message.type === 'hello') {
        backoff = 250;
        void serialize(reconcile).catch(() => { connection.disconnect(); disconnected(connection); });
      } else if (message.type === 'pads' && validPads(message.pads)) {
        pendingPads = message.pads;
        void route().catch(() => {});
      } else if (message.type === 'hud' && ['navigation', 'tabs'].includes(message.view)) {
        epoch++;
        void serialize(async () => {
          const owned = await state();
          if (!owned.focused || owned.xr) return;
          await native({ operation: 'hud', view: owned.hudView === message.view ? 'closed' : message.view });
          await reconcile();
        }).catch(() => {});
      }
    });
  }
  const changed = () => { epoch++; void serialize(reconcile).catch(() => {}); };
  return {
    start() { stopped = false; api.vrwatchPrivate.onChanged.addListener(changed); changed(); },
    stop() { stopped = true; cancel(retry); api.vrwatchPrivate.onChanged.removeListener(changed); const old = port; port = null; epoch++; old?.disconnect(); },
    changed,
    state,
    async leave(tab) {
      const owned = await state();
      const origin = owned.xr?.tabId === tab.id ? owned.xr : null;
      let timeout;
      try {
        await Promise.race([
          api.tabs.sendMessage(tab.id, { type: 'vrwatch:leave' }, origin ? { documentId: origin.documentId } : { frameId: 0 }),
          new Promise((_, reject) => { timeout = schedule(() => reject(new Error('The XR page has not finished exiting.')), origin ? 2000 : 150); }),
        ]);
      } catch (error) {
        // Ordinary slow/protected pages cannot hold the browser command queue.
        // Active XR teardown must be acknowledged by its exact origin.
        if (origin && (await state()).xr?.session === origin.session) throw error;
      } finally { cancel(timeout); }
    },
    async authorizeHud(sender) {
      if (sender.id !== api.runtime.id || sender.tab || sender.url !== api.runtime.getURL('hud.html') || !sender.documentId) throw new Error('Unowned HUD sender');
      return native({ operation: 'authorizeHud', documentId: sender.documentId });
    },
    request(message, sender) {
      epoch++;
      return serialize(async () => {
        const { owned, tab } = await authenticate(sender, message.type === 'vrwatch:bridge-xr');
        if (message.type === 'vrwatch:bridge-xr') {
          if (typeof message.active !== 'boolean' || typeof message.session !== 'string') throw new Error('Invalid XR request');
          await native({ operation: 'xr', tabId: tab.id, frameId: sender.frameId, documentId: sender.documentId,
            session: message.session, active: message.active });
        } else if (message.type === 'vrwatch:bridge-menu') {
          if (owned.activeTabId !== tab.id || !owned.focused || owned.xr) throw new Error('Inactive menu origin');
          await native({ operation: 'hud', view: 'navigation' });
        } else if (message.type !== 'vrwatch:bridge-focus') throw new Error('Unknown bridge request');
        return reconcile();
      });
    },
  };
}

export function validPads(pads) {
  return Array.isArray(pads) && pads.length <= 2 && pads.every(pad => pad &&
    Number.isInteger(pad.index) && pad.index >= 0 && pad.index < 2 &&
    typeof pad.connected === 'boolean' && Array.isArray(pad.axes) && pad.axes.length <= 4 &&
    pad.axes.every(value => Number.isFinite(value) && Math.abs(value) <= 1));
}

import { readRecent } from './recent.js';
import { createBookmarkCapture } from './bookmark-capture.js';
import { createBrowserState } from './browser-state.js';
import { readMP4Projection } from './spatial-metadata.js';
import { nativeCandidate } from './runtime-mode.js';
import { createNativeSession } from './native-bridge.js';

async function resizePreview(image, viewport) {
  const binary = atob(image.split(',')[1]);
  const bitmap = await createImageBitmap(new Blob([Uint8Array.from(binary, character => character.charCodeAt(0))], { type: 'image/jpeg' }));
  try {
    const scale = bitmap.width / Math.max(1, Number(viewport?.width) || bitmap.width);
    const top = Math.min(bitmap.height - 1, Math.max(0, Number(viewport?.top) || 0) * scale);
    const height = bitmap.height - top;
    const width = Math.min(640, bitmap.width);
    const canvas = new OffscreenCanvas(width, Math.max(1, Math.round(height * width / bitmap.width)));
    canvas.getContext('2d').drawImage(bitmap, 0, top, bitmap.width, height, 0, 0, canvas.width, canvas.height);
    const blob = await canvas.convertToBlob({ type: 'image/jpeg', quality: 0.65 });
    const bytes = new Uint8Array(await blob.arrayBuffer());
    let base64 = '';
    for (const byte of bytes) base64 += String.fromCharCode(byte);
    return 'data:image/jpeg;base64,' + btoa(base64);
  } finally { bitmap.close(); }
}
const subscribers = new Set();
const notify = () => { for (const port of subscribers) { try { port.postMessage({ type: 'changed' }); } catch { subscribers.delete(port); } } };
const native = nativeCandidate ? createNativeSession(chrome, { notify: () => { browser.invalidate(); } }) : null;
// Both thumbnail features share Chrome's captureVisibleTab rate limit.
let visibleCaptureAt = -Infinity;
async function captureVisible(windowId) {
  if (Date.now() - visibleCaptureAt < 650) throw new Error('Capture cooling down.');
  visibleCaptureAt = Date.now();
  return chrome.tabs.captureVisibleTab(windowId, { format: 'jpeg', quality: 65 });
}
const bookmarkCapture = createBookmarkCapture(chrome, { native, captureVisible });
const browser = createBrowserState(chrome, { resizePreview, notify, native, bookmarkCapture, captureVisible });
native?.start();
if (native) chrome.windows.onFocusChanged.addListener(native.changed);
chrome.runtime.onConnect.addListener(port => {
  if (port.name !== 'vrwatch:hud' || port.sender?.id !== chrome.runtime.id || port.sender?.frameId > 0) return port.disconnect();
  subscribers.add(port);
  port.onDisconnect.addListener(() => subscribers.delete(port));
});
chrome.tabs.onActivated.addListener(({ tabId }) => { browser.invalidate(); bookmarkCapture.invalidate(); void browser.activity(tabId).catch(() => {}); });
chrome.tabs.onMoved.addListener(id => { browser.invalidate(); void browser.activity(id).catch(() => {}); });
chrome.tabs.onAttached.addListener(browser.invalidate);
chrome.tabs.onDetached.addListener(browser.invalidate);
chrome.windows.onFocusChanged.addListener(id => {
  browser.invalidate();
  if (id >= 0) void chrome.tabs.query({ windowId: id, active: true }).then(tabs => tabs[0] && browser.activity(tabs[0].id)).catch(() => {});
});
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;
  notify();
  if (changes.preferences) {
    void readRecent().catch(console.error);
    void chrome.tabs.query({ active: true, lastFocusedWindow: true }).then(tabs => tabs[0] && browser.activity(tabs[0].id)).catch(() => {});
  }
});
// Alarms survive service-worker suspension; reads and writes also enforce expiry.
void chrome.alarms.get('vrwatch-history-expiry').then(alarm => {
  if (!alarm) return chrome.alarms.create('vrwatch-history-expiry', { periodInMinutes: 60 });
}).catch(console.error);
chrome.alarms.onAlarm.addListener(alarm => { if (alarm.name === 'vrwatch-history-expiry') void readRecent().catch(console.error); });
void readRecent().catch(console.error);
const projectionCache = new Map();
chrome.runtime.onMessage.addListener((message, sender, respond) => {
  if (native && message?.type?.startsWith('vrwatch:bridge-')) {
    native.request(message, sender).then(value => respond({ value }), error => respond({ error: error.message }));
    return true;
  }
  if (message?.type === 'vrwatch:projection') {
    if (sender.id !== chrome.runtime.id || !sender.tab || typeof message.url !== 'string'
        || message.url.length > 8192 || !/^https?:\/\//.test(message.url)) return;
    if (!projectionCache.has(message.url)) {
      if (projectionCache.size >= 200) projectionCache.delete(projectionCache.keys().next().value);
      projectionCache.set(message.url, readMP4Projection(message.url).catch(() => null));
    }
    projectionCache.get(message.url).then(projection => respond({ projection }));
    return true;
  }
  if (message?.type !== 'vrwatch:browser') return;
  browser.request(message, sender).then(value => respond({ value }), error => respond({ error: error.message }));
  return true;
});
chrome.tabs.onRemoved.addListener((id, info) => { browser.removed(id, info).catch(console.error); });
chrome.tabs.onUpdated.addListener((id, changes) => {
  if (changes.url || changes.status === 'loading') bookmarkCapture.invalidate();
  browser.changed(id, changes).catch(console.error);
  if (changes.url || changes.status === 'complete') chrome.tabs.sendMessage(id, { type: 'vrwatch:capture-idle' }, { frameId: 0 }).catch(() => {});
});
chrome.tabs.onCreated.addListener(tab => { browser.created(tab).catch(console.error); });

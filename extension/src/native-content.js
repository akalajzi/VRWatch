import { nativeCandidate } from './runtime-mode.js';
import { validPads } from './native-bridge.js';
import { mountNativeLauncher } from './native-launcher.js';

let session = null;
let xrActive = false;
let queue = Promise.resolve();
function send(message) {
  const work = async () => {
    let reply;
    for (let attempt = 0; ; attempt++) {
      try {
        reply = await chrome.runtime.sendMessage(message);
        if (!reply) throw new Error('Native worker unavailable');
        break;
      } catch (error) {
        if (attempt === 4) throw error;
        await new Promise(resolve => setTimeout(resolve, 100 * 2 ** attempt));
      }
    }
    if (reply.error) throw new Error(reply.error);
    return reply.value;
  };
  const result = queue.then(work);
  queue = result.catch(() => {});
  return result;
}
// Called directly in the extension's isolated world after XR attachment and
// teardown, never via a forgeable DOM CustomEvent or page-supplied binding.
export async function nativeXR(active) {
  if (!nativeCandidate) return;
  xrActive = active;
  if (active) session = crypto.randomUUID();
  if (!session) return;
  const token = session;
  await send({ type: 'vrwatch:bridge-xr', active, session: token });
  if (!active && session === token) session = null;
}
export function mountNativeContent() {
  if (!nativeCandidate || window.top !== window) return;
  mountNativeLauncher(() => send({ type: 'vrwatch:bridge-menu' }));
  const focus = () => {
    if (!xrActive && session) void nativeXR(false).catch(() => {});
    void send({ type: 'vrwatch:bridge-focus' }).catch(() => {});
  };
  let capture;
  const idle = () => {
    clearTimeout(capture);
    capture = setTimeout(() => {
      if (!xrActive && document.hasFocus() && document.visibilityState === 'visible')
        void chrome.runtime.sendMessage({ type: 'vrwatch:browser', action: 'capture', viewport: { top: 0, width: innerWidth } }).catch(() => {});
    }, 1200);
  };
  const cancelCapture = () => {
    clearTimeout(capture);
    void chrome.runtime.sendMessage({ type: 'vrwatch:browser', action: 'cancelCapture' }).catch(() => {});
  };
  document.addEventListener('scroll', () => { cancelCapture(); idle(); }, { passive: true, capture: true });
  document.addEventListener('vrwatch:xr-state', cancelCapture);
  window.addEventListener('pagehide', cancelCapture);
  window.addEventListener('focus', idle);
  window.addEventListener('focus', focus);
  window.addEventListener('blur', focus);
  document.addEventListener('visibilitychange', focus);
  document.addEventListener('vrwatch:menu', () => {
    if (document.hasFocus() && document.visibilityState === 'visible')
      void send({ type: 'vrwatch:bridge-menu' }).catch(() => {});
  });
  chrome.runtime.onMessage.addListener((message, sender) => {
    if (sender.id === chrome.runtime.id && message?.type === 'vrwatch:capture-idle') idle();
    if (sender.id !== chrome.runtime.id || message?.type !== 'vrwatch:native-pads' || !validPads(message.pads)) return;
    if (!xrActive && document.hasFocus() && document.visibilityState === 'visible')
      document.dispatchEvent(new CustomEvent('vrwatch:thumbstick', { detail: message.pads }));
  });
  focus();
  idle();
}

// A page-local entry point only. Chromium owns the HUD, focus and tab actions.
// No page padding, native API or document identity is supplied by this button.
export function mountNativeLauncher(open, { document: doc = document, window: win = window } = {}) {
  if (win.top !== win || doc.getElementById('vrwatch-native-launcher')) return;
  const host = doc.createElement('div');
  host.id = 'vrwatch-native-launcher';
  host.style.cssText = 'position:fixed;top:12px;left:12px;z-index:2147483647;';
  const root = host.attachShadow({ mode: 'closed' });
  root.innerHTML = `<style>
    :host{all:initial;color-scheme:dark;font:14px system-ui;color:#f1f2f4}
    button{display:grid;place-items:center;width:52px;height:52px;padding:9px;box-sizing:border-box;border:1px solid #665439;border-radius:13px;background:#25231e;cursor:pointer;touch-action:manipulation}
    button:hover{border-color:#a7dfd9}button:focus-visible{outline:3px solid #a7dfd9;outline-offset:3px}
    img{width:32px;height:32px;object-fit:contain}p{max-width:280px;background:#191a1f;color:#ffc0b4;padding:10px;border-radius:8px}p:empty{display:none}
  </style><button aria-label="Open VRWatch controls" title="Open VRWatch controls"><img alt=""></button><p role="alert"></p>`;
  root.querySelector('img').src = chrome.runtime.getURL('icons/icon128.png');
  const button = root.querySelector('button'), status = root.querySelector('p');
  button.addEventListener('click', async event => {
    if (!event.isTrusted) return;
    status.textContent = '';
    button.disabled = true;
    try { await open(); }
    catch (error) { status.textContent = error.message; }
    finally { button.disabled = false; }
  });
  const attach = () => (doc.fullscreenElement ?? doc.documentElement).append(host);
  doc.addEventListener('fullscreenchange', attach);
  win.addEventListener('pagehide', () => doc.removeEventListener('fullscreenchange', attach), { once: true });
  attach();
}

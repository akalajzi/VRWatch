import { createHUDClient } from './hud-client.js';
import { createThumbstickScrollInput } from './browser-input.js';
import { validPads } from './native-bridge.js';
import { browserIcon as icon } from './browser-icons.js';

const client = createHUDClient();
const cards = new Map();
const get = id => document.getElementById(id);
const native = request => chrome.vrwatchPrivate.request(request);
let reading = false, dirty = false, unsubscribe, visible = false, busy = false;
let view = 'closed';
let bookmarkable = false;
for (const node of document.querySelectorAll('[data-icon]')) node.innerHTML = icon(node.dataset.icon);
const report = error => { get('status').textContent = error.message; };
const hide = () => native({ operation: 'hud', view: 'closed' }).catch(report);
async function action(name, extra = {}) {
  if (busy) return;
  busy = true;
  const buttons = [...document.querySelectorAll('[data-action], .select-tab, .close-tab')];
  buttons.forEach(button => { button.disabled = true; });
  get('new').setAttribute('aria-busy', String(name === 'create'));
  let waiting = setTimeout(() => { get('status').textContent = 'Still waiting for the browser. Please do not repeat the action.'; }, 5000);
  try {
    get('status').textContent = '';
    await client.request(name, extra);
    clearTimeout(waiting);
    if (['activate', 'create', 'navigate', 'home'].includes(name)) await hide();
    else await refresh();
  } catch (error) { report(error); }
  finally {
    clearTimeout(waiting);
    busy = false;
    document.querySelectorAll('[data-action], .select-tab, .close-tab').forEach(button => { button.disabled = false; });
    get('new').setAttribute('aria-busy', 'false');
    get('bookmark').disabled = !bookmarkable;
  }
}
function card(tab) {
  let entry = cards.get(tab.id);
  if (!entry) {
    const node = document.createElement('article');
    node.className = 'card'; node.setAttribute('role', 'listitem');
    node.innerHTML = `<button class="select-tab"><span class="preview"><span class="fallback">${icon('globe')}<small>No preview yet</small></span><img alt=""></span><span class="caption"><span class="page-icon"><img alt=""></span><span class="caption-text"><span class="page-title"></span><span class="domain"></span></span><span class="current-label"></span></span></button><button class="close-tab">${icon('close')}</button>`;
    entry = { node, version: null, request: 0 };
    node.querySelector('.select-tab').onclick = () => action('activate', { tabId: tab.id });
    node.querySelector('.close-tab').onclick = () => action('close', { tabId: tab.id });
    cards.set(tab.id, entry);
  }
  entry.node.classList.toggle('current', tab.current);
  entry.node.querySelector('.page-title').textContent = tab.title;
  entry.node.querySelector('.select-tab').setAttribute('aria-label', tab.title);
  entry.node.querySelector('.close-tab').setAttribute('aria-label', `Close ${tab.title}`);
  entry.node.querySelectorAll('button').forEach(button => { button.disabled = busy; });
  entry.node.querySelector('.current-label').textContent = tab.current ? 'Current' : '';
  let domain = ''; try { domain = new URL(tab.url).hostname; } catch {}
  entry.node.querySelector('.domain').textContent = [tab.home ? 'VRWatch Home' : domain, tab.loading && 'Loading', tab.audible && 'Playing audio'].filter(Boolean).join(' · ');
  const favicon = entry.node.querySelector('.page-icon img');
  const source = tab.home ? chrome.runtime.getURL('icons/icon128.png') : tab.favicon;
  if (/^(https?:|data:image\/|chrome-extension:)/.test(source)) {
    if (favicon.getAttribute('src') !== source) favicon.src = source;
  } else favicon.removeAttribute('src');
  if (entry.version !== tab.previewVersion) {
    entry.version = tab.previewVersion;
    const token = ++entry.request;
    entry.node.querySelector('.preview>img').removeAttribute('src');
    if (tab.previewVersion) client.request('preview', { tabId: tab.id, version: tab.previewVersion }).then(({ image }) => {
      if (cards.get(tab.id) !== entry || token !== entry.request) return;
      if (visible && image) entry.node.querySelector('.preview>img').src = image;
      else entry.version = null;
    }).catch(() => {});
  }
  return entry.node;
}
async function refresh() {
  dirty = true;
  if (reading) return;
  reading = true;
  try {
    while (dirty) {
      dirty = false;
      const owned = await native({ operation: 'state' });
      view = owned.hudView;
      visible = view !== 'closed';
      get('tabs').setAttribute('aria-expanded', String(view === 'tabs'));
      get('picker').hidden = owned.hudView !== 'tabs';
      if (!visible) { unsubscribe?.(); unsubscribe = null; continue; }
      if (!unsubscribe) unsubscribe = client.subscribe(() => { void refresh().catch(report); });
      const snapshot = await client.request('state');
      const current = snapshot.tabs.find(tab => tab.current);
      if (document.activeElement !== get('address')) get('address').value = current?.home ? '' : current?.url || '';
      get('summary').textContent = `${snapshot.tabs.length} ${snapshot.tabs.length === 1 ? 'tab' : 'tabs'}`;
      bookmarkable = /^https?:/.test(current?.url || '');
      get('bookmark').disabled = !bookmarkable;
      get('bookmark').setAttribute('aria-pressed', String(snapshot.saved));
      get('bookmark').title = snapshot.saved ? 'Remove bookmark' : 'Bookmark';
      get('reload').innerHTML = icon(current?.loading ? 'close' : 'reload');
      get('reload').setAttribute('aria-label', current?.loading ? 'Stop' : 'Reload');
      get('reload').title = current?.loading ? 'Stop' : 'Reload';
      get('reload').dataset.action = current?.loading ? 'stop' : 'reload';
      const ids = new Set(snapshot.tabs.map(tab => tab.id));
      for (const [id, entry] of cards) if (!ids.has(id)) { entry.node.remove(); cards.delete(id); }
      snapshot.tabs.forEach((tab, index) => {
        const node = card(tab), next = get('cards').children[index];
        if (next !== node) get('cards').insertBefore(node, next || null);
      });
    }
  } finally { reading = false; }
}
document.querySelectorAll('[data-action]').forEach(button => { button.onclick = () => action(button.dataset.action); });
get('tabs').onclick = () => native({ operation: 'hud', view: view === 'tabs' ? 'navigation' : 'tabs' }).catch(report);
get('return').onclick = () => native({ operation: 'hud', view: 'navigation' }).catch(report);
get('hide').onclick = hide;
get('address-form').onsubmit = event => {
  event.preventDefault();
  const url = get('address').value;
  void action('navigate', { url });
};
document.addEventListener('keydown', event => { if (event.key === 'Escape') void hide(); });
const stick = createThumbstickScrollInput(top => get('cards').scrollBy({ top, behavior: 'instant' }));
chrome.runtime.onMessage.addListener((message, sender) => {
  if (sender.id === chrome.runtime.id && message?.type === 'vrwatch:hud-pads' && validPads(message.pads))
    stick.update(message.pads, visible && document.hasFocus());
});
chrome.vrwatchPrivate.onChanged.addListener(() => { void refresh().catch(report); });
void refresh().catch(report);

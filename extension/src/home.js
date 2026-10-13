import { readPreferences } from './preferences.js';
import { mountPagePreferences } from './page-preferences.js';
import { createHUDClient } from './hud-client.js';
import { browserIcon } from './browser-icons.js';
import { normalizeUrl } from './media.js';
import { readBookmarkState, DEFAULT_BOOKMARKS } from './bookmarks.js';
import { mountBrowserHUD } from './browser-hud.js';
import { mountBrowserScroll } from './browser-scroll.js';
import { mountNativeContent } from './native-content.js';
import { readRecent, clearRecent, removeRecent, remember } from './recent.js';

for (const node of document.querySelectorAll('[data-home-icon]')) node.innerHTML = browserIcon(node.dataset.homeIcon);

mountPagePreferences();
mountNativeContent();
if (new URLSearchParams(location.search).get('startup') === '1' && globalThis.chrome?.runtime?.id) {
  void createHUDClient().request('startup').catch(error => { document.querySelector('#url-error').textContent = error.message; });
}
mountBrowserHUD({ home: true });
mountBrowserScroll();

const bookmarkGrid = document.querySelector('.bookmark-grid');
const bookmarkTemplates = new Map(DEFAULT_BOOKMARKS.map(item => [item.icon, bookmarkGrid.querySelector(`.${item.icon}`).cloneNode(true)]));
async function renderBookmarks() {
  const state = await readBookmarkState();
  const bookmarks = state.quickLinks.map(url => state.bookmarks.find(item => item.url === url)).filter(Boolean);
  document.querySelector('.bookmarks-section').hidden = !state.showQuickLinks;
  document.querySelector('#quick-links-empty').hidden = bookmarks.length !== 0;
  const tiles = bookmarks.map(item => {
    const tile = bookmarkTemplates.get(item.icon)?.cloneNode(true) || document.createElement('a');
    if (!tile.className) {
      tile.className = 'bookmark website';
      tile.innerHTML = '<span class="tile-arrow" aria-hidden="true">↗</span><div class="tile-art"><svg class="airpano-mark" viewBox="0 0 100 100" aria-hidden="true"><circle cx="50" cy="50" r="35"></circle><ellipse cx="50" cy="50" rx="16" ry="35"></ellipse><path d="M15 50h70M21 31h58M21 69h58"></path></svg></div><div class="tile-label"><h2></h2><p></p></div><span class="format-tag"></span>';
    }
    tile.href = item.url;
    tile.dataset.history = '';
    tile.setAttribute('aria-label', `${item.title} — ${item.description}`);
    tile.querySelector('h2').textContent = item.title;
    tile.querySelector('.tile-label p').textContent = item.description;
    tile.querySelector('.format-tag').textContent = item.format;
    return tile;
  });
  bookmarkGrid.replaceChildren(...tiles);
  document.querySelector('.section-count').textContent = `${bookmarks.length} destination${bookmarks.length === 1 ? '' : 's'}`;
}
renderBookmarks().catch(console.error);
globalThis.chrome?.storage?.onChanged?.addListener((changes, area) => {
  if (area === 'local' && (changes.bookmarks || changes.quickLinks || changes.showQuickLinks)) renderBookmarks().catch(console.error);
});
window.addEventListener('storage', event => { if (['vrwatch.bookmarks', 'vrwatch.quickLinks', 'vrwatch.showQuickLinks'].includes(event.key)) renderBookmarks().catch(console.error); });


async function openHistoryLink(event) {
  const link = event.target.closest('[data-history]');
  if (!link) return;
  if (event.button || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
  event.preventDefault();
  await remember(link.href).catch(console.error);
  window.location.assign(link.href);
}
bookmarkGrid.addEventListener('click', openHistoryLink);
document.querySelector('#recent-list').addEventListener('click', openHistoryLink);

let recentGeneration = 0, recentSignature;
async function renderRecent() {
  const generation = ++recentGeneration;
  const list = document.querySelector('#recent-list');
  const [recent, preferences] = await Promise.all([readRecent(), readPreferences()]);
  if (generation !== recentGeneration) return;
  document.querySelector('.recent-section').hidden = !preferences.showRecent;
  const signature = JSON.stringify([recent, preferences.rememberHistory]);
  if (signature === recentSignature) return;
  recentSignature = signature;
  const clear = document.querySelector('#clear-recent');
  const hint = document.querySelector('#recent-hint');
  hint.hidden = true;
  clear.hidden = recent.length === 0;
  if (!recent.length) {
    list.innerHTML = '<p class="empty-state"></p>';
    list.firstChild.textContent = preferences.rememberHistory ? 'Sites you open will appear here.' : 'Remembering recently opened sites is off. You can enable it in Settings.';
    return;
  }
  list.replaceChildren();
  for (const item of recent) {
    let url;
    try { url = normalizeUrl(item.url); } catch { continue; }
    const link = document.createElement('a');
    link.className = 'recent-link';
    link.href = url;
    link.dataset.history = '';
    const text = document.createElement('div');
    text.className = 'recent-text';
    const name = document.createElement('div');
    name.className = 'recent-meta';
    name.textContent = new URL(url).hostname.replace(/^www\./, '');
    const opened = new Date(item.opened);
    if (Number.isFinite(opened.getTime())) {
      const time = document.createElement('time');
      time.dateTime = opened.toISOString();
      time.textContent = opened.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
      time.title = opened.toLocaleString();
      name.append(time);
    }
    const detail = document.createElement('small');
    detail.textContent = url;
    text.append(name, detail);
    const arrow = document.createElement('span');
    arrow.textContent = '↗';
    arrow.setAttribute('aria-hidden', 'true');
    link.append(text, arrow);
    const row = document.createElement('div');
    row.className = 'recent-entry';
    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'recent-remove';
    remove.title = 'Remove from history';
    remove.setAttribute('aria-label', `Remove ${url} from history`);
    remove.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m7 7 10 10M17 7 7 17"></path></svg>';
    remove.addEventListener('click', async () => {
      const index = [...list.querySelectorAll('.recent-remove')].indexOf(remove);
      remove.disabled = true;
      try {
        await removeRecent(item.url);
        await renderRecent();
        const buttons = list.querySelectorAll('.recent-remove');
        (buttons[index] ?? buttons[buttons.length - 1] ?? list).focus();
      } catch (problem) {
        remove.disabled = false;
        document.querySelector('#url-error').textContent = 'Could not remove this history entry. Please try again.';
        console.error(problem);
      }
    });
    row.append(link, remove);
    list.append(row);
  }
  hint.hidden = list.childElementCount <= 4;
}
document.querySelector('#clear-recent').addEventListener('click', async () => {
  try { await clearRecent(); await renderRecent(); document.querySelector('#recent-list').focus(); }
  catch { document.querySelector('#url-error').textContent = 'Could not clear history. Please try again.'; }
});
renderRecent().catch(console.error);
globalThis.chrome?.storage?.onChanged?.addListener((changes, area) => {
  if (area === 'local' && (changes.recent || changes.preferences)) void renderRecent().catch(console.error);
});
window.addEventListener('storage', event => { if (!event.key || ['vrwatch.recent', 'vrwatch.preferences'].includes(event.key)) void renderRecent().catch(console.error); });
window.addEventListener('pageshow', () => { void renderRecent().catch(console.error); });
const recentTimer = setInterval(() => { void renderRecent().catch(console.error); }, 60000);
window.addEventListener('pagehide', () => clearInterval(recentTimer));

const status = document.querySelector('#runtime-status');
async function checkHeadset() {
  try {
    const supported = await navigator.xr?.isSessionSupported('immersive-vr');
    status.classList.toggle('ready', !!supported);
    status.lastChild.textContent = supported ? 'VR ready' : 'Headset not detected';
  } catch { status.lastChild.textContent = 'Browse, then check VR'; }
}
checkHeadset();
navigator.xr?.addEventListener('devicechange', checkHeadset);

import { browserIcon } from './browser-icons.js';
import { readBookmarkState, changeBookmarks, cleanupBookmarkPreviews } from './bookmarks.js';
import { getPreview } from './bookmark-previews.js';
import { mountManagePage, showMessage } from './manage-page.js';
import { remember } from './recent.js';

const get = id => document.getElementById(id);
let state, editing = null, confirmation, generation = 0;
let imageURLs = [];
const element = (tag, text, className) => {
  const node = document.createElement(tag); if (text) node.textContent = text; if (className) node.className = className; return node;
};
function button(label, action, url, text = label) {
  const node = element('button', text); node.type = 'button'; node.setAttribute('aria-label', label);
  node.title = label; node.dataset.action = action; node.dataset.url = url; return node;
}
function iconButton(label, action, url, icon) {
  const node = button(label, action, url, '');
  node.innerHTML = browserIcon(icon);
  return node;
}
function folders(select, all = false) {
  const value = select.value;
  select.replaceChildren(...(all ? [new Option('All folders', '*')] : []), new Option('Unfiled', all ? JSON.stringify('') : ''), ...state.bookmarkFolders.map(name => new Option(name, all ? JSON.stringify(name) : name)));
  select.value = [...select.options].some(option => option.value === value) ? value : all ? '*' : '';
}
function revokeImages() { for (const url of imageURLs) URL.revokeObjectURL(url); imageURLs = []; }
async function render() {
  const currentGeneration = ++generation;
  try {
    const next = await readBookmarkState(); if (currentGeneration !== generation) return;
    state = next;
    const focused = document.activeElement?.dataset;
    const focus = focused?.action ? { ...focused } : null;
    folders(get('folder-filter'), true);
    const selectedFolder = get('folder-filter').value;
    const folder = selectedFolder === '*' ? null : JSON.parse(selectedFolder);
    get('delete-folder').hidden = !folder;
    get('quick-count').textContent = `${state.quickLinks.length} / 5${state.showQuickLinks ? '' : ' · Hidden on Home'}`;
    get('quick-empty').hidden = state.quickLinks.length !== 0;
    get('quick-list').replaceChildren(...state.quickLinks.map((url, index) => {
      const item = state.bookmarks.find(bookmark => bookmark.url === url), li = element('li');
      li.append(element('span', `${index + 1}. ${item.title}`));
      const left = button(`Move ${item.title} earlier`, 'earlier', url, '←'); left.disabled = index === 0;
      const right = button(`Move ${item.title} later`, 'later', url, '→'); right.disabled = index === state.quickLinks.length - 1;
      li.append(left, right, button(`Unpin ${item.title}`, 'unpin', url, 'Unpin')); return li;
    }));
    const query = get('search').value.trim().toLocaleLowerCase();
    const items = state.bookmarks.filter(item => (folder === null || item.folder === folder) && `${item.title} ${item.url} ${item.folder}`.toLocaleLowerCase().includes(query));
    const sort = get('sort').value;
    items.sort((a, b) => sort === 'newest' ? b.added - a.added : sort === 'site' ? new URL(a.url).hostname.localeCompare(new URL(b.url).hostname) || a.title.localeCompare(b.title) : a.title.localeCompare(b.title));
    get('result-count').textContent = `${items.length} bookmark${items.length === 1 ? '' : 's'}`;
    get('empty').hidden = items.length > 0;
    get('empty').textContent = state.bookmarks.length ? 'No bookmarks match. Try another search or folder.' : 'No bookmarks yet. Save a page using the toolbar bookmark button.';
    revokeImages();
    get('bookmark-cards').replaceChildren(...items.map(item => {
      const card = element('article', '', 'saved-card'), link = element('a'); link.href = item.url;
      const preview = element('div', '', 'preview'), fallback = element('span', '↗', 'preview-fallback'); fallback.setAttribute('aria-hidden', 'true'); preview.append(fallback);
      const copy = element('div', '', 'card-copy'); copy.append(element('h2', item.title), element('p', new URL(item.url).hostname, 'site'), element('p', item.url, 'saved-url'));
      if (item.folder) copy.append(element('p', item.folder));
      link.append(preview, copy);
      link.addEventListener('click', event => {
        if (event.button || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return;
        event.preventDefault(); void remember(item.url).catch(() => {}).finally(() => location.assign(item.url));
      });
      const actions = element('div', '', 'card-actions'), pinned = state.quickLinks.includes(item.url);
      const pin = iconButton(pinned ? `Unpin ${item.title} from Home` : `Pin ${item.title} to Home`, 'pin', item.url, 'pin');
      pin.setAttribute('aria-pressed', String(pinned));
      const refresh = iconButton(`Refresh preview for ${item.title}`, 'preview', item.url, 'reload');
      refresh.title = 'Refresh preview — open this page to capture a fresh preview'; refresh.disabled = !globalThis.chrome?.runtime?.id;
      if (refresh.disabled) refresh.title = 'Preview capture is available in the installed extension.';
      actions.append(pin, iconButton(`Edit ${item.title}`, 'edit', item.url, 'edit'), refresh, iconButton(`Delete ${item.title}`, 'delete', item.url, 'trash'));
      card.append(link, actions);
      void getPreview(item.previewKey).then(blob => {
        if (!blob || generation !== currentGeneration) return;
        const image = document.createElement('img'), url = URL.createObjectURL(blob); imageURLs.push(url);
        image.alt = ''; image.loading = 'lazy'; image.src = url; image.onerror = () => image.remove(); preview.append(image);
      }).catch(() => {});
      return card;
    }));
    if (focus) [...document.querySelectorAll('button[data-action]')].find(node => node.dataset.action === focus.action && node.dataset.url === focus.url)?.focus();
  } catch (error) { showMessage(error.message, true); }
}
function edit(item) {
  editing = item.url;
  const form = get('bookmark-form'); form.reset(); folders(form.elements.folder);
  form.elements.title.value = item?.title || ''; form.elements.url.value = item?.url || ''; form.elements.folder.value = item?.folder || '';
  get('editor-error').textContent = ''; get('editor').showModal(); form.elements.title.focus();
}
function confirm(title, detail, work) {
  get('confirm-title').textContent = title; get('confirm-detail').textContent = detail; confirmation = work; get('confirm-dialog').showModal();
}
get('new-folder').onclick = () => { get('folder-form').reset(); get('folder-error').textContent = ''; get('folder-dialog').showModal(); };
for (const close of document.querySelectorAll('[data-close]')) close.onclick = () => get(close.dataset.close).close();
for (const id of ['search', 'sort', 'folder-filter']) get(id).addEventListener(id === 'search' ? 'input' : 'change', render);
get('bookmark-form').onsubmit = async event => {
  event.preventDefault(); const form = event.target, submit = form.querySelector('[type="submit"]'); submit.disabled = true;
  try {
    await changeBookmarks('save', { originalUrl: editing, title: form.elements.title.value, url: form.elements.url.value, folder: form.elements.folder.value });
    get('editor').close(); await render(); showMessage('Bookmark saved.');
  } catch (error) { get('editor-error').textContent = error.message; }
  finally { submit.disabled = false; }
};
get('folder-form').onsubmit = async event => {
  event.preventDefault();
  try { await changeBookmarks('folder', { name: event.target.elements.name.value }); get('folder-dialog').close(); await render(); showMessage('Folder created. Choose it when editing a bookmark.'); }
  catch (error) { get('folder-error').textContent = error.message; }
};
get('delete-folder').onclick = () => {
  const name = JSON.parse(get('folder-filter').value);
  confirm('Remove folder?', `“${name}” will be removed. Its bookmarks will move to Unfiled.`, () => changeBookmarks('deleteFolder', { name }));
};
get('confirm-remove').onclick = async event => {
  event.target.disabled = true;
  try { await confirmation(); get('confirm-dialog').close(); await render(); showMessage('Removed.'); get('search').focus(); }
  catch (error) { get('confirm-dialog').close(); showMessage(error.message, true); }
  finally { event.target.disabled = false; }
};
document.addEventListener('click', async event => {
  const target = event.target.closest('button[data-action]'); if (!target) return;
  const { action, url } = target.dataset, item = state.bookmarks.find(bookmark => bookmark.url === url); if (!item) return;
  if (action === 'edit') return edit(item);
  if (action === 'delete') return confirm('Delete bookmark?', `Remove “${item.title}” and its saved preview? It will also be removed from Home.`, () => changeBookmarks('delete', { url }));
  target.disabled = true;
  try {
    if (action === 'preview') { await changeBookmarks('refreshPreview', { url }); location.assign(url); return; }
    await changeBookmarks(['pin', 'unpin'].includes(action) ? 'pin' : 'move', { url, direction: action === 'earlier' ? -1 : 1 });
    await render(); showMessage('Home Quick Links updated.');
  } catch (error) { showMessage(error.message, true); target.disabled = false; }
});
window.addEventListener('pagehide', revokeImages);
mountManagePage(render);
void render().then(async () => {
  // Reconcile leftovers after an interrupted write without racing a new capture.
  try {
    await cleanupBookmarkPreviews();
  } catch { /* Missing preview storage never blocks bookmark management. */ }
});

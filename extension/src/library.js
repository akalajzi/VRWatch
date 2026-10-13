const token = document.querySelector('meta[name="library-token"]').content;
const source = document.querySelector('#source');
const status = document.querySelector('#status');
const entries = document.querySelector('#entries');
const filter = document.querySelector('#filter');
const video = document.querySelector('#library-video');
const browser = document.querySelector('#browser');
const player = document.querySelector('#player');
const videoStatus = document.querySelector('#video-status');
let roots = [];
let listing = null;
let request = null;
let revision = 0;
let selected = null;
document.querySelector('#home').href = 'chrome-extension://bkjijegjmneghekcknijmioimbahmfap/home.html';

function showStatus(message, error = false) {
  status.textContent = message;
  status.classList.toggle('error', error);
}

async function api(path, signal) {
  const response = await fetch(path, { headers: { 'X-VRWatch-Library-Token': token }, signal });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || 'The media drive could not be read.');
  return data;
}

function locationState() {
  const query = new URLSearchParams(location.search);
  return { root: query.get('root') || roots[0]?.id || '', path: query.get('path') || '', file: query.get('file') || '' };
}

function go(root, path = '', file = '') {
  const query = new URLSearchParams({ root, path });
  if (file) query.set('file', file);
  history.pushState(null, '', `${location.pathname}?${query}`);
  void load();
}

function sizeLabel(bytes) {
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  if (bytes < 1024 ** 3) return `${Math.round(bytes / 1024 ** 2)} MB`;
  return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
}

function renderEntries() {
  entries.replaceChildren();
  if (!listing) return;
  const needle = filter.value.trim().toLocaleLowerCase();
  const visible = listing.entries.filter(item => item.name.toLocaleLowerCase().includes(needle));
  document.querySelector('#count').textContent = `${visible.length} ${visible.length === 1 ? 'item' : 'items'}`;
  const fragment = document.createDocumentFragment();
  for (const item of visible) {
    const button = document.createElement('button');
    button.type = 'button'; button.className = `entry ${item.folder ? 'folder' : 'video'}`;
    const icon = document.createElement('span'); icon.className = 'entry-icon'; icon.setAttribute('aria-hidden', 'true');
    icon.innerHTML = item.folder
      ? '<svg viewBox="0 0 24 24"><path d="M3 7V5a2 2 0 0 1 2-2h5l2 3h7a2 2 0 0 1 2 2v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7Z"/></svg>'
      : '<svg viewBox="0 0 24 24"><rect x="3" y="4" width="18" height="16" rx="3"/><path d="m10 8 6 4-6 4Z"/></svg>';
    const name = document.createElement('span'); name.className = 'entry-name'; name.textContent = item.name;
    const meta = document.createElement('span'); meta.className = 'entry-meta';
    meta.textContent = item.folder ? 'Folder' : sizeLabel(item.size);
    const arrow = document.createElement('span'); arrow.className = 'entry-arrow'; arrow.textContent = '›'; arrow.setAttribute('aria-hidden', 'true');
    button.append(icon, name, meta, arrow);
    button.addEventListener('click', () => go(listing.root, item.folder ? item.path : listing.path, item.folder ? '' : item.path));
    fragment.append(button);
  }
  entries.append(fragment);
  showStatus(visible.length ? '' : needle ? 'No matching folders or videos.' : 'No videos in this folder. Open another folder to keep browsing.');
}

function renderBreadcrumbs() {
  const breadcrumbs = document.querySelector('#breadcrumbs');
  breadcrumbs.replaceChildren();
  const parts = listing.path ? listing.path.split('/') : [];
  for (let index = 0; index <= parts.length; index++) {
    if (index) {
      const separator = document.createElement('span'); separator.className = 'separator'; separator.textContent = '/';
      separator.setAttribute('aria-hidden', 'true'); breadcrumbs.append(separator);
    }
    const button = document.createElement('button'); button.type = 'button';
    button.textContent = index ? parts[index - 1] : listing.label;
    if (index === parts.length) button.setAttribute('aria-current', 'location');
    button.addEventListener('click', () => go(listing.root, parts.slice(0, index).join('/')));
    breadcrumbs.append(button);
  }
}

function stopVideo() {
  video.pause(); video.removeAttribute('src'); video.load(); selected = null;
  document.title = 'Media library · VRWatch';
}

function openVideo(root, file) {
  browser.hidden = true; player.hidden = false;
  if (selected === `${root}\n${file}`) return;
  stopVideo(); selected = `${root}\n${file}`;
  const title = file.split('/').at(-1);
  document.querySelector('#video-title').textContent = title;
  document.title = `${title} · VRWatch`;
  videoStatus.classList.remove('error');
  videoStatus.textContent = 'Start playback, then use the VRWatch button beside the video to watch in VR.';
  video.src = `/media/${token}/${encodeURIComponent(root)}/${file.split('/').map(encodeURIComponent).join('/')}`;
  window.scrollTo(0, 0);
}

async function load() {
  const current = ++revision;
  request?.abort(); request = new AbortController();
  const controller = request;
  const timeout = setTimeout(() => controller.abort(), 15000);
  const state = locationState();
  source.value = state.root;
  if (!state.file) {
    if (selected) stopVideo();
    player.hidden = true; browser.hidden = false;
  }
  listing = null; entries.replaceChildren();
  document.querySelector('#count').textContent = '';
  entries.setAttribute('aria-busy', 'true');
  showStatus('Reading folder…');
  try {
    const next = await api(`/api/list?${new URLSearchParams({ root: state.root, path: state.path })}`, controller.signal);
    if (current !== revision) return;
    listing = next; filter.value = '';
    renderBreadcrumbs(); renderEntries();
    if (state.file) openVideo(state.root, state.file);
  } catch (error) {
    if (current !== revision) return;
    if (selected) stopVideo();
    player.hidden = true; browser.hidden = false;
    listing = null;
    showStatus(error.name === 'AbortError' ? 'The drive is taking too long to respond. Check its connection and refresh.' : error.message, true);
  } finally {
    clearTimeout(timeout);
    if (current === revision) entries.setAttribute('aria-busy', 'false');
  }
}

source.addEventListener('change', () => go(source.value));
filter.addEventListener('input', renderEntries);
document.querySelector('#refresh').addEventListener('click', () => void initialize());
document.querySelector('#back-to-folder').addEventListener('click', () => {
  const state = locationState(); go(state.root, state.path);
});
video.addEventListener('error', () => {
  if (!video.getAttribute('src')) return;
  videoStatus.classList.add('error');
  videoStatus.textContent = video.error?.code === MediaError.MEDIA_ERR_NETWORK
    ? 'The video could not be read. Check the NAS connection, then return to the folder and try again.'
    : 'This video could not be played. Its video or audio format may not be supported by this browser.';
});
window.addEventListener('popstate', () => void load());
window.addEventListener('pagehide', () => { request?.abort(); stopVideo(); });
window.addEventListener('pageshow', event => { if (event.persisted) void initialize(); });

async function initialize() {
  showStatus('Connecting to media library…');
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15000);
  try {
    const data = await api('/api/roots', controller.signal);
    roots = data.roots;
    source.replaceChildren(...roots.map(root => {
      const option = document.createElement('option'); option.value = root.id; option.textContent = root.label; return option;
    }));
    if (!roots.length) {
      entries.setAttribute('aria-busy', 'false');
      showStatus('No media folders are connected yet. Connect a drive to start browsing.');
      return;
    }
    await load();
  } catch (error) {
    entries.setAttribute('aria-busy', 'false');
    showStatus(error.name === 'AbortError' ? 'The media library is taking too long to respond. Refresh to try again.' : error.message, true);
  } finally { clearTimeout(timeout); }
}
void initialize();

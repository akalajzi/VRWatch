import { reconcileCards } from './tab-cards.js';
import styles from '../pages/hud.css';
import scrollbarStyles from '../pages/scrollbars.css';
import { createHUDClient } from './hud-client.js';
import { nativeCandidate } from './runtime-mode.js';
import { createBrowserMenuInput } from './browser-input.js';
import { positionOverlay, OVERLAYS, POSITIONS, readOverlayPositions, watchOverlayPositions, saveOverlayPosition, resetOverlayPositions, MOVE_HANDLE, MOVE_STYLE } from './overlay-position.js';

import { browserIcon as icon } from './browser-icons.js';

function pageMark(url) {
  let hostname; try { hostname = new URL(url).hostname; } catch { return ''; }
  if (/(^|\.)youtube\.com$/.test(hostname)) return '<svg viewBox="0 0 100 70" style="stroke:none" aria-hidden="true"><rect x="4" y="7" width="92" height="56" rx="17" fill="#ff3333"/><path d="M42 23 66 35 42 47Z" fill="white"/></svg>';
  if (/(^|\.)dailymotion\.com$/.test(hostname)) return '<span class="daily-mark">d.</span>';
  if (/(^|\.)deovr\.com$/.test(hostname)) return '<span class="deo-mark">DEO<span>VR</span></span>';
  if (/(^|\.)airpano\.com$/.test(hostname)) return icon('globe');
  return '';
}

export function mountBrowserHUD({ client = createHUDClient(), home = false } = {}) {
  if (nativeCandidate) return;
  if (window.top !== window || document.getElementById('vrwatch-hud')) return;
  const host = document.createElement('div');
  host.id = 'vrwatch-hud';
  host.dataset.view = 'closed';
  host.style.cssText = 'position:fixed;inset:0;z-index:2147483647;pointer-events:none;';
  // Reserve room only in our own homepage, never by changing website CSS.
  const spacer = home ? document.createElement('div') : null;
  if (spacer) { spacer.id = 'vrwatch-bar-space'; document.body.prepend(spacer); }
  const root = host.attachShadow({ mode: 'closed' });
  const logo = globalThis.chrome?.runtime?.id ? chrome.runtime.getURL('icons/icon128.png') : new URL('icons/icon128.png', client.homeURL).href;
  root.innerHTML = `<style>${styles}${scrollbarStyles}${MOVE_STYLE}</style>
    <button class="trigger" id="trigger" aria-label="Expand VRWatch controls" title="Expand VRWatch controls" aria-controls="dock" aria-expanded="false"><img src="${logo}" alt=""></button>
    <div id="shade" class="shade" hidden></div>
    <section id="dock" class="dock" aria-label="VRWatch controls" hidden>
      <button class="brand-toggle" id="dismiss" aria-label="Collapse VRWatch controls" title="Collapse VRWatch controls" aria-controls="dock" aria-expanded="true"><img src="${logo}" alt=""></button>
      <nav class="actions" aria-label="Browser navigation"><button class="action" id="back" aria-label="Back" title="Back">${icon('back')}</button><button class="action" id="forward" aria-label="Forward" title="Forward">${icon('forward')}</button><button class="action" id="reload" aria-label="Reload" title="Reload">${icon('reload')}</button><button class="action" id="home" aria-label="Home" title="Home">${icon('home')}</button></nav>
      <form class="address-field" id="address-form"><label class="sr-only" for="address">Website or search</label>${icon('globe')}<input id="address" inputmode="url" autocomplete="url" spellcheck="false" placeholder="Search or enter a website"><button aria-label="Open URL" title="Open URL">${icon('forward')}</button></form>
      <div class="actions"><button class="action" id="bookmark" aria-label="Bookmark" title="Bookmark" aria-pressed="false">${icon('bookmark')}</button>
      <button class="action tabs-action" id="tabs" aria-label="Tabs" title="Tabs">${icon('tabs')}</button><button class="action" id="layout" aria-label="Positions" title="Positions">${icon('layout')}</button></div>
    </section>
    <section id="picker" class="picker" role="dialog" aria-label="Choose a tab" aria-modal="true" hidden>
      <div class="picker-inner"><button class="move-handle" id="move-picker" aria-label="Move tab picker" title="Drag to move">${MOVE_HANDLE}</button><header class="heading"><div><h1>Tabs</h1><p class="summary" id="summary" role="status">Loading tabs…</p></div>
      <div class="tools"><button class="new-tab" id="new">${icon('plus')}<span>New tab</span></button><button class="icon-button" id="return" aria-label="Return to current tab">${icon('close')}</button></div></header>
      <p class="picker-error" id="error" role="alert"></p><div class="grid" id="grid"></div></div>
    </section>
    <section id="positions" class="positions" role="dialog" aria-label="Popup positions" aria-modal="true" hidden>
      <header class="heading"><button class="move-handle" id="move-layout" aria-label="Move popup positions" title="Drag to move">${MOVE_HANDLE}</button><h1>Popup positions</h1><button class="icon-button" id="positions-close" aria-label="Close popup positions">${icon('close')}</button></header>
      <p>Drag a move handle to place a popup. Positions are saved across websites. Choose a default below to replace a dragged position.</p>
      <div id="position-fields"></div><button class="new-tab" id="reset-positions">Restore defaults</button><p class="position-status" id="position-status" role="status"></p>
    </section><div class="notice" id="notice" role="status" hidden></div>`;
  const get = id => root.getElementById(id);
  let view = 'closed';
  let busy = false;
  let state;
  let noticeTimer;
  let captureTimer;
  let capturing = false;
  let unsubscribe;
  const cards = new Map();
  let refreshing = false;
  let refreshAgain = false;
  let revision = 0;
  let previousFocus;

  const placements = {
    picker: positionOverlay('picker', get('picker'), { handle: get('move-picker') }),
    layout: positionOverlay('layout', get('positions'), { handle: get('move-layout') }),
    notice: positionOverlay('notice', get('notice'), { bottom: 155 }),
  };
  function renderPositions() {
    const focused = root.activeElement?.id;
    get('position-fields').replaceChildren();
    for (const [id, [label, fallback]] of Object.entries(OVERLAYS)) {
      if (['dock', 'trigger', 'scroll'].includes(id)) continue;
      const row = document.createElement('label'); row.className = 'position-field';
      const title = document.createElement('span'); title.textContent = label;
      const select = document.createElement('select'); select.id = `position-${id}`;
      const current = readOverlayPositions()[id] ?? fallback;
      for (const value of [...POSITIONS, ...(typeof current === 'object' ? ['custom'] : [])]) {
        const option = document.createElement('option'); option.value = value;
        option.textContent = value === 'custom' ? 'Dragged position' : value.replace('-', ' ');
        option.disabled = value === 'custom'; select.append(option);
      }
      select.value = typeof current === 'object' ? 'custom' : current;
      select.addEventListener('change', () => {
        saveOverlayPosition(id, select.value).then(() => { get('position-status').textContent = 'Position saved'; })
          .catch(error => { get('position-status').textContent = error.message; });
      });
      row.append(title, select); get('position-fields').append(row);
    }
    if (focused) get(focused)?.focus();
  }
  watchOverlayPositions(renderPositions);
  renderPositions();
  function notify(message) {
    clearTimeout(noticeTimer);
    get('notice').textContent = message;
    get('notice').hidden = false;
    placements.notice.update();
    noticeTimer = setTimeout(() => { get('notice').hidden = true; }, 2600);
  }
  function barHeight() {
    return get('dock').hidden ? 0 : get('dock').getBoundingClientRect().height;
  }
  function updateBarSize() {
    const height = barHeight();
    host.dataset.barHeight = height;
    host.style.setProperty('--bar-height', `${height}px`);
    if (spacer) spacer.style.height = `${document.fullscreenElement ? 0 : height}px`;
    for (const placement of Object.values(placements)) placement.update();
  }
  function setView(next) {
    revision++;
    const opening = view === 'closed' && next !== 'closed';
    if (opening) { previousFocus = root.activeElement || document.activeElement; cancelCapture(); }
    view = next;
    host.dataset.view = next;
    document.dispatchEvent(new CustomEvent('vrwatch:scroll-target', { detail: next === 'tabs' ? get('picker') : next === 'positions' ? get('positions') : null }));
    if (next !== 'closed') (document.fullscreenElement ?? document.documentElement).append(host);
    get('trigger').hidden = next !== 'closed';
    get('trigger').setAttribute('aria-expanded', String(next !== 'closed'));
    get('shade').hidden = !['tabs', 'positions'].includes(next);
    get('dock').hidden = next === 'closed';
    get('picker').hidden = next !== 'tabs';
    get('positions').hidden = next !== 'positions';
    updateBarSize();
    get('error').textContent = '';
    if (next === 'closed') { unsubscribe?.(); unsubscribe = null; scheduleCapture(); }
    else if (!unsubscribe) unsubscribe = client.subscribe?.(() => { refresh().catch(showError); });
    if (next === 'dock') get('dismiss').focus({ preventScroll: true });
    else if (next === 'tabs') get('new').focus();
    else if (next === 'positions') get('position-video').focus();
    else { get('notice').hidden = true; (previousFocus?.isConnected && previousFocus.getRootNode() !== root && previousFocus !== document.body && previousFocus !== host ? previousFocus : get('trigger')).focus({ preventScroll: true }); }
  }
  function showError(error) {
    if (view === 'tabs') { get('error').textContent = error.message; get('summary').textContent = 'Could not load tabs'; }
    else notify(error.message);
  }
  async function drawPreview(canvas, source, valid) {
    if (!/^data:image\/(?:jpeg|png);base64,[A-Za-z0-9+/=]+$/.test(source)) return;
    try {
      const binary = atob(source.split(',')[1]);
      const bitmap = await createImageBitmap(new Blob([Uint8Array.from(binary, character => character.charCodeAt(0))]));
      try {
        if (!valid() || !canvas.isConnected) return;
        canvas.width = bitmap.width; canvas.height = bitmap.height;
        canvas.getContext('2d').drawImage(bitmap, 0, 0);
        canvas.hidden = false;
        canvas.nextElementSibling.hidden = true;
        return true;
      } finally { bitmap.close(); }
    } catch { /* Keep the honest fallback instead of a broken image. */ }
  }
  function renderTabs(tabs) {
    get('summary').textContent = `${tabs.length} open`;
    const focused = root.activeElement;
    reconcileCards(get('grid'), cards, tabs, () => {
      const article = document.createElement('article');
      article.innerHTML = `<button class="select-tab"><span class="preview"><canvas hidden aria-hidden="true"></canvas><span class="fallback">${icon('globe')}<span></span><small>Preview available after viewing</small></span></span><span class="caption"><span class="page-icon"></span><span class="caption-text"><span class="page-title"></span><span class="domain"></span></span><span class="current-label">Current</span></span></button><button class="close-tab">${icon('close')}</button>`;
      return article;
    }, (article, tab, previous) => {
      let domain;
      try { domain = tab.home ? 'VR bookmarks' : new URL(tab.url).hostname.replace(/^www\./, '') || tab.url; }
      catch { domain = 'New tab'; }
      const select = article.querySelector('.select-tab');
      const close = article.querySelector('.close-tab');
      article.className = 'card' + (tab.current ? ' current' : '');
      select.dataset.tab = close.dataset.close = tab.id;
      const title = tab.home ? 'VRWatch home' : tab.title;
      select.setAttribute('aria-label', `Open ${title}${tab.audible ? ', playing audio' : ''}${tab.loading ? ', loading' : ''}`);
      close.setAttribute('aria-label', `Close ${title}`);
      select.querySelector('.page-title').textContent = title;
      select.querySelector('.domain').textContent = domain;
      select.querySelector('.fallback>span').textContent = tab.home ? 'VRWatch' : domain;
      select.querySelector('.current-label').hidden = !tab.current;
      if (!previous || previous.url !== tab.url) {
        const mark = tab.home ? `<img src="${logo}" alt="">` : pageMark(tab.url);
        select.querySelector('.page-icon').innerHTML = mark;
        if (!mark) select.querySelector('.page-icon').textContent = (domain || 'W').charAt(0).toUpperCase();
      }
      if (!previous || previous.previewVersion !== tab.previewVersion || previous.url !== tab.url) {
        const canvas = select.querySelector('canvas');
        canvas.hidden = true; canvas.nextElementSibling.hidden = false;
        article.previewVersion = tab.previewVersion;
        if (tab.previewVersion != null) {
          const current = () => article.previewVersion === tab.previewVersion && cards.get(tab.id)?.node === article;
          const valid = () => current() && view === 'tabs' && browsing();
          client.request('preview', { tabId: tab.id, version: tab.previewVersion }).then(result => {
            if (result.image && valid()) return drawPreview(canvas, result.image, valid);
          }).catch(() => {}).finally(() => {
            // A hidden/XR HUD must not decode late images. Retry a skipped
            // preview when this card is next rendered after opening.
            if (current() && canvas.hidden) cards.get(tab.id).data = null;
          });
        }
      }
    });
    if (focused && !focused.isConnected) get('new').focus();
  }
  async function refresh() {
    if (refreshing) { refreshAgain = true; return; }
    refreshing = true;
    try {
      do {
        refreshAgain = false;
        const token = revision;
        const next = await client.request('state');
        if (token !== revision) { refreshAgain = view !== 'closed'; continue; }
        state = next;
        get('tabs').setAttribute('aria-label', `Tabs (${next.tabs.length} open)`);
        get('tabs').title = `Tabs (${next.tabs.length} open)`;
        get('bookmark').disabled = next.home || !/^https?:/.test(location.href);
        get('bookmark').setAttribute('aria-pressed', String(next.saved));
        get('bookmark').setAttribute('aria-label', next.saved ? 'Remove bookmark' : 'Bookmark');
        get('bookmark').title = next.saved ? 'Remove bookmark' : 'Bookmark';
        if (view === 'tabs') renderTabs(next.tabs);
      } while (refreshAgain);
    } finally { refreshing = false; }
  }
  function cancelCapture() {
    clearTimeout(captureTimer);
    client.request('cancelCapture').catch(() => {});
  }
  async function capture() {
    if (!browsing() || busy || capturing || view !== 'closed') return;
    capturing = true;
    try { await client.request('capture', { viewport: { width: innerWidth, top: barHeight() } }); }
    catch { /* Screenshot availability never prevents browsing. */ }
    finally { capturing = false; }
  }
  function scheduleCapture() {
    clearTimeout(captureTimer);
    captureTimer = setTimeout(capture, 1200);
  }
  async function perform(action, extra = {}) {
    if (busy) return;
    busy = true;
    try {
      const result = await client.request(action, extra);
      if (action === 'bookmark') { await refresh(); notify(result.saved ? 'Saved to VR bookmarks' : 'Bookmark removed'); }
      else if (action === 'close' && !result.closedCurrent && !result.navigated) await refresh();
      else setView('closed');
    } catch (error) { showError(error); }
    finally { busy = false; }
  }
  function toggleMenu() {
    if (busy) return;
    if (view !== 'closed') { setView('closed'); return; }
    setView('dock');
    refresh().catch(showError);
  }
  // Both logo buttons toggle the same bar without changing the current page.
  get('trigger').addEventListener('click', toggleMenu);
  const browsing = () => document.visibilityState === 'visible' && document.hasFocus()
    && document.getElementById('vrwatch-viewer')?.dataset.xrActive !== 'true';
  document.addEventListener('vrwatch:menu', () => {
    if (browsing()) toggleMenu();
  });
  const menuInput = createBrowserMenuInput(toggleMenu);
  const inputTimer = setInterval(() => {
    menuInput.update(navigator.getGamepads?.(), browsing());
  }, 50);
  window.addEventListener('pagehide', () => clearInterval(inputTimer));
  get('dismiss').addEventListener('click', () => setView('closed'));
  get('return').addEventListener('click', () => setView('dock'));
  get('shade').addEventListener('click', () => setView('dock'));
  get('back').addEventListener('click', () => perform('back'));
  get('forward').addEventListener('click', () => perform('forward'));
  get('reload').addEventListener('click', () => perform('reload'));
  get('layout').addEventListener('click', () => setView(view === 'positions' ? 'dock' : 'positions'));
  get('positions-close').addEventListener('click', () => setView('dock'));
  get('reset-positions').addEventListener('click', () => resetOverlayPositions().then(() => { get('position-status').textContent = 'Defaults restored'; }).catch(showError));
  get('home').addEventListener('click', () => perform('home'));
  get('bookmark').addEventListener('click', () => perform('bookmark'));
  get('tabs').addEventListener('click', () => { setView(view === 'tabs' ? 'dock' : 'tabs'); if (view === 'tabs' && state) renderTabs(state.tabs); refresh().catch(showError); });
  const address = get('address');
  function syncAddress() { if (root.activeElement !== address) address.value = home ? '' : location.href; }
  syncAddress();
  address.addEventListener('focus', () => address.select());
  get('address-form').addEventListener('submit', async event => {
    event.preventDefault();
    try {
      const url = address.value;
      await perform('navigate', { url });
    } catch (error) { showError(error); }
  });
  const addressTimer = setInterval(syncAddress, 1000);
  const barObserver = new ResizeObserver(updateBarSize);
  barObserver.observe(get('dock'));
  window.addEventListener('pagehide', () => { clearInterval(addressTimer); barObserver.disconnect(); });
  get('new').addEventListener('click', () => perform('create'));
  get('grid').addEventListener('click', event => {
    const select = event.target.closest('[data-tab]');
    const close = event.target.closest('[data-close]');
    if (select) perform('activate', { tabId: Number(select.dataset.tab) });
    else if (close) perform('close', { tabId: Number(close.dataset.close) });
  });
  document.addEventListener('keydown', event => {
    if (view === 'closed') return;
    if (event.key === 'Escape') { event.preventDefault(); event.stopImmediatePropagation(); setView(view === 'dock' ? 'closed' : 'dock'); }
    if (event.key === 'Tab' && view !== 'dock') {
      const container = view === 'dock' ? get('dock') : view === 'positions' ? get('positions') : get('picker');
      const buttons = [...container.querySelectorAll('button:not(:disabled),select:not(:disabled)')];
      const first = buttons[0], last = buttons.at(-1);
      if (event.shiftKey && root.activeElement === first) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && root.activeElement === last) { event.preventDefault(); first.focus(); }
    }
  }, true);
  document.addEventListener('fullscreenchange', () => {
    const focused = root.activeElement;
    (document.fullscreenElement ?? document.documentElement).append(host);
    updateBarSize();
    // The video's own badge also reparents on this event. Keep the open HUD
    // above it after every fullscreen listener has finished.
    queueMicrotask(() => {
      if (view === 'closed') return;
      (document.fullscreenElement ?? document.documentElement).append(host);
      (focused?.isConnected ? focused : get(view === 'dock' ? 'home' : view === 'positions' ? 'position-video' : 'new')).focus();
    });
  });
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible' && view !== 'closed') setView('closed');
  });
  window.addEventListener('resize', updateBarSize);
  window.addEventListener('pagehide', () => { clearTimeout(captureTimer); clearTimeout(noticeTimer); unsubscribe?.(); });
  window.addEventListener('popstate', scheduleCapture);
  document.addEventListener('yt-navigate-finish', scheduleCapture);
  const onBrowserEvent = message => { if (message?.type === 'vrwatch:capture-idle') scheduleCapture(); };
  globalThis.chrome?.runtime?.onMessage?.addListener(onBrowserEvent);
  window.addEventListener('scroll', () => { if (capturing) cancelCapture(); scheduleCapture(); }, { passive: true, capture: true });
  document.addEventListener('vrwatch:xr-state', () => { cancelCapture(); if (view !== 'closed') setView('closed'); });
  window.addEventListener('pagehide', () => { cancelCapture(); globalThis.chrome?.runtime?.onMessage?.removeListener(onBrowserEvent); });
  scheduleCapture();
  document.documentElement.append(host);
  if (home) setView('dock');
  refresh().catch(() => {});
}

const KEY = 'overlayPositions';
export const OVERLAYS = {
  video: ['VR video controls', 'top-right'],
  dock: ['Browser controls', 'bottom-center'],
  trigger: ['Menu button', 'bottom-right'],
  scroll: ['Scroll buttons', 'bottom-right'],
  picker: ['Tab picker', 'top-center'],
  layout: ['Popup positions', 'center'],
  notice: ['Notifications', 'bottom-center'],
};
export const POSITIONS = ['top-left', 'top-center', 'top-right', 'center', 'bottom-left', 'bottom-center', 'bottom-right'];
let positions = {};
let ready;
const listeners = new Set();
const broadcast = () => { for (const listener of listeners) listener(); };
export function readOverlayPositions() { return positions; }
export function watchOverlayPositions(listener) {
  listeners.add(listener);
  if (!ready) {
    const storage = globalThis.chrome?.storage;
    ready = (storage?.local ? storage.local.get(KEY).then(value => value[KEY]) :
      Promise.resolve().then(() => JSON.parse(localStorage.getItem('vrwatch.' + KEY) || '{}')))
      .then(value => { positions = cleanPositions(value); broadcast(); }).catch(() => {});
    storage?.onChanged?.addListener((changes, area) => {
      if (area === 'local' && changes[KEY]) { positions = cleanPositions(changes[KEY].newValue); broadcast(); }
    });
    globalThis.addEventListener?.('storage', event => {
      if (event.key === 'vrwatch.' + KEY) { try { positions = cleanPositions(JSON.parse(event.newValue)); broadcast(); } catch {} }
    });
  }
  return () => listeners.delete(listener);
}
export function cleanPositions(value) {
  const result = {};
  for (const id of Object.keys(OVERLAYS)) {
    const position = value?.[id];
    if (POSITIONS.includes(position)) result[id] = position;
    else if (position && Number.isFinite(position.x) && Number.isFinite(position.y)) {
      result[id] = { x: Math.max(0, Math.min(1, position.x)), y: Math.max(0, Math.min(1, position.y)) };
    }
  }
  return result;
}
export async function saveOverlayPosition(id, position) {
  await ready;
  const next = cleanPositions({ ...positions, [id]: position });
  // Save only this entry against the latest shared value, preserving other tabs' changes.
  if (globalThis.chrome?.storage?.local) {
    const current = (await chrome.storage.local.get(KEY))[KEY];
    positions = cleanPositions({ ...current, [id]: next[id] });
    await chrome.storage.local.set({ [KEY]: positions });
  } else { positions = next; localStorage.setItem('vrwatch.' + KEY, JSON.stringify(positions)); }
  broadcast();
}
export async function resetOverlayPositions() {
  await ready;
  positions = {};
  if (globalThis.chrome?.storage?.local) await chrome.storage.local.set({ [KEY]: positions });
  else localStorage.removeItem('vrwatch.' + KEY);
  broadcast();
}

export function overlayCoordinates(position, bounds, size, anchor = bounds) {
  const maxX = Math.max(bounds.left, bounds.right - size.width);
  const maxY = Math.max(bounds.top, bounds.bottom - size.height);
  let x, y;
  if (typeof position === 'object') {
    x = bounds.left + position.x * (maxX - bounds.left);
    y = bounds.top + position.y * (maxY - bounds.top);
  } else {
    x = position.endsWith('left') ? anchor.left : position.endsWith('right') ? anchor.right - size.width : (anchor.left + anchor.right - size.width) / 2;
    y = position.startsWith('top') ? anchor.top : position.startsWith('bottom') ? anchor.bottom - size.height : (anchor.top + anchor.bottom - size.height) / 2;
  }
  return { x: Math.max(bounds.left, Math.min(maxX, x)), y: Math.max(bounds.top, Math.min(maxY, y)) };
}

export const MOVE_HANDLE = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3v18M3 12h18M9 6l3-3 3 3M9 18l3 3 3-3M6 9l-3 3 3 3M18 9l3 3-3 3"/></svg>';
export const MOVE_STYLE = '.move-handle{display:grid;place-items:center;flex-shrink:0;min-width:36px;min-height:36px;padding:6px;border:0;border-radius:8px;background:transparent;color:#92959e;cursor:move;touch-action:none}.move-handle:hover{color:#a7dfd9;background:#ffffff08}.move-handle svg{width:22px;height:22px;fill:none;stroke:currentColor;stroke-width:1.7;stroke-linecap:round;stroke-linejoin:round}';

export function positionOverlay(id, element, { handle, anchor, bottom = 12, clickable = false } = {}) {
  const document = element.ownerDocument, view = document.defaultView;
  let drag;
  let suppressClick = false;
  const bounds = () => ({ left: 12, right: view.innerWidth - 12,
    top: Math.min(view.innerHeight - 12, Math.max(12, (Number(document.getElementById('vrwatch-hud')?.dataset.barHeight) || 0) + 12)),
    bottom: view.innerHeight - bottom });
  function place(point) {
    element.style.position = 'fixed'; element.style.right = 'auto'; element.style.bottom = 'auto';
    element.style.transform = 'none'; element.style.left = point.x + 'px'; element.style.top = point.y + 'px';
  }
  function update() {
    if (drag || !element.getClientRects().length) return;
    const area = bounds(), rect = element.getBoundingClientRect();
    place(overlayCoordinates(positions[id] ?? OVERLAYS[id][1], area, rect, anchor?.() ?? area));
  }
  async function persist(point) {
    const area = bounds(), rect = element.getBoundingClientRect();
    await saveOverlayPosition(id, {
      x: (point.x - area.left) / Math.max(1, area.right - area.left - rect.width),
      y: (point.y - area.top) / Math.max(1, area.bottom - area.top - rect.height),
    });
  }
  handle?.addEventListener('pointerdown', event => {
    if (event.button !== 0 || !event.isPrimary) return;
    const rect = element.getBoundingClientRect();
    drag = { id: event.pointerId, x: event.clientX, y: event.clientY, left: rect.left, top: rect.top };
    suppressClick = false;
    event.preventDefault(); event.stopPropagation();
  });
  document.addEventListener('pointermove', event => {
    if (!drag || (event.pointerId !== drag.id && !(event.pointerType === 'pen' && event.isPrimary && (event.buttons & 1)))) return;
    if (Math.hypot(event.clientX - drag.x, event.clientY - drag.y) < 8 && !suppressClick) return;
    suppressClick = true;
    const area = bounds(), rect = element.getBoundingClientRect();
    place({ x: Math.max(area.left, Math.min(Math.max(area.left, area.right - rect.width), drag.left + event.clientX - drag.x)),
      y: Math.max(area.top, Math.min(Math.max(area.top, area.bottom - rect.height), drag.top + event.clientY - drag.y)) });
    event.preventDefault(); event.stopPropagation();
  }, { capture: true, passive: false });
  document.addEventListener('pointerup', event => {
    if (!drag || event.pointerId !== drag.id) return;
    const rect = element.getBoundingClientRect(); drag = null;
    if (suppressClick) persist({ x: rect.left, y: rect.top }).catch(console.error);
    event.preventDefault(); event.stopPropagation();
  }, true);
  const cancel = () => { drag = null; update(); };
  document.addEventListener('pointercancel', cancel, true);
  view.addEventListener('blur', cancel);
  view.addEventListener('pagehide', cancel);
  handle?.addEventListener('click', event => {
    if (!clickable || suppressClick) { event.preventDefault(); event.stopImmediatePropagation(); }
    suppressClick = false;
  });
  handle?.addEventListener('keydown', event => {
    const delta = { ArrowLeft: [-20, 0], ArrowRight: [20, 0], ArrowUp: [0, -20], ArrowDown: [0, 20] }[event.key];
    if (!delta) return;
    event.preventDefault(); event.stopPropagation();
    const rect = element.getBoundingClientRect();
    persist({ x: rect.left + delta[0], y: rect.top + delta[1] }).catch(console.error);
  });
  const unwatch = watchOverlayPositions(update);
  const observer = new view.ResizeObserver(update); observer.observe(element);
  view.addEventListener('resize', update);
  document.addEventListener('fullscreenchange', update);
  view.addEventListener('pagehide', () => { unwatch(); observer.disconnect(); });
  update();
  return { update };
}

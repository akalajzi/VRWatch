// Steam's browser panel can deliver controller clicks without touch panning.
// Translate mouse drags and thumbsticks into scrolling without a floating widget.
import { createThumbstickScrollInput } from './browser-input.js';
let scrollMounted = false;
export function installDragScroll(document) {
  let drag = null;
  let suppressedClick = null;
  let holdTimer;
  const view = document.defaultView;
  const cancelHold = () => { view.clearTimeout(holdTimer); holdTimer = undefined; };
  const reset = () => { cancelHold(); drag = null; };
  const scrollable = element => element?.isConnected && element.clientHeight > 0
    && element.scrollHeight > element.clientHeight + 1
    && (element === document.scrollingElement || /^(auto|scroll)$/.test(view.getComputedStyle(element).overflowY));
  document.addEventListener('pointerdown', event => {
    reset();
    if (event.pointerType !== 'mouse' || event.button !== 0 || !event.isPrimary
      || event.ctrlKey || event.altKey || event.shiftKey || event.metaKey) return;
    const path = event.composedPath();
    if (path.some(element => element.id?.startsWith('vrwatch-') || element.matches?.(
      'button,input,textarea,select,video,canvas,[contenteditable]:not([contenteditable="false"]),[role="slider"],[role="spinbutton"],[draggable="true"]'
    ))) return;
    const scroller = path.find(scrollable) ?? (scrollable(document.scrollingElement) ? document.scrollingElement : null);
    drag = { id: event.pointerId, x: event.clientX, y: event.clientY, lastY: event.clientY, scroller, moved: false, menuOpened: false };
    // A stationary trigger hold uses the same input that Frame reliably sends
    // for clicking and dragging. Leave links and site actions alone.
    if (!path.some(element => element.matches?.('a,[role="button"],[role="link"]'))) {
      holdTimer = view.setTimeout(() => {
        if (!drag || drag.moved || document.visibilityState !== 'visible'
          || !document.hasFocus() || document.getElementById('vrwatch-viewer')?.dataset.xrActive === 'true') return;
        drag.menuOpened = true;
        document.dispatchEvent(new view.Event('vrwatch:menu'));
      }, 700);
    }
    // Prevent the mouse compatibility events that would start text selection.
    // A press/release without a drag still produces the ordinary click.
    event.preventDefault();
  }, { capture: true, passive: false });
  document.addEventListener('pointermove', event => {
    if (!drag) return;
    // Frame's laser emits mouse down/up (ID 1) but pen motion (ID 2).
    const frameMotion = event.pointerType === 'pen' && event.isPrimary && !!(event.buttons & 1);
    if (event.pointerId !== drag.id && !frameMotion) return;
    if (Math.hypot(event.clientX - drag.x, event.clientY - drag.y) >= 8) cancelHold();
    if (drag.menuOpened) { event.preventDefault(); event.stopPropagation(); return; }
    // Frame sends the press through its relative-pointer device, then motion
    // through a different pointer device whose buttons mask can be zero.
    // Use the down/up gesture lifecycle instead of that per-device mask.
    if (!drag.scroller) return;
    if (!drag.scroller.isConnected) { reset(); return; }
    if (!drag.moved) {
      const dy = Math.abs(event.clientY - drag.y);
      if (dy < 8 || dy < Math.abs(event.clientX - drag.x)) return;
      drag.moved = true;
      view.getSelection()?.removeAllRanges();
    }
    drag.scroller.scrollBy({ top: drag.lastY - event.clientY, behavior: 'instant' });
    drag.lastY = event.clientY;
    event.preventDefault();
    event.stopPropagation();
  }, { capture: true, passive: false });
  document.addEventListener('pointerup', event => {
    if (!drag || event.pointerId !== drag.id) return;
    if (drag.moved || drag.menuOpened) suppressedClick = { id: drag.id, until: view.performance.now() + 500 };
    reset();
  }, true);
  document.addEventListener('pointercancel', reset, true);
  document.addEventListener('click', event => {
    if (!suppressedClick || event.detail === 0 || ('pointerId' in event && event.pointerId !== suppressedClick.id)) return;
    if (view.performance.now() < suppressedClick.until) { event.preventDefault(); event.stopImmediatePropagation(); }
    suppressedClick = null;
  }, true);
  document.addEventListener('dragstart', event => { if (drag) event.preventDefault(); }, true);
  view.addEventListener('blur', () => { reset(); suppressedClick = null; });
  view.addEventListener('pagehide', () => { reset(); suppressedClick = null; });
  document.addEventListener('visibilitychange', () => { if (document.visibilityState !== 'visible') reset(); });
}

export function mountBrowserScroll() {
  if (window.top !== window || scrollMounted) return;
  scrollMounted = true;
  installDragScroll(document);
  let aimedScroller = null;
  let overlayScroller = null;
  document.addEventListener('vrwatch:scroll-target', event => { overlayScroller = event.detail; });
  const scrollable = element => element?.isConnected && element.scrollHeight > element.clientHeight + 1
    && element.clientHeight > 0 && /^(auto|scroll)$/.test(getComputedStyle(element).overflowY);
  // Remember an inner scrolling area when the controller points into it.
  // Moving to the toolbar must not replace the page scrolling target.
  const rememberScroller = event => {
    const path = event.composedPath();
    if (path.some(element => element.id?.startsWith('vrwatch-'))) return;
    aimedScroller = path.find(element => element !== document.scrollingElement && scrollable(element)) ?? null;
  };
  document.addEventListener('pointermove', rememberScroller, { passive: true });
  document.addEventListener('pointerdown', rememberScroller, { passive: true });
  function target() {
    if (overlayScroller?.isConnected) return overlayScroller;
    if (['tabs', 'positions'].includes(document.getElementById('vrwatch-hud')?.dataset.view)) return null;
    if (scrollable(aimedScroller) && aimedScroller.getBoundingClientRect().bottom > 0
      && aimedScroller.getBoundingClientRect().top < innerHeight) return aimedScroller;
    const page = document.scrollingElement;
    if (page && page.scrollHeight > page.clientHeight + 1) return page;
    // Some sites keep the document fixed and put their page in a scroll area.
    return [...document.querySelectorAll('body *')].filter(element => {
      if (!scrollable(element)) return false;
      const rect = element.getBoundingClientRect();
      return rect.width > 0 && rect.bottom > 0 && rect.top < innerHeight;
    }).sort((a, b) => b.clientWidth * b.clientHeight - a.clientWidth * a.clientHeight)[0];
  }
  const stick = createThumbstickScrollInput(top => target()?.scrollBy({ top, behavior: 'instant' }));
  let nativePads = [], nativeAt = -Infinity;
  document.addEventListener('vrwatch:thumbstick', event => {
    if (!Array.isArray(event.detail)) return;
    nativePads = event.detail; nativeAt = performance.now();
  });
  const inputTimer = setInterval(() => {
    const enabled = document.visibilityState === 'visible' && document.hasFocus()
      && document.getElementById('vrwatch-viewer')?.dataset.xrActive !== 'true';
    stick.update(performance.now() - nativeAt < 200 && nativePads.some(pad => pad.connected) ? nativePads : navigator.getGamepads?.(), enabled);
  }, 20);
  window.addEventListener('pagehide', () => clearInterval(inputTimer));
}

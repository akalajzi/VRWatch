import { test } from 'node:test';
import assert from 'node:assert/strict';
import { installDragScroll } from '../extension/src/browser-scroll.js';

function fixture() {
  const document = new EventTarget();
  const view = new EventTarget();
  let selectionClears = 0;
  let timer;
  Object.assign(view, { performance, getComputedStyle: () => ({ overflowY: 'auto' }),
    Event, setTimeout(callback) { timer = callback; return 1; }, clearTimeout() { timer = undefined; },
    getSelection: () => ({ removeAllRanges() { selectionClears++; } }) });
  const makeScroller = () => ({ isConnected: true, clientHeight: 200, scrollHeight: 2000, scrollTop: 0,
    scrollBy({ top }) { this.scrollTop = Math.min(1800, Math.max(0, this.scrollTop + top)); } });
  const page = makeScroller(), nested = makeScroller();
  Object.assign(document, { defaultView: view, scrollingElement: page, visibilityState: 'visible',
    hasFocus: () => true, getElementById: () => null });
  installDragScroll(document);
  function send(type, values = {}) {
    const event = new Event(type, { cancelable: true, bubbles: true });
    Object.assign(event, { pointerType: 'mouse', isPrimary: true, button: 0, buttons: 1, pointerId: 1,
      clientX: 100, clientY: 200, detail: 1, composedPath: () => [page], ...values });
    document.dispatchEvent(event);
    return event;
  }
  return { document, page, nested, view, send, hold: () => timer?.(), selectionClears: () => selectionClears };
}

test('stationary trigger hold opens once and suppresses release click, including on a short page', () => {
  const { document, page, send, hold } = fixture();
  page.scrollHeight = page.clientHeight;
  let menus = 0;
  document.addEventListener('vrwatch:menu', () => menus++);
  send('pointerdown');
  send('pointermove', { pointerType: 'pen', pointerId: 2, clientY: 197 });
  hold();
  assert.equal(menus, 1);
  send('pointerup', { buttons: 0 });
  assert.equal(send('click').defaultPrevented, true);
  hold();
  assert.equal(menus, 1);
});

test('dragging, horizontal movement, release, blur, links, and active XR cancel the menu hold', () => {
  const { document, page, view, send, hold } = fixture();
  let menus = 0;
  document.addEventListener('vrwatch:menu', () => menus++);
  for (const cancel of [
    () => send('pointermove', { pointerType: 'pen', pointerId: 2, clientY: 100 }),
    () => send('pointermove', { clientX: 150 }),
    () => send('pointerup', { buttons: 0 }),
    () => view.dispatchEvent(new Event('blur')),
    () => send('pointercancel'),
  ]) { send('pointerdown'); cancel(); hold(); }
  send('pointerdown', { composedPath: () => [{ matches: selector => selector.startsWith('a,') }, page] });
  hold();
  document.getElementById = () => ({ dataset: { xrActive: 'true' } });
  send('pointerdown'); hold(); send('pointerup');
  assert.equal(menus, 0);
});

test('controller mouse drags scroll instead of selecting text, and cannot activate a link on release', () => {
  const { page, send, selectionClears } = fixture();
  assert.equal(send('pointerdown').defaultPrevented, true);
  send('pointermove', { clientY: 197 });
  assert.equal(page.scrollTop, 0);
  send('pointermove', { clientY: 140 });
  assert.equal(page.scrollTop, 60);
  send('pointermove', { clientY: 100 });
  assert.equal(page.scrollTop, 100);
  assert.equal(selectionClears(), 1);
  send('pointerup', { clientY: 100, buttons: 0 });
  assert.equal(send('click').defaultPrevented, true);
  assert.equal(send('click').defaultPrevented, false);
});

test('Frame mouse press, pen motion, and mouse release form one drag gesture', () => {
  const { page, send } = fixture();
  send('pointerdown', { pointerType: 'mouse', pointerId: 1 });
  send('pointermove', { pointerType: 'pen', pointerId: 2, clientY: 120 });
  assert.equal(page.scrollTop, 80);
  send('pointermove', { pointerType: 'pen', pointerId: 3, isPrimary: false, clientY: 20 });
  assert.equal(page.scrollTop, 80);
  send('pointermove', { pointerType: 'pen', pointerId: 2, clientY: 100 });
  assert.equal(page.scrollTop, 100);
  send('pointerup', { pointerType: 'mouse', pointerId: 1, buttons: 0 });
  send('pointermove', { pointerType: 'pen', pointerId: 2, clientY: 20 });
  assert.equal(page.scrollTop, 100);
  assert.equal(send('click').defaultPrevented, true);
});

test('ordinary clicks, touch gestures, form controls, and VRWatch controls retain their behavior', () => {
  const { page, send } = fixture();
  send('pointerdown');
  send('pointerup', { buttons: 0 });
  assert.equal(send('click').defaultPrevented, false);
  assert.equal(send('pointerdown', { pointerType: 'touch' }).defaultPrevented, false);
  send('pointermove', { pointerType: 'touch', clientY: 100 });
  assert.equal(page.scrollTop, 0);
  for (const element of [{ matches: () => true }, { id: 'vrwatch-viewer' }]) {
    assert.equal(send('pointerdown', { composedPath: () => [element, page] }).defaultPrevented, false);
    send('pointermove', { clientY: 100 });
    assert.equal(page.scrollTop, 0);
  }
  assert.equal(send('pointerdown', { shiftKey: true }).defaultPrevented, false);
});

test('drags survive Frame pointer-device changes and cancel on release, cancellation, and browser blur', () => {
  const { page, nested, view, send } = fixture();
  send('pointerdown', { composedPath: () => [nested, page] });
  send('pointermove', { clientY: 100 });
  assert.equal(nested.scrollTop, 100);
  assert.equal(page.scrollTop, 0);
  send('pointermove', { clientY: 50, buttons: 0 });
  send('pointermove', { clientY: 0 });
  assert.equal(nested.scrollTop, 200);
  send('pointerup', { buttons: 0 });
  send('pointermove', { clientY: -50, buttons: 0 });
  assert.equal(nested.scrollTop, 200);
  send('pointerdown');
  send('pointercancel');
  send('pointermove', { clientY: 100 });
  assert.equal(page.scrollTop, 0);
  send('pointerdown');
  view.dispatchEvent(new Event('blur'));
  send('pointermove', { clientY: 100 });
  assert.equal(page.scrollTop, 0);
});

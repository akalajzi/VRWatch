import { test } from 'node:test';
import assert from 'node:assert/strict';
import { overlayCoordinates, cleanPositions } from '../extension/src/overlay-position.js';

test('saved positions stay inside the viewport on resize and expanded panels stay reachable', () => {
  const bounds = { left: 12, top: 88, right: 348, bottom: 788 };
  assert.deepEqual(overlayCoordinates({ x: 1, y: 1 }, bounds, { width: 100, height: 200 }), { x: 248, y: 588 });
  assert.deepEqual(overlayCoordinates('top-right', bounds, { width: 100, height: 200 }, { left: 0, top: -200, right: 900, bottom: 200 }), { x: 248, y: 88 });
  assert.deepEqual(overlayCoordinates({ x: 1, y: 1 }, bounds, { width: 500, height: 1000 }), { x: 12, y: 88 });
});

test('popup settings reject malformed data and clamp saved positions', () => {
  assert.deepEqual(cleanPositions({ video: { x: -1, y: 5 }, dock: 'top-left', scroll: { x: NaN, y: 1 }, picker: 'elsewhere', unknown: 'center' }),
    { video: { x: 0, y: 1 }, dock: 'top-left' });
  assert.deepEqual(cleanPositions(null), {});
});

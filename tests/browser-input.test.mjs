import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createBrowserMenuInput, createThumbstickScrollInput } from '../extension/src/browser-input.js';

const pad = (pressed, extra = {}) => ({ index: 0, mapping: 'standard', connected: true,
  buttons: [{ pressed: false }, { pressed }], ...extra });

test('standard gamepad B toggles the browser menu once per press', () => {
  let toggles = 0;
  const input = createBrowserMenuInput(() => toggles++);
  input.update([pad(false)]);
  for (let i = 0; i < 20; i++) input.update([pad(true)]);
  assert.equal(toggles, 1);
  input.update([pad(false)]);
  input.update([pad(true)]);
  assert.equal(toggles, 2);
});

test('browser B ignores XR input and held buttons while inactive, and recovers on reconnect', () => {
  let toggles = 0;
  const input = createBrowserMenuInput(() => toggles++);
  input.update([pad(true, { mapping: 'xr-standard' })]);
  input.update([pad(true)], false);
  input.update([pad(true)], true);
  assert.equal(toggles, 0);
  input.update([pad(false)]);
  input.update([pad(true)]);
  input.update([]);
  input.update([pad(true)]);
  assert.equal(toggles, 2);
});

test('thumbstick scrolling has a deadzone, continuous speed, and correct standard/XR axes', () => {
  let time = 0, distance = 0;
  const input = createThumbstickScrollInput(delta => distance += delta, { now: () => time });
  const standard = axis => pad(false, { axes: [0, axis, 0, 0] });
  input.update([standard(1)]);
  for (let n = 0; n < 50; n++) { time += 20; input.update([standard(1)]); }
  assert.ok(Math.abs(distance - 1100) < 0.001);
  time += 20; input.update([standard(0.19)]);
  assert.ok(Math.abs(distance - 1100) < 0.001);
  time += 100; input.update([pad(false, { mapping: 'xr-standard', axes: [0, 1, 0, -1] })]);
  assert.ok(Math.abs(distance - 990) < 0.001);
  time += 100; input.update([standard(1), standard(1)]);
  assert.ok(Math.abs(distance - 1100) < 0.001, 'two sticks must not double speed');
});

test('thumbstick scrolling stops when inactive/disconnected and never jumps after resuming', () => {
  let time = 0, distance = 0;
  const input = createThumbstickScrollInput(delta => distance += delta, { now: () => time });
  const stick = pad(false, { axes: [0, 1, 0, 0] });
  input.update([stick]);
  time += 50; input.update([stick], false);
  time += 10000; input.update([stick]);
  assert.equal(distance, 0);
  time += 20; input.update([{ ...stick, connected: false }]);
  time += 20; input.update([{ ...stick, mapping: '' }]);
  time += 20; input.update([{ ...stick, axes: [0, NaN, 0, Infinity] }]);
  assert.equal(distance, 0);
  time += 5000; input.update([stick]);
  assert.equal(distance, 110, 'long stalls cap the movement to 100ms');
});

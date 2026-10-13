import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { XRControls } from '../extension/src/xr-controls.js';
import { VRPlayer, PROJECTIONS } from '../extension/src/vr-player.js';
import { XR_PROJECTION_LABELS, PROJECTION_LABELS } from '../extension/src/projections.js';

function fixture(run, { open = true } = {}) {
  const originalDocument = globalThis.document, originalPath = globalThis.Path2D;
  globalThis.Path2D = class {};
  globalThis.document = { createElement: () => ({ getContext: () => new Proxy({}, { get: () => () => {} }) }) };
  const hands = [new THREE.Group(), new THREE.Group()];
  const camera = new THREE.PerspectiveCamera();
  const videoEvents = new EventTarget();
  const video = { duration: 100, currentTime: 50, volume: 0.3, muted: false, paused: true, seekable: { length: 0 },
    addEventListener: videoEvents.addEventListener.bind(videoEvents), removeEventListener: videoEvents.removeEventListener.bind(videoEvents),
    dispatchEvent: videoEvents.dispatchEvent.bind(videoEvents),
    pause() { this.paused = true; }, play() { this.paused = false; return Promise.resolve(); } };
  let recenters = 0;
  const player = { video, scene: new THREE.Scene(), renderer: { xr: { isPresenting: true, getController: i => hands[i], getCamera: () => camera } }, recenter() { recenters++; } };
  const controls = new XRControls(player);
  const sources = ['left', 'right'].map(handedness => ({ handedness, gamepad: {
    mapping: 'xr-standard', axes: [0, 0, 0, 0], buttons: Array.from({ length: 6 }, () => ({ pressed: false, touched: false, value: 0 })),
  } }));
  hands.forEach((hand, i) => hand.dispatchEvent({ type: 'connected', data: sources[i] }));
  if (open) controls.setPanelVisible(true);
  const pointAt = (hand, x, y) => {
    const { width, height } = controls.panel.geometry.parameters;
    hand.position.copy(controls.panel.localToWorld(new THREE.Vector3(width * (x / 1024 - 0.5), height * (0.5 - y / 164), 0)));
    hand.position.z = 0;
    player.scene.updateMatrixWorld(true);
  };
  try { run({ controls, hands, sources, camera, player, video, pointAt, recenters: () => recenters }); }
  finally { controls.dispose(); globalThis.document = originalDocument; globalThis.Path2D = originalPath; }
}

test('HUD uses the current head pose, stays visible to both eyes, and reduces disparity without shrinking targets', () => fixture(({ controls, camera, player }) => {
  // A stale union-camera transform must not determine the HUD's placement.
  camera.position.set(8, -4, 12);
  camera.rotation.y = -1;
  camera.updateMatrixWorld(true);
  const position = new THREE.Vector3(2, 1.6, 3);
  const orientation = new THREE.Quaternion().setFromEuler(new THREE.Euler(0.2, 0.7, -0.1, 'YXZ'));
  const referenceSpace = {};
  player.renderer.xr.getReferenceSpace = () => referenceSpace;
  player.renderer.xr.getFrame = () => ({ getViewerPose(space) {
    assert.equal(space, referenceSpace);
    return { transform: { position, orientation } };
  } });
  controls.recenter();
  player.scene.updateMatrixWorld(true);
  const offset = controls.panel.position.clone().sub(position).applyQuaternion(orientation.clone().invert());
  assert.ok(Math.abs(offset.x) < 1e-6, 'HUD must be centered between the eyes');
  assert.ok(Math.abs(offset.z + 2.5) < 1e-6);
  assert.ok(controls.panel.quaternion.angleTo(orientation) < 1e-6);
  const { width, height } = controls.panel.geometry.parameters;
  assert.ok(Math.abs(width / 2.5 - 1.72 / 1.7) < 1e-6, 'retain angular target width');
  assert.ok(Math.abs(height / width - 164 / 1024) < 1e-6);
  const eyes = [-0.032, 0.032].map((x, i) => {
    const eye = new THREE.PerspectiveCamera(90, 1, 0.1, 10);
    eye.position.copy(position).add(new THREE.Vector3(x, 0, 0).applyQuaternion(orientation));
    eye.quaternion.copy(orientation);
    eye.layers.enable(i + 1);
    eye.updateMatrixWorld(true);
    assert.ok(eye.layers.test(controls.panel.layers));
    for (const state of controls.controllers) assert.ok(eye.layers.test(state.cursor.layers));
    for (const corner of [[-1, -1], [-1, 1], [1, -1], [1, 1]]) {
      const projected = controls.panel.localToWorld(new THREE.Vector3(corner[0] * width / 2, corner[1] * height / 2, 0)).project(eye);
      assert.ok(Math.abs(projected.x) < 1 && Math.abs(projected.y) < 1 && Math.abs(projected.z) < 1,
        'entire HUD must fit in each eye frustum');
    }
    return eye;
  });
  const centers = eyes.map(eye => controls.panel.position.clone().project(eye));
  assert.ok(Math.abs(centers[0].x + centers[1].x) < 1e-6, 'equal and opposite eye offsets');
  const disparity = centers[0].x - centers[1].x;
  assert.ok(Math.abs(disparity - 0.064 / 2.5) < 1e-6);
  assert.ok(disparity < 0.064 / 1.7, 'less disparity than the old panel');
}));

test('opening controls removes competing video depth cues and closing restores each mesh visibility', () => fixture(({ controls, player, video }) => {
  player.meshes = [new THREE.Mesh(), new THREE.Mesh(), new THREE.Mesh()];
  player.meshes[0].layers.set(1);
  player.meshes[1].layers.set(2);
  player.meshes[2].visible = false;
  video.paused = false;
  controls.setPanelVisible(true);
  assert.equal(video.paused, true);
  assert.ok(player.meshes.every(mesh => !mesh.visible));
  controls.setPanelVisible(false);
  assert.equal(video.paused, false);
  assert.deepEqual(player.meshes.map(mesh => mesh.visible), [true, true, false]);
  assert.equal(controls.hiddenVideoMeshes.size, 0);
}, { open: false }));

test('video meshes replaced while controls are open stay hidden until close or XR teardown', () => fixture(({ controls, player }) => {
  const original = new THREE.Mesh();
  player.meshes = [original];
  controls.update(500);
  assert.equal(original.visible, false);
  const replacement = new THREE.Mesh();
  player.meshes = [replacement];
  controls.update(511);
  assert.equal(replacement.visible, false);
  controls.dispose();
  assert.equal(original.visible, true);
  assert.equal(replacement.visible, true);
  assert.equal(controls.hiddenVideoMeshes.size, 0);
}));

test('paused image shares the controls depth, refreshes after seeking, and avoids idle rendering', () => fixture(({ controls, player, video, camera }) => {
  let captures = 0;
  player.renderPausedPreview = (target, pose) => {
    captures++;
    assert.equal(target.width / target.height, 16 / 9);
    assert.ok(pose.position.distanceTo(camera.position) < 1e-6);
  };
  controls.update(500);
  assert.equal(captures, 1);
  assert.equal(controls.preview.layers.mask, controls.panel.layers.mask, 'shared image in both eyes');
  assert.equal(controls.preview.position.z, 0, 'image and controls use the same depth');
  for (let frame = 1; frame < 180; frame++) controls.update(500 + frame * 1000 / 90);
  assert.equal(captures, 1, 'paused frame requires no recurring GPU capture');
  video.seeking = true;
  video.dispatchEvent(new Event('seeked'));
  controls.update(2600);
  assert.equal(captures, 1, 'wait for the decoded frame');
  video.seeking = false;
  controls.update(2611);
  assert.equal(captures, 2);
  controls.setPanelVisible(false);
  assert.equal(controls.preview.visible, false);
  video.dispatchEvent(new Event('resize'));
  controls.update(2700);
  assert.equal(captures, 2, 'hidden HUD requires no capture');
  controls.setPanelVisible(true);
  controls.update(2711);
  assert.equal(captures, 3);
  let targetDisposals = 0;
  controls.previewTarget.addEventListener('dispose', () => { targetDisposals++; });
  controls.dispose();
  assert.equal(targetDisposals, 1);
  controls.previewDirty = false;
  video.dispatchEvent(new Event('seeked'));
  assert.equal(controls.previewDirty, false, 'remove video listeners on XR teardown');
}));

test('controller mode picker offers every projection, changes paused geometry and remembers the selection', () => fixture(({ controls, player, video, hands, pointAt }) => {
  assert.deepEqual(new Set(XR_PROJECTION_LABELS.map(([name]) => name)), new Set(PROJECTION_LABELS.map(([name]) => name)));
  assert.deepEqual(new Set(XR_PROJECTION_LABELS.map(([name]) => name)), new Set(Object.keys(PROJECTIONS)));
  const saved = [];
  player.material = new THREE.MeshBasicMaterial({ map: new THREE.Texture({ videoWidth: 1920, videoHeight: 1080 }) });
  player.meshes = []; player.viewYaw = 0; player.viewPosition = new THREE.Vector3();
  player.setProjection = VRPlayer.prototype.setProjection;
  player.disposeMeshes = VRPlayer.prototype.disposeMeshes;
  player.onProjectionChange = name => saved.push(name);
  try {
    for (const [name] of XR_PROJECTION_LABELS) {
      pointAt(hands[0], 832, 112);
      hands[0].dispatchEvent({ type: 'selectstart' });
      assert.equal(controls.modeOpen, true);
      assert.equal(controls.modePanel.layers.mask, controls.panel.layers.mask);
      const option = controls.modeButtons.find(button => button.value === name);
      pointAt(hands[0], option.x + option.w / 2, option.y + option.h / 2);
      hands[0].dispatchEvent({ type: 'selectstart' });
      assert.equal(player.projection, name);
      assert.equal(controls.modeOpen, false);
      assert.equal(controls.modePanel.visible, false);
      assert.ok(player.meshes.every(mesh => !mesh.visible));
      assert.equal(controls.previewDirty, true);
      assert.equal(video.paused, true);
      assert.equal(video.currentTime, 50);
      assert.equal(video.volume, 0.3);
    }
    assert.deepEqual(saved, XR_PROJECTION_LABELS.map(([name]) => name));
    controls.setPanelVisible(false);
    assert.ok(player.meshes.every(mesh => mesh.visible));
  } finally { player.disposeMeshes(); player.material.map.dispose(); player.material.dispose(); }
}));

test('mode picker has stable ray coordinates, excludes its cursor children, and Done keeps the current format', () => fixture(({ controls, hands, pointAt, player, video }) => {
  player.projection = '180_LR';
  controls.setModePickerVisible(true);
  const option = controls.modeButtons.find(button => button.value === '180_LR');
  const x = option.x + option.w / 2, y = option.y + option.h / 2;
  pointAt(hands[0], x, y);
  for (let frame = 0; frame < 180; frame++) {
    controls.update(500 + frame * 1000 / 90);
    assert.ok(Math.abs(controls.controllers[0].point.x - x) < 0.01);
    assert.ok(Math.abs(controls.controllers[0].point.y - y) < 0.01);
  }
  const done = controls.modeButtons.find(button => button.label === 'Done');
  pointAt(hands[0], done.x + done.w / 2, done.y + done.h / 2);
  hands[0].dispatchEvent({ type: 'selectstart' });
  assert.equal(controls.modeOpen, false);
  assert.equal(player.projection, '180_LR');
  assert.equal(video.paused, true);
  controls.setModePickerVisible(true);
  controls.setPanelVisible(false);
  assert.equal(controls.modeOpen, false);
  assert.equal(controls.modePanel.visible, false);
}));

test('right-hand B toggles once per press, ignoring touch, A, left-hand Y, and unmapped inputs', () => fixture(({ controls, sources }) => {
  controls.update(500);
  sources[0].gamepad.buttons[5].pressed = true;
  sources[1].gamepad.buttons[4].pressed = true;
  sources[1].gamepad.buttons[5].touched = true;
  controls.update(511);
  assert.equal(controls.panel.visible, true);
  sources[1].gamepad.mapping = '';
  sources[1].gamepad.buttons[5].pressed = true;
  controls.update(522);
  assert.equal(controls.panel.visible, true);
  sources[1].gamepad.mapping = 'xr-standard';
  controls.update(533);
  assert.equal(controls.panel.visible, false);
  for (let frame = 1; frame <= 90; frame++) controls.update(533 + frame * 1000 / 90);
  assert.equal(controls.panel.visible, false);
  sources[1].gamepad.buttons[5].pressed = false;
  controls.update(1533);
  assert.equal(controls.panel.visible, false);
  sources[1].gamepad.buttons[5].pressed = true;
  controls.update(1544);
  assert.equal(controls.panel.visible, true);
  sources[1].gamepad.mapping = '';
  controls.update(1555);
  assert.equal(controls.panel.visible, true);
}));

test('B cancels both slider gestures, recenters when showing, and resets on controller reconnect', () => fixture(({ controls, hands, sources, camera, video, pointAt }) => {
  pointAt(hands[0], 715, 38);
  pointAt(hands[1], 458, 112);
  controls.update(500);
  hands.forEach(hand => hand.dispatchEvent({ type: 'selectstart' }));
  assert.equal(controls.controllers[0].dragging, 'seek');
  assert.equal(controls.controllers[1].dragging, 'volume');
  const currentTime = video.currentTime, volume = video.volume;
  pointAt(hands[0], 850, 38);
  pointAt(hands[1], 640, 112);
  sources[1].gamepad.buttons[5].pressed = true;
  controls.update(1000);
  hands.forEach(hand => hand.dispatchEvent({ type: 'selectend' }));
  assert.equal(controls.panel.visible, false);
  assert.equal(video.currentTime, currentTime);
  assert.equal(video.volume, volume);
  assert.ok(controls.controllers.every(state => state.dragging === null && !state.cursor.visible && !state.line.visible));
  sources[1].gamepad.buttons[5].pressed = false;
  controls.update(1011);
  camera.position.set(2, 1, 3);
  camera.rotation.y = Math.PI / 2;
  camera.updateMatrixWorld(true);
  sources[1].gamepad.buttons[5].pressed = true;
  controls.update(1022);
  const expected = new THREE.Vector3(0, -0.38 * 2.5 / 1.7, -2.5).applyQuaternion(camera.quaternion).add(camera.position);
  assert.equal(controls.panel.visible, true);
  assert.ok(controls.panel.position.distanceTo(expected) < 0.00001);
  assert.ok(controls.panel.quaternion.angleTo(camera.quaternion) < 0.00001);
  hands[1].dispatchEvent({ type: 'disconnected' });
  controls.update(1033);
  hands[1].dispatchEvent({ type: 'connected', data: sources[1] });
  controls.update(1044);
  assert.equal(controls.panel.visible, false);
}));

test('stationary Mode aim stays stationary across frames and never changes volume', () => fixture(({ controls, hands, video, pointAt, recenters }) => {
  pointAt(hands[0], 832, 112);
  let toggles = 0;
  for (let frame = 0; frame < 180; frame++) {
    controls.update(500 + frame * 1000 / 90);
    assert.ok(Math.abs(controls.controllers[0].point.x - 832) < 0.01, `ray drifted on frame ${frame}`);
    assert.ok(Math.abs(controls.controllers[0].point.y - 112) < 0.01);
    if (frame % 18 === 0) {
      hands[0].dispatchEvent({ type: 'selectstart' });
      hands[0].dispatchEvent({ type: 'selectend' });
      toggles++;
      assert.equal(controls.modeOpen, toggles % 2 === 1);
      assert.equal(video.volume, 0.3);
      assert.equal(video.currentTime, 50);
    }
  }
  assert.equal(toggles, 10);
  assert.equal(recenters(), 0);
}));

test('both moving controller rays ignore both cursor meshes', () => fixture(({ controls, hands, pointAt }) => {
  for (let frame = 0; frame < 360; frame++) {
    const x = 110 + frame * 2;
    pointAt(hands[0], x, 38);
    pointAt(hands[1], x + 2, 38);
    controls.update(500 + frame * 1000 / 90);
    controls.controllers.forEach((state, i) => {
      assert.ok(Math.abs(state.point.x - x - i * 2) < 0.01, `hand ${i}, frame ${frame}`);
      assert.ok(Math.abs(state.point.y - 38) < 0.01);
    });
  }
}));

test('a Mode click cancels stale slider dragging', () => fixture(({ controls, hands, video, pointAt, recenters }) => {
  pointAt(hands[0], 458, 112);
  controls.update(500);
  hands[0].dispatchEvent({ type: 'selectstart' });
  assert.ok(Math.abs(video.volume - 0.3) < 0.001);
  // Start another action even if the previous input's release event was lost.
  pointAt(hands[0], 832, 112);
  hands[0].dispatchEvent({ type: 'selectstart' });
  controls.update(511);
  assert.equal(controls.modeOpen, true);
  assert.equal(recenters(), 0);
  assert.equal(controls.controllers[0].dragging, null);
  assert.ok(Math.abs(video.volume - 0.3) < 0.001);
}));

test('90 Hz timeline drag limits decoder seeks and release commits the latest pose', () => fixture(({ controls, hands, video, pointAt }) => {
  let value = 50;
  const seeks = [];
  Object.defineProperty(video, 'currentTime', { get: () => value, set: v => { value = v; seeks.push(v); }, configurable: true });
  pointAt(hands[0], 200, 38); controls.update(500);
  hands[0].dispatchEvent({ type: 'selectstart' });
  for (let frame = 1; frame <= 90; frame++) {
    pointAt(hands[0], 200 + frame * 5, 38);
    controls.update(500 + frame * 1000 / 90);
  }
  assert.ok(seeks.length <= 5, `Expected at most five seeks, got ${seeks.length}`);
  assert.ok(controls.controllers[0].seekPreview > value);
  pointAt(hands[0], 715, 38); // release between XR frames
  hands[0].dispatchEvent({ type: 'selectend' });
  assert.ok(Math.abs(value - 75) < 0.001);
  assert.equal(controls.controllers[0].seekPreview, null);
}));

test('stationary seek aim does not repeatedly reset decoding and canceled gestures do not commit', () => fixture(({ controls, hands, video, pointAt }) => {
  let value = 50, seeks = 0;
  Object.defineProperty(video, 'currentTime', { get: () => value, set: v => { value = v; seeks++; }, configurable: true });
  pointAt(hands[0], 715, 38); controls.update(500);
  hands[0].dispatchEvent({ type: 'selectstart' });
  for (let i = 1; i < 180; i++) controls.update(500 + i * 1000 / 90);
  assert.equal(seeks, 1);
  pointAt(hands[0], 850, 38); controls.update(2495);
  const beforeCancel = seeks;
  hands[0].dispatchEvent({ type: 'squeezestart' });
  hands[0].dispatchEvent({ type: 'selectend' });
  assert.equal(seeks, beforeCancel);
  assert.equal(controls.controllers[0].seekPreview, null);
}));

test('B and grip pause on open and resume on close without interrupting VR entry', () => fixture(({ controls, hands, sources, video }) => {
  video.paused = false;
  assert.equal(controls.panel.visible, false);
  controls.update(500);
  assert.equal(video.paused, false);
  sources[1].gamepad.buttons[5].pressed = true;
  controls.update(511);
  assert.equal(controls.panel.visible, true);
  assert.equal(video.paused, true);
  controls.update(522); // Holding B must not resume.
  assert.equal(video.paused, true);
  sources[1].gamepad.buttons[5].pressed = false;
  controls.update(533);
  sources[1].gamepad.buttons[5].pressed = true;
  controls.update(544);
  assert.equal(controls.panel.visible, false);
  assert.equal(video.paused, false);
  hands[0].dispatchEvent({ type: 'squeezestart' });
  assert.equal(video.paused, true);
  hands[0].dispatchEvent({ type: 'squeezestart' });
  assert.equal(video.paused, false);
  assert.equal(video.currentTime, 50);
  assert.equal(video.volume, 0.3);
}, { open: false }));

test('opening and closing the HUD preserves an already paused video, and Play closes it', () => fixture(({ controls, hands, video, pointAt }) => {
  controls.togglePanel();
  controls.togglePanel();
  assert.equal(video.paused, true);
  controls.togglePanel();
  pointAt(hands[0], 140, 112);
  hands[0].dispatchEvent({ type: 'selectstart' });
  assert.equal(video.paused, false);
  assert.equal(controls.panel.visible, false);
  assert.equal(controls.resumeOnClose, false);
}, { open: false }));

test('thumbstick reveal pauses before seeking and closing resumes from the chosen position', () => fixture(({ controls, sources, video }) => {
  video.paused = false;
  let time = 50;
  Object.defineProperty(video, 'currentTime', { get: () => time, set: value => {
    assert.equal(video.paused, true, 'seek must happen after the HUD pauses playback'); time = value;
  } });
  sources[0].gamepad.axes = [0, 0, 1, 0];
  controls.update(500);
  assert.equal(controls.panel.visible, true);
  assert.equal(video.paused, true);
  assert.equal(time, 60);
  controls.togglePanel();
  assert.equal(video.paused, false);
  assert.equal(time, 60);
}, { open: false }));

test('idle paused HUD avoids repeated texture uploads while hover and slider changes redraw', () => fixture(({ controls, hands, video, pointAt }) => {
  pointAt(hands[0], 400, 38);
  controls.update(500);
  const version = controls.texture.version;
  for (let frame = 1; frame <= 180; frame++) controls.update(500 + frame * 1000 / 90);
  assert.equal(controls.texture.version, version);
  pointAt(hands[0], 420, 38);
  controls.update(2511);
  assert.equal(controls.texture.version, version, 'cursor motion within a slider needs no upload');
  pointAt(hands[0], 140, 112);
  controls.update(2522);
  assert.ok(controls.texture.version > version, 'button hover redraws immediately');
  const hoverVersion = controls.texture.version;
  video.volume = 0.8;
  controls.update(2700);
  assert.ok(controls.texture.version > hoverVersion);
}));

test('XR teardown restores only playback paused by the HUD, once', () => fixture(({ controls, video }) => {
  video.paused = false;
  let plays = 0;
  video.play = () => { plays++; video.paused = false; return Promise.resolve(); };
  controls.togglePanel();
  assert.equal(video.paused, true);
  controls.dispose();
  assert.equal(video.paused, false);
  assert.equal(plays, 1);
  controls.resumePlayback();
  assert.equal(plays, 1);
}, { open: false }));

test('HUD never automatically resumes replacement, ended, or failed media', () => {
  for (const change of [video => { video.currentSrc = 'replacement.mp4'; }, video => { video.src = 'replacement.mp4'; }, video => { video.ended = true; }, video => { video.error = {}; }]) {
    fixture(({ controls, video }) => {
      video.paused = false;
      video.currentSrc = 'original.mp4';
      let plays = 0;
      video.play = () => { plays++; return Promise.resolve(); };
      controls.togglePanel();
      change(video);
      controls.togglePanel();
      controls.dispose();
      assert.equal(video.paused, true);
      assert.equal(plays, 0);
    }, { open: false });
  }
});

test('a rejected automatic resume clears ownership and leaves the video paused', async () => {
  fixture(({ controls, video }) => {
    video.paused = false;
    video.play = () => Promise.reject(new Error('Playback was blocked'));
    controls.togglePanel();
    controls.togglePanel();
    assert.equal(video.paused, true);
    assert.equal(controls.resumeOnClose, false);
  }, { open: false });
  await Promise.resolve();
});

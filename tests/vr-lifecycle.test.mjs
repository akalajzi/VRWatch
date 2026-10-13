import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { VRPlayer } from '../extension/src/vr-player.js';

function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

async function fixture(run) {
  const originalNavigator = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  const originalNative = globalThis.__vrwatchNative;
  const request = deferred(), attach = deferred();
  const session = new EventTarget();
  let ends = 0, attaches = 0, destroyed = 0, controlsDisposed = 0, loop = null;
  const native = [];
  session.end = async () => { ends++; session.dispatchEvent(new Event('end')); };
  const video = new EventTarget();
  const canvas = new EventTarget(); canvas.remove = () => {};
  const player = Object.create(VRPlayer.prototype);
  Object.assign(player, {
    video, meshes: [], scene: new THREE.Scene(),
    material: { map: { dispose() {} }, dispose() {} },
    renderer: { domElement: canvas, xr: { setSession() {
      assert.ok(player.xrControls, 'controller listeners must exist before XR attachment');
      attaches++; return attach.promise;
    } }, setAnimationLoop(fn) { loop = fn; }, dispose() { destroyed++; } },
    createXRControls: () => ({ dispose() { controlsDisposed++; } }),
    renderFrame() {},
  });
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { xr: { requestSession: () => request.promise } } });
  globalThis.__vrwatchNative = event => native.push(event);
  try {
    await run({ player, session, request, attach, native, stats: () => ({ ends, attaches, destroyed, controlsDisposed, loop }) });
  } finally {
    if (originalNavigator) Object.defineProperty(globalThis, 'navigator', originalNavigator);
    else delete globalThis.navigator;
    if (originalNative === undefined) delete globalThis.__vrwatchNative;
    else globalThis.__vrwatchNative = originalNative;
  }
}

test('navigation during requestSession ends the late session without attaching or rendering', () => fixture(async ({ player, session, request, stats }) => {
  const entering = player.enterVR();
  const rejected = assert.rejects(entering, { name: 'AbortError' });
  const disposal = player.dispose();
  assert.equal(player.dispose(), disposal);
  assert.equal(stats().destroyed, 0);
  request.resolve(session);
  await Promise.all([rejected, disposal]);
  assert.deepEqual(stats(), { ends: 1, attaches: 0, destroyed: 1, controlsDisposed: 0, loop: null });
}));

test('candidate XR restores the browser only after canvas and GPU teardown', () => fixture(async ({ player, session, request, attach, native, stats }) => {
  const events = [];
  player.nativeBridge = async active => { events.push(active); if (!active) assert.equal(stats().destroyed, 1); };
  const entering = player.enterVR(); request.resolve(session); attach.resolve(); await entering;
  assert.deepEqual(events, [true]);
  await session.end(); assert.deepEqual(events, [true]);
  await player.dispose(); assert.deepEqual(events, [true, false]);
  assert.deepEqual(native, []);
}));

test('session end during candidate bridge acknowledgement cannot leave startup active', () => fixture(async ({ player, session, request, attach, stats }) => {
  const acknowledgement = deferred(), events = [];
  player.nativeBridge = active => { events.push(active); return active ? acknowledgement.promise : Promise.resolve(); };
  const entering = player.enterVR(); const rejected = assert.rejects(entering, { name: 'AbortError' });
  request.resolve(session); attach.resolve();
  await new Promise(setImmediate);
  await session.end(); acknowledgement.resolve();
  await rejected; await player.dispose();
  assert.deepEqual(events, [true, false]); assert.equal(stats().destroyed, 1);
}));

test('navigation during renderer attachment waits before destroying GPU resources', () => fixture(async ({ player, session, request, attach, native, stats }) => {
  const entering = player.enterVR();
  const rejected = assert.rejects(entering, { name: 'AbortError' });
  request.resolve(session); await Promise.resolve();
  assert.equal(stats().attaches, 1);
  const disposal = player.dispose();
  assert.equal(stats().destroyed, 0);
  attach.resolve();
  await Promise.all([rejected, disposal]);
  assert.equal(stats().ends, 1); assert.equal(stats().destroyed, 1);
  assert.deepEqual(native, []);
}));

test('failed XR attachment releases the acquired session and can be disposed', () => fixture(async ({ player, session, request, attach, stats }) => {
  const entering = player.enterVR();
  const rejected = assert.rejects(entering, /GPU unavailable/);
  request.resolve(session); await Promise.resolve();
  attach.reject(new Error('GPU unavailable'));
  await rejected; await player.dispose();
  assert.equal(stats().ends, 1); assert.equal(stats().destroyed, 1);
}));

test('session end during startup never announces an active session', () => fixture(async ({ player, session, request, attach, native, stats }) => {
  const entering = player.enterVR();
  const rejected = assert.rejects(entering, { name: 'AbortError' });
  request.resolve(session); await Promise.resolve();
  await session.end(); attach.resolve();
  await rejected; await player.dispose();
  assert.equal(stats().ends, 1); assert.deepEqual(native, []);
}));

test('normal XR exit stops rendering, disposes controls once and restores the browser', () => fixture(async ({ player, session, request, attach, native, stats }) => {
  const entering = player.enterVR(); request.resolve(session); attach.resolve();
  await entering;
  assert.equal(stats().loop, player.renderFrame);
  await session.end(); await player.dispose();
  assert.deepEqual(native, ['xr-started', 'xr-ended']);
  assert.deepEqual(stats(), { ends: 1, attaches: 1, destroyed: 1, controlsDisposed: 1, loop: null });
}));

test('quality resize and projection changes preserve the recentered viewpoint', () => {
  const player = Object.create(VRPlayer.prototype);
  const video = { videoWidth: 1920, videoHeight: 1080 };
  const camera = new THREE.PerspectiveCamera();
  camera.position.set(1, 1.6, 2); camera.rotation.y = 0.7; camera.updateMatrixWorld(true);
  Object.assign(player, { video, meshes: [], scene: new THREE.Scene(), material: new THREE.MeshBasicMaterial({ map: new THREE.Texture(video) }),
    viewYaw: 0, viewPosition: new THREE.Vector3(), renderer: { xr: { getCamera: () => camera } } });
  player.setProjection('FLAT'); player.recenter();
  const position = player.meshes[0].position.clone(), yaw = player.meshes[0].rotation.y;
  video.videoWidth = 4096; video.videoHeight = 2048;
  player.setProjection(player.projection);
  assert.ok(player.meshes[0].position.distanceTo(position) < 0.00001);
  assert.equal(player.meshes[0].rotation.y, yaw);
  assert.equal(player.meshes[0].geometry.parameters.width, 4);
  player.setProjection('180_LR');
  assert.ok(player.meshes.every(mesh => mesh.rotation.y === yaw));
  player.disposeMeshes(); player.material.map.dispose(); player.material.dispose();
});

test('paused preview projects one video eye and restores XR/render-target state, even on failure', () => {
  for (const fail of [false, true]) {
    const texture = new THREE.Texture();
    const material = new THREE.MeshBasicMaterial({ map: texture });
    const left = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), material);
    const right = left.clone();
    left.layers.set(1); right.layers.set(2);
    left.visible = right.visible = false;
    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0x101010);
    const originalTarget = {}, target = { width: 1280, height: 720 };
    let activeTarget = originalTarget, renders = 0;
    const pose = { position: new THREE.Vector3(1, 1.6, 2), quaternion: new THREE.Quaternion() };
    const renderer = { xr: { enabled: true }, getRenderTarget: () => activeTarget, setRenderTarget: value => { activeTarget = value; },
      render(previewScene, camera) {
        renders++;
        assert.equal(this.xr.enabled, false);
        assert.equal(activeTarget, target);
        assert.equal(previewScene.background, scene.background);
        assert.equal(previewScene.children.length, 2);
        assert.ok(previewScene.children.every(mesh => mesh.visible));
        assert.ok(camera.layers.test(previewScene.children[0].layers));
        assert.equal(camera.layers.test(previewScene.children[1].layers), false);
        assert.ok(camera.position.distanceTo(pose.position) < 1e-6);
        if (fail) throw new Error('render failed');
      } };
    const player = Object.assign(Object.create(VRPlayer.prototype), { renderer, scene, meshes: [left, right], material,
      camera: new THREE.PerspectiveCamera(70, 1, 1, 2000) });
    if (fail) assert.throws(() => player.renderPausedPreview(target, pose), /render failed/);
    else player.renderPausedPreview(target, pose);
    assert.equal(renders, 1);
    assert.equal(renderer.xr.enabled, true);
    assert.equal(activeTarget, originalTarget);
    assert.equal(left.visible, false);
    assert.equal(right.visible, false);
    left.geometry.dispose(); material.dispose(); texture.dispose();
  }
});

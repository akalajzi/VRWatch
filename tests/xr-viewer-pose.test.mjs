import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { xrViewerPose } from '../extension/src/xr-viewer-pose.js';

test('outside an active XR frame, use the current eye midpoint rather than stale world or union transforms', () => {
  const orientation = new THREE.Quaternion().setFromEuler(new THREE.Euler(0.1, 0.8, 0));
  const center = new THREE.Vector3(2, 1.6, 3);
  const eyes = [-0.032, 0.032].map(x => {
    const eye = new THREE.PerspectiveCamera();
    eye.position.copy(center).add(new THREE.Vector3(x, 0, 0).applyQuaternion(orientation));
    eye.quaternion.copy(orientation);
    // Leave matrixWorld stale, just like before renderer.render().
    return eye;
  });
  const camera = new THREE.ArrayCamera(eyes);
  camera.position.set(10, 10, 10);
  camera.updateMatrixWorld(true);
  for (const expiredFrame of [false, true]) {
    const pose = xrViewerPose({ getCamera: () => camera, getReferenceSpace: () => ({}),
      getFrame: () => expiredFrame ? { getViewerPose() { throw new DOMException('Frame inactive', 'InvalidStateError'); } } : null });
    assert.ok(pose.position.distanceTo(center) < 1e-6);
    assert.ok(pose.quaternion.angleTo(orientation) < 1e-6);
  }
});

test('before XR tracking starts, desktop replay camera placement is retained', () => {
  const camera = new THREE.PerspectiveCamera();
  camera.position.set(1, 2, 3);
  camera.rotation.y = 0.7;
  const pose = xrViewerPose({ getCamera: () => camera });
  assert.ok(pose.position.distanceTo(camera.position) < 1e-6);
  assert.ok(pose.quaternion.angleTo(camera.quaternion) < 1e-6);
});

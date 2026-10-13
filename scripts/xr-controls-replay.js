// Bundle with esbuild and evaluate in the Frame's extension world through CDP.
// Uses real Canvas2D, WebGL, and production controls with deterministic poses;
// it doesn't require wearing the headset or change the active XR session.
import * as THREE from 'three';
import { XRControls } from '../extension/src/xr-controls.js';

globalThis.__vrwatchReplayControls = () => {
  const hands = [new THREE.Group(), new THREE.Group()];
  const camera = new THREE.PerspectiveCamera(70, 1024 / 430, 0.1, 10);
  const video = { duration: 100, currentTime: 50, volume: 0.3, muted: false, paused: true, seekable: { length: 0 } };
  let modeToggles = 0;
  const player = { video, scene: new THREE.Scene(), renderer: { xr: { isPresenting: true, getController: i => hands[i], getCamera: () => camera } }, recenter() {} };
  const renderer = new THREE.WebGLRenderer({ preserveDrawingBuffer: true });
  renderer.setSize(1024, 430);
  const controls = new XRControls(player);
  controls.setPanelVisible(true);
  hands.forEach(hand => hand.dispatchEvent({ type: 'connected', data: { gamepad: { axes: [0, 0, 0, 0] } } }));
  const pointAt = (hand, x, y) => {
    const { width, height } = controls.panel.geometry.parameters;
    hand.position.copy(controls.panel.localToWorld(new THREE.Vector3(width * (x / 1024 - 0.5), height * (0.5 - y / 164), 0)));
    hand.position.z = 0;
    player.scene.updateMatrixWorld(true);
  };
  const trace = [];
  let worstError = 0;
  try {
    pointAt(hands[0], 832, 112);
    hands[1].position.set(10, 10, 0);
    for (let frame = 0; frame < 180; frame++) {
      controls.update(500 + frame * 1000 / 90);
      const point = controls.controllers[0].point;
      worstError = Math.max(worstError, Math.hypot(point.x - 832, point.y - 112));
      if (frame < 10) trace.push({ frame, x: point.x, y: point.y });
      if (frame % 18 === 1) {
        hands[0].dispatchEvent({ type: 'selectstart' });
        modeToggles++;
      }
      if (frame % 18 === 2) hands[0].dispatchEvent({ type: 'selectend' });
      renderer.render(player.scene, camera);
    }
    const stationary = { worstError, modeToggles, volume: video.volume, trace };
    worstError = 0;
    for (let frame = 0; frame < 360; frame++) {
      const x = 110 + frame * 2;
      pointAt(hands[0], x, 38); pointAt(hands[1], x + 2, 38);
      controls.update(3000 + frame * 1000 / 90);
      controls.controllers.forEach((state, i) => {
        worstError = Math.max(worstError, Math.hypot(state.point.x - x - i * 2, state.point.y - 38));
      });
      renderer.render(player.scene, camera);
    }
    pointAt(hands[0], 832, 112);
    hands[1].position.set(10, 10, 0);
    controls.update(8000);
    renderer.render(player.scene, camera);
    const image = renderer.domElement.toDataURL('image/png');
    return { stationary, moving: { worstError, frames: 360, hands: 2 }, renderedFrames: 541,
      passed: stationary.worstError < 0.01 && stationary.modeToggles === 10 && stationary.volume === 0.3 && worstError < 0.01,
      image };
  } finally { controls.dispose(); renderer.dispose(); }
};

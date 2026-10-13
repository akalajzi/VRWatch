import * as THREE from 'three';

// The ArrayCamera returned by getCamera() is a culling camera, not the
// midpoint of the viewer's eyes. Its world transform can also be from the
// previous render when input handlers run. Prefer the current tracked pose.
export function xrViewerPose(xr) {
  const frame = xr.getFrame?.();
  const referenceSpace = xr.getReferenceSpace?.();
  let pose = null;
  if (frame && referenceSpace) {
    try { pose = frame.getViewerPose(referenceSpace); }
    catch (error) {
      // Select/squeeze events can run outside the animation-frame callback,
      // when the manager's last XRFrame is no longer active.
      if (error.name !== 'InvalidStateError') throw error;
    }
  }
  if (pose) {
    const { position, orientation } = pose.transform;
    return {
      position: new THREE.Vector3(position.x, position.y, position.z),
      quaternion: new THREE.Quaternion(orientation.x, orientation.y, orientation.z, orientation.w),
    };
  }
  const camera = xr.getCamera();
  if (camera.cameras?.length === 2) {
    // WebXRManager refreshes these local eye transforms before our animation
    // callback; matrixWorld and the union camera wait until renderer.render().
    const [left, right] = camera.cameras;
    return {
      position: left.position.clone().add(right.position).multiplyScalar(0.5),
      quaternion: left.quaternion.clone().slerp(right.quaternion, 0.5),
    };
  }
  // Before the first tracked frame (and in desktop geometry replays).
  return {
    position: camera.getWorldPosition(new THREE.Vector3()),
    quaternion: camera.getWorldQuaternion(new THREE.Quaternion()),
  };
}

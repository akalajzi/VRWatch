import * as THREE from 'three';
import { formatTime, seekBounds, seekTo, setVolume } from './media.js';
import { drawControlIcon } from './control-icons.js';
import { xrViewerPose } from './xr-viewer-pose.js';
import { XR_PROJECTION_LABELS } from './projections.js';

const W = 1024, H = 164;
// Reduce binocular disparity without shrinking controls in the viewer's field
// of view. Scale the panel, drop, and cursor together with viewing distance.
const PANEL_DISTANCE = 2.5;
const PANEL_SCALE = PANEL_DISTANCE / 1.7;
const PANEL_WIDTH = 1.72 * PANEL_SCALE;
const PANEL_HEIGHT = PANEL_WIDTH * H / W;
const PANEL_DROP = 0.38 * PANEL_SCALE;
const MODE_H = 304;
const MODE_GAP = 0.08;
const MODE_Y = -MODE_H - MODE_GAP * W / PANEL_WIDTH;
const SEEK = { x: 106, y: 16, w: 812, h: 44 };
const VOLUME = { x: 380, y: 80, w: 260, h: 64 };
const inside = (p, r) => p && p.x >= r.x && p.x <= r.x + r.w && p.y >= r.y && p.y <= r.y + r.h;

// Browser-independent controls rendered in the player's own XR scene.
export class XRControls {
  constructor(player) {
    this.player = player;
    this.video = player.video;
    this.raycaster = new THREE.Raycaster();
    this.rotation = new THREE.Matrix4();
    this.lastDraw = 0;
    this.pendingRecenter = true;
    this.hiddenVideoMeshes = new Map();
    this.invalidatePreview = () => { this.previewDirty = true; };
    for (const event of ['seeked', 'resize', 'loadeddata']) this.video.addEventListener?.(event, this.invalidatePreview);
    this.canvas = document.createElement('canvas');
    this.canvas.width = W;
    this.canvas.height = H;
    this.context = this.canvas.getContext('2d');
    this.texture = new THREE.CanvasTexture(this.canvas);
    this.texture.colorSpace = THREE.SRGBColorSpace;
    this.texture.minFilter = THREE.LinearFilter;
    this.texture.generateMipmaps = false;
    this.panel = new THREE.Mesh(new THREE.PlaneGeometry(PANEL_WIDTH, PANEL_HEIGHT), new THREE.MeshBasicMaterial({ map: this.texture, transparent: true, side: THREE.DoubleSide, depthTest: false, depthWrite: false }));
    this.panel.renderOrder = 100;
    // Enter VR without interrupting playback. Explicitly opening the HUD pauses it.
    this.panel.visible = false;
    player.scene.add(this.panel);
    this.buttons = [
      { x: 32, y: 80, w: 64, h: 64, icon: () => 'back', action: () => seekTo(this.video, this.video.currentTime - 10) },
      { x: 108, y: 80, w: 64, h: 64, icon: () => this.video.paused ? 'play' : 'pause', action: () => this.togglePlayback() },
      { x: 184, y: 80, w: 64, h: 64, icon: () => 'forward', action: () => seekTo(this.video, this.video.currentTime + 10) },
      { x: 300, y: 80, w: 64, h: 64, icon: () => this.video.muted ? 'muted' : 'volume', action: () => { this.video.muted = !this.video.muted; } },
      { x: 760, y: 80, w: 144, h: 64, label: 'Mode', icon: () => 'mode', action: () => this.setModePickerVisible(!this.modeOpen) },
      { x: 920, y: 80, w: 64, h: 64, icon: () => 'exit', action: () => player.renderer.xr.getSession()?.end() },
    ];
    this.controllers = [0, 1].map(index => {
      const object = player.renderer.xr.getController(index);
      const line = new THREE.Line(new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), new THREE.Vector3(0, 0, -3)]), new THREE.LineBasicMaterial({ color: 0xf4ba54, transparent: true, opacity: 0.65 }));
      object.add(line);
      player.scene.add(object);
      // The pointer moves at XR refresh rate, independently of the UI texture.
      const cursor = new THREE.Mesh(new THREE.CircleGeometry(0.010 * PANEL_SCALE, 20), new THREE.MeshBasicMaterial({ color: 0xf4f3ea, transparent: true, depthTest: false, depthWrite: false }));
      cursor.renderOrder = 101;
      cursor.visible = false;
      this.panel.add(cursor);
      const state = { object, line, cursor, point: null, dragging: null, source: null, bPressed: false, lastStick: 0, listeners: {} };
      state.listeners.connected = event => { state.source = event.data; state.bPressed = false; };
      state.listeners.disconnected = () => { state.source = null; state.bPressed = false; this.cancelDrag(state); state.cursor.visible = false; };
      state.listeners.selectstart = () => this.select(state);
      state.listeners.selectend = () => this.finishDrag(state);
      state.listeners.squeezestart = () => this.togglePanel();
      for (const [event, handler] of Object.entries(state.listeners)) object.addEventListener(event, handler);
      return state;
    });
    this.recenter();
    this.draw();
  }

  togglePanel() {
    this.setPanelVisible(!this.panel.visible);
  }

  setPanelVisible(visible, resume = true) {
    if (this.panel.visible === visible) return;
    this.panel.visible = visible;
    if (!visible) this.setModePickerVisible(false);
    this.updateBackdrop();
    for (const controller of this.controllers) this.cancelDrag(controller);
    if (visible) {
      this.resumeOnClose = !this.video.paused && !this.video.ended;
      this.pausedSource = { currentSrc: this.video.currentSrc, src: this.video.src };
      if (this.resumeOnClose) this.video.pause();
      this.recenter();
    } else {
      if (resume) this.resumePlayback();
      else this.resumeOnClose = false;
      for (const state of this.controllers) {
        state.point = null;
        state.cursor.visible = state.line.visible = false;
      }
    }
    this.lastDraw = 0;
  }

  updateBackdrop(visible = this.panel.visible) {
    // Replace the immersive stereo background with a shared image at the
    // controls' depth, preserving orientation without competing depth cues.
    if (visible) {
      for (const mesh of this.player.meshes ?? []) {
        if (!this.hiddenVideoMeshes.has(mesh)) this.hiddenVideoMeshes.set(mesh, mesh.visible);
        mesh.visible = false;
      }
    } else {
      for (const [mesh, wasVisible] of this.hiddenVideoMeshes) mesh.visible = wasVisible;
      this.hiddenVideoMeshes.clear();
    }
    if (this.preview) this.preview.visible = visible && !this.modeOpen;
  }

  updatePausedPreview() {
    if (!this.panel.visible || this.modeOpen || !this.player.renderPausedPreview) return;
    if (!this.preview) {
      this.previewTarget = new THREE.WebGLRenderTarget(1280, 720);
      this.previewTarget.texture.colorSpace = THREE.SRGBColorSpace;
      const height = PANEL_WIDTH * 9 / 16;
      this.preview = new THREE.Mesh(new THREE.PlaneGeometry(PANEL_WIDTH, height),
        new THREE.MeshBasicMaterial({ map: this.previewTarget.texture, side: THREE.DoubleSide, depthTest: false, depthWrite: false }));
      this.preview.position.set(0, PANEL_HEIGHT / 2 + height / 2 + 0.08, 0);
      this.preview.renderOrder = 99;
      this.panel.add(this.preview);
      this.previewDirty = true;
    }
    this.preview.visible = true;
    if (!this.previewDirty || this.video.seeking || this.video.readyState < 2) return;
    this.player.renderPausedPreview(this.previewTarget, this.previewPose);
    this.previewDirty = false;
  }

  setModePickerVisible(visible) {
    for (const state of this.controllers) this.cancelDrag(state);
    this.modeOpen = visible;
    if (visible && !this.modePanel) {
      this.modeCanvas = document.createElement('canvas');
      this.modeCanvas.width = W; this.modeCanvas.height = MODE_H;
      this.modeTexture = new THREE.CanvasTexture(this.modeCanvas);
      this.modeTexture.colorSpace = THREE.SRGBColorSpace;
      this.modeTexture.minFilter = THREE.LinearFilter;
      this.modeTexture.generateMipmaps = false;
      const height = PANEL_WIDTH * MODE_H / W;
      this.modePanel = new THREE.Mesh(new THREE.PlaneGeometry(PANEL_WIDTH, height),
        new THREE.MeshBasicMaterial({ map: this.modeTexture, transparent: true, side: THREE.DoubleSide, depthTest: false, depthWrite: false }));
      this.modePanel.position.set(0, PANEL_HEIGHT / 2 + height / 2 + MODE_GAP, 0);
      this.modePanel.renderOrder = 100;
      this.panel.add(this.modePanel);
      this.modeButtons = XR_PROJECTION_LABELS.map(([value, label], index) => ({
        value, label, x: 24 + index % 3 * 330, y: MODE_Y + 72 + Math.floor(index / 3) * 72, w: 316, h: 60,
        action: () => this.changeProjection(value),
      }));
      this.modeButtons.push({ label: 'Done', x: 888, y: MODE_Y + 16, w: 112, h: 40, action: () => this.setModePickerVisible(false) });
    }
    if (this.modePanel) this.modePanel.visible = visible;
    this.updateBackdrop();
    if (visible) this.drawModePicker();
    this.lastDraw = 0;
  }

  changeProjection(name) {
    this.player.setProjection(name);
    // A new cinema screen should face the current viewer, including when
    // switching from a panorama after looking in another direction.
    if (name === 'FLAT') this.player.recenter();
    this.player.onProjectionChange?.(name);
    this.previewDirty = true;
    this.updateBackdrop();
    this.setModePickerVisible(false);
  }

  drawModePicker() {
    const ctx = this.modeCanvas.getContext('2d');
    ctx.clearRect(0, 0, W, MODE_H);
    ctx.fillStyle = '#252624';
    ctx.beginPath(); ctx.roundRect(0, 0, W, MODE_H, 22); ctx.fill();
    ctx.strokeStyle = '#454640'; ctx.lineWidth = 2; ctx.stroke();
    ctx.textBaseline = 'middle'; ctx.textAlign = 'left'; ctx.font = '28px system-ui';
    ctx.fillStyle = '#f4f3ea'; ctx.fillText('Video mode', 24, 36);
    for (const button of this.modeButtons) {
      const selected = button.value != null && button.value === this.player.projection;
      const hover = this.controllers.some(state => inside(state.point, button));
      const y = button.y - MODE_Y;
      ctx.fillStyle = selected ? '#f4ba54' : hover ? '#3a3b35' : '#30312d';
      ctx.beginPath(); ctx.roundRect(button.x, y, button.w, button.h, 12); ctx.fill();
      ctx.fillStyle = selected ? '#252624' : '#f4f3ea';
      ctx.font = '24px system-ui'; ctx.textAlign = 'center';
      ctx.fillText(button.label, button.x + button.w / 2, y + button.h / 2);
    }
    this.modeTexture.needsUpdate = true;
  }

  resumePlayback() {
    const resume = this.resumeOnClose;
    this.resumeOnClose = false;
    // Never restart an ended/failed video or a replacement source on teardown.
    if (resume && this.video.paused && !this.video.ended && !this.video.error
        && this.pausedSource.currentSrc === this.video.currentSrc && this.pausedSource.src === this.video.src) {
      this.video.play().catch(() => {});
    }
  }

  togglePlayback() {
    this.resumeOnClose = false;
    if (this.video.paused) {
      // Play dismisses the HUD so its texture work cannot compete with playback.
      this.setPanelVisible(false, false);
      this.video.play().catch(() => {});
    } else this.video.pause();
  }

  recenter() {
    // Moving the panel ends slider gestures from its previous location.
    for (const state of this.controllers ?? []) this.cancelDrag(state);
    const { position, quaternion } = xrViewerPose(this.player.renderer.xr);
    this.previewPose = { position, quaternion };
    this.previewDirty = true;
    this.panel.position.copy(position).add(new THREE.Vector3(0, -PANEL_DROP, -PANEL_DISTANCE).applyQuaternion(quaternion));
    this.panel.quaternion.copy(quaternion);
  }

  pointer(state) {
    if (!this.panel.visible || !state.source) return null;
    this.rotation.extractRotation(state.object.matrixWorld);
    this.raycaster.ray.origin.setFromMatrixPosition(state.object.matrixWorld);
    this.raycaster.ray.direction.set(0, 0, -1).applyMatrix4(this.rotation);
    // Cursor meshes are children of the panel. Their own UVs must never be
    // interpreted as panel UVs, or the cursor feeds back into the next hit.
    const targets = this.modeOpen ? [this.panel, this.modePanel] : [this.panel];
    const hit = this.raycaster.intersectObjects(targets, false)[0];
    if (!hit?.uv) return null;
    const mode = hit.object === this.modePanel;
    return { x: hit.uv.x * W, y: (1 - hit.uv.y) * (mode ? MODE_H : H) + (mode ? MODE_Y : 0), distance: hit.distance };
  }

  select(state) {
    this.cancelDrag(state);
    this.player.scene.updateMatrixWorld(true);
    const point = this.pointer(state);
    const modeButton = this.modeOpen && this.modeButtons.find(button => inside(point, button));
    if (modeButton) modeButton.action();
    else if (inside(point, SEEK)) { state.dragging = 'seek'; this.adjust(state, point); }
    else if (inside(point, VOLUME)) { state.dragging = 'volume'; this.adjust(state, point); }
    else this.buttons.find(button => inside(point, button))?.action();
    this.lastDraw = 0;
  }

  cancelDrag(state) {
    state.dragging = null;
    state.seekPreview = null;
    state.lastSeekTarget = null;
    state.lastSeekAt = -Infinity;
  }

  finishDrag(state) {
    if (state.dragging === 'seek') {
      this.player.scene.updateMatrixWorld(true);
      this.adjust(state, this.pointer(state), performance.now(), true);
      // Release outside the panel commits the last visible preview.
      if (state.seekPreview != null && state.seekPreview !== state.lastSeekTarget) seekTo(this.video, state.seekPreview);
    }
    this.cancelDrag(state);
    this.lastDraw = 0;
  }

  adjust(state, point, time = this.frameTime ?? performance.now(), final = false) {
    if (!point) return;
    const clamp = value => Math.min(1, Math.max(0, value));
    if (state.dragging === 'seek') {
      const bounds = seekBounds(this.video);
      if (bounds) {
        const target = bounds.start + clamp((point.x - SEEK.x) / SEEK.w) * (bounds.end - bounds.start);
        state.seekPreview = target;
        // Four decoder seeks per second, with a small jitter deadband. The
        // pointer/preview still follows every XR frame; release is exact.
        if (final || (time - state.lastSeekAt >= 250 && (state.lastSeekTarget == null || Math.abs(target - state.lastSeekTarget) >= 0.25))) {
          if (target !== state.lastSeekTarget) seekTo(this.video, target);
          state.lastSeekAt = time;
          state.lastSeekTarget = target;
        }
      }
    } else if (state.dragging === 'volume') setVolume(this.video, clamp((point.x - VOLUME.x) / VOLUME.w));
  }

  update(time) {
    this.frameTime = time;
    if (this.pendingRecenter && this.player.renderer.xr.isPresenting) {
      this.recenter(); this.pendingRecenter = false;
    }
    // Touch-compatible xr-standard controllers expose right-hand B at index 5.
    // Poll before ray/drag updates and toggle only on the press edge.
    for (const state of this.controllers) {
      const source = state.source;
      const pressed = source?.handedness === 'right' && source.gamepad?.mapping === 'xr-standard'
        && !!source.gamepad.buttons?.[5]?.pressed;
      if (pressed && !state.bPressed) this.togglePanel();
      state.bPressed = pressed;
    }
    this.player.scene.updateMatrixWorld(true);
    for (const state of this.controllers) {
      state.line.visible = this.panel.visible && !!state.source;
      const point = state.point = this.pointer(state);
      state.cursor.visible = !!point;
      if (point) {
        state.cursor.position.set(PANEL_WIDTH * (point.x / W - 0.5), PANEL_HEIGHT * (0.5 - point.y / H), 0.002);
      }
      state.line.scale.z = point ? point.distance / 3 : 1;
      if (state.dragging) this.adjust(state, point, time);
      const axes = state.source?.gamepad?.axes ?? [];
      const offset = axes.length >= 4 ? 2 : 0;
      const x = axes[offset] ?? 0, y = axes[offset + 1] ?? 0;
      if (time - state.lastStick > 350 && (Math.abs(x) > 0.65 || Math.abs(y) > 0.65)) {
        this.setPanelVisible(true);
        if (Math.abs(x) >= Math.abs(y)) seekTo(this.video, this.video.currentTime + Math.sign(x) * 10);
        else setVolume(this.video, this.video.volume - Math.sign(y) * 0.05);
        state.lastStick = time;
      }
    }
    const hover = [...this.buttons, ...(this.modeOpen ? this.modeButtons : [])].map((button, index) => this.controllers.some(state => inside(state.point, button)) ? index : '').join(',');
    const hoverChanged = hover !== this.lastHover;
    this.lastHover = hover;
    if (this.panel.visible && (hoverChanged || this.lastDraw === 0 || time - this.lastDraw > 120)) {
      const drawState = this.drawState();
      if (drawState !== this.lastDrawState) {
        this.draw();
        if (this.modeOpen) this.drawModePicker();
        this.lastDrawState = drawState;
      }
      this.lastDraw = time;
    }
    // Quality changes and video recentering can replace meshes while paused.
    this.updateBackdrop();
    this.updatePausedPreview();
    this.updateDiagnostics(time);
  }

  updateDiagnostics(time) {
    if (!this.player.diagnostics) {
      if (this.diagnosticsPanel) this.diagnosticsPanel.visible = false;
      return;
    }
    if (!this.diagnosticsPanel) {
      this.diagnosticsCanvas = document.createElement('canvas');
      this.diagnosticsCanvas.width = 1024; this.diagnosticsCanvas.height = 192;
      this.diagnosticsTexture = new THREE.CanvasTexture(this.diagnosticsCanvas);
      this.diagnosticsTexture.colorSpace = THREE.SRGBColorSpace;
      this.diagnosticsTexture.minFilter = THREE.LinearFilter;
      this.diagnosticsTexture.generateMipmaps = false;
      this.diagnosticsPanel = new THREE.Mesh(new THREE.PlaneGeometry(PANEL_WIDTH, PANEL_WIDTH * 192 / 1024),
        new THREE.MeshBasicMaterial({ map: this.diagnosticsTexture, depthTest: false, side: THREE.DoubleSide }));
      this.diagnosticsPanel.position.set(0, 0.33 * PANEL_SCALE, 0);
      this.diagnosticsPanel.renderOrder = 100;
      this.panel.add(this.diagnosticsPanel);
    }
    const wasVisible = this.diagnosticsPanel.visible;
    this.diagnosticsPanel.visible = true;
    if (!this.panel.visible || (wasVisible && time - this.lastDiagnosticsDraw < 1000)) return;
    this.lastDiagnosticsDraw = time;
    const ctx = this.diagnosticsCanvas.getContext('2d');
    ctx.fillStyle = '#252624'; ctx.fillRect(0, 0, 1024, 192);
    ctx.fillStyle = '#f4f3ea'; ctx.font = '28px system-ui'; ctx.textBaseline = 'middle';
    this.player.diagnostics.lines().forEach((line, i) => ctx.fillText(line, 24, 30 + i * 44));
    this.diagnosticsTexture.needsUpdate = true;
  }

  drawState() {
    const preview = this.controllers.find(state => state.dragging === 'seek' && state.seekPreview != null)?.seekPreview ?? this.video.currentTime;
    const bounds = seekBounds(this.video);
    // Paused, untouched controls need no canvas redraw or GPU upload. Cursor
    // movement remains a separate mesh update at the headset's refresh rate.
    return [preview, this.video.duration, bounds?.start, bounds?.end,
      this.video.volume, this.video.muted, this.video.paused, this.modeOpen, this.player.projection,
      ...[SEEK, VOLUME, ...this.buttons].map(region => this.controllers.some(state => inside(state.point, region))),
      ...(this.modeOpen ? this.modeButtons.map(region => this.controllers.some(state => inside(state.point, region))) : []),
      ...this.controllers.map(state => state.dragging)].join('|');
  }

  draw() {
    const ctx = this.context;
    ctx.clearRect(0, 0, W, H);
    ctx.fillStyle = '#252624';
    ctx.beginPath(); ctx.roundRect(0, 0, W, H, 22); ctx.fill();
    ctx.strokeStyle = '#454640'; ctx.lineWidth = 2; ctx.stroke();
    ctx.textBaseline = 'middle';
    const preview = this.controllers.find(state => state.dragging === 'seek' && state.seekPreview != null)?.seekPreview ?? this.video.currentTime;
    ctx.fillStyle = '#f4f3ea'; ctx.font = '22px system-ui'; ctx.fillText(formatTime(preview), 24, 38);
    ctx.textAlign = 'right'; ctx.fillText(formatTime(this.video.duration), W - 24, 38); ctx.textAlign = 'left';
    const pointers = this.controllers.map(state => state.point);
    const drawSlider = (region, y, ratio) => {
      const active = this.controllers.some(state => state.dragging === (region === SEEK ? 'seek' : 'volume'));
      const hover = pointers.some(point => inside(point, region));
      ctx.fillStyle = '#454640';
      ctx.beginPath(); ctx.roundRect(region.x, y - 5, region.w, 10, 5); ctx.fill();
      if (ratio === null) return;
      ctx.fillStyle = '#f4ba54';
      ctx.beginPath(); ctx.roundRect(region.x, y - 5, region.w * ratio, 10, 5); ctx.fill();
      ctx.beginPath(); ctx.arc(region.x + region.w * ratio, y, 10, 0, Math.PI * 2); ctx.fill();
      if (hover || active) {
        ctx.strokeStyle = active ? '#f4f3ea' : '#f4ba54'; ctx.lineWidth = 2;
        ctx.beginPath(); ctx.arc(region.x + region.w * ratio, y, 13, 0, Math.PI * 2); ctx.stroke();
      }
    };
    const bounds = seekBounds(this.video);
    let seekRatio = null;
    if (bounds && bounds.end > bounds.start) {
      seekRatio = Math.min(1, Math.max(0, (preview - bounds.start) / (bounds.end - bounds.start)));
    }
    drawSlider(SEEK, 38, seekRatio);
    for (const button of this.buttons) {
      const icon = button.icon();
      const primary = icon === 'play' || icon === 'pause';
      const hover = pointers.some(point => inside(point, button));
      ctx.fillStyle = primary ? '#f4ba54' : hover ? '#3a3b35' : '#30312d';
      ctx.beginPath(); ctx.roundRect(button.x, button.y, button.w, button.h, 12); ctx.fill();
      if (hover || icon === 'muted') {
        ctx.strokeStyle = primary ? '#f4f3ea' : '#f4ba54'; ctx.lineWidth = 2;
        ctx.beginPath(); ctx.roundRect(button.x + 1, button.y + 1, button.w - 2, button.h - 2, 11); ctx.stroke();
      }
      ctx.fillStyle = primary ? '#252624' : icon === 'muted' ? '#f4ba54' : '#f4f3ea';
      if (button.label) {
        ctx.font = '24px system-ui'; ctx.textAlign = 'center';
        ctx.fillText(button.label, button.x + button.w / 2, button.y + button.h / 2);
        ctx.textAlign = 'left';
      } else drawControlIcon(ctx, icon, button.x + button.w / 2, button.y + button.h / 2);
    }
    const volume = this.video.muted ? 0 : this.video.volume;
    drawSlider(VOLUME, 112, volume);
    ctx.fillStyle = this.video.muted ? '#b9bbb4' : '#f4f3ea'; ctx.font = '22px system-ui'; ctx.fillText(`${Math.round(volume * 100)}%`, 664, 112);
    this.texture.needsUpdate = true;
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.updateBackdrop(false);
    for (const event of ['seeked', 'resize', 'loadeddata']) this.video.removeEventListener?.(event, this.invalidatePreview);
    this.preview?.geometry.dispose();
    this.preview?.material.dispose();
    this.previewTarget?.dispose();
    this.modePanel?.geometry.dispose();
    this.modePanel?.material.dispose();
    this.modeTexture?.dispose();
    this.resumePlayback();
    this.diagnosticsPanel?.geometry.dispose();
    this.diagnosticsPanel?.material.dispose();
    this.diagnosticsTexture?.dispose();
    for (const state of this.controllers) {
      for (const [event, handler] of Object.entries(state.listeners)) state.object.removeEventListener(event, handler);
      state.object.remove(state.line); this.player.scene.remove(state.object);
      state.line.geometry.dispose(); state.line.material.dispose();
      this.panel.remove(state.cursor); state.cursor.geometry.dispose(); state.cursor.material.dispose();
    }
    this.player.scene.remove(this.panel);
    this.panel.geometry.dispose(); this.panel.material.dispose(); this.texture.dispose();
  }
}

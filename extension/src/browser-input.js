// Optional desktop gamepad fallback; Frame's browser laser uses pointer events.
export function createBrowserMenuInput(toggle) {
  let held = new Map();
  return {
    update(gamepads, enabled = true) {
      const next = new Map();
      let activated = false;
      for (const pad of gamepads ?? []) {
        if (!pad || pad.mapping !== 'standard' || pad.connected === false) continue;
        const pressed = !!pad.buttons?.[1]?.pressed; // Standard gamepad B.
        next.set(pad.index, pressed);
        if (enabled && pressed && !held.get(pad.index) && !activated) {
          toggle();
          activated = true;
        }
      }
      held = next;
    },
  };
}

// Time-based velocity makes scrolling independent of polling frequency.
export function createThumbstickScrollInput(scroll, { now = () => performance.now(), speed = 1100, deadzone = 0.2 } = {}) {
  let previous;
  return {
    update(gamepads, enabled = true) {
      const time = now();
      const elapsed = previous == null ? 0 : Math.min(0.1, Math.max(0, (time - previous) / 1000));
      previous = enabled ? time : undefined;
      if (!enabled) return;
      let axis = 0;
      for (const pad of gamepads ?? []) {
        if (!pad || pad.connected === false || !['standard', 'xr-standard'].includes(pad.mapping)) continue;
        const indices = pad.mapping === 'xr-standard' ? [3] : [1, 3];
        for (const index of indices) {
          const value = pad.axes?.[index];
          if (Number.isFinite(value) && Math.abs(value) > Math.abs(axis)) axis = Math.max(-1, Math.min(1, value));
        }
      }
      if (Math.abs(axis) <= deadzone || !elapsed) return;
      scroll(Math.sign(axis) * (Math.abs(axis) - deadzone) / (1 - deadzone) * speed * elapsed);
    },
  };
}

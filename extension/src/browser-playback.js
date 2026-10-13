import { pornhubPlayer } from './pornhub.js';

function overrideStyle(element, values) {
  const previous = Object.keys(values).map(name => [name, element.style.getPropertyValue(name), element.style.getPropertyPriority(name)]);
  for (const [name, value] of Object.entries(values)) element.style.setProperty(name, value, 'important');
  return () => {
    for (const [name, value, priority] of previous) {
      if (value) element.style.setProperty(name, value, priority);
      else element.style.removeProperty(name);
    }
  };
}

// Keep the site's existing media element and stream. This is an explicit,
// reversible browser view for sites that hide their source behind a VR canvas.
export function showSourceInBrowser(video, anchor) {
  const canvas = anchor.querySelector('.mgp_vr-container');
  const controls = video.controls;
  const restoreVideo = overrideStyle(video, { display: 'block', position: 'absolute', width: '100%', height: '100%', 'object-fit': 'contain', 'z-index': '1' });
  const restoreCanvas = canvas ? overrideStyle(canvas, { display: 'none' }) : () => {};
  video.controls = true;
  return () => { restoreVideo(); restoreCanvas(); video.controls = controls; };
}

export function mountBrowserPlayback(shadow, document, getUrl, isIdle) {
  const button = document.createElement('button');
  button.className = 'focus';
  button.textContent = 'Play source in browser';
  button.hidden = true;
  shadow.querySelector('#options').append(button);
  let active = null;
  function restore() {
    active?.restore();
    active = null;
    button.textContent = 'Play source in browser';
  }
  function candidate() {
    const player = pornhubPlayer(document, getUrl());
    return player?.projection && player.projection !== 'FLAT' ? player : null;
  }
  button.addEventListener('click', async () => {
    if (!isIdle()) return;
    if (active) { restore(); return; }
    const player = candidate();
    if (!player || player.video.readyState < 2) return;
    const preview = active = { video: player.video, restore: showSourceInBrowser(player.video, player.anchor) };
    button.textContent = 'Use site player';
    try { await player.video.play(); }
    catch { if (active === preview) restore(); }
  });
  document.defaultView.addEventListener('pagehide', restore);
  return {
    update() {
      const player = candidate();
      if (active && active.video !== player?.video) restore();
      button.hidden = !player;
      button.disabled = !isIdle() || !player || player.video.readyState < 2;
    },
  };
}

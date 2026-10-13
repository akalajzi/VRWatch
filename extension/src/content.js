import { mountBookmarkCapture } from './bookmark-capture-content.js';
import { VRPlayer } from './vr-player.js';
import { mountNativeContent } from './native-content.js';
import { PROJECTION_LABELS } from './projections.js';
import { mountNavigation } from './navigation.js';
import { createReadabilityProbe } from './media-readability.js';
import { PlaybackDiagnostics } from './playback-diagnostics.js';
import { mountBrowserScroll } from './browser-scroll.js';
import { positionOverlay, MOVE_HANDLE, MOVE_STYLE } from './overlay-position.js';
import { chooseProjection, detectSiteProjection, projectionPreferenceKey } from './projection-detection.js';
import { createProjectionPreferences } from './projection-preferences.js';
import { findVideo } from './video-discovery.js';
import { mountBrowserPlayback } from './browser-playback.js';

if (!window.__vrwatch) {
  window.__vrwatch = true;
  mount();
}

function mount() {
  mountBookmarkCapture();
  mountNativeContent();
  mountBrowserScroll();
  mountNavigation();
  const host = document.createElement('div');
  host.id = 'vrwatch-viewer';
  host.style.cssText = 'position:fixed;z-index:2147483647;display:none;max-width:calc(100vw - 24px);';
  const shadow = host.attachShadow({ mode: 'closed' });
  shadow.innerHTML = `<style>
    :host{all:initial;color-scheme:dark;font:14px system-ui,sans-serif;color:#f4f3ea}
    *{box-sizing:border-box}button,select,input{font:inherit}button,select{cursor:pointer;touch-action:manipulation}
    .dock{width:max-content;max-width:calc(100vw - 24px);border:1px solid #454640;border-radius:12px;background:#252624;box-shadow:0 3px 12px #0003;padding:8px}
    .row{display:flex;align-items:center;gap:8px}.row>button{display:grid;place-items:center;flex:none;width:48px;height:48px;border:1px solid transparent;border-radius:8px;padding:0;background:#f4ba54;color:#252624}
    .row>button:hover:not(:disabled){border-color:#f4f3ea}.row>button:disabled{background:#30312d;color:#b9bbb4;cursor:default}.row>.more{background:#30312d;color:#f4f3ea;font-size:26px;line-height:1}
    .row>.move-handle{width:36px;background:transparent;color:#92959e}
    .row>.more:hover,.row>.more[aria-expanded=true]{border-color:#f4ba54}.row>button[aria-busy=true]{border-color:#f4ba54}.row svg{width:28px;height:28px}
    .status{width:248px;max-width:calc(100vw - 42px);font-size:11px;padding:8px 2px 0;color:#b9bbb4;line-height:1.5;overflow-wrap:anywhere}.status:empty{display:none}
    .options{width:248px;max-width:calc(100vw - 42px);padding-top:10px;display:none}.options.open{display:block}
    .sr-only{position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip-path:inset(50%);white-space:nowrap;border:0}
    select{width:100%;background:#30312d;border:1px solid #454640;border-radius:8px;color:#f4f3ea;padding:10px;margin-bottom:8px;min-height:44px}
    .focus{display:block;width:100%;padding:10px;border:1px solid #454640;border-radius:8px;background:#30312d;color:#f4f3ea;min-height:44px}.focus:hover,select:hover{border-color:#f4ba54}.focus[aria-pressed=true]{color:#f4ba54;border-color:#f4ba54}
    .focus[hidden]{display:none}.diagnostics{white-space:pre-wrap;font:12px/1.6 system-ui;width:280px;max-width:100%;margin:8px 0 0}.diagnostics-toggle{margin-top:8px}
    button:focus-visible,select:focus-visible{outline:3px solid #f4ba54;outline-offset:3px}
    ${MOVE_STYLE}
  </style><div class="dock"><div class="row"><button class="move-handle" id="move" aria-label="Move VR video controls" title="Drag to move; arrow keys also work">${MOVE_HANDLE}</button><button id="enter" aria-label="Checking VR availability" title="Checking VR availability" aria-busy="true" disabled><svg viewBox="0 0 32 32" aria-hidden="true" focusable="false"><path fill="currentColor" fill-rule="evenodd" d="M7 6h18a5 5 0 0 1 5 5v12a3 3 0 0 1-3 3h-7l-4-5-4 5H5a3 3 0 0 1-3-3V11a5 5 0 0 1 5-5Zm5 7a4 4 0 1 0 0 8 4 4 0 0 0 0-8Zm8 0a4 4 0 1 0 0 8 4 4 0 0 0 0-8Z"/></svg></button><button class="more" id="more" aria-label="Video format and focus controls" title="Video format and focus controls" aria-controls="options" aria-expanded="false">⋯</button></div><div class="status" id="status" role="status">Checking VR…</div><div class="options" id="options"><label class="sr-only" for="projection">Video format</label><select id="projection"></select><button class="focus" id="focus" aria-pressed="false">Focus view</button><button class="focus diagnostics-toggle" id="diagnostics-toggle" aria-pressed="false">Playback diagnostics</button><pre class="diagnostics" id="diagnostics" hidden></pre></div></div>`;
  document.documentElement.append(host);
  const enter = shadow.querySelector('#enter');
  const status = shadow.querySelector('#status');
  const projection = shadow.querySelector('#projection');
  const options = shadow.querySelector('#options');
  const autoFormat = document.createElement('button');
  autoFormat.className = 'focus';
  autoFormat.textContent = 'Detect format automatically';
  autoFormat.hidden = true;
  projection.after(autoFormat);
  function entryLabel(label, busy = false) {
    enter.setAttribute('aria-label', label);
    enter.title = label;
    enter.setAttribute('aria-busy', String(busy));
  }
  const canvas = document.createElement('canvas');
  const readability = createReadabilityProbe(canvas);
  let diagnostics = null;
  let diagnosticsEnabled = false;
  let diagnosticsDrawAt = -Infinity;
  const diagnosticsText = shadow.querySelector('#diagnostics');
  let attempt = 0;
  let cleanup = Promise.resolve();
  let failureMessage = '';
  let observedVideo = null;
  let xrSupported = false;
  let video = null;
  let videoAnchor = null;
  let player = null;
  let phase = 'idle';
  let selectedProjection = 'FLAT';
  let userPickedProjection = false;
  const projectionPreferences = createProjectionPreferences();
  let preferencesReady = false;
  let projectionKey = '';
  let metadataIdentity = '';
  let metadataRevision = 0;
  let fileProjection = null;
  let metadataPending = false;
  let updateTimer;
  let focused = false;
  let focusStyle = null;
  const browserPlayback = mountBrowserPlayback(shadow, document, () => location.href, () => phase === 'idle');

  const formats = [...PROJECTION_LABELS].sort((a, b) => (a[0] === 'FLAT' ? -1 : b[0] === 'FLAT' ? 1 : 0));
  for (const [value, label] of formats) {
    const option = document.createElement('option');
    option.value = value; option.textContent = label;
    projection.append(option);
  }
  projection.value = selectedProjection;
  projection.addEventListener('change', () => {
    selectedProjection = projection.value; userPickedProjection = true;
    projectionPreferences.save(projectionKey, selectedProjection).catch(console.error);
    player?.setProjection(selectedProjection);
    update();
  });
  projectionPreferences.load().finally(() => { preferencesReady = true; update(); });
  autoFormat.addEventListener('click', async () => {
    if (phase !== 'idle') return;
    userPickedProjection = false;
    try { await projectionPreferences.reset(projectionKey); } catch (error) { console.error(error); }
    update();
  });
  shadow.querySelector('#more').addEventListener('click', event => {
    const open = options.classList.toggle('open');
    event.currentTarget.setAttribute('aria-expanded', String(open));
    positionDock();
  });
  shadow.querySelector('#focus').addEventListener('click', event => {
    focused = !focused;
    event.currentTarget.setAttribute('aria-pressed', String(focused));
    if (focused && /(^|\.)youtube\.com$/.test(location.hostname)) {
      focusStyle = document.createElement('style');
      focusStyle.textContent = '#secondary, #comments, ytd-reel-shelf-renderer, ytd-rich-shelf-renderer[is-shorts] {display:none!important}';
      document.documentElement.append(focusStyle);
    } else {
      focusStyle?.remove(); focusStyle = null;
      if (focused) status.textContent = 'Focus view supports YouTube only.';
    }
  });

  async function checkXR() {
    try { xrSupported = !!(await navigator.xr?.isSessionSupported('immersive-vr')); }
    catch { xrSupported = false; }
    update();
  }
  checkXR();
  navigator.xr?.addEventListener('devicechange', checkXR);

  function sourceChanged() {
    readability.invalidate();
    failureMessage = '';
    update();
  }

  function observeVideo(candidate) {
    if (observedVideo === candidate) return;
    for (const name of ['loadeddata', 'emptied', 'encrypted']) observedVideo?.removeEventListener(name, sourceChanged);
    observedVideo = candidate;
    for (const name of ['loadeddata', 'emptied', 'encrypted']) observedVideo?.addEventListener(name, sourceChanged);
    readability.invalidate();
  }

  function refreshDiagnostics() {
    const candidate = diagnosticsEnabled ? (player?.video ?? video) : null;
    if (diagnostics?.video !== candidate) {
      diagnostics?.dispose();
      diagnostics = candidate ? new PlaybackDiagnostics(candidate) : null;
      diagnosticsDrawAt = -Infinity;
    }
    if (player) player.diagnostics = diagnostics;
    diagnosticsText.hidden = !diagnosticsEnabled;
    if (diagnosticsEnabled && performance.now() - diagnosticsDrawAt >= 1000) {
      const text = diagnostics ? diagnostics.lines().join('\n') : 'Start a video to measure playback.';
      if (diagnosticsText.textContent !== text) diagnosticsText.textContent = text;
      diagnosticsDrawAt = performance.now();
    }
  }
  shadow.querySelector('#diagnostics-toggle').addEventListener('click', event => {
    diagnosticsEnabled = !diagnosticsEnabled;
    event.currentTarget.setAttribute('aria-pressed', String(diagnosticsEnabled));
    refreshDiagnostics();
    positionDock();
  });

  const dockPosition = positionOverlay('video', host, {
    handle: shadow.querySelector('#move'),
    anchor: () => {
      const rect = videoAnchor?.getBoundingClientRect();
      return rect ? { left: rect.left + 12, right: rect.right - 12, top: rect.top + 12, bottom: rect.bottom - 80 } : undefined;
    },
  });
  function positionDock() { dockPosition.update(); }

  function update() {
    autoFormat.disabled = phase !== 'idle';
    if (phase !== 'idle') { browserPlayback.update(); refreshDiagnostics(); positionDock(); return; }
    const candidate = findVideo(document, location.href);
    const nextVideo = candidate?.video ?? null;
    videoAnchor = candidate?.anchor ?? null;
    if (nextVideo !== video) {
      video = nextVideo;
      observeVideo(video);
      failureMessage = '';
    }
    browserPlayback.update();
    refreshDiagnostics();
    if (!video) { host.style.display = 'none'; return; }
    host.style.display = 'block';
    const key = projectionPreferenceKey(location.href, video);
    if (key !== projectionKey) { projectionKey = key; userPickedProjection = false; }
    const siteProjection = detectSiteProjection(document, location.href, video);
    autoFormat.hidden = !userPickedProjection && !projectionPreferences.get(key);
    const identity = `${key}\n${video.currentSrc}`;
    if (identity !== metadataIdentity) {
      metadataIdentity = identity; metadataRevision++;
      fileProjection = null; metadataPending = false;
    }
    if (preferencesReady && !userPickedProjection && !projectionPreferences.get(key) && !siteProjection
        && !metadataPending && fileProjection === null && /^https?:/.test(video.currentSrc)) {
      const revision = metadataRevision;
      metadataPending = true;
      chrome.runtime.sendMessage({ type: 'vrwatch:projection', url: video.currentSrc }).then(reply => {
        if (revision === metadataRevision) fileProjection = reply?.projection || '';
      }).catch(() => { if (revision === metadataRevision) fileProjection = ''; }).finally(() => {
        if (revision === metadataRevision) { metadataPending = false; update(); }
      });
    }
    if (!userPickedProjection) {
      selectedProjection = chooseProjection({ saved: projectionPreferences.get(key), site: siteProjection,
        file: fileProjection, hostname: location.hostname });
      projection.value = selectedProjection;
    }
    const formatPending = !preferencesReady || (metadataPending && !userPickedProjection && !siteProjection && !projectionPreferences.get(key));
    const available = readability.check(video);
    enter.disabled = !xrSupported || available.state !== 'ready' || formatPending;
    entryLabel(enter.disabled ? 'VR unavailable' : selectedProjection === 'FLAT' ? 'Watch on VR screen' : 'Watch in VR');
    status.textContent = !xrSupported ? 'Headset unavailable. Check SteamVR.' : available.reason ?? (formatPending ? 'Checking video format…' : failureMessage);
    positionDock();
  }

  enter.addEventListener('click', event => {
    event.preventDefault(); event.stopPropagation();
    if (phase === 'active') { stop(); return; }
    if (phase !== 'idle' || !video) return;
    const check = readability.check(video);
    if (check.state !== 'ready') { status.textContent = check.reason; return; }
    const playingVideo = video;
    const currentAttempt = ++attempt;
    failureMessage = '';
    try {
      phase = 'starting'; host.dataset.xrActive = 'true'; enter.disabled = true; entryLabel('Entering VR', true); status.textContent = 'Entering VR…';
      const startingPlayer = player = new VRPlayer(playingVideo, selectedProjection, {
        onProjectionChange: name => {
          selectedProjection = name; projection.value = name; userPickedProjection = true;
          projectionPreferences.save(projectionKey, name).catch(console.error);
          update();
        },
        diagnostics,
        onFailure: message => { if (currentAttempt === attempt) stop(message); },
      });
      // Keep rendering independent of page fullscreen and avoid replacing the site's player.
      player.canvas.style.cssText = 'position:fixed;width:1px;height:1px;opacity:0;pointer-events:none;left:0;top:0';
      document.documentElement.append(player.canvas);
      // requestSession must run synchronously inside this actual page click.
      startingPlayer.enterVR().then(session => {
        if (currentAttempt !== attempt) return;
        phase = 'active'; enter.disabled = false; entryLabel('Leave VR');
        status.textContent = '';
        session.addEventListener('end', () => { if (currentAttempt === attempt) stop(); }, { once: true });
      }).catch(error => {
        if (currentAttempt === attempt) stop(`Could not enter VR: ${error.message}`);
      });
    } catch (error) { stop(error.message); }
  });

  function stop(message = '') {
    if (message) failureMessage = message;
    if (phase === 'stopping') return cleanup;
    const previous = player;
    const stoppingAttempt = ++attempt;
    player = null; phase = 'stopping';
    enter.disabled = true; entryLabel('Leaving VR', true);
    status.textContent = failureMessage || 'Leaving VR…';
    cleanup = (previous?.dispose() ?? Promise.resolve()).catch(error => {
      failureMessage = `Could not finish VR cleanup: ${error.message}`;
    }).then(() => {
      if (attempt !== stoppingAttempt) return;
      phase = 'idle';
      delete host.dataset.xrActive;
      update();
    });
    return cleanup;
  }
  chrome.runtime.onMessage.addListener((message, sender, respond) => {
    if (sender.id !== chrome.runtime.id || message?.type !== 'vrwatch:leave') return;
    stop().then(() => {
      for (const candidate of document.querySelectorAll('video')) candidate.pause();
      respond({ stopped: true });
    });
    return true;
  });
  document.addEventListener('yt-navigate-start', () => { readability.invalidate(); stop(); });
  window.addEventListener('pagehide', () => {
    if (player) player.diagnostics = null;
    stop();
    diagnosticsEnabled = false;
    diagnostics?.dispose(); diagnostics = null;
  });
  window.addEventListener('scroll', positionDock, { passive: true });
  window.addEventListener('resize', positionDock);
  document.addEventListener('fullscreenchange', () => {
    (document.fullscreenElement ?? document.documentElement).append(host);
    update();
  });
  new MutationObserver(() => {
    clearTimeout(updateTimer);
    updateTimer = setTimeout(update, 150);
  }).observe(document.documentElement, { childList: true, subtree: true });
  setInterval(() => {
    if (player && !player.video.isConnected) stop();
    else update();
  }, 1000);
  update();
}

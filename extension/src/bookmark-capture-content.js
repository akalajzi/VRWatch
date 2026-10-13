import { findVideo } from './video-discovery.js';

// Capture only the top document's main visible video. Never query unrelated
// iframe videos or follow a site's canonical URL to a different saved page.
export function relevantBookmarkVideo(doc, url) {
  const match = findVideo(doc, url);
  if (!match) return null;
  const link = match.anchor.closest?.('a[href]');
  if (link && new URL(link.href, url).href !== url) return null;
  const video = match.video;
  if (video.closest?.('[data-ad], [data-advertisement], .ad, .advertisement') || video.duration < 15) return null;
  // Avoid choosing one item from a multi-video feed without a main-player cue.
  if (doc.querySelectorAll('video').length > 1 && !match.anchor.closest?.('main, [role="main"], #player, #movie_player')) return null;
  return video;
}
export function mountBookmarkCapture() {
  if (window.top !== window || !globalThis.chrome?.runtime?.id) return;
  let restore = () => {};
  let timer;
  let activeToken;
  chrome.runtime.onMessage.addListener((message, sender, respond) => {
    if (sender.id !== chrome.runtime.id) return;
    if (message?.type === 'vrwatch:bookmark-restore') {
      if (message.token === activeToken) restore();
      respond({}); return;
    }
    if (message?.type !== 'vrwatch:bookmark-prepare') return;
    if (message.url !== location.href || document.visibilityState !== 'visible') { respond(null); return; }
    restore(); activeToken = message.token;
    const hidden = [...document.querySelectorAll('#vrwatch-hud, #vrwatch-viewer, #vrwatch-native-launcher')]
      .map(element => [element, element.style.getPropertyValue('visibility'), element.style.getPropertyPriority('visibility')]);
    for (const [element] of hidden) element.style.setProperty('visibility', 'hidden', 'important');
    restore = () => {
      clearTimeout(timer);
      for (const [element, value, priority] of hidden) {
        if (value) element.style.setProperty('visibility', value, priority); else element.style.removeProperty('visibility');
      }
    };
    timer = setTimeout(restore, 2500); // Worker termination must not hide controls permanently.
    (async () => {
      const video = relevantBookmarkVideo(document, location.href);
      let image = null;
      if (video && video.readyState >= 2 && video.videoWidth && !video.mediaKeys) {
        try {
          const canvas = document.createElement('canvas'); canvas.width = 480; canvas.height = 270;
          const context = canvas.getContext('2d');
          const scale = Math.min(480 / video.videoWidth, 270 / video.videoHeight);
          const width = video.videoWidth * scale, height = video.videoHeight * scale;
          context.fillStyle = '#1c1e23'; context.fillRect(0, 0, 480, 270);
          context.drawImage(video, (480 - width) / 2, (270 - height) / 2, width, height);
          image = canvas.toDataURL('image/jpeg', 0.72);
        } catch { /* Tainted or protected video can still have a poster. */ }
      }
      await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      respond({ url: location.href, video: !!video, image, poster: video?.poster || '' });
    })().catch(() => { restore(); respond(null); });
    return true;
  });
}

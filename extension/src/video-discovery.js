import { isPornhub, pornhubPlayer } from './pornhub.js';

function inView(rect, view) {
  return rect.width >= 160 && rect.height >= 90 && rect.bottom > 0 && rect.top < view.innerHeight
    && rect.right > 0 && rect.left < view.innerWidth;
}

export function findVideo(document, url) {
  const view = document.defaultView;
  if (isPornhub(url)) {
    // Pornhub's VR source is display:none; its visible player is a WebGL
    // canvas. Select the source and anchor controls to the player container.
    // A pending main video must never fall back to a playing banner advert.
    const player = pornhubPlayer(document, url);
    return player && inView(player.anchor.getBoundingClientRect(), view) ? player : null;
  }
  return [...document.querySelectorAll('video')].map(video => ({ video, anchor: video, rect: video.getBoundingClientRect() }))
    .filter(({ rect }) => inView(rect, view))
    .sort((a, b) => b.rect.width * b.rect.height - a.rect.width * a.rect.height)[0] ?? null;
}

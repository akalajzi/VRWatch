import { PROJECTION_LABELS } from './projections.js';
import { isPornhub, pornhubPlayer } from './pornhub.js';

const supported = new Set(PROJECTION_LABELS.map(([id]) => id));
const scripts = new WeakMap();

export function normalizeProjection(value) {
  const id = String(value || '').trim().toUpperCase();
  return id === 'SPHERE' ? '360' : id === 'NONE' ? 'FLAT' : supported.has(id) ? id : null;
}

// Read data declarations, never execute the website's JavaScript. These inline
// values are visible to the extension even in its isolated content-script world.
export function parseEpornerMetadata(text) {
  const value = (field, pattern) => [...text.matchAll(new RegExp(`(?:^|[;\\n])\\s*EP\\.video\\.player\\.${field}\\s*=\\s*${pattern}\\s*;`, 'g'))].at(-1);
  const enabled = value('VR', '(true|false)');
  const type = value('VRtype', `(['"])([A-Za-z0-9_]+)\\1`);
  const video = value('vid', `(['"])([A-Za-z0-9]+)\\1`);
  if (!enabled) return null;
  return { videoId: video?.[2] ?? null, projection: enabled[1] === 'false' ? 'FLAT' : normalizeProjection(type?.[2]) };
}

export function detectSiteProjection(document, url, video) {
  const location = new URL(url);
  const declared = normalizeProjection(video?.dataset?.projection);
  if (declared) return declared;
  if (isPornhub(url)) {
    const player = pornhubPlayer(document, url);
    return player?.video === video ? player.projection : null;
  }
  if (/(^|\.)eporner\.com$/.test(location.hostname)) {
    const id = location.pathname.match(/\/(?:video-|embed\/)([A-Za-z0-9]+)/)?.[1];
    for (const script of [...document.scripts].reverse()) {
      if (script.src) continue;
      const text = script.textContent;
      let entry = scripts.get(script);
      if (entry?.text !== text) {
        entry = { text, metadata: parseEpornerMetadata(text) };
        scripts.set(script, entry);
      }
      const metadata = entry.metadata;
      if (metadata && (!id || !metadata.videoId || id === metadata.videoId) && metadata.projection) return metadata.projection;
    }
  }
  if (/(^|\.)youtube\.com$/.test(location.hostname)) {
    const player = video?.closest?.('.html5-video-player') ?? document;
    if (player.querySelector('.ytp-webgl-spherical-control, .webgl')) return 'EAC';
  }
  return null;
}

export function projectionPreferenceKey(url, video) {
  const page = new URL(url);
  if (isPornhub(url)) {
    const key = page.searchParams.get('viewkey') ?? page.pathname.match(/^\/embed\/([A-Za-z0-9]+)/)?.[1];
    if (key) return `pornhub:${key}`;
  }
  if (/(^|\.)eporner\.com$/.test(page.hostname)) {
    const id = page.pathname.match(/\/(?:video-|embed\/)([A-Za-z0-9]+)/)?.[1];
    if (id) return `eporner:${id}`;
  }
  if (/(^|\.)youtube\.com$/.test(page.hostname)) {
    const id = page.searchParams.get('v') ?? page.pathname.match(/\/(?:shorts|embed)\/([^/]+)/)?.[1];
    if (id) return `youtube:${id}`;
  }
  page.hash = '';
  for (const key of [...page.searchParams.keys()]) {
    if (/^(utm_|fbclid$|gclid$|t$|start$)/.test(key)) page.searchParams.delete(key);
  }
  return `${page.href}${video?.id ? `#${video.id}` : ''}`;
}

export function chooseProjection({ manual, saved, site, file, hostname }) {
  return normalizeProjection(manual) ?? normalizeProjection(saved) ?? normalizeProjection(site)
    ?? normalizeProjection(file) ?? (/(^|\.)eporner\.com$/.test(hostname) ? '180_LR' : 'FLAT');
}

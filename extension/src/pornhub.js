const scripts = new WeakMap();

export function isPornhub(url) {
  try { return /(^|\.)pornhub\.com$/.test(new URL(url).hostname); }
  catch { return false; }
}

// VIDEO_SHOW is a JSON data declaration. Read it without running site code or
// importing player globals into the extension's isolated world.
export function parsePornhubMetadata(text) {
  const declaration = /(?:^|[;\n])\s*(?:var|let|const)\s+VIDEO_SHOW\s*=\s*(?=\{)/.exec(text);
  if (!declaration) return null;
  const start = declaration.index + declaration[0].length;
  let depth = 0, quoted = false, escaped = false;
  for (let index = start; index < Math.min(text.length, start + 256 * 1024); index++) {
    const char = text[index];
    if (quoted) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') quoted = false;
      continue;
    }
    if (char === '"') quoted = true;
    else if (char === '{') depth++;
    else if (char === '}' && --depth === 0) {
      try {
        const data = JSON.parse(text.slice(start, index + 1));
        if (!/^playerDiv_\d+$/.test(data.videoId) || typeof data.vkey !== 'string') return null;
        const vr = typeof data.vr === 'string' ? JSON.parse(data.vr || 'null') : data.vr;
        let projection = null;
        if (vr?.enabled === false) projection = 'FLAT';
        else if (vr?.enabled === true && [0, 1, 2, 3].includes(vr.projection)) {
          const degrees = vr.projection === 2 ? '360' : '180';
          if (vr.stereoSrc === false) projection = degrees;
          else if (vr.stereoSrc === true && [1, 3].includes(vr.stereoType)) projection = `${degrees}_LR`;
          else if (vr.stereoSrc === true && degrees === '360' && [2, 4].includes(vr.stereoType)) projection = '360_TB';
        }
        return { key: data.vkey, playerId: data.videoId, projection };
      } catch { return null; }
    }
  }
  return null;
}

export function pornhubMetadata(document, url) {
  if (!isPornhub(url)) return null;
  const page = new URL(url);
  const key = page.searchParams.get('viewkey') ?? page.pathname.match(/^\/embed\/([A-Za-z0-9]+)/)?.[1];
  for (const script of [...document.scripts].reverse()) {
    if (script.src) continue;
    const text = script.textContent;
    let entry = scripts.get(script);
    if (entry?.text !== text) {
      entry = { text, metadata: parsePornhubMetadata(text) };
      scripts.set(script, entry);
    }
    if (entry.metadata && key === entry.metadata.key) return entry.metadata;
  }
  return null;
}

export function pornhubPlayer(document, url) {
  const metadata = pornhubMetadata(document, url);
  const anchor = metadata ? document.getElementById(metadata.playerId)
    : document.querySelector('#player .mgp_container');
  const video = anchor?.querySelector('video.mgp_videoElement');
  return video ? { video, anchor, projection: metadata?.projection ?? null } : null;
}

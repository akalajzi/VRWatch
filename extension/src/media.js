export function normalizeUrl(input) {
  const text = input.trim();
  if (!text) throw new Error('Enter a website or video URL.');
  if (/\s/.test(text)) throw new Error('Paste a complete URL without spaces.');
  const url = new URL(/^[a-z][a-z\d+.-]*:/i.test(text) && !/^[^/]+:\d+(\/|$)/.test(text) ? text : `https://${text}`);
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('Use an http or https URL.');
  return url.href;
}

export function formatTime(seconds) {
  if (!Number.isFinite(seconds)) return 'LIVE';
  const value = Math.max(0, Math.floor(seconds));
  const hours = Math.floor(value / 3600);
  const minutes = Math.floor((value % 3600) / 60);
  const rest = String(value % 60).padStart(2, '0');
  return hours ? `${hours}:${String(minutes).padStart(2, '0')}:${rest}` : `${minutes}:${rest}`;
}

export function seekBounds(video) {
  const ranges = video.seekable;
  if (ranges?.length) return { start: ranges.start(0), end: ranges.end(ranges.length - 1) };
  if (Number.isFinite(video.duration) && video.duration > 0) return { start: 0, end: video.duration };
  return null;
}

export function seekTo(video, seconds) {
  const bounds = seekBounds(video);
  if (!bounds || !Number.isFinite(seconds)) return false;
  let target = Math.min(bounds.end, Math.max(bounds.start, seconds));
  const ranges = video.seekable;
  if (ranges?.length) {
    let nearest = bounds.start;
    let distance = Infinity;
    for (let i = 0; i < ranges.length; i++) {
      const candidate = Math.min(ranges.end(i), Math.max(ranges.start(i), target));
      if (Math.abs(candidate - target) < distance) {
        nearest = candidate;
        distance = Math.abs(candidate - target);
      }
    }
    target = nearest;
  }
  video.currentTime = target;
  return true;
}

export function setVolume(video, value) {
  if (!Number.isFinite(value)) return;
  video.volume = Math.min(1, Math.max(0, value));
  if (video.volume > 0) video.muted = false;
}

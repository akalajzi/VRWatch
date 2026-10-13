// MP4 Spatial Media v2: st3d (eye layout), sv3d/proj/equi (projection).
// Unsupported mesh/cubemap/eye layouts are deliberately left to the selector.
const LIMIT = 512 * 1024;
const containers = new Set(['moov', 'trak', 'mdia', 'minf', 'stbl', 'sv3d', 'proj']);
const videoEntries = new Set(['avc1', 'avc3', 'hvc1', 'hev1', 'av01', 'vp09', 'encv']);
const typeAt = (bytes, offset) => String.fromCharCode(...bytes.subarray(offset, offset + 4));

function boxAt(bytes, offset, total = bytes.length) {
  if (offset + 8 > bytes.length) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let size = view.getUint32(offset), header = 8;
  if (size === 1) {
    if (offset + 16 > bytes.length) return null;
    size = Number(view.getBigUint64(offset + 8)); header = 16;
  } else if (size === 0) size = total - offset;
  if (!Number.isSafeInteger(size) || size < header || offset + size > total) return null;
  return { type: typeAt(bytes, offset + 4), size, header, start: offset + header, end: offset + size };
}

export function parseMP4Projection(bytes) {
  if (!(bytes instanceof Uint8Array) || bytes.length > LIMIT) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let visited = 0;
  function scan(start, end, depth, metadata) {
    if (depth > 12) return null;
    for (let offset = start; offset + 8 <= end && ++visited < 4096;) {
      const box = boxAt(bytes, offset, end);
      if (!box) return null;
      if (videoEntries.has(box.type)) {
        const entry = {};
        scan(box.start + 78, box.end, depth + 1, entry);
        if (entry.sphere && [0, 1, 2].includes(entry.stereo ?? 0)) {
          if (entry.sphere === '180' && entry.stereo === 1) return null;
          return entry.sphere + (entry.stereo === 2 ? '_LR' : entry.stereo === 1 ? '_TB' : '');
        }
      } else if (box.type === 'st3d' && metadata && box.size >= box.header + 5 && bytes[box.start] === 0) {
        metadata.stereo = bytes[box.start + 4];
      } else if (box.type === 'equi' && metadata && box.size >= box.header + 20 && bytes[box.start] === 0) {
        const left = view.getUint32(box.start + 12), right = view.getUint32(box.start + 16);
        metadata.sphere = left >= 0x30000000 && right >= 0x30000000 ? '180' : '360';
      } else if (containers.has(box.type) || box.type === 'stsd') {
        const result = scan(box.start + (box.type === 'stsd' ? 8 : 0), box.end, depth + 1, metadata);
        if (result) return result;
      }
      offset = box.end;
    }
    return null;
  }
  try { return scan(0, bytes.length, 0, null); } catch { return null; }
}

async function readRange(fetcher, url, start, count, signal) {
  const response = await fetcher(url, { headers: { Range: `bytes=${start}-${start + count - 1}` }, signal, credentials: 'omit' });
  if (!response.ok || (start && response.status !== 206)) {
    await response.body?.cancel(); return null;
  }
  const range = response.headers.get('Content-Range')?.match(/^bytes (\d+)-(\d+)\/(\d+)$/);
  if (response.status === 206 && (!range || Number(range[1]) !== start)) {
    await response.body?.cancel(); return null;
  }
  const total = range ? Number(range[3]) : Number(response.headers.get('Content-Length')) || null;
  const reader = response.body?.getReader();
  if (!reader) return null;
  const bytes = new Uint8Array(count);
  let length = 0;
  try {
    while (length < count) {
      const { value, done } = await reader.read();
      if (done) break;
      const size = Math.min(value.length, count - length);
      bytes.set(value.subarray(0, size), length); length += size;
    }
  } finally { await reader.cancel(); }
  return { bytes: bytes.subarray(0, length), total, ranged: response.status === 206 };
}

export async function readMP4Projection(url, fetcher = fetch) {
  const parsed = new URL(url);
  if (!['http:', 'https:'].includes(parsed.protocol)) return null;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 2500);
  try {
    const first = await readRange(fetcher, url, 0, 16384, controller.signal);
    if (!first || typeAt(first.bytes, 4) !== 'ftyp') return null;
    let offset = 0, downloaded = first.bytes.length;
    for (let index = 0; index < 32 && downloaded < LIMIT; index++) {
      const inFirst = offset + 16 <= first.bytes.length;
      const chunk = inFirst ? { bytes: first.bytes.subarray(offset) } :
        first.ranged ? await readRange(fetcher, url, offset, 16, controller.signal) : null;
      if (!chunk) return null;
      if (!inFirst) downloaded += chunk.bytes.length;
      const box = boxAt(chunk.bytes, 0, first.total ? first.total - offset : Number.MAX_SAFE_INTEGER);
      if (!box) return null;
      if (box.type === 'moov') {
        if (box.size > LIMIT - downloaded) return null;
        if (box.size <= chunk.bytes.length) return parseMP4Projection(chunk.bytes.subarray(0, box.size));
        if (!first.ranged) return null;
        const moov = await readRange(fetcher, url, offset, box.size, controller.signal);
        return moov ? parseMP4Projection(moov.bytes) : null;
      }
      offset += box.size;
      if (first.total && offset >= first.total) break;
    }
  } catch { /* Unavailable metadata never prevents playback. */ }
  finally { clearTimeout(timeout); }
  return null;
}

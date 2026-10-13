import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseMP4Projection, readMP4Projection } from '../extension/src/spatial-metadata.js';

const concat = (...parts) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let offset = 0; for (const p of parts) { out.set(p, offset); offset += p.length; } return out;
};
const box = (type, ...parts) => {
  const content = concat(...parts), out = new Uint8Array(content.length + 8);
  new DataView(out.buffer).setUint32(0, out.length); out.set(new TextEncoder().encode(type), 4); out.set(content, 8); return out;
};
function movie(stereo = 2, crop = 0x40000000) {
  const equi = new Uint8Array(20), view = new DataView(equi.buffer);
  view.setUint32(12, crop); view.setUint32(16, crop);
  const entry = box('avc1', new Uint8Array(78), box('st3d', Uint8Array.of(0, 0, 0, 0, stereo)), box('sv3d', box('proj', box('equi', equi))));
  const stsd = box('stsd', Uint8Array.of(0, 0, 0, 0, 0, 0, 0, 1), entry);
  return box('moov', box('trak', box('mdia', box('minf', box('stbl', stsd)))));
}
const ftyp = box('ftyp', new TextEncoder().encode('isom'), new Uint8Array(4));

test('MP4 spatial metadata distinguishes stereo layout and 180/360 projection', () => {
  assert.equal(parseMP4Projection(movie()), '180_LR');
  assert.equal(parseMP4Projection(movie(0)), '180');
  assert.equal(parseMP4Projection(movie(0, 0)), '360');
  assert.equal(parseMP4Projection(movie(1, 0)), '360_TB');
  assert.equal(parseMP4Projection(movie(2, 0)), '360_LR');
  assert.equal(parseMP4Projection(movie(3)), null);
  assert.equal(parseMP4Projection(movie(4)), null);
  assert.equal(parseMP4Projection(movie(1)), null); // No matching renderer for 180 top/bottom.
});

test('malformed, truncated, absent and overly large metadata cannot produce a format', () => {
  assert.equal(parseMP4Projection(ftyp), null);
  assert.equal(parseMP4Projection(movie().slice(0, -1)), null);
  assert.equal(parseMP4Projection(Uint8Array.of(255, 255, 255, 255, 109, 111, 111, 118)), null);
  assert.equal(parseMP4Projection(new Uint8Array(1024 * 1024)), null);
  assert.equal(parseMP4Projection(box('moov', box('mdat', new TextEncoder().encode('st3d sv3d equi')))), null);
});

test('range reader skips the media payload to reach a moov atom at the end', async () => {
  const file = concat(ftyp, box('mdat', new Uint8Array(2 * 1024 * 1024)), movie(1, 0));
  const requests = [];
  const fetcher = async (url, options) => {
    const [, start, end] = options.headers.Range.match(/bytes=(\d+)-(\d+)/).map(Number);
    requests.push([start, end]);
    const last = Math.min(end, file.length - 1);
    return new Response(file.slice(start, last + 1), { status: 206, headers: { 'Content-Range': `bytes ${start}-${last}/${file.length}` } });
  };
  assert.equal(await readMP4Projection('https://example.com/video.mp4', fetcher), '360_TB');
  assert.ok(requests.some(([start]) => start > 2 * 1024 * 1024));
  assert.ok(requests.reduce((n, [start, end]) => n + end - start + 1, 0) < 20000);
});

test('ignored ranges, unavailable sources, incorrect range offsets and non-MP4 streams fall back', async () => {
  const fastStart = concat(ftyp, movie());
  assert.equal(await readMP4Projection('https://example.com/video.mp4', async () => new Response(fastStart)), '180_LR');
  assert.equal(await readMP4Projection('https://example.com/video.mp4', async () => new Response('unavailable', { status: 403 })), null);
  assert.equal(await readMP4Projection('https://example.com/video.m3u8', async () => new Response('#EXTM3U')), null);
  assert.equal(await readMP4Projection('https://example.com/video.mp4', async () => new Response(fastStart, { status: 206, headers: { 'Content-Range': 'bytes 1-100/101' } })), null);
  assert.equal(await readMP4Projection('blob:https://example.com/video', () => { throw new Error('Must not fetch blobs'); }), null);
});

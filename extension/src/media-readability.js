// A probe belongs to one discovery loop. Never let a CORS failure poison the
// next source's canvas, and avoid synchronous GPU readback on every DOM update.
export function createReadabilityProbe(canvas) {
  const context = canvas.getContext('2d', { willReadFrequently: true });
  let cached;
  return {
    invalidate() { cached = null; },
    check(video) {
      if (video.mediaKeys) return { state: 'blocked', reason: 'Protected video is unavailable in VR.' };
      if (video.readyState < 2 || !video.videoWidth) return { state: 'pending', reason: 'Start playback to check VR.' };
      const source = video.currentSrc;
      if (cached?.video === video && cached.source === source && cached.stream === video.srcObject) return cached.result;
      // Resetting the bitmap also resets its origin-clean flag.
      canvas.width = canvas.height = 1;
      let result;
      try {
        if (!context) throw new Error('Canvas unavailable');
        context.drawImage(video, 0, 0, 1, 1);
        context.getImageData(0, 0, 1, 1);
        result = { state: 'ready' };
      } catch (error) {
        result = { state: 'blocked', reason: error.name === 'SecurityError'
          ? 'This site blocks VR access to this video.' : 'Could not check video. Start playback to retry.' };
        // Transient decode/readback errors must be retried.
        if (error.name !== 'SecurityError') return result;
      }
      cached = { video, source, stream: video.srcObject, result };
      return result;
    },
  };
}

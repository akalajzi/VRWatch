export function bufferAhead(video) {
  const ranges = video.buffered;
  for (let i = 0; i < (ranges?.length ?? 0); i++) {
    if (ranges.start(i) <= video.currentTime && video.currentTime <= ranges.end(i)) {
      return ranges.end(i) - video.currentTime;
    }
  }
  return 0;
}

// Local, opt-in measurements; no URLs, credentials, network requests or telemetry.
export class PlaybackDiagnostics {
  constructor(video, now = () => performance.now()) {
    this.video = video;
    this.now = now;
    this.listeners = {};
    this.reset();
    const on = (name, handler) => {
      this.listeners[name] = handler;
      video.addEventListener(name, handler);
    };
    on('waiting', () => this.beginBuffering());
    on('stalled', () => { this.stalls++; });
    for (const name of ['playing', 'pause', 'ended', 'seeking', 'error']) on(name, () => this.endBuffering());
    on('seeked', () => { if (video.readyState < 3) this.beginBuffering(); });
    on('emptied', () => this.reset());
    if (video.readyState < 3) this.beginBuffering();
  }

  reset() {
    this.bufferingSince = null;
    this.bufferingMs = 0;
    this.bufferingCount = 0;
    this.stalls = 0;
    this.xrIntervals = [];
    this.lastXR = null;
    this.sampleAt = this.now();
    this.baseline = this.video.getVideoPlaybackQuality?.() ?? null;
    this.previousQuality = this.baseline;
    this.videoFPS = null;
  }

  beginBuffering() {
    if (this.video.paused || this.video.ended || this.video.seeking || this.bufferingSince !== null) return;
    this.bufferingSince = this.now();
    this.bufferingCount++;
  }

  endBuffering() {
    if (this.bufferingSince !== null) this.bufferingMs += this.now() - this.bufferingSince;
    this.bufferingSince = null;
  }

  resetXR() { this.lastXR = null; this.xrIntervals = []; }

  xrFrame(time) {
    if (this.lastXR !== null && time > this.lastXR) {
      this.xrIntervals.push(time - this.lastXR);
      if (this.xrIntervals.length > 180) this.xrIntervals.shift();
    }
    this.lastXR = time;
  }

  snapshot() {
    const now = this.now(), video = this.video;
    const quality = video.getVideoPlaybackQuality?.() ?? null;
    if (quality && now - this.sampleAt >= 1000) {
      const previous = this.previousQuality;
      const frames = previous ? quality.totalVideoFrames - previous.totalVideoFrames : 0;
      const dropped = previous ? quality.droppedVideoFrames - previous.droppedVideoFrames : 0;
      this.videoFPS = frames >= 0 && dropped >= 0 ? Math.max(0, frames - dropped) * 1000 / (now - this.sampleAt) : null;
      this.previousQuality = quality;
      this.sampleAt = now;
      if (frames < 0 || dropped < 0) this.baseline = quality;
    }
    const intervals = [...this.xrIntervals].sort((a, b) => a - b);
    return {
      state: video.error ? 'Error' : video.ended ? 'Ended' : video.seeking ? 'Seeking' : video.paused ? 'Paused' : this.bufferingSince !== null ? 'Buffering' : 'Playing',
      width: video.videoWidth, height: video.videoHeight,
      bufferSeconds: bufferAhead(video), videoFPS: this.videoFPS,
      droppedFrames: quality && this.baseline ? Math.max(0, quality.droppedVideoFrames - this.baseline.droppedVideoFrames) : null,
      totalFrames: quality && this.baseline ? Math.max(0, quality.totalVideoFrames - this.baseline.totalVideoFrames) : null,
      bufferingSeconds: (this.bufferingMs + (this.bufferingSince === null ? 0 : now - this.bufferingSince)) / 1000,
      bufferingCount: this.bufferingCount, stalls: this.stalls,
      xrP95Ms: intervals.length ? intervals[Math.ceil(intervals.length * 0.95) - 1] : null,
      xrFPS: intervals.length ? 1000 * intervals.length / intervals.reduce((a, b) => a + b, 0) : null,
    };
  }

  lines() {
    const s = this.snapshot();
    const number = n => n === null ? '—' : n.toFixed(1);
    return [
      `${s.state} · ${s.width} × ${s.height} · Buffer ${s.bufferSeconds.toFixed(1)} s`,
      `Video ${number(s.videoFPS)} fps · Dropped ${s.droppedFrames ?? '—'}/${s.totalFrames ?? '—'}`,
      `Buffering ${s.bufferingSeconds.toFixed(1)} s (${s.bufferingCount}) · Fetch stalls ${s.stalls}`,
      `XR ${number(s.xrFPS)} fps · p95 interval ${number(s.xrP95Ms)} ms`,
    ];
  }

  dispose() {
    this.endBuffering();
    for (const [name, handler] of Object.entries(this.listeners)) this.video.removeEventListener(name, handler);
  }
}

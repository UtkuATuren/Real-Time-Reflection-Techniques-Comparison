// Lightweight FPS / frame-time tracker. Avoids the visual style of Stats.js
// since we render the metrics into our own DOM overlays.

export class PerfTracker {
  constructor({ sampleSize = 60 } = {}) {
    this.sampleSize = sampleSize;
    this.samples = [];
    this.lastTime = performance.now();
    this.lastEmit = this.lastTime;
    this.listeners = new Set();
  }

  begin() {
    this._frameStart = performance.now();
  }

  end() {
    const now = performance.now();
    const frameMs = now - this._frameStart;
    this.samples.push(frameMs);
    if (this.samples.length > this.sampleSize) this.samples.shift();

    // Throttle UI updates to ~5 Hz so numbers are readable.
    if (now - this.lastEmit >= 200) {
      this.lastEmit = now;
      const avg = this.samples.reduce((a, b) => a + b, 0) / this.samples.length;
      const fps = avg > 0 ? 1000 / avg : 0;
      const payload = { fps, frameMs: avg };
      for (const fn of this.listeners) fn(payload);
    }
  }

  onUpdate(fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }
}

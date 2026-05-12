// ============================================================
// performance.js
// Lightweight rolling FPS monitor that fires a callback when
// the frame rate stays under a threshold for a sustained period.
// Used to auto-engage "Low Power Mode".
// ============================================================

export class PerformanceMonitor {
  constructor({ window = 60, lowFps = 30, holdMs = 2500 } = {}) {
    this.window = window;
    this.frames = [];
    this.lowFps = lowFps;
    this.holdMs = holdMs;

    this._belowSince = null;
    this._lastTime = performance.now();

    this.onDownshift = null;
  }

  /** Call every animation frame. dt = seconds since last frame. */
  tick(dt) {
    const now = performance.now();
    this.frames.push(dt);
    if (this.frames.length > this.window) this.frames.shift();

    const fps = this.fps();

    if (fps < this.lowFps) {
      if (this._belowSince === null) this._belowSince = now;
      else if (now - this._belowSince >= this.holdMs) {
        this._belowSince = null;
        this.onDownshift?.(fps);
      }
    } else {
      this._belowSince = null;
    }

    this._lastTime = now;
  }

  fps() {
    if (this.frames.length < 4) return 60;
    let sum = 0;
    for (const f of this.frames) sum += f;
    const avg = sum / this.frames.length;
    return avg > 0 ? 1 / avg : 60;
  }
}

/**
 * Keyboard-wedge scanner detection (USB / Bluetooth scanners that type what they read, then Enter). Pure: fed key
 * events with their time, it says when a burst was a scan. A person types far slower than a scanner (≥ 80 ms between
 * keys is typical; a scanner sends a key every 2–30 ms), so a run of at least `minLength` characters whose gaps are all
 * under `maxGapMs`, ended by Enter (or Tab), is a scan. Anything slower resets: what a person types is left alone.
 */
export type WedgeOptions = { maxGapMs?: number; minLength?: number };

export class WedgeDetector {
  private buf = "";
  private last = -Infinity;
  private readonly maxGap: number;
  private readonly minLength: number;

  constructor(opts: WedgeOptions = {}) {
    this.maxGap = opts.maxGapMs ?? 60;
    this.minLength = opts.minLength ?? 4;
  }

  /** The characters of the burst so far (for a caller that swallows them). */
  get pending(): string { return this.buf; }

  /** True while a burst is in progress at time `t` (the last key came within the gap). */
  active(t: number): boolean { return this.buf.length > 0 && t - this.last <= this.maxGap; }

  /**
   * One key. `key` is KeyboardEvent.key: a single printable character, or "Enter" / "Tab" (the scanner's suffix).
   * Returns the scanned text when this key ends a scan, otherwise null.
   */
  push(key: string, t: number): string | null {
    const gap = t - this.last;
    if (key === "Enter" || key === "Tab") {
      const out = this.buf.length >= this.minLength && gap <= this.maxGap * 2 ? this.buf : null;
      this.reset();
      return out;
    }
    if (key.length !== 1) { if (key !== "Shift") this.reset(); return null; }
    if (gap > this.maxGap) this.buf = "";
    this.buf += key;
    this.last = t;
    return null;
  }

  reset() { this.buf = ""; this.last = -Infinity; }
}

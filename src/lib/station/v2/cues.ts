/**
 * Roasting station v2 — the loud cues (D12): a full-column colour flash with a sound, so a roaster with gloves and a
 * running machine notices. Web Audio (no files); the sound can be switched off in the station's settings
 * (localStorage, per device).
 */
const SOUND_KEY = "hq.roastv2.sound";
let ctx: AudioContext | null = null;

export function soundOn(): boolean {
  try { return localStorage.getItem(SOUND_KEY) !== "off"; } catch { return true; }
}
export function setSound(on: boolean) {
  try { localStorage.setItem(SOUND_KEY, on ? "on" : "off"); } catch { /* storage unavailable */ }
}

/** ok: two rising notes · warn: one long middle note · err: three low pulses. */
export function cue(kind: "ok" | "warn" | "err") {
  if (!soundOn() || typeof window === "undefined") return;
  try {
    const AC = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!AC) return;
    ctx ??= new AC();
    const notes = kind === "ok" ? [[660, 0, 0.12], [990, 0.13, 0.16]] : kind === "warn" ? [[520, 0, 0.45]] : [[220, 0, 0.14], [220, 0.2, 0.14], [220, 0.4, 0.2]];
    const t0 = ctx.currentTime + 0.01;
    for (const [f, at, dur] of notes) {
      const o = ctx.createOscillator(), g = ctx.createGain();
      o.type = kind === "err" ? "square" : "triangle";
      o.frequency.value = f;
      g.gain.setValueAtTime(0.0001, t0 + at);
      g.gain.exponentialRampToValueAtTime(0.6, t0 + at + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, t0 + at + dur);
      o.connect(g).connect(ctx.destination);
      o.start(t0 + at); o.stop(t0 + at + dur + 0.02);
    }
  } catch { /* audio unavailable */ }
}

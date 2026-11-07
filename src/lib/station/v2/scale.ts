/**
 * Roasting station v2 — the scale port (D12). A Bluetooth scale will implement it later; today the only adapter is the
 * manual one: the operator types the weight on the keypad (or the ± steps on the prep screen). The screens read weights
 * through this interface only, so a real scale plugs in without touching them.
 */
export type ScaleReading = { kg: number; stable: boolean; source: "manual" | "bluetooth" };
export interface ScaleAdapter {
  readonly kind: "manual" | "bluetooth";
  /** Whether a live reading is available (manual: never — the person types it). */
  readonly live: boolean;
  /** Subscribe to readings; returns the unsubscribe. The manual adapter never emits. */
  subscribe(fn: (r: ScaleReading) => void): () => void;
  /** A typed weight, normalised (Arabic digits, one point, three decimals). Null when it is not a weight. */
  manual(text: string): ScaleReading | null;
}

export function cleanWeight(v: string): string {
  let s = v.replace(/[٠-٩]/g, (d) => String("٠١٢٣٤٥٦٧٨٩".indexOf(d))).replace(/[^0-9.]/g, "");
  const i = s.indexOf(".");
  if (i >= 0) s = s.slice(0, i + 1) + s.slice(i + 1).replace(/\./g, "").slice(0, 3);
  if (s.startsWith(".")) s = "0" + s;
  return s.slice(0, 7);
}

export const manualScale: ScaleAdapter = {
  kind: "manual",
  live: false,
  subscribe: () => () => undefined,
  manual(text) {
    const n = Number(cleanWeight(text));
    return Number.isFinite(n) && n > 0 ? { kg: +n.toFixed(3), stable: true, source: "manual" } : null;
  },
};

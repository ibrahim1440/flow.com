/**
 * Roasting station (Workstations W1) — the constants and pure rules the station screen and its
 * API share. Client-safe: no server import.
 */

/** WorkItemClaim.stationType / WorkstationActionLog.stationType of the roasting station. */
export const ROASTING_STATION = "ROASTING";

/** What a claim of the roasting station is about (WorkItemClaim.itemType). */
export type StationItemType = "RoastCoffee" | "ProductionOrder";

/**
 * The loss boundary. Reused, not invented: the ERP roast sheet already flags a roast whose loss is
 * more than this many percentage points away from the product's expected roast loss
 * (CoffeeProduct.expectedRoastLoss, default 15 %). The station uses the same number, so the two
 * screens never disagree about what is «خارج المعتاد».
 */
export const LOSS_WARN_POINTS = 5;
/** The built-in expected loss when a product names none (CoffeeProduct.expectedRoastLoss default). */
export const DEFAULT_EXPECTED_LOSS = 15;

export type LossVerdict = { kg: number; pct: number; expected: number; limit: number; tone: "ok" | "above" | "below" };

/** Loss = green − roasted (derived, never typed), against expected ± LOSS_WARN_POINTS. */
export function lossVerdict(greenKg: number, roastedKg: number, expectedPct: number | null | undefined): LossVerdict | null {
  if (!(greenKg > 0) || !(roastedKg > 0) || roastedKg >= greenKg) return null;
  const expected = Number.isFinite(expectedPct as number) ? (expectedPct as number) : DEFAULT_EXPECTED_LOSS;
  const kg = +(greenKg - roastedKg).toFixed(3);
  const pct = (kg / greenKg) * 100;
  const limit = expected + LOSS_WARN_POINTS;
  const tone = pct > limit ? "above" : pct < expected - LOSS_WARN_POINTS ? "below" : "ok";
  return { kg, pct, expected, limit, tone };
}

/** Problem report kinds (design W4, R7). None changes the roaster status (owner decision D13). */
export const PROBLEM_KINDS = ["PAUSE", "MALFUNCTION", "RELEASE_REQUEST"] as const;
export type ProblemKind = (typeof PROBLEM_KINDS)[number];
/** The claim state each report leaves (WorkstationActionLog.toState). */
export const PROBLEM_STATE: Record<ProblemKind, string> = {
  PAUSE: "PAUSED",
  MALFUNCTION: "STOPPED_MALFUNCTION",
  RELEASE_REQUEST: "RELEASE_REQUESTED",
};
/** The reason chips of R7 «ماذا حدث؟» (stored as the code; the screen shows the words). */
export const PROBLEM_REASONS = ["BURNER_STOPPED", "IRREGULAR_HEAT", "COOLING_PROBLEM", "OTHER"] as const;
/** The loss reason chips of R4 «سبب الفاقد» (design ws-rloss). */
export const LOSS_REASONS = ["PROCESS", "EQUIPMENT", "SAMPLE", "UNKNOWN"] as const;

/** Idle lock (owner decision D3): a /station page signs out after this long without input. */
export const STATION_IDLE_MS = 5 * 60 * 1000;

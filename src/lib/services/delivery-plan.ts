/**
 * The pure half of dispatch without lots (Phase D): which lots, how much from each. No database,
 * no framework import, so it is unit-tested directly (tests/ops/unit/delivery-plan.test.ts).
 * The rule: the line's reservations first, then free stock, each oldest lot first.
 */

/** Repo-wide kg precision: gram-level, 3 decimals. */
const roundKg = (v: number): number => { const r = Number(v.toFixed(3)); return Object.is(r, -0) ? 0 : r; };

export type PlanCandidate = {
  lotId: string;
  /** Oldest first: the FIFO key. */
  createdAt: Date;
  /** What this line holds on the lot (units, or kg on a kilogram line). */
  held: number;
  /** What is free to anyone on the lot (available − reserved, never negative). */
  free: number;
};

export type PlannedLot = { lotId: string; quantity: number; fromHeld: number; fromFree: number };

export type DispatchPlan = {
  lots: PlannedLot[];
  /** What the plan covers. Less than `want` means the shelf cannot cover the request. */
  covered: number;
  /** Everything this line could take right now (held + free over every candidate). */
  ready: number;
};

const fifo = (a: PlanCandidate, b: PlanCandidate) =>
  a.createdAt.getTime() - b.createdAt.getTime() || (a.lotId < b.lotId ? -1 : a.lotId > b.lotId ? 1 : 0);

/**
 * Reservations first, then free stock, each oldest lot first. `kg` switches the arithmetic to
 * gram precision (3 dp); otherwise quantities are whole units.
 */
export function planDispatch(candidates: readonly PlanCandidate[], want: number, kg = false): DispatchPlan {
  const norm = (v: number) => (kg ? roundKg(v) : Math.trunc(v));
  const eps = kg ? 0.0005 : 0;
  const sorted = [...candidates].sort(fifo);
  const byLot = new Map<string, PlannedLot>();
  const order: string[] = [];
  let remaining = norm(Math.max(0, want));

  const take = (lotId: string, q: number, kind: "fromHeld" | "fromFree") => {
    let row = byLot.get(lotId);
    if (!row) { row = { lotId, quantity: 0, fromHeld: 0, fromFree: 0 }; byLot.set(lotId, row); order.push(lotId); }
    row[kind] = norm(row[kind] + q);
    row.quantity = norm(row.quantity + q);
    remaining = norm(remaining - q);
  };

  for (const c of sorted) {
    if (remaining <= eps) break;
    const q = norm(Math.min(remaining, Math.max(0, c.held)));
    if (q > eps) take(c.lotId, q, "fromHeld");
  }
  for (const c of sorted) {
    if (remaining <= eps) break;
    const q = norm(Math.min(remaining, Math.max(0, c.free)));
    if (q > eps) take(c.lotId, q, "fromFree");
  }

  const lots = order.map((id) => byLot.get(id)!);
  const covered = norm(lots.reduce((s, l) => s + l.quantity, 0));
  const ready = norm(sorted.reduce((s, c) => s + Math.max(0, c.held) + Math.max(0, c.free), 0));
  return { lots, covered, ready };
}

/**
 * Kilograms of each planned unit lot, summing exactly to the delivery's quantityKg. Every share
 * but the last is units × net weight; the last is the remainder, so float noise can never make
 * the lines and the delivery disagree.
 */
export function splitKg(totalKg: number, shares: readonly number[]): number[] {
  const out: number[] = [];
  let used = 0;
  shares.forEach((kg, i) => {
    if (i === shares.length - 1) out.push(roundKg(totalKg - used));
    else { out.push(roundKg(kg)); used = roundKg(used + roundKg(kg)); }
  });
  return out;
}


// Depreciation arithmetic for one asset (stage 5, STAGE_5_DESIGN.md §3). Pure: no database.
//
// Months are counted as ym = year × 12 + (month − 1). An asset depreciates from its start month
// (the in-service month or the month after, by its class's convention) over the months of life
// that remain after any opening depreciation it was brought in with.
//
//   STRAIGHT_LINE      cumulative target: after k months the accumulated charge is
//                      round2(B × k / L), B = cost − residual − opening accumulated, L = remaining
//                      months. A month's charge is the target less what has posted, so rounding
//                      never drifts and the last month lands exactly on the residual value; months
//                      missed (an asset capitalised late) are caught up in one line.
//   DECLINING_BALANCE  each month round2(NBV × factor / (life / 12) / 12), never below the residual
//                      value; the last month of the life takes the NBV down to the residual.
import { Prisma } from "@/generated/prisma/client";
import { ZERO, dec, round2 } from "./money";

export type DepMethod = "STRAIGHT_LINE" | "DECLINING_BALANCE";
export type DepAsset = {
  cost: Prisma.Decimal | string;
  residualValue: Prisma.Decimal | string;
  openingAccumulated: Prisma.Decimal | string;
  openingMonths: number;
  usefulLifeMonths: number;
  method: DepMethod;
  decliningFactor: Prisma.Decimal | string | null;
  startConvention: "IN_SERVICE_MONTH" | "NEXT_MONTH";
  inServiceDate: Date;
};
/** What has posted for the asset so far (excluding the opening accumulated depreciation). */
export type DepPosted = { accumulated: Prisma.Decimal; months: number };
export type DepCharge = { amount: Prisma.Decimal; months: number; accumulatedAfter: Prisma.Decimal; nbvAfter: Prisma.Decimal; note: string | null };

export const ym = (d: Date) => d.getUTCFullYear() * 12 + d.getUTCMonth();
export const ymLabel = (m: number) => `${Math.floor(m / 12)}-${String((m % 12) + 1).padStart(2, "0")}`;

export function startMonth(a: Pick<DepAsset, "inServiceDate" | "startConvention">): number {
  return ym(a.inServiceDate) + (a.startConvention === "NEXT_MONTH" ? 1 : 0);
}

/** Months of life left after the opening depreciation. */
export function remainingLife(a: Pick<DepAsset, "usefulLifeMonths" | "openingMonths">): number {
  return Math.max(0, a.usefulLifeMonths - a.openingMonths);
}

/** The charge that brings the asset up to date through month `through` (inclusive). */
export function chargeThrough(a: DepAsset, through: number, posted: DepPosted): DepCharge {
  const cost = dec(a.cost), residual = dec(a.residualValue), opening = dec(a.openingAccumulated);
  const L = remainingLife(a);
  const base = cost.sub(residual).sub(opening);
  const k = Math.min(Math.max(0, through - startMonth(a) + 1), L);
  const done = (amount: Prisma.Decimal, months: number, note: string | null): DepCharge => {
    const accumulatedAfter = opening.add(posted.accumulated).add(amount);
    return { amount, months, accumulatedAfter, nbvAfter: cost.sub(accumulatedAfter), note };
  };
  if (L === 0 || base.lte(0) || k <= posted.months) return done(ZERO, 0, null);
  const months = k - posted.months;
  const catchUp = months > 1 ? `includes ${months - 1} earlier month(s) not yet charged` : null;

  if (a.method === "STRAIGHT_LINE") {
    const target = round2(base.mul(k).div(L));
    const amount = Prisma.Decimal.max(target.sub(posted.accumulated), ZERO);
    return done(amount, months, k === L ? (catchUp ? `${catchUp}; last month of life` : "last month of life") : catchUp);
  }

  const factor = dec(a.decliningFactor ?? "2");
  const years = new Prisma.Decimal(a.usefulLifeMonths).div(12);
  let accum = posted.accumulated;
  let total = ZERO;
  for (let i = posted.months + 1; i <= k; i++) {
    const nbv = cost.sub(opening).sub(accum);
    const room = Prisma.Decimal.max(nbv.sub(residual), ZERO);
    const lifeMonth = a.openingMonths + i;
    let c = lifeMonth >= a.usefulLifeMonths ? room : round2(nbv.mul(factor).div(years).div(12));
    c = Prisma.Decimal.min(c, room);
    accum = accum.add(c);
    total = total.add(c);
  }
  return done(total, months, k === L ? (catchUp ? `${catchUp}; last month of life` : "last month of life") : catchUp);
}

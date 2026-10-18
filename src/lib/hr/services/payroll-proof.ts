// Native HR — proof of payment per employee (P-2 rev3 item 2, Finding 12, P1).
//
// A recorded payment (HrPayrollPayment) is what left the bank: a transfer to one employee line, or a
// bulk transfer for many. It proves nothing about who received what. The proof is an ALLOCATION
// (HrPayrollPaymentAllocation): the payment, the run, the employee line, the payee and the bank
// reference of that employee's credit. A creditable source only:
//   · a per-line payment carries its own allocation (its reference is that employee's credit);
//   · the payer enters the bank's per-employee references by hand (`confirmAllocations`);
//   · the payer imports the bank's RESULT file (`importBankResults`) — every row must match an
//     employee line of the run and that line's outstanding net exactly, or nothing is imported.
// Never the file the system exports (exportCsv): sending a bank file is not proof.
//
// Settlement per line: settled = Σ allocations − Σ returned allocations, never above the net (DB).
//   status NONE_DUE (net 0) · UNPAID · PARTIAL · PAID (settled = net) · RETURNED (a return / rejection
//   left it short). A run is PAID only when every line is settled, every payment is fully accounted
//   for (allocated + rejected = amount) and payments − returns = net (DB, 20261017160000). A return
//   after PAID reopens the run (PAID → APPROVED). Bank references are unique (DB), and every request
//   names an idempotency key, so neither a retry nor a re-import ever records a second credit.
import { createHash } from "node:crypto";
import { Prisma } from "@/generated/prisma/client";
import { HrError, type Db } from "../core";
import { parseAmount } from "../money";
import { closeIfDone } from "./advances";
import { settleReservations } from "./commission-bridge";

type Tx = Prisma.TransactionClient;
const D = (v: string | number | Prisma.Decimal) => new Prisma.Decimal(v);
const ZERO = D(0);

export type LineSettlementStatus = "NONE_DUE" | "UNPAID" | "PARTIAL" | "PAID" | "RETURNED";
export type LineSettlement = {
  lineId: string; employeeId: string; net: Prisma.Decimal; allocated: Prisma.Decimal; returned: Prisma.Decimal; rejected: Prisma.Decimal;
  settled: Prisma.Decimal; outstanding: Prisma.Decimal; status: LineSettlementStatus;
};
export type PaymentAccounting = { paymentId: string; amount: Prisma.Decimal; allocated: Prisma.Decimal; rejected: Prisma.Decimal; unallocated: Prisma.Decimal };
export type RunSettlement = {
  lines: Map<string, LineSettlement>;
  payments: PaymentAccounting[];
  /** Σ payments − Σ returns (both kinds): what actually left the bank and stayed out. */
  cashOut: Prisma.Decimal;
  returnedTotal: Prisma.Decimal;
  unsettledLines: number;
  unallocated: Prisma.Decimal;
  /** Every line credited its net with proof, every payment accounted for, cash out = net. */
  complete: boolean;
};

/** The proof state of a run, read in one pass (no write). */
export async function runSettlement(db: Db, runId: string): Promise<RunSettlement> {
  const run = await db.hrPayrollRun.findUniqueOrThrow({ where: { id: runId }, select: { totalNet: true } });
  const [lines, payments, allocations, returns] = await Promise.all([
    db.hrPayrollLine.findMany({ where: { runId }, select: { id: true, employeeId: true, net: true } }),
    db.hrPayrollPayment.findMany({ where: { runId }, select: { id: true, amount: true } }),
    db.hrPayrollPaymentAllocation.findMany({ where: { runId }, select: { paymentId: true, lineId: true, amount: true } }),
    db.hrPayrollPaymentReturn.findMany({ where: { runId }, select: { paymentId: true, lineId: true, amount: true, kind: true } }),
  ]);
  const sumWhere = <T extends { amount: Prisma.Decimal }>(rows: T[], f: (r: T) => boolean) => rows.filter(f).reduce((s, r) => s.plus(r.amount), ZERO);
  const out = new Map<string, LineSettlement>();
  let unsettledLines = 0;
  for (const l of lines) {
    const allocated = sumWhere(allocations, (a) => a.lineId === l.id);
    const returned = sumWhere(returns, (r) => r.lineId === l.id && r.kind === "RETURNED");
    const rejected = sumWhere(returns, (r) => r.lineId === l.id && r.kind === "REJECTED");
    const settled = allocated.minus(returned);
    const outstanding = l.net.minus(settled);
    let status: LineSettlementStatus;
    if (l.net.isZero()) status = "NONE_DUE";
    else if (outstanding.isZero()) status = "PAID";
    else if (returned.greaterThan(0) || rejected.greaterThan(0)) status = "RETURNED";
    else status = settled.isZero() ? "UNPAID" : "PARTIAL";
    if (!outstanding.isZero()) unsettledLines++;
    out.set(l.id, { lineId: l.id, employeeId: l.employeeId, net: l.net, allocated, returned, rejected, settled, outstanding, status });
  }
  const acc = payments.map((p) => {
    const allocated = sumWhere(allocations, (a) => a.paymentId === p.id);
    const rejected = sumWhere(returns, (r) => r.paymentId === p.id && r.kind === "REJECTED");
    return { paymentId: p.id, amount: p.amount, allocated, rejected, unallocated: p.amount.minus(allocated).minus(rejected) };
  });
  const returnedTotal = returns.reduce((s, r) => s.plus(r.amount), ZERO);
  const cashOut = payments.reduce((s, p) => s.plus(p.amount), ZERO).minus(returnedTotal);
  const unallocated = acc.reduce((s, a) => s.plus(a.unallocated), ZERO);
  const complete = unsettledLines === 0 && unallocated.isZero() && cashOut.equals(run.totalNet);
  return { lines: out, payments: acc, cashOut, returnedTotal, unsettledLines, unallocated, complete };
}

/**
 * APPROVED → PAID when (and only when) the proof is complete. Settles what the run reserved
 * (installments, commission periods; both idempotent: only RESERVED rows are touched, so a run
 * reopened by a return and paid again settles nothing twice) and closes finished advances.
 */
export async function completeIfSettled(tx: Tx, run: { id: string; runNo: number }, actorId: string): Promise<boolean> {
  const cur = await tx.hrPayrollRun.findUniqueOrThrow({ where: { id: run.id }, select: { status: true } });
  if (cur.status !== "APPROVED") return false;
  const st = await runSettlement(tx, run.id);
  if (!st.complete) return false;
  const settled = await tx.hrAdvanceInstallment.findMany({ where: { payrollRunId: run.id, status: "RESERVED" }, select: { id: true, advanceId: true } });
  await tx.hrAdvanceInstallment.updateMany({ where: { payrollRunId: run.id, status: "RESERVED" }, data: { status: "SETTLED", settledAt: new Date() } });
  await settleReservations(tx, run.id, run.runNo, actorId);
  await tx.hrPayrollRun.update({ where: { id: run.id }, data: { status: "PAID", paidAt: new Date() } });
  for (const advId of new Set(settled.map((s) => s.advanceId))) await closeIfDone(tx, advId, actorId);
  return true;
}

/** PAID → APPROVED after a return left a line short (the DB allows exactly this, and nothing else). */
export async function reopenIfShort(tx: Tx, runId: string): Promise<boolean> {
  const cur = await tx.hrPayrollRun.findUniqueOrThrow({ where: { id: runId }, select: { status: true } });
  if (cur.status !== "PAID") return false;
  const st = await runSettlement(tx, runId);
  if (st.unsettledLines === 0) return false;
  await tx.hrPayrollRun.update({ where: { id: runId }, data: { status: "APPROVED", paidAt: null } });
  return true;
}

// ── Input parsing ─────────────────────────────────────────────────────────────────

export const bankRef = (v: unknown, field: string): string => {
  const s = typeof v === "string" ? v.trim() : "";
  if (s.length < 3 || s.length > 120) throw new HrError(`${field} must be the bank's reference of that credit (3 to 120 characters).`, 400);
  return s;
};

export function proofAmount(v: unknown, field: string): Prisma.Decimal {
  try {
    return D(parseAmount(v).toString());
  } catch (e) {
    throw new HrError(`${field}: ${(e as Error).message}`, 400);
  }
}

export type AllocationIn = { lineId: string; amount: Prisma.Decimal; bankReference: string };

export function allocationsIn(v: unknown): AllocationIn[] {
  if (!Array.isArray(v) || !v.length) throw new HrError("allocations must list at least one employee line, amount and bank reference.", 400);
  if (v.length > 2000) throw new HrError("At most 2000 allocations per request.", 400);
  const seen = new Set<string>();
  return v.map((x, i) => {
    const o = (x ?? {}) as Record<string, unknown>;
    const lineId = typeof o.lineId === "string" && o.lineId.trim() ? o.lineId.trim() : "";
    if (!lineId) throw new HrError(`allocations[${i}].lineId is required.`, 400);
    const bankReference = bankRef(o.bankReference, `allocations[${i}].bankReference`);
    const k = bankReference.toLowerCase();
    if (seen.has(k)) throw new HrError(`Bank reference ${bankReference} appears twice in this request.`, 409, "DUPLICATE_BANK_REFERENCE");
    seen.add(k);
    return { lineId, amount: proofAmount(o.amount, `allocations[${i}].amount`), bankReference };
  });
}

export type BankRow = { row: number; employeeNo: string; amount: Prisma.Decimal; bankReference: string; status: "PAID" | "REJECTED" | "RETURNED"; originalReference: string | null; reason: string | null };

/**
 * A bank RESULT file: header `employeeNo,amount,bankReference,status[,originalReference][,reason]`;
 * status PAID (credited), REJECTED (never credited; part of the bulk payment comes back) or RETURNED
 * (a credit already recorded came back — `originalReference` names it). Any malformed row refuses all.
 */
export function parseBankResultCsv(csv: string): BankRow[] {
  const rows = csv.replace(/^﻿/, "").split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  if (rows.length < 2) throw new HrError("The bank result file needs a header row and at least one row.", 400, "CSV_INVALID");
  if (rows.length > 2001) throw new HrError("At most 2000 rows per bank result file.", 400, "CSV_INVALID");
  const head = rows[0].split(",").map((h) => h.trim());
  const col = (n: string) => head.indexOf(n);
  for (const n of ["employeeNo", "amount", "bankReference", "status"]) if (col(n) < 0) throw new HrError("The header must include employeeNo, amount, bankReference and status.", 400, "CSV_INVALID");
  const errors: string[] = [];
  const out: BankRow[] = [];
  rows.slice(1).forEach((r, i) => {
    const c = r.split(",").map((x) => x.trim());
    const line = i + 2;
    try {
      const status = (c[col("status")] ?? "").toUpperCase();
      if (!["PAID", "REJECTED", "RETURNED"].includes(status)) throw new Error("status must be PAID, REJECTED or RETURNED");
      const employeeNo = c[col("employeeNo")] ?? "";
      if (!employeeNo) throw new Error("employeeNo is required");
      const original = col("originalReference") >= 0 ? (c[col("originalReference")] ?? "") : "";
      if (status === "RETURNED" && original.length < 3) throw new Error("a RETURNED row names the original credit (originalReference)");
      out.push({
        row: line, employeeNo, amount: proofAmount(c[col("amount")], "amount"), bankReference: bankRef(c[col("bankReference")], "bankReference"), status: status as BankRow["status"],
        originalReference: original || null, reason: col("reason") >= 0 ? c[col("reason")] || null : null,
      });
    } catch (e) {
      errors.push(`row ${line}: ${(e as Error).message}`);
    }
  });
  if (errors.length) throw new HrError(`The bank result file was not imported (nothing was saved): ${errors.slice(0, 5).join("; ")}${errors.length > 5 ? ` (+${errors.length - 5} more)` : ""}.`, 400, "CSV_INVALID");
  const seen = new Set<string>();
  for (const r of out) {
    const k = r.bankReference.toLowerCase();
    if (seen.has(k)) throw new HrError(`Bank reference ${r.bankReference} appears twice in the file (row ${r.row}); nothing was imported.`, 409, "DUPLICATE_BANK_REFERENCE");
    seen.add(k);
  }
  return out;
}

export const sha256 = (s: string) => createHash("sha256").update(s, "utf8").digest("hex");

/** A bank reference already used by an allocation or a return (case-insensitive), or null. */
export async function usedReference(db: Db, refs: string[]): Promise<string | null> {
  if (!refs.length) return null;
  const lower = refs.map((r) => r.trim().toLowerCase());
  const rows = await db.$queryRaw<{ ref: string }[]>`
    SELECT "bankReference" AS ref FROM "HrPayrollPaymentAllocation" WHERE lower(btrim("bankReference")) = ANY(${lower})
    UNION ALL SELECT "bankReference" FROM "HrPayrollPaymentReturn" WHERE lower(btrim("bankReference")) = ANY(${lower}) LIMIT 1`;
  return rows[0]?.ref ?? null;
}

/** The last four characters of the payee's account, never more (null when none is on file). */
export function last4(iban: string | null | undefined): string | null {
  const s = (iban ?? "").replace(/\s+/g, "").toUpperCase();
  return /^[0-9A-Z]{4,}$/.test(s) ? s.slice(-4) : null;
}

/** Settlement figures as strings for the page / API. */
export function settlementDto(s: LineSettlement | undefined) {
  if (!s) return null;
  return { status: s.status, allocated: s.allocated.toFixed(2), returned: s.returned.toFixed(2), rejected: s.rejected.toFixed(2), settled: s.settled.toFixed(2), outstanding: s.outstanding.toFixed(2) };
}

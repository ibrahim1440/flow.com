// Native HR — GOSI invoice entry, reconciliation and lifecycle (P-2 finding 4, E-4; spec S-4.7;
// review P2-B4). Controls only: no statutory rate, threshold or formula is entered or used here —
// contribution rates live in the policy's contribution rules (accountant decisions).
//
// • The invoice as received is ENTERED (by hand, or imported from CSV) per period, per person,
//   per SCHEME (subscriber category — matched to the person's contribution group), per BRANCH
//   (matched to the contribution rule code) and per share. Its source file is recorded: name and
//   SHA-256 (and the CSV text itself). It is never edited; the invoice number is never live twice
//   and never reused for another month (DB).
// • RECONCILED (read only) per (person, month, scheme, branch, share) against the contribution
//   items of APPROVED / PAID runs of the month (correction runs included), net of employer-borne
//   adjustments. Each difference is TYPED: MISSING_IN_PAYROLL, MISSING_IN_INVOICE, WAGE_MISMATCH,
//   DAYS_MISMATCH, RATE_MISMATCH, CATEGORY_MISMATCH, ROUNDING (one halala, after equal wage and
//   rate — a classification, never an acceptance) or AMOUNT_MISMATCH.
// • Each difference is decided by a proposal (explanation + action + its D-4h CASE,
//   ../gosi-treatments) that ANOTHER person approves. P-2 rev3 item 3: a decision BOOKS only when
//   its case's treatment is enabled (HrGosiTreatment: all nine cases ship DISABLED, no keys; enabled
//   only by an applied two-person GOSI_TREATMENT_SET change). Otherwise the decision is recorded and
//   stays OPEN and flagged in the register (DECIDED_OPEN, unbooked) — nothing is posted, nothing
//   zeroed. Once its case is enabled, `bookGosiSettlement` books it, once (unique adjustment and
//   journal link). PAYROLL_CORRECTION (case 5) and a corrected invoice (case 6) never post: they
//   stay OPEN until RESOLVED — linked to the approved correction run of that month, or to the
//   dispute outcome / written acceptance (HrGosiResolution). A later correction run counts once.
// • Lifecycle: ENTERED → RECONCILED (the reconciliation reviewed and recorded — differences may be
//   open) → APPROVED (a second person, neither the enterer nor the reconciler, naming the digest) →
//   PAID → CLOSED. A VOID (only before approval) is requested by one person and decided by another.
// • P-2 rev3 item 3: PAYMENT status is bank reality, separate from the DIFFERENCE status. Each
//   transfer to GOSI is a payment row (actual amount, bank reference, idempotency key) with its own
//   HR journal PAYMENT:<id> (Dr CONTRIB_PAYABLE / Cr PAYROLL_CASH); the invoice is PAID when they
//   equal its total, whatever its open differences (they stay in the register). CLOSED needs both:
//   PAID, and every difference booked under an enabled treatment or resolved (re-review N3's
//   refusal, moved from payment to closing).
// Database: migrations 20261017100000, 20261017130000 and 20261017170000 (lifecycle, keys, guards).
import { createHash } from "node:crypto";
import { Prisma } from "@/generated/prisma/client";
import { prisma } from "@/lib/db";
import { HrError, type HrActor, type Db, TX, accountNames, assertAny, assertCan, assertFresh, assertNotSelf, audit, lock, mapDbError, oneOf, reqText, resolveScope, text } from "../core";
import { assertPayrollLive } from "../payroll-lock";
import { dayString, isDay, isMonth, parseDay } from "../dates";
import { parseAmount } from "../money";
import { assertVerifiedActor, samePersonAsAny } from "../identity";
import { assertPostingReady, postHrJournal } from "./accounting-bridge";
import { assertJournalIntact } from "./journal-integrity";
import { GOSI_CASE_RULES, GOSI_TREATMENT_CASES, caseLines, caseMismatch, defaultCase, type GosiCase } from "../gosi-treatments";
import type { AccountKey } from "./policy";

type Tx = Prisma.TransactionClient;
const ZERO = new Prisma.Decimal(0);
const SHARES = ["EMPLOYEE", "EMPLOYER"] as const;
type Share = (typeof SHARES)[number];
// P-2 rev3 item 3: EMPLOYEE_RECEIVABLE (case 2a) and EMPLOYEE_REFUND (case 4) are decisions too.
export const GOSI_ACTIONS = ["EMPLOYER_EXPENSE", "PAYROLL_CORRECTION", "INVOICE_DISPUTE", "NO_ADJUSTMENT", "EMPLOYEE_RECEIVABLE", "EMPLOYEE_REFUND"] as const;
/** Decisions that book an entry (once their case's treatment is enabled). */
const BOOKING_ACTIONS = new Set(["EMPLOYER_EXPENSE", "EMPLOYEE_RECEIVABLE", "EMPLOYEE_REFUND"]);
export const DIFFERENCE_TYPES = ["MISSING_IN_PAYROLL", "MISSING_IN_INVOICE", "WAGE_MISMATCH", "DAYS_MISMATCH", "RATE_MISMATCH", "CATEGORY_MISMATCH", "ROUNDING", "AMOUNT_MISMATCH"] as const;
export type DifferenceType = (typeof DIFFERENCE_TYPES)[number];
const UNSPECIFIED = "UNSPECIFIED";

async function assertCompanyWide(actor: HrActor) {
  if (!(await resolveScope(actor)).all) throw new HrError("GOSI reconciliation is company-wide: it needs the all-branches duty.", 403);
}

function money(v: unknown, field: string): Prisma.Decimal {
  try {
    return new Prisma.Decimal(parseAmount(v, { allowZero: true }).toString());
  } catch (e) {
    throw new HrError(`${field}: ${(e as Error).message}`, 400);
  }
}

const code = (v: unknown, field: string) => {
  const s = reqText(v, field, 40).toUpperCase();
  if (!/^[A-Z0-9_.-]{1,40}$/.test(s)) throw new HrError(`${field} must be a code (letters, digits, _ . -).`, 400);
  return s;
};
const dayCount = (v: unknown, field: string): number | null => {
  if (v === undefined || v === null || v === "") return null;
  const n = Number(v);
  if (!Number.isInteger(n) || n < 0 || n > 31) throw new HrError(`${field} must be a whole number of days (0–31).`, 400);
  return n;
};

type InLine = { employeeNo: string; scheme: string; branch: string; share: Share; amount: Prisma.Decimal; contributoryWage: Prisma.Decimal | null; days: number | null; row: number };

/** Parse CSV text: header `employeeNo,scheme,branch,share,amount[,contributoryWage][,days]`. Every row is checked; any error refuses all. */
export function parseGosiCsv(csv: string): InLine[] {
  const rows = csv.replace(/^﻿/, "").split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  if (rows.length < 2) throw new HrError("The CSV needs a header row and at least one line.", 400);
  const head = rows[0].split(",").map((h) => h.trim());
  const col = (n: string) => head.indexOf(n);
  for (const n of ["employeeNo", "scheme", "branch", "share", "amount"]) if (col(n) < 0) throw new HrError("The CSV header must include employeeNo, scheme, branch, share and amount.", 400);
  const errors: string[] = [];
  const out: InLine[] = [];
  rows.slice(1).forEach((r, i) => {
    const cells = r.split(",").map((c) => c.trim());
    const line = i + 2;
    try {
      const share = cells[col("share")]?.toUpperCase();
      if (!(SHARES as readonly string[]).includes(share)) throw new Error("share must be EMPLOYEE or EMPLOYER");
      const wageCell = col("contributoryWage") >= 0 ? cells[col("contributoryWage")] : "";
      out.push({
        employeeNo: cells[col("employeeNo")] ?? "", scheme: code(cells[col("scheme")], "scheme"), branch: code(cells[col("branch")], "branch"), share: share as Share,
        amount: money(cells[col("amount")], "amount"), contributoryWage: wageCell ? money(wageCell, "contributoryWage") : null,
        days: col("days") >= 0 ? dayCount(cells[col("days")], "days") : null, row: line,
      });
    } catch (e) {
      errors.push(`line ${line}: ${(e as Error).message}`);
    }
  });
  if (errors.length) throw new HrError(`The CSV was not imported (nothing was saved): ${errors.slice(0, 5).join("; ")}${errors.length > 5 ? ` (+${errors.length - 5} more)` : ""}.`, 400, "CSV_INVALID");
  return out;
}

function manualLines(v: unknown): InLine[] {
  if (!Array.isArray(v) || !v.length) throw new HrError("lines must list at least one person, scheme, branch and share.", 400);
  return v.map((x, i) => {
    const o = (x ?? {}) as Record<string, unknown>;
    return {
      employeeNo: reqText(o.employeeNo, "employeeNo", 40), scheme: code(o.scheme, "scheme"), branch: code(o.branch, "branch"), share: oneOf(o.share, "share", SHARES), amount: money(o.amount, "amount"),
      contributoryWage: o.contributoryWage === undefined || o.contributoryWage === null || o.contributoryWage === "" ? null : money(o.contributoryWage, "contributoryWage"),
      days: dayCount(o.days, "days"), row: i + 1,
    };
  });
}

const sha256 = (s: string) => createHash("sha256").update(s, "utf8").digest("hex");

/**
 * Enter the invoice of a period (manual `lines`, or `csv`). Atomic: all lines or none. The source
 * is recorded: a CSV's text, name (`fileName`) and SHA-256; a hand-typed invoice names the file it
 * was typed from (`sourceFileName`, `sourceFileSha256`).
 */
export async function enterGosiInvoice(actor: HrActor, b: Record<string, unknown>) {
  assertCan(actor, "payroll_prepare");
  await assertCompanyWide(actor);
  await assertVerifiedActor(actor, "GOSI_INVOICE_ENTER");
  const periodMonth = typeof b.periodMonth === "string" ? b.periodMonth : "";
  if (!isMonth(periodMonth)) throw new HrError("periodMonth must look like 2026-10.", 400);
  const reference = reqText(b.reference, "reference", 80);
  const source = typeof b.csv === "string" ? "CSV" : "MANUAL";
  const lines = source === "CSV" ? parseGosiCsv(b.csv as string) : manualLines(b.lines);
  const sourceFileName = reqText(source === "CSV" ? b.fileName : b.sourceFileName, source === "CSV" ? "fileName" : "sourceFileName", 200, 3);
  let sourceFileSha256: string;
  if (source === "CSV") sourceFileSha256 = sha256(b.csv as string);
  else {
    const h = typeof b.sourceFileSha256 === "string" ? b.sourceFileSha256.trim().toLowerCase() : "";
    if (!/^[0-9a-f]{64}$/.test(h)) throw new HrError("sourceFileSha256 must be the SHA-256 (64 hex characters) of the invoice file this entry was typed from.", 400);
    sourceFileSha256 = h;
  }
  const seen = new Set<string>();
  for (const l of lines) {
    const k = `${l.employeeNo}|${l.scheme}|${l.branch}|${l.share}`;
    if (seen.has(k)) throw new HrError(`${l.employeeNo} ${l.scheme} ${l.branch} ${l.share} appears twice on the invoice.`, 400);
    seen.add(k);
  }
  try {
    return await prisma.$transaction(async (tx) => {
      await lock(tx, `gosi:${periodMonth}`);
      await lock(tx, `gosi-ref:${reference.trim().toLowerCase()}`);
      const reused = await tx.hrGosiInvoice.findFirst({ where: { reference: { equals: reference.trim(), mode: "insensitive" } } });
      if (reused && (reused.periodMonth !== periodMonth || reused.status !== "VOID")) throw new HrError(reused.periodMonth !== periodMonth ? `Invoice number ${reference} was already used for ${reused.periodMonth}; an invoice number is never reused for another month.` : `Invoice ${reference} is already entered for ${periodMonth}.`, 409, "GOSI_INVOICE_DUPLICATE");
      const people = await tx.hrEmployee.findMany({ where: { employeeNo: { in: [...new Set(lines.map((l) => l.employeeNo))] } }, select: { id: true, employeeNo: true } });
      const byNo = new Map(people.map((p) => [p.employeeNo, p.id]));
      const unknown = lines.filter((l) => !byNo.has(l.employeeNo));
      if (unknown.length) throw new HrError(`Unknown employee number(s) on the invoice (nothing was saved): ${unknown.slice(0, 5).map((l) => `${l.employeeNo} (line ${l.row})`).join(", ")}.`, 400, "UNKNOWN_EMPLOYEE");
      const sum = (s: Share) => lines.filter((l) => l.share === s).reduce((t, l) => t.plus(l.amount), ZERO);
      const inv = await tx.hrGosiInvoice.create({ data: { periodMonth, reference: reference.trim(), source, totalEmployee: sum("EMPLOYEE"), totalEmployer: sum("EMPLOYER"), notes: text(b.notes, "notes", { max: 500 }), enteredBy: actor.id, sourceFileName, sourceFileSha256, sourceContent: source === "CSV" ? (b.csv as string) : null } });
      await tx.hrGosiInvoiceLine.createMany({ data: lines.map((l) => ({ invoiceId: inv.id, employeeId: byNo.get(l.employeeNo) as string, scheme: l.scheme, branch: l.branch, share: l.share, amount: l.amount, contributoryWage: l.contributoryWage, days: l.days, sourceRow: l.row })) });
      await audit(tx, { action: "GOSI_INVOICE_ENTER", entityType: "HrGosiInvoice", entityId: inv.id, after: { periodMonth, reference, source, lines: lines.length, totalEmployee: inv.totalEmployee.toFixed(2), totalEmployer: inv.totalEmployer.toFixed(2), sourceFileName, sourceFileSha256 }, actorId: actor.id });
      return { id: inv.id, periodMonth, reference: inv.reference, source, stage: inv.stage, lines: lines.length, totalEmployee: inv.totalEmployee.toFixed(2), totalEmployer: inv.totalEmployer.toFixed(2), sourceFileName, sourceFileSha256 };
    }, TX);
  } catch (e) {
    if (e instanceof HrError) throw e;
    if ((e as { code?: string }).code === "P2002") throw new HrError(`An active GOSI invoice for ${periodMonth}, or one with this number, already exists. Void it first to enter a corrected one.`, 409, "GOSI_INVOICE_EXISTS");
    mapDbError(e);
  }
}

// ── Void: requested by one person, decided by another (only before approval) ─────────

async function loadInvoice(tx: Tx, id: string) {
  await tx.$queryRaw`SELECT 1 FROM "HrGosiInvoice" WHERE "id" = ${id} FOR UPDATE`;
  const inv = await tx.hrGosiInvoice.findUnique({ where: { id } });
  if (!inv) throw new HrError("GOSI invoice not found", 404);
  return inv;
}

/** Request a void (the route `.../void`). Nothing is voided until a second person decides it. */
export async function voidGosiInvoice(actor: HrActor, id: string, b: Record<string, unknown>) {
  assertCan(actor, "payroll_prepare");
  await assertCompanyWide(actor);
  const reason = reqText(b.reason, "reason", 500, 5);
  return prisma.$transaction(async (tx) => {
    const inv = await loadInvoice(tx, id);
    if (inv.status !== "ACTIVE") throw new HrError("Only an active invoice can be voided.", 409);
    if (!["ENTERED", "RECONCILED"].includes(inv.stage)) throw new HrError(`An invoice is voided only before approval (this one is ${inv.stage}).`, 409, "GOSI_INVOICE_STAGE");
    if (inv.voidRequestedBy) throw new HrError("A void of this invoice is already waiting for a decision.", 409, "GOSI_VOID_PENDING");
    if (await tx.hrGosiSettlement.count({ where: { invoiceId: id, status: { in: ["PENDING", "APPROVED"] } } })) throw new HrError("This invoice has settled or pending differences; it cannot be voided. Dispute it through a settlement instead.", 409, "GOSI_INVOICE_SETTLED");
    await tx.hrGosiInvoice.update({ where: { id }, data: { voidRequestedBy: actor.id, voidRequestedAt: new Date(), voidRequestReason: reason } });
    await audit(tx, { action: "GOSI_INVOICE_VOID_REQUEST", entityType: "HrGosiInvoice", entityId: id, reason, actorId: actor.id });
    return { voided: false, voidRequested: true };
  }, TX);
}

/** Decide a requested void: another person (not the requester, not the same person). */
export async function decideGosiVoid(actor: HrActor, id: string, b: Record<string, unknown>) {
  assertCan(actor, "payroll_approve");
  await assertCompanyWide(actor);
  await assertVerifiedActor(actor, "GOSI_INVOICE_VOID");
  const decision = oneOf(b.decision, "decision", ["APPROVE", "REJECT"] as const);
  const note = text(b.note, "note", { max: 500 });
  return prisma.$transaction(async (tx) => {
    const inv = await loadInvoice(tx, id);
    if (inv.status !== "ACTIVE" || !inv.voidRequestedBy) throw new HrError("No void of this invoice is waiting for a decision.", 409);
    if (await samePersonAsAny(tx, [inv.voidRequestedBy], actor.id)) throw new HrError("You requested this void; another person must decide it.", 403, "SELF_ACTION");
    if (decision === "REJECT") {
      if (!note || note.length < 3) throw new HrError("A reason is required to reject.", 400);
      await tx.hrGosiInvoice.update({ where: { id }, data: { voidRequestedBy: null, voidRequestedAt: null, voidRequestReason: null } });
      await audit(tx, { action: "GOSI_INVOICE_VOID_REJECT", entityType: "HrGosiInvoice", entityId: id, before: { requestedBy: inv.voidRequestedBy, reason: inv.voidRequestReason }, reason: note, actorId: actor.id });
      return { voided: false };
    }
    if (await tx.hrGosiSettlement.count({ where: { invoiceId: id, status: { in: ["PENDING", "APPROVED"] } } })) throw new HrError("This invoice has settled or pending differences; it cannot be voided.", 409, "GOSI_INVOICE_SETTLED");
    await tx.hrGosiInvoice.update({ where: { id }, data: { status: "VOID", voidedBy: actor.id, voidedAt: new Date(), voidReason: inv.voidRequestReason } });
    await audit(tx, { action: "GOSI_INVOICE_VOID", entityType: "HrGosiInvoice", entityId: id, after: { requestedBy: inv.voidRequestedBy, voidedBy: actor.id }, reason: inv.voidRequestReason, actorId: actor.id });
    return { voided: true };
  }, TX);
}

export async function withdrawGosiVoid(actor: HrActor, id: string) {
  assertCan(actor, "payroll_prepare");
  return prisma.$transaction(async (tx) => {
    const inv = await loadInvoice(tx, id);
    if (inv.voidRequestedBy !== actor.id) throw new HrError("Only the person who requested the void can withdraw it.", 403, "NOT_REQUESTER");
    if (inv.status !== "ACTIVE") throw new HrError("This invoice is void.", 409);
    await tx.hrGosiInvoice.update({ where: { id }, data: { voidRequestedBy: null, voidRequestedAt: null, voidRequestReason: null } });
    await audit(tx, { action: "GOSI_INVOICE_VOID_WITHDRAW", entityType: "HrGosiInvoice", entityId: id, actorId: actor.id });
    return { voided: false };
  }, TX);
}

// ── Reconciliation (read only) ────────────────────────────────────────────────────

type Side = { amount: Prisma.Decimal; wage: Prisma.Decimal | null; rate: Prisma.Decimal | null; days: number | null };
type Decision = { id: string; status: string; action: string; treatmentCase: string | null; booked: boolean; difference: string; differenceType: string | null; fingerprint: string; proposedBy: string; resolution: { outcome: string; reference: string; correctionRunId: string | null } | null };
/**
 * P-2 rev3 item 3 — where a difference stands in the register (never an acceptance by itself):
 * MATCHED · BOOKED (booked under an enabled treatment; the difference is zero) · OPEN_UNDECIDED ·
 * OPEN_PENDING (a decision awaits its approver) · OPEN_UNBOOKED (approved, its case's treatment is
 * not enabled: nothing posted) · OPEN_AWAITING_LINK (approved; waits for its correction run / outcome)
 * · RESOLVED_UNBOOKED (resolved without an entry; the difference still sits in the payable) ·
 * RESOLVED_CORRECTED_INVOICE (case 6: the corrected invoice carries it).
 */
type Register = "MATCHED" | "BOOKED" | "OPEN_UNDECIDED" | "OPEN_PENDING" | "OPEN_UNBOOKED" | "OPEN_AWAITING_LINK" | "RESOLVED_UNBOOKED" | "RESOLVED_CORRECTED_INVOICE";
type RecoRow = {
  employeeId: string; employeeNo: string; fullNameAr: string; scheme: string; branch: string; share: Share;
  invoice: string; payroll: string; adjustments: string; difference: string; differenceType: DifferenceType | null;
  invoiceWage: string | null; payrollWage: string | null; payrollRate: string | null; invoiceDays: number | null;
  /** MATCHED · SETTLED (zero after an employer-borne adjustment) · DIFFERENCE (no decision) · PENDING (decision awaited) · DECIDED_OPEN (approved, not yet resolved) · ACCEPTED (resolved without changing payroll). */
  status: "MATCHED" | "SETTLED" | "DIFFERENCE" | "PENDING" | "DECIDED_OPEN" | "ACCEPTED";
  register: Register;
  /** Open in the register (anything but MATCHED, BOOKED and RESOLVED_CORRECTED_INVOICE): the invoice is not CLOSED. */
  flagged: boolean;
  pending: { id: string; action: string; fingerprint: string; proposedBy: string } | null;
  decisions: Decision[];
  approvedSettlements: number;
};

/** Contribution items of APPROVED / PAID runs of the month (correction runs included), per key. */
async function payrollContributions(db: Db, periodMonth: string) {
  const rows = await db.$queryRaw<{ employeeId: string; scheme: string; branch: string; share: Share; amount: Prisma.Decimal; wage: Prisma.Decimal | null; rate: Prisma.Decimal | null; days: number | null }[]>`
    SELECT l."employeeId" AS "employeeId",
           COALESCE(l."snapshot" ->> 'contributionGroup', ${UNSPECIFIED}) AS scheme,
           substring(i."code" FROM 12) AS branch,
           CASE WHEN i."code" LIKE 'CONTRIB_EE:%' THEN 'EMPLOYEE' ELSE 'EMPLOYER' END AS share,
           sum(i."amount") AS amount, max(i."quantity") AS wage, max(i."rate") AS rate,
           max(((l."snapshot" -> 'employed' ->> 'to')::date - (l."snapshot" -> 'employed' ->> 'from')::date) + 1)::int AS days
      FROM "HrPayrollItem" i
      JOIN "HrPayrollLine" l ON l."id" = i."lineId"
      JOIN "HrPayrollRun" r ON r."id" = l."runId"
     WHERE r."periodMonth" = ${periodMonth} AND r."status" IN ('APPROVED', 'PAID')
       AND (i."code" LIKE 'CONTRIB_EE:%' OR i."code" LIKE 'CONTRIB_ER:%')
     GROUP BY 1, 2, 3, 4`;
  return new Map(rows.map((r) => [`${r.employeeId}|${r.scheme}|${r.branch}|${r.share}`, { amount: new Prisma.Decimal(r.amount), wage: r.wage === null ? null : new Prisma.Decimal(r.wage), rate: r.rate === null ? null : new Prisma.Decimal(r.rate), days: r.days === null ? null : Number(r.days) } as Side]));
}

/** Why invoice and payroll differ for one key (a classification only; never an acceptance). */
export function classifyDifference(inv: Side | null, pay: Side | null, otherSchemeOnPayroll: boolean, diff: Prisma.Decimal): DifferenceType | null {
  if (diff.isZero()) return null;
  if (inv && !pay) return otherSchemeOnPayroll ? "CATEGORY_MISMATCH" : "MISSING_IN_PAYROLL";
  if (!inv && pay) return "MISSING_IN_INVOICE";
  if (!inv || !pay) return "AMOUNT_MISMATCH";
  if (inv.wage && pay.wage && !inv.wage.equals(pay.wage)) return "WAGE_MISMATCH";
  if (inv.days !== null && inv.days !== undefined && pay.days !== null && pay.days !== undefined && inv.days !== pay.days) return "DAYS_MISMATCH";
  if (inv.wage && pay.wage && pay.rate) {
    if (diff.abs().lessThanOrEqualTo(new Prisma.Decimal("0.01"))) return "ROUNDING";
    const invRate = inv.wage.isZero() ? null : inv.amount.times(100).dividedBy(inv.wage);
    if (invRate && !invRate.toDecimalPlaces(2).equals(pay.rate.toDecimalPlaces(2))) return "RATE_MISMATCH";
  }
  return "AMOUNT_MISMATCH";
}

/** Per (person, scheme, branch, share): invoice vs payroll vs employer-borne adjustments, in exact halalas. Writes nothing. */
export async function reconcileGosi(db: Db, periodMonth: string) {
  const inv = await db.hrGosiInvoice.findFirst({ where: { periodMonth, status: "ACTIVE" }, include: { lines: true } });
  const payroll = await payrollContributions(db, periodMonth);
  // Only BOOKED adjustments change the expected side (rev3: an adjustment exists only once its
  // treatment booked it); every other decision stays open.
  const adjustments = await db.hrGosiAdjustment.groupBy({ by: ["employeeId", "scheme", "branch", "share"], where: { periodMonth }, _sum: { amount: true } });
  const adj = new Map(adjustments.map((a) => [`${a.employeeId}|${a.scheme}|${a.branch}|${a.share}`, a._sum.amount ?? ZERO]));
  const invoiced = new Map((inv?.lines ?? []).map((l) => [`${l.employeeId}|${l.scheme}|${l.branch}|${l.share}`, { amount: l.amount, wage: l.contributoryWage, rate: null, days: l.days } as Side]));
  const keys = [...new Set([...invoiced.keys(), ...payroll.keys(), ...adj.keys()])];
  const settlements = inv ? await db.hrGosiSettlement.findMany({ where: { invoiceId: inv.id, status: { in: ["PENDING", "APPROVED"] } }, include: { resolution: true, adjustment: { select: { id: true } } }, orderBy: { proposedAt: "asc" } }) : [];
  const people = await db.hrEmployee.findMany({ where: { id: { in: keys.map((k) => k.split("|")[0]) } }, select: { id: true, employeeNo: true, fullNameAr: true } });
  const pById = new Map(people.map((p) => [p.id, p]));
  const rows: RecoRow[] = keys.map((k): RecoRow => {
    const [employeeId, scheme, branch, share] = k.split("|") as [string, string, string, Share];
    const iSide = invoiced.get(k) ?? null, pSide = payroll.get(k) ?? null;
    const i = iSide?.amount ?? ZERO, p = pSide?.amount ?? ZERO, a = adj.get(k) ?? ZERO;
    const diff = i.minus(p).minus(a);
    const otherScheme = !pSide && [...payroll.keys()].some((x) => { const [e, s, b2, sh] = x.split("|"); return e === employeeId && b2 === branch && sh === share && s !== scheme; });
    const differenceType = classifyDifference(iSide, pSide, otherScheme, diff);
    const mine = settlements.filter((s) => s.employeeId === employeeId && s.scheme === scheme && s.branch === branch && s.share === share);
    const pending = mine.find((s) => s.status === "PENDING");
    const approved = mine.filter((s) => s.status === "APPROVED");
    // A decision covers the CURRENT difference only if it was made for exactly this amount.
    // A payroll-correction decision linked to its correction run is spent: if the difference is
    // still there, the correction did not carry it and the difference needs a new decision.
    // rev3: an approved booking decision whose treatment is not enabled is unbooked — it covers the
    // difference as an OPEN decision, exactly like one waiting for its link.
    const covering = approved.filter((s) => !s.adjustment && s.difference.equals(diff) && s.resolution?.outcome !== "CORRECTION_RUN");
    let status: RecoRow["status"];
    if (diff.isZero()) status = approved.length ? "SETTLED" : "MATCHED";
    // The LATEST covering decision speaks (a booking decision taken after an acceptance supersedes it).
    else if (covering.length) status = covering[covering.length - 1].resolution ? "ACCEPTED" : "DECIDED_OPEN";
    else if (pending) status = "PENDING";
    else status = "DIFFERENCE";
    const res = covering[covering.length - 1]?.resolution ?? null;
    const register: Register = status === "MATCHED" ? "MATCHED" : status === "SETTLED" ? "BOOKED" : status === "PENDING" ? "OPEN_PENDING" : status === "DIFFERENCE" ? "OPEN_UNDECIDED"
      : status === "ACCEPTED" ? (res?.outcome === "INVOICE_CORRECTED" ? "RESOLVED_CORRECTED_INVOICE" : "RESOLVED_UNBOOKED")
      : BOOKING_ACTIONS.has(covering[covering.length - 1]?.action ?? "") ? "OPEN_UNBOOKED" : "OPEN_AWAITING_LINK";
    return {
      employeeId, employeeNo: pById.get(employeeId)?.employeeNo ?? "?", fullNameAr: pById.get(employeeId)?.fullNameAr ?? "?", scheme, branch, share,
      invoice: i.toFixed(2), payroll: p.toFixed(2), adjustments: a.toFixed(2), difference: diff.toFixed(2), differenceType,
      invoiceWage: iSide?.wage?.toFixed(2) ?? null, payrollWage: pSide?.wage?.toFixed(2) ?? null, payrollRate: pSide?.rate?.toString() ?? null, invoiceDays: iSide?.days ?? null,
      status, register, flagged: !["MATCHED", "BOOKED", "RESOLVED_CORRECTED_INVOICE"].includes(register),
      pending: pending ? { id: pending.id, action: pending.action, fingerprint: pending.fingerprint, proposedBy: pending.proposedBy } : null,
      decisions: mine.map((s) => ({ id: s.id, status: s.status, action: s.action, treatmentCase: s.treatmentCase, booked: !!s.adjustment, difference: s.difference.toFixed(2), differenceType: s.differenceType, fingerprint: s.fingerprint, proposedBy: s.proposedBy, resolution: s.resolution ? { outcome: s.resolution.outcome, reference: s.resolution.reference, correctionRunId: s.resolution.correctionRunId } : null })),
      approvedSettlements: approved.length,
    };
  }).sort((x, y) => x.employeeNo.localeCompare(y.employeeNo) || x.scheme.localeCompare(y.scheme) || x.branch.localeCompare(y.branch) || x.share.localeCompare(y.share));
  const tot = (f: "invoice" | "payroll" | "adjustments" | "difference") => rows.reduce((s, r) => s.plus(r[f]), ZERO).toFixed(2);
  const unexplained = rows.filter((r) => r.status === "DIFFERENCE" || r.status === "PENDING").length;
  const openDecisions = settlements.filter((s) => s.status === "APPROVED" && !s.adjustment && !s.resolution).length;
  const flagged = rows.filter((r) => r.flagged).length;
  // rev3: payment status (bank reality) is reported apart from the difference status.
  const pays = inv ? await db.hrGosiInvoicePayment.findMany({ where: { invoiceId: inv.id }, orderBy: { createdAt: "asc" } }) : [];
  const paidTotal = pays.reduce((s, p) => s.plus(p.amount), ZERO);
  return {
    periodMonth,
    invoice: inv ? {
      id: inv.id, reference: inv.reference, source: inv.source, stage: inv.stage, totalEmployee: inv.totalEmployee.toFixed(2), totalEmployer: inv.totalEmployer.toFixed(2), enteredBy: inv.enteredBy, enteredAt: inv.enteredAt, sourceFileName: inv.sourceFileName, sourceFileSha256: inv.sourceFileSha256, voidRequested: !!inv.voidRequestedBy,
      paymentStatus: paymentStatusOf(inv, paidTotal), paid: (pays.length ? paidTotal : inv.paidAmount ?? ZERO).toFixed(2),
      payments: pays.map((p) => ({ id: p.id, amount: p.amount.toFixed(2), paidOn: dayString(p.paidOn), bankReference: p.bankReference })),
    } : null,
    /** MATCHED (no difference) · SETTLED (every difference booked or carried by a corrected invoice) · OPEN (flagged in the register). */
    reconciliationStatus: !inv ? null : flagged ? "OPEN" : rows.some((r) => r.register !== "MATCHED") ? "SETTLED" : "MATCHED",
    flagged,
    ok: !!inv && rows.every((r) => r.status === "MATCHED" || r.status === "SETTLED"),
    explained: !!inv && unexplained === 0,
    totals: { invoice: tot("invoice"), payroll: tot("payroll"), adjustments: tot("adjustments"), difference: tot("difference") },
    differences: rows.filter((r) => r.status !== "MATCHED" && r.status !== "SETTLED").length,
    unexplained, openDecisions,
    digest: createHash("sha256").update(JSON.stringify(rows.map((r) => [r.employeeId, r.scheme, r.branch, r.share, r.invoice, r.payroll, r.adjustments, r.difference, r.status, r.decisions.map((d) => [d.id, d.status, d.resolution?.outcome ?? null])]))).digest("hex").slice(0, 24),
    rows,
  };
}

export async function gosiReconciliation(actor: HrActor, periodMonth: string) {
  assertAny(actor, ["payroll_prepare", "payroll_approve"]);
  await assertCompanyWide(actor);
  if (!isMonth(periodMonth)) throw new HrError("month must look like 2026-10.", 400);
  const r = await reconcileGosi(prisma, periodMonth);
  const names = await accountNames(prisma, [r.invoice?.enteredBy, ...r.rows.map((x) => x.pending?.proposedBy)]);
  return { ...r, invoice: r.invoice ? { ...r.invoice, enteredByName: names.get(r.invoice.enteredBy) ?? null } : null };
}

// ── Lifecycle: RECONCILED → APPROVED → PAID → CLOSED ─────────────────────────────

/** ENTERED → RECONCILED once every difference has an approved decision (none undecided or pending). */
export async function reconcileGosiInvoice(actor: HrActor, id: string) {
  assertCan(actor, "payroll_prepare");
  await assertCompanyWide(actor);
  await assertVerifiedActor(actor, "GOSI_INVOICE_RECONCILE");
  return prisma.$transaction(async (tx) => {
    const inv = await loadInvoice(tx, id);
    if (inv.status !== "ACTIVE") throw new HrError("This invoice is void.", 409);
    if (!["ENTERED", "RECONCILED"].includes(inv.stage)) throw new HrError(`Only an invoice not yet approved is reconciled (this one is ${inv.stage}).`, 409, "GOSI_INVOICE_STAGE");
    // P-2 rev3 item 3: reconciling RECORDS the reconciliation as reviewed (its digest, open
    // differences included); it no longer waits for every difference to be decided. Paying the
    // invoice as billed is approved separately; the differences stay open in the register and
    // the invoice is not CLOSED until each is booked or resolved.
    const r = await reconcileGosi(tx, inv.periodMonth);
    await tx.hrGosiInvoice.update({ where: { id }, data: { stage: "RECONCILED", reconciledBy: actor.id, reconciledAt: new Date(), reconcileDigest: r.digest } });
    await audit(tx, { action: "GOSI_INVOICE_RECONCILE", entityType: "HrGosiInvoice", entityId: id, after: { digest: r.digest, differences: r.differences, openDecisions: r.openDecisions, flagged: r.flagged, unexplained: r.unexplained }, actorId: actor.id });
    return { id, stage: "RECONCILED", digest: r.digest, flagged: r.flagged };
  }, TX);
}

/** RECONCILED → APPROVED by a second person (neither the enterer nor the reconciler), naming the reconciliation it reviewed. */
export async function approveGosiInvoice(actor: HrActor, id: string, b: Record<string, unknown>) {
  assertCan(actor, "payroll_approve");
  assertFresh(actor);
  await assertCompanyWide(actor);
  await assertVerifiedActor(actor, "GOSI_INVOICE_APPROVE");
  const note = text(b.note, "note", { max: 500 });
  return prisma.$transaction(async (tx) => {
    const inv = await loadInvoice(tx, id);
    if (inv.status !== "ACTIVE" || inv.stage !== "RECONCILED") throw new HrError("Only a reconciled, active invoice is approved.", 409, "GOSI_INVOICE_STAGE");
    if (inv.voidRequestedBy) throw new HrError("A void of this invoice is waiting for a decision.", 409, "GOSI_VOID_PENDING");
    if (await samePersonAsAny(tx, [inv.enteredBy, inv.reconciledBy as string], actor.id)) throw new HrError("The approver is a second person: neither the one who entered nor the one who reconciled the invoice.", 403, "SELF_ACTION");
    const r = await reconcileGosi(tx, inv.periodMonth);
    if (b.expected !== inv.reconcileDigest) throw new HrError("expected must name the reconciliation you reviewed (its digest).", 400);
    if (r.digest !== inv.reconcileDigest) throw new HrError("The reconciliation changed after it was recorded (payroll, decisions or the invoice moved). Reconcile it again.", 409, "GOSI_RECONCILIATION_STALE");
    await tx.hrGosiInvoice.update({ where: { id }, data: { stage: "APPROVED", approvedBy: actor.id, approvedAt: new Date(), approvalNote: note } });
    await audit(tx, { action: "GOSI_INVOICE_APPROVE", entityType: "HrGosiInvoice", entityId: id, after: { digest: inv.reconcileDigest, enteredBy: inv.enteredBy, reconciledBy: inv.reconciledBy }, reason: note, actorId: actor.id });
    return { id, stage: "APPROVED" };
  }, TX);
}

/** UNPAID · PARTIAL · PAID — what the bank paid, nothing else. */
export function paymentStatusOf(inv: { stage: string; totalEmployee: Prisma.Decimal; totalEmployer: Prisma.Decimal; paidAmount: Prisma.Decimal | null }, paid: Prisma.Decimal): "UNPAID" | "PARTIAL" | "PAID" {
  const total = inv.totalEmployee.plus(inv.totalEmployer);
  if (inv.stage === "PAID" || inv.stage === "CLOSED") return "PAID";
  if (paid.isZero()) return "UNPAID";
  return paid.greaterThanOrEqualTo(total) ? "PAID" : "PARTIAL";
}

/**
 * P-2 rev3 item 3 — record what was ACTUALLY paid to GOSI for an APPROVED invoice: the amount
 * (default: what is still unpaid), the bank reference of the transfer (unique) and an idempotency
 * key (a retry returns the payment already recorded). Each payment posts its own HR journal
 * PAYMENT:<id> (Dr CONTRIB_PAYABLE / Cr PAYROLL_CASH; refused while HR accounting is off). The
 * invoice is PAID when the payments equal its total. Open differences do NOT stop it: they stay in
 * the register and stop CLOSING instead (re-review N3 reworked). Never above the invoice total
 * (DB); never by the invoice's approver.
 */
export async function payGosiInvoice(actor: HrActor, id: string, b: Record<string, unknown>) {
  assertCan(actor, "payroll_pay");
  assertFresh(actor);
  await assertCompanyWide(actor);
  await assertPayrollLive("GOSI_PAY");
  await assertVerifiedActor(actor, "GOSI_INVOICE_PAY");
  if (!isDay(b.paidOn)) throw new HrError("paidOn must be a date.", 400);
  const paidOn = parseDay(b.paidOn);
  const paymentReference = reqText(b.paymentReference, "paymentReference", 120, 3);
  const key = text(b.idempotencyKey, "idempotencyKey", { max: 80 });
  if (!key || key.length < 8) throw new HrError("idempotencyKey is required (8 to 80 characters) so a retry can never record the GOSI payment twice.", 400, "IDEMPOTENCY_REQUIRED");
  try {
    return await prisma.$transaction(async (tx) => {
      await assertPayrollLive("GOSI_PAY", tx); // F8: again inside the transaction
      const inv = await loadInvoice(tx, id);
      const prior = await tx.hrGosiInvoicePayment.findUnique({ where: { invoiceId_idempotencyKey: { invoiceId: id, idempotencyKey: key } } });
      if (prior) {
        if (prior.bankReference.toLowerCase() !== paymentReference.toLowerCase() || (b.paidAmount !== undefined && !money(b.paidAmount, "paidAmount").equals(prior.amount))) throw new HrError("This idempotency key was already used for a different GOSI payment. Nothing was recorded.", 409, "IDEMPOTENCY_CONFLICT");
        return { id, stage: inv.stage, paymentId: prior.id, replayed: true };
      }
      if (inv.status !== "ACTIVE" || inv.stage !== "APPROVED") throw new HrError(`Only an approved, active invoice not yet fully paid takes a payment (this one is ${inv.status === "VOID" ? "VOID" : inv.stage}).`, 409, "GOSI_INVOICE_STAGE");
      if (await samePersonAsAny(tx, [inv.approvedBy as string], actor.id)) throw new HrError("The approver of the invoice cannot record its payment.", 403, "SELF_ACTION");
      await lock(tx, `gosi-settle:${id}`);
      const total = inv.totalEmployee.plus(inv.totalEmployer);
      if (!total.greaterThan(0)) throw new HrError("The invoice total is zero; there is nothing to pay.", 409);
      const before = (await tx.hrGosiInvoicePayment.aggregate({ where: { invoiceId: id }, _sum: { amount: true } }))._sum.amount ?? ZERO;
      const amount = b.paidAmount === undefined ? total.minus(before) : money(b.paidAmount, "paidAmount");
      if (!amount.greaterThan(0)) throw new HrError("paidAmount must be above zero.", 400);
      if (before.plus(amount).greaterThan(total)) throw new HrError(`Payments to GOSI for this invoice would be ${before.plus(amount).toFixed(2)}, more than its total of ${total.toFixed(2)}.`, 409, "EVIDENCE_MISMATCH");
      if (await tx.hrGosiInvoicePayment.findFirst({ where: { bankReference: { equals: paymentReference, mode: "insensitive" } } })) throw new HrError(`Bank reference ${paymentReference} is already recorded for a GOSI payment.`, 409, "DUPLICATE_BANK_REFERENCE");
      await assertPostingReady(tx, { date: paidOn, keys: ["CONTRIB_PAYABLE", "PAYROLL_CASH"], source: { sourceType: "GOSI_INVOICE", sourceId: id, purpose: "PAYMENT" }, actorId: actor.id });
      const pay = await tx.hrGosiInvoicePayment.create({ data: { invoiceId: id, amount, paidOn, bankReference: paymentReference, idempotencyKey: key, recordedBy: actor.id } });
      const j = await postHrJournal(tx, {
        sourceType: "GOSI_INVOICE", sourceId: id, purpose: `PAYMENT:${pay.id}`, date: paidOn, actorId: actor.id, mode: "required", description: `GOSI ${inv.periodMonth} · invoice ${inv.reference} paid (${paymentReference})`,
        lines: [{ key: "CONTRIB_PAYABLE", debit: amount, description: `GOSI ${inv.periodMonth} invoice ${inv.reference}` }, { key: "PAYROLL_CASH", credit: amount, description: `GOSI ${inv.periodMonth} invoice ${inv.reference}` }],
      });
      const paid = before.plus(amount);
      const complete = paid.equals(total);
      if (complete) await tx.hrGosiInvoice.update({ where: { id }, data: { stage: "PAID", paidBy: actor.id, paidAt: new Date(), paidOn, paidAmount: paid, paymentReference, paymentJournalEntryId: j.journalEntryId } });
      const r = await reconcileGosi(tx, inv.periodMonth);
      await audit(tx, { action: "GOSI_INVOICE_PAY", entityType: "HrGosiInvoice", entityId: id, after: { paymentId: pay.id, amount: amount.toFixed(2), paid: paid.toFixed(2), total: total.toFixed(2), paidOn: dayString(paidOn), paymentReference, journalEntryId: j.journalEntryId, complete, openDifferences: r.flagged }, actorId: actor.id });
      return { id, stage: complete ? "PAID" : inv.stage, paymentId: pay.id, paymentStatus: complete ? "PAID" : "PARTIAL", paid: paid.toFixed(2), journalEntryId: j.journalEntryId, openDifferences: r.flagged, reconciliationStatus: r.reconciliationStatus };
    }, TX);
  } catch (e) {
    if (e instanceof HrError) throw e;
    if ((e as { code?: string }).code === "P2002") throw new HrError("This GOSI payment (bank reference or idempotency key) is already recorded.", 409, "DUPLICATE_BANK_REFERENCE");
    mapDbError(e);
  }
}

/**
 * PAID → CLOSED needs BOTH statuses: the invoice is paid (every payment journal intact), and every
 * difference is booked under an enabled treatment, or carried by a corrected invoice (case 6). A
 * difference still open in the register — undecided, pending, decided but unbooked, waiting for its
 * link, or resolved without an entry — keeps it open (409 GOSI_DIFFERENCES_OPEN): closing would
 * leave the contributions payable with a balance nothing explains (re-review N3, moved here).
 */
export async function closeGosiInvoice(actor: HrActor, id: string) {
  assertAny(actor, ["payroll_approve", "payroll_pay"]);
  await assertCompanyWide(actor);
  return prisma.$transaction(async (tx) => {
    const inv = await loadInvoice(tx, id);
    if (inv.stage !== "PAID") throw new HrError("Only a paid invoice is closed.", 409, "GOSI_INVOICE_STAGE");
    const r = await reconcileGosi(tx, inv.periodMonth);
    const open = r.rows.filter((x) => x.flagged);
    if (open.length) {
      const by = (s: string) => open.filter((x) => x.register === s).length;
      throw new HrError(`${open.length} difference(s) of this invoice are still open (${by("OPEN_UNDECIDED") + by("OPEN_PENDING")} undecided, ${by("OPEN_UNBOOKED")} decided but not booked — the treatment is not enabled, ${by("OPEN_AWAITING_LINK")} waiting for their correction run or outcome, ${by("RESOLVED_UNBOOKED")} resolved without an entry), so it is not closed. The invoice stays PAID; the differences stay in the register until each is booked under an approved treatment or resolved.`, 409, "GOSI_DIFFERENCES_OPEN");
    }
    const pays = await tx.hrGosiInvoicePayment.findMany({ where: { invoiceId: id } });
    if (pays.length) {
      for (const p of pays) await assertJournalIntact(tx, { sourceType: "GOSI_INVOICE", sourceId: id, purpose: `PAYMENT:${p.id}` }, { expected: [{ key: "CONTRIB_PAYABLE", debit: p.amount }, { key: "PAYROLL_CASH", credit: p.amount }], actorId: actor.id, step: "BEFORE_CLOSE" });
    } else {
      await assertJournalIntact(tx, { sourceType: "GOSI_INVOICE", sourceId: id, purpose: "PAYMENT" }, { expected: [{ key: "CONTRIB_PAYABLE", debit: inv.paidAmount as Prisma.Decimal }, { key: "PAYROLL_CASH", credit: inv.paidAmount as Prisma.Decimal }], actorId: actor.id, step: "BEFORE_CLOSE" });
    }
    await tx.hrGosiInvoice.update({ where: { id }, data: { stage: "CLOSED", closedBy: actor.id, closedAt: new Date() } });
    await audit(tx, { action: "GOSI_INVOICE_CLOSE", entityType: "HrGosiInvoice", entityId: id, after: { reconciliationStatus: r.reconciliationStatus }, actorId: actor.id });
    return { id, stage: "CLOSED", reconciliationStatus: r.reconciliationStatus };
  }, TX);
}

// ── Settlement of a difference (second person) ───────────────────────────────────

const fp = (x: unknown) => createHash("sha256").update(JSON.stringify(x)).digest("hex").slice(0, 24);

async function currentDifference(tx: Tx, invoiceId: string, k: { employeeId: string; scheme: string; branch: string; share: Share }) {
  const inv = await tx.hrGosiInvoice.findUnique({ where: { id: invoiceId } });
  if (!inv) throw new HrError("GOSI invoice not found", 404);
  if (inv.status !== "ACTIVE") throw new HrError("This invoice is void.", 409);
  const r = await reconcileGosi(tx, inv.periodMonth);
  const row = r.rows.find((x) => x.employeeId === k.employeeId && x.scheme === k.scheme && x.branch === k.branch && x.share === k.share);
  if (!row) throw new HrError("There is nothing to reconcile for this person, scheme, branch and share in this period.", 409);
  return { inv, row };
}

export async function proposeGosiSettlement(actor: HrActor, invoiceId: string, b: Record<string, unknown>) {
  assertCan(actor, "payroll_prepare");
  await assertCompanyWide(actor);
  await assertVerifiedActor(actor, "GOSI_SETTLEMENT_PROPOSE");
  const employeeId = reqText(b.employeeId, "employeeId", 40);
  const share = oneOf(b.share, "share", SHARES);
  const scheme = code(b.scheme, "scheme"), branch = code(b.branch, "branch");
  const action = oneOf(b.action, "action", GOSI_ACTIONS);
  const explanation = reqText(b.explanation, "explanation", 1000, 10);
  // P-2 rev3 item 3: the D-4h case the decision is (named, or the case its action has always meant).
  const named = b.treatmentCase === undefined || b.treatmentCase === null || b.treatmentCase === "" ? null : oneOf(b.treatmentCase, "treatmentCase", GOSI_TREATMENT_CASES);
  try {
    return await prisma.$transaction(async (tx) => {
      await lock(tx, `gosi-settle:${invoiceId}`);
      const person = await tx.hrEmployee.findUnique({ where: { id: employeeId } });
      if (!person) throw new HrError("Employee not found", 404);
      assertNotSelf(actor, person, "settle a GOSI difference");
      const { inv, row } = await currentDifference(tx, invoiceId, { employeeId, scheme, branch, share });
      // A difference can surface after approval too (a later correction run, a resolution that did
      // not carry it): it is decided at any stage until the invoice is CLOSED.
      if (inv.stage === "CLOSED") throw new HrError("This invoice is closed.", 409, "GOSI_INVOICE_STAGE");
      const difference = new Prisma.Decimal(row.difference);
      if (difference.isZero()) throw new HrError("There is no difference to settle for this key.", 409, "NO_DIFFERENCE");
      if (row.status === "DECIDED_OPEN") throw new HrError("An approved decision already covers this difference; resolve it (or let payroll change) instead of deciding it again.", 409, "GOSI_ALREADY_DECIDED");
      // Re-review N3: a difference accepted without booking (NO_ADJUSTMENT, or a rejected dispute) is
      // still unbooked; the only further decision is to book it as an employer expense.
      if (row.status === "ACCEPTED" && !BOOKING_ACTIONS.has(action)) throw new HrError("This difference was accepted without booking; the only further decision is to book it under a treatment case (EMPLOYER_EXPENSE, EMPLOYEE_RECEIVABLE or EMPLOYEE_REFUND).", 409, "GOSI_ALREADY_DECIDED");
      const treatmentCase: GosiCase | null = named ?? defaultCase(action, share, difference.comparedTo(0));
      if (BOOKING_ACTIONS.has(action) && !treatmentCase) throw new HrError(`${action} does not fit this difference (${share.toLowerCase()} share, ${difference.toFixed(2)}): an employee-share amount below payroll is a refund owed (EMPLOYEE_REFUND, case 4).`, 400, "GOSI_CASE_MISMATCH");
      if (treatmentCase) {
        const why = caseMismatch(treatmentCase, action, share, difference.comparedTo(0), row.differenceType);
        if (why) throw new HrError(why, 400, "GOSI_CASE_MISMATCH");
      }
      // The amounts and the type are the server's, never the proposer's: the approver approves the fingerprint.
      const content = { invoiceId, employeeId, scheme, branch, share, invoice: row.invoice, payroll: row.payroll, adjustments: row.adjustments, difference: row.difference, differenceType: row.differenceType, action, explanation, ...(treatmentCase ? { treatmentCase } : {}) };
      const s = await tx.hrGosiSettlement.create({ data: { invoiceId, periodMonth: inv.periodMonth, employeeId, scheme, branch, share, differenceType: row.differenceType, invoiceAmount: new Prisma.Decimal(row.invoice), payrollAmount: new Prisma.Decimal(row.payroll), priorAdjustments: new Prisma.Decimal(row.adjustments), difference, explanation, action, treatmentCase, fingerprint: fp(content), proposedBy: actor.id } });
      await audit(tx, { action: "GOSI_SETTLEMENT_PROPOSE", entityType: "HrGosiSettlement", entityId: s.id, employeeId, after: { ...content, fingerprint: s.fingerprint }, actorId: actor.id });
      return { id: s.id, status: s.status, fingerprint: s.fingerprint, ...content };
    }, TX);
  } catch (e) {
    if (e instanceof HrError) throw e;
    if ((e as { code?: string }).code === "P2002") throw new HrError("A settlement for this key is already waiting for a decision.", 409, "GOSI_SETTLEMENT_PENDING");
    mapDbError(e);
  }
}

/**
 * Approve (fingerprint, unchanged difference) or reject, by a person other than the proposer.
 * EMPLOYER_EXPENSE books the difference to employer contribution expense against the
 * contributions payable (an HR journal: refused while HR accounting is off) and records the
 * adjustment. PAYROLL_CORRECTION, INVOICE_DISPUTE and NO_ADJUSTMENT record the decision ONLY: it
 * stays OPEN — nothing is zeroed — until it is resolved (`resolveGosiSettlement`).
 */
export async function decideGosiSettlement(actor: HrActor, id: string, b: Record<string, unknown>, today: Date) {
  assertCan(actor, "payroll_approve");
  await assertCompanyWide(actor);
  await assertVerifiedActor(actor, "GOSI_SETTLEMENT_DECIDE");
  const decision = oneOf(b.decision, "decision", ["APPROVE", "REJECT"] as const);
  const note = text(b.note, "note", { max: 500 });
  if (decision === "REJECT" && (!note || note.length < 3)) throw new HrError("A reason is required to reject.", 400);
  try {
    return await prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT 1 FROM "HrGosiSettlement" WHERE "id" = ${id} FOR UPDATE`;
      const s = await tx.hrGosiSettlement.findUnique({ where: { id }, include: { employee: true } });
      if (!s) throw new HrError("GOSI settlement not found", 404);
      if (s.status !== "PENDING") throw new HrError(`Only a pending settlement can be decided (this one is ${s.status}).`, 409);
      if (s.proposedBy === actor.id) throw new HrError("You proposed this settlement; another approver must decide it.", 403, "SELF_ACTION");
      if (await samePersonAsAny(tx, [s.proposedBy], actor.id)) throw new HrError("You are the same person as the proposer; another person must decide it.", 403, "SAME_PERSON");
      assertNotSelf(actor, s.employee, "decide a GOSI settlement");
      const now = new Date();
      if (decision === "REJECT") {
        await tx.hrGosiSettlement.update({ where: { id }, data: { status: "REJECTED", decidedBy: actor.id, decidedAt: now, decisionNote: note } });
        await audit(tx, { action: "GOSI_SETTLEMENT_REJECT", entityType: "HrGosiSettlement", entityId: id, employeeId: s.employeeId, reason: note, actorId: actor.id });
        return { id, status: "REJECTED", applied: false };
      }
      if (typeof b.expected !== "string" || !b.expected) throw new HrError("expected must name the settlement you reviewed (its fingerprint).", 400);
      if (b.expected !== s.fingerprint) throw new HrError("This is not the settlement you reviewed. Reload it and review it again.", 409, "GOSI_SETTLEMENT_CHANGED");
      await lock(tx, `gosi-settle:${s.invoiceId}`);
      const { row } = await currentDifference(tx, s.invoiceId, { employeeId: s.employeeId, scheme: s.scheme, branch: s.branch, share: s.share as Share });
      if (!new Prisma.Decimal(row.difference).equals(s.difference)) throw new HrError("The difference changed after this settlement was proposed (payroll or the invoice changed), so it is stale. Withdraw it and propose again.", 409, "GOSI_SETTLEMENT_STALE");
      await tx.hrGosiSettlement.update({ where: { id }, data: { status: "APPROVED", decidedBy: actor.id, decidedAt: now, decisionNote: note } });
      // P-2 rev3 item 3: a booking decision books only under its case's ENABLED treatment; otherwise
      // it is recorded, stays OPEN and flagged in the register, and nothing is posted.
      const booked = BOOKING_ACTIONS.has(s.action) ? await bookUnderTreatment(tx, { ...s, status: "APPROVED" }, actor.id, today) : null;
      const open = !booked;
      const treatment = s.treatmentCase ? await tx.hrGosiTreatment.findUnique({ where: { caseCode: s.treatmentCase } }) : null;
      await audit(tx, { action: "GOSI_SETTLEMENT_APPROVE", entityType: "HrGosiSettlement", entityId: id, employeeId: s.employeeId, after: { fingerprint: s.fingerprint, adjustmentId: booked?.adjustmentId ?? null, amount: s.difference.toFixed(2), action: s.action, treatmentCase: s.treatmentCase, treatmentEnabled: treatment?.enabled ?? false, journalEntryId: booked?.journalEntryId ?? null, open, proposedBy: s.proposedBy, approvedBy: actor.id }, reason: note, actorId: actor.id });
      return { id, status: "APPROVED", applied: !open, open, booked: !!booked, treatmentCase: s.treatmentCase, treatmentEnabled: treatment?.enabled ?? false, adjustmentId: booked?.adjustmentId ?? null, journalEntryId: booked?.journalEntryId ?? null };
    }, TX);
  } catch (e) {
    if (e instanceof HrError) throw e;
    mapDbError(e);
  }
}

/**
 * Resolve an OPEN decision: PAYROLL_CORRECTION → the APPROVED / PAID correction run of that month
 * (approved after the decision) that carries the correction; INVOICE_DISPUTE → INVOICE_CORRECTED or
 * DISPUTE_REJECTED with GOSI's reference; NO_ADJUSTMENT → ACCEPTED with the written acceptance's
 * reference. Nothing is booked or zeroed: a correction run changes the payroll side itself, so the
 * difference is counted once. Append-only (DB).
 */
export async function resolveGosiSettlement(actor: HrActor, id: string, b: Record<string, unknown>) {
  assertAny(actor, ["payroll_prepare", "payroll_approve"]);
  await assertCompanyWide(actor);
  await assertVerifiedActor(actor, "GOSI_SETTLEMENT_RESOLVE");
  const reference = reqText(b.reference, "reference", 200, 3);
  const note = text(b.note, "note", { max: 500 });
  try {
    return await prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT 1 FROM "HrGosiSettlement" WHERE "id" = ${id} FOR UPDATE`;
      const s = await tx.hrGosiSettlement.findUnique({ where: { id }, include: { resolution: true } });
      if (!s) throw new HrError("GOSI settlement not found", 404);
      if (s.status !== "APPROVED" || BOOKING_ACTIONS.has(s.action)) throw new HrError("Only an approved decision that does not book an entry (correction, dispute, acceptance) is resolved; a booking decision is booked under its treatment.", 409);
      if (s.resolution) throw new HrError("This decision is already resolved.", 409);
      let outcome: string, correctionRunId: string | null = null;
      if (s.action === "PAYROLL_CORRECTION") {
        outcome = "CORRECTION_RUN";
        correctionRunId = reqText(b.correctionRunId, "correctionRunId", 40);
        const run = await tx.hrPayrollRun.findUnique({ where: { id: correctionRunId } });
        if (!run || run.kind !== "CORRECTION" || !["APPROVED", "PAID"].includes(run.status) || run.periodMonth !== s.periodMonth || (run.approvedAt && s.decidedAt && run.approvedAt < s.decidedAt)) throw new HrError(`correctionRunId must name an APPROVED or PAID correction run of ${s.periodMonth}, approved after the decision.`, 400);
      } else if (s.action === "INVOICE_DISPUTE") outcome = oneOf(b.outcome, "outcome", ["INVOICE_CORRECTED", "DISPUTE_REJECTED"] as const);
      else outcome = "ACCEPTED";
      const r = await tx.hrGosiResolution.create({ data: { settlementId: id, outcome, correctionRunId, reference, note, resolvedBy: actor.id } });
      await audit(tx, { action: "GOSI_SETTLEMENT_RESOLVE", entityType: "HrGosiSettlement", entityId: id, employeeId: s.employeeId, after: { outcome, correctionRunId, reference, resolutionId: r.id }, reason: note, actorId: actor.id });
      return { id, resolution: { id: r.id, outcome, correctionRunId, reference } };
    }, TX);
  } catch (e) {
    if (e instanceof HrError) throw e;
    mapDbError(e);
  }
}

/**
 * Book an APPROVED booking decision under its case's treatment, once that treatment is enabled
 * (two-person GOSI_TREATMENT_SET). Posts nothing while the treatment is disabled: returns null and
 * the decision stays OPEN in the register. Exactly once: the adjustment is unique per decision, the
 * journal link unique per (GOSI_SETTLEMENT, decision, ADJUSTMENT), and a booked decision is never
 * booked again; the difference must still be the one decided (else stale).
 */
async function bookUnderTreatment(tx: Tx, s: Prisma.HrGosiSettlementGetPayload<object>, actorId: string, today: Date): Promise<{ adjustmentId: string; journalEntryId: string | null } | null> {
  if (!s.treatmentCase) return null;
  const t = await tx.hrGosiTreatment.findUnique({ where: { caseCode: s.treatmentCase } });
  if (!t?.enabled || !t.debitKey || !t.creditKey) return null;
  const prior = await tx.hrGosiAdjustment.findUnique({ where: { settlementId: s.id } });
  if (prior) return { adjustmentId: prior.id, journalEntryId: prior.journalEntryId };
  // Phase 1 lock: booking under an enabled treatment posts a journal (also when a decision books it).
  await assertPayrollLive("GOSI_BOOK", tx);
  if (s.treatmentCase === "CASE_8_DISPUTED") {
    // The reclass applies only to an invoice paid in full while disputed (D-4h case 8).
    const inv = await tx.hrGosiInvoice.findUniqueOrThrow({ where: { id: s.invoiceId } });
    if (!["PAID", "CLOSED"].includes(inv.stage)) throw new HrError("A disputed difference is reclassed only once the invoice is paid in full (D-4h case 8).", 409, "GOSI_TREATMENT_NOT_APPLICABLE");
  }
  const amt = s.difference.abs();
  const side = caseLines(s.treatmentCase as GosiCase, t.debitKey, t.creditKey, s.difference.toNumber());
  // Refused (409 ACCOUNTING_REQUIRED / ACCOUNT_MAP, audited) while HR accounting is off or a key is unmapped.
  const j = await postHrJournal(tx, {
    sourceType: "GOSI_SETTLEMENT", sourceId: s.id, purpose: "ADJUSTMENT", date: today, actorId,
    description: `GOSI ${s.periodMonth} · ${s.scheme}/${s.branch} ${s.share} difference · ${s.treatmentCase} (${t.decisionReference})`,
    lines: [{ key: side.debit as AccountKey, debit: amt, description: `GOSI ${s.periodMonth} difference` }, { key: side.credit as AccountKey, credit: amt, description: `GOSI ${s.periodMonth} difference` }],
  });
  const adj = await tx.hrGosiAdjustment.create({ data: { settlementId: s.id, periodMonth: s.periodMonth, employeeId: s.employeeId, scheme: s.scheme, branch: s.branch, share: s.share, amount: s.difference, action: s.action, journalEntryId: j.journalEntryId, treatmentCase: s.treatmentCase, debitKey: t.debitKey, creditKey: t.creditKey, createdBy: actorId } });
  return { adjustmentId: adj.id, journalEntryId: j.journalEntryId };
}

/**
 * P-2 rev3 item 3: book an approved decision that was recorded while its treatment was disabled,
 * now that the accountant enabled it. A person other than the proposer, with the approval duty.
 * Refused while the treatment is still disabled (nothing posted), when the difference changed since
 * the decision (stale), or when it is already booked (no double posting).
 */
export async function bookGosiSettlement(actor: HrActor, id: string, today: Date) {
  assertCan(actor, "payroll_approve");
  assertFresh(actor);
  await assertCompanyWide(actor);
  await assertPayrollLive("GOSI_BOOK");
  await assertVerifiedActor(actor, "GOSI_SETTLEMENT_BOOK");
  try {
    return await prisma.$transaction(async (tx) => {
      await assertPayrollLive("GOSI_BOOK", tx); // F8: again inside the transaction
      await tx.$queryRaw`SELECT 1 FROM "HrGosiSettlement" WHERE "id" = ${id} FOR UPDATE`;
      const s = await tx.hrGosiSettlement.findUnique({ where: { id }, include: { adjustment: true } });
      if (!s) throw new HrError("GOSI settlement not found", 404);
      if (s.status !== "APPROVED" || !BOOKING_ACTIONS.has(s.action)) throw new HrError("Only an approved booking decision is booked.", 409);
      if (s.adjustment) throw new HrError("This decision is already booked; it is never booked twice.", 409, "GOSI_ALREADY_BOOKED");
      if (await samePersonAsAny(tx, [s.proposedBy], actor.id)) throw new HrError("You proposed this decision; another person books it.", 403, "SELF_ACTION");
      await lock(tx, `gosi-settle:${s.invoiceId}`);
      const { row } = await currentDifference(tx, s.invoiceId, { employeeId: s.employeeId, scheme: s.scheme, branch: s.branch, share: s.share as Share });
      if (!new Prisma.Decimal(row.difference).equals(s.difference)) throw new HrError("The difference changed after this decision (payroll or the invoice changed), so it is stale. Propose it again.", 409, "GOSI_SETTLEMENT_STALE");
      const t = s.treatmentCase ? await tx.hrGosiTreatment.findUnique({ where: { caseCode: s.treatmentCase } }) : null;
      if (!t?.enabled) throw new HrError(`The treatment of ${s.treatmentCase ?? "this decision"} is not enabled (no approved accountant decision and keys), so nothing is booked; the difference stays open in the register.`, 409, "GOSI_TREATMENT_DISABLED");
      const booked = await bookUnderTreatment(tx, s, actor.id, today);
      await audit(tx, { action: "GOSI_SETTLEMENT_BOOK", entityType: "HrGosiSettlement", entityId: id, employeeId: s.employeeId, after: { treatmentCase: s.treatmentCase, debitKey: t.debitKey, creditKey: t.creditKey, decisionReference: t.decisionReference, amount: s.difference.toFixed(2), ...booked }, actorId: actor.id });
      return { id, booked: true, ...booked };
    }, TX);
  } catch (e) {
    if (e instanceof HrError) throw e;
    if ((e as { code?: string }).code === "P2002") throw new HrError("This decision is already booked; it is never booked twice.", 409, "GOSI_ALREADY_BOOKED");
    mapDbError(e);
  }
}

/** P-2 rev3 item 3: the D-4h matrix as it stands (every case disabled until the accountant decides). */
export async function listGosiTreatments(actor: HrActor) {
  assertAny(actor, ["payroll_prepare", "payroll_approve", "policy_manage"]);
  const rows = await prisma.hrGosiTreatment.findMany();
  const by = new Map(rows.map((r) => [r.caseCode, r]));
  return GOSI_TREATMENT_CASES.map((c) => {
    const r = by.get(c);
    return { caseCode: c, action: GOSI_CASE_RULES[c].action, share: GOSI_CASE_RULES[c].share, sign: GOSI_CASE_RULES[c].sign, posting: GOSI_CASE_RULES[c].posting, proposedEntry: GOSI_CASE_RULES[c].proposed, enabled: r?.enabled ?? false, debitKey: r?.debitKey ?? null, creditKey: r?.creditKey ?? null, decisionReference: r?.decisionReference ?? null, approvedAt: r?.approvedAt ?? null, configChangeId: r?.configChangeId ?? null };
  });
}

export async function withdrawGosiSettlement(actor: HrActor, id: string, b: Record<string, unknown>) {
  assertCan(actor, "payroll_prepare");
  const note = text(b.note, "note", { max: 500 });
  return prisma.$transaction(async (tx) => {
    const s = await tx.hrGosiSettlement.findUnique({ where: { id } });
    if (!s) throw new HrError("GOSI settlement not found", 404);
    if (s.proposedBy !== actor.id) throw new HrError("Only the person who proposed this settlement can withdraw it.", 403, "NOT_REQUESTER");
    const n = await tx.hrGosiSettlement.updateMany({ where: { id, status: "PENDING" }, data: { status: "WITHDRAWN", decidedAt: new Date(), decisionNote: note } });
    if (n.count !== 1) throw new HrError("Only a pending settlement can be withdrawn.", 409);
    await audit(tx, { action: "GOSI_SETTLEMENT_WITHDRAW", entityType: "HrGosiSettlement", entityId: id, employeeId: s.employeeId, reason: note, actorId: actor.id });
    return { id, status: "WITHDRAWN" };
  }, TX);
}

export async function listGosiInvoices(actor: HrActor) {
  assertAny(actor, ["payroll_prepare", "payroll_approve"]);
  await assertCompanyWide(actor);
  const rows = await prisma.hrGosiInvoice.findMany({ orderBy: [{ periodMonth: "desc" }, { enteredAt: "desc" }], take: 120, include: { _count: { select: { lines: true } }, payments: { select: { amount: true } } } });
  return rows.map((r) => ({
    id: r.id, periodMonth: r.periodMonth, reference: r.reference, source: r.source, status: r.status, stage: r.stage, lines: r._count.lines, totalEmployee: r.totalEmployee.toFixed(2), totalEmployer: r.totalEmployer.toFixed(2),
    enteredAt: r.enteredAt, voidReason: r.voidReason, voidRequested: !!r.voidRequestedBy, sourceFileName: r.sourceFileName, sourceFileSha256: r.sourceFileSha256,
    reconcileDigest: r.reconcileDigest, approvedAt: r.approvedAt, paidOn: r.paidOn ? dayString(r.paidOn) : null, paidAmount: r.paidAmount?.toFixed(2) ?? null, paymentReference: r.paymentReference, closedAt: r.closedAt,
    // P-2 rev3 item 3: bank reality, apart from the difference status (see the reconciliation).
    paymentStatus: paymentStatusOf(r, r.payments.reduce((s, p) => s.plus(p.amount), ZERO)), paid: r.payments.length ? r.payments.reduce((s, p) => s.plus(p.amount), ZERO).toFixed(2) : r.paidAmount?.toFixed(2) ?? "0.00",
  }));
}

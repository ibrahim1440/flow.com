// Native HR — salary advances.
//
// REQUESTED → APPROVED (by someone who is neither the requester nor the person) →
// DISBURSED (recorded by someone other than the approver; no money moves) → CLOSED when
// nothing is outstanding. Installments: SCHEDULED → RESERVED by exactly one payroll run →
// SETTLED when that run's payment is recorded. A manual repayment COVERS installments from
// the end of the schedule. Outstanding = amount − settled installments − repayments.
import { Prisma } from "@/generated/prisma/client";
import { prisma } from "@/lib/db";
import { HrError, type HrActor, type Db, TX, accountNames, assertCan, can, resolveScope, personInScope, inScope, audit, lock, assertNotSelf, int, oneOf, reqText, text, mapDbError, assertFresh } from "../core";
import { assertPayrollLive } from "../payroll-lock";
import { addMonths, dayString, isDay, isMonth, monthBounds, monthOf, parseDay } from "../dates";
import { parseAmount } from "../money";
import { nextNumber } from "./people";
import { postHrJournal } from "./accounting-bridge";
import { activePolicyFor } from "./policy";
import { deductionPolicyGaps, loanCapPercent } from "../deductions";
import { isSimpleMode } from "@/lib/simple-mode";

const D = (v: string | number | Prisma.Decimal) => new Prisma.Decimal(v);
const ZERO = D(0);

async function guarded<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    if (e instanceof HrError) throw e;
    mapDbError(e);
  }
}

function amountArg(v: unknown, field = "amount") {
  try {
    return D(parseAmount(v).toString());
  } catch (e) {
    throw new HrError(`${field}: ${(e as Error).message}`, 400);
  }
}

/** Split an amount into n installments of 2-decimal amounts; the last absorbs the remainder. */
export function schedule(amount: Prisma.Decimal, n: number, firstMonth: string) {
  const each = amount.dividedBy(n).toDecimalPlaces(2, Prisma.Decimal.ROUND_DOWN);
  const out: { seq: number; dueMonth: string; amount: Prisma.Decimal }[] = [];
  for (let i = 0; i < n; i++) out.push({ seq: i + 1, dueMonth: addMonths(firstMonth, i), amount: i === n - 1 ? amount.minus(each.times(n - 1)) : each });
  return out.filter((x) => x.amount.greaterThan(0));
}

export type CapCheck =
  | { ok: true; cap: string; largestInstallment: string; monthlyGross: string; maxDeductionPercent: string; policyVersion: number; month: string }
  | { ok: false; code: "INSTALLMENT_OVER_CAP"; cap: string; largestInstallment: string; monthlyGross: string; maxDeductionPercent: string; policyVersion: number; minInstallments: number | null; month: string }
  | { ok: false; code: "NO_POLICY" }
  | { ok: false; code: "NO_COMPENSATION" }
  | { ok: false; code: "DEDUCTION_POLICY_UNSET"; policyVersion: number; gaps: string[] };

/**
 * F2 / finding 2 (structural part): would every installment of this schedule fit under the
 * payslip deduction cap at all? The cap is the policy's percentage of the person's full-month
 * fixed pay (basic + allowances, the compensation in force in the first installment month) —
 * exactly what the payroll engine applies to a full month. An installment above it would be
 * deferred every month and never recovered by payroll. This is a necessary condition only:
 * other deductions in a month can still defer an installment (that is the engine's normal,
 * capped behaviour). Which deductions count toward the cap is a policy question for the accountant.
 *
 * P-2 finding 2: the percentage is the policy's LOAN_RECOVERY category cap — and also the overall
 * cap when the policy says the overall cap covers loan recovery (the lower of the two). Both are
 * accountant decisions: while the version leaves any deduction setting unset, the check cannot be
 * made (DEDUCTION_POLICY_UNSET) and approval refuses. The base is always guaranteed fixed pay:
 * a fixed schedule never relies on commission or overtime. The same check runs again when a
 * reschedule is requested and approved, and every payroll run re-applies the caps.
 */
export async function installmentCapCheck(db: Db, employeeId: string, amount: Prisma.Decimal, count: number, firstMonth: string): Promise<CapCheck> {
  // Review P2-B7 (S-3.4.1): EVERY installment is checked against the cap of ITS OWN month — the
  // policy in force that month and the guaranteed fixed pay in force at its start — not only the
  // first month's.
  type MonthCap = { ok: true; cap: Prisma.Decimal; gross: Prisma.Decimal; pct: Prisma.Decimal; policyVersion: number } | Exclude<CapCheck, { ok: true } | { code: "INSTALLMENT_OVER_CAP" }>;
  const caps = new Map<string, MonthCap>();
  const capOf = async (month: string): Promise<MonthCap> => {
    const hit = caps.get(month);
    if (hit) return hit;
    const { start, end } = monthBounds(month);
    const policy = await activePolicyFor(db, end);
    let r: MonthCap;
    if (!policy) r = { ok: false, code: "NO_POLICY" };
    else {
      const comp = (await db.hrCompensation.findFirst({ where: { employeeId, effectiveFrom: { lte: start }, OR: [{ effectiveTo: null }, { effectiveTo: { gte: start } }] }, orderBy: { effectiveFrom: "desc" } }))
        ?? (await db.hrCompensation.findFirst({ where: { employeeId, effectiveFrom: { lte: end } }, orderBy: { effectiveFrom: "desc" } }))
        ?? (await db.hrCompensation.findFirst({ where: { employeeId }, orderBy: { effectiveFrom: "desc" } }));
      const loanPct = loanCapPercent(policy);
      if (!comp) r = { ok: false, code: "NO_COMPENSATION" };
      else if (loanPct === null) r = { ok: false, code: "DEDUCTION_POLICY_UNSET", policyVersion: policy.version, gaps: deductionPolicyGaps(policy) };
      else {
        const pct = policy.deductionOverallCovers.includes("LOAN_RECOVERY") && policy.maxDeductionPercent.lessThan(loanPct) ? policy.maxDeductionPercent : loanPct;
        const gross = comp.basic.plus(comp.housing).plus(comp.transport).plus(comp.otherAllowance);
        r = { ok: true, cap: gross.times(pct).dividedBy(100).toDecimalPlaces(2, Prisma.Decimal.ROUND_HALF_UP), gross, pct, policyVersion: policy.version };
      }
    }
    caps.set(month, r);
    return r;
  };
  /** The first installment of an n-schedule that does not fit its month, or a reason it cannot be checked. */
  const check = async (n: number) => {
    let largest = ZERO, first: { month: string; amount: Prisma.Decimal; c: Extract<MonthCap, { ok: true }> } | null = null, worst: Extract<MonthCap, { ok: true }> | null = null, worstMonth = firstMonth;
    for (const i of schedule(amount, n, firstMonth)) {
      const c = await capOf(i.dueMonth);
      if (!c.ok) return { blocked: c };
      if (i.amount.greaterThan(largest)) largest = i.amount;
      if (!worst || c.cap.lessThan(worst.cap)) { worst = c; worstMonth = i.dueMonth; }
      if (!first && i.amount.greaterThan(c.cap)) first = { month: i.dueMonth, amount: i.amount, c };
    }
    return { largest, first, worst: worst!, worstMonth };
  };
  const r = await check(count);
  if ("blocked" in r) return r.blocked as CapCheck;
  const at = r.first ? r.first.c : r.worst;
  const facts = { cap: at.cap.toFixed(2), largestInstallment: (r.first?.amount ?? r.largest).toFixed(2), monthlyGross: at.gross.toFixed(2), maxDeductionPercent: at.pct.toString(), policyVersion: at.policyVersion, month: r.first?.month ?? r.worstMonth };
  if (!r.first) return { ok: true, ...facts };
  let minInstallments: number | null = null;
  if (at.cap.greaterThan(0)) for (let n = count + 1; n <= 120; n++) { const x = await check(n); if (!("blocked" in x) && !x.first) { minInstallments = n; break; } }
  return { ok: false, code: "INSTALLMENT_OVER_CAP", ...facts, minInstallments };
}

export function capRefusal(c: Exclude<CapCheck, { ok: true }>): HrError {
  if (c.code === "NO_POLICY") return new HrError("No payroll policy is in force for the first installment month, so the installments cannot be checked against the deduction cap.", 409, "NO_POLICY");
  if (c.code === "NO_COMPENSATION") return new HrError("This person has no recorded pay, so the installments cannot be checked against the deduction cap.", 409, "NO_COMPENSATION");
  if (c.code === "DEDUCTION_POLICY_UNSET") return new HrError(`Payroll policy v${c.policyVersion} has deduction settings the accountant has not decided yet (${c.gaps.join(", ")}), so the installments cannot be checked against the deduction cap.`, 409, "DEDUCTION_POLICY_UNSET");
  return new HrError(
    `An installment of ${c.largestInstallment} due ${c.month} is above that month's deduction cap of ${c.cap} (${c.maxDeductionPercent}% of the monthly pay ${c.monthlyGross}, policy v${c.policyVersion}), so payroll could never deduct it. ${c.minInstallments ? `Spread the advance over at least ${c.minInstallments} installments.` : "Reduce the amount."}`,
    409, "INSTALLMENT_OVER_CAP",
  );
}

export async function outstanding(db: Db, advanceId: string) {
  const a = await db.hrAdvance.findUniqueOrThrow({ where: { id: advanceId }, include: { installments: true, repayments: true } });
  const settled = a.installments.filter((i) => i.status === "SETTLED").reduce((s, i) => s.plus(i.amount), ZERO);
  const reserved = a.installments.filter((i) => i.status === "RESERVED").reduce((s, i) => s.plus(i.amount), ZERO);
  const repaid = a.repayments.reduce((s, r) => s.plus(r.amount), ZERO);
  const out = a.status === "DISBURSED" || a.status === "CLOSED" ? a.amount.minus(settled).minus(repaid) : ZERO;
  return { advance: a, settled, reserved, repaid, outstanding: out, unreserved: out.minus(reserved) };
}

export async function advanceDto(db: Db, id: string) {
  const o = await outstanding(db, id);
  const a = o.advance;
  // Shown to the requester and the approver before the decision (F2 / finding 2).
  const capCheck = a.status === "REQUESTED" ? await installmentCapCheck(db, a.employeeId, a.amount, a.installmentCount, a.firstInstallmentMonth) : null;
  return {
    capCheck,
    id: a.id, advanceNo: a.advanceNo, employeeId: a.employeeId, amount: a.amount.toFixed(2), installmentCount: a.installmentCount, firstInstallmentMonth: a.firstInstallmentMonth,
    reason: a.reason, status: a.status, cancelReason: a.cancelReason, requestedBy: a.requestedBy, createdAt: a.createdAt, decidedBy: a.decidedBy, decidedAt: a.decidedAt, decisionNote: a.decisionNote,
    disbursedBy: a.disbursedBy, disbursedOn: a.disbursedOn ? dayString(a.disbursedOn) : null, disbursementRef: a.disbursementRef, closedAt: a.closedAt,
    settled: o.settled.toFixed(2), reserved: o.reserved.toFixed(2), repaid: o.repaid.toFixed(2), outstanding: o.outstanding.toFixed(2),
    installments: a.installments.sort((x, y) => x.seq - y.seq).map((i) => ({ id: i.id, seq: i.seq, dueMonth: i.dueMonth, amount: i.amount.toFixed(2), status: i.status, payrollRunId: i.payrollRunId })),
    repayments: a.repayments.map((r) => ({ id: r.id, amount: r.amount.toFixed(2), paidOn: dayString(r.paidOn), method: r.method, reference: r.reference })),
  };
}

export async function requestAdvance(actor: HrActor, b: Record<string, unknown>, opts: { selfEmployeeId?: string; today: Date }) {
  const employeeId = opts.selfEmployeeId ?? reqText(b.employeeId, "employeeId", 40);
  if (!opts.selfEmployeeId) assertCan(actor, "advances_manage");
  const amount = amountArg(b.amount);
  const installmentCount = int(b.installmentCount, "installmentCount", { min: 1, max: 120, required: true }) as number;
  const firstInstallmentMonth = typeof b.firstInstallmentMonth === "string" ? b.firstInstallmentMonth : "";
  if (!isMonth(firstInstallmentMonth)) throw new HrError("firstInstallmentMonth must look like 2026-11.", 400);
  if (firstInstallmentMonth < monthOf(opts.today)) throw new HrError("Installments cannot start in a past month.", 400);
  const reason = reqText(b.reason, "reason", 500, 3);
  return guarded(() => prisma.$transaction(async (tx) => {
    const person = opts.selfEmployeeId ? await tx.hrEmployee.findUniqueOrThrow({ where: { id: employeeId } }) : await personInScope(tx, await resolveScope(actor, tx), employeeId);
    if (person.status === "SEPARATED" || person.status === "NOTICE") throw new HrError("Advances are not available during notice or after separation.", 409);
    await lock(tx, `advance:${employeeId}`);
    // E-5: a schedule whose installment can never fit the cap is refused at request too (approval
    // re-checks, and also refuses when the cap cannot be checked at all).
    const cap = await installmentCapCheck(tx, employeeId, amount, installmentCount, firstInstallmentMonth);
    if (!cap.ok && cap.code === "INSTALLMENT_OVER_CAP") throw capRefusal(cap);
    const open = await tx.hrAdvance.findFirst({ where: { employeeId, status: { in: ["REQUESTED", "APPROVED", "DISBURSED"] } } });
    if (open) throw new HrError(`Advance ${open.advanceNo} is still open (${open.status}). One open advance per person (proposed policy).`, 409, "OPEN_ADVANCE");
    const advanceNo = await nextNumber(tx, "ADV-", "advance");
    const a = await tx.hrAdvance.create({ data: { advanceNo, employeeId, amount, installmentCount, firstInstallmentMonth, reason, requestedBy: actor.id } });
    await audit(tx, { action: "ADVANCE_REQUEST", entityType: "HrAdvance", entityId: a.id, employeeId, after: { advanceNo, amount: amount.toFixed(2), installmentCount, firstInstallmentMonth }, actorId: actor.id });
    return advanceDto(tx, a.id);
  }, TX));
}

export async function decideAdvance(actor: HrActor, id: string, b: Record<string, unknown>) {
  assertCan(actor, "advances_approve");
  const decision = oneOf(b.decision, "decision", ["APPROVE", "REJECT"] as const);
  const note = text(b.note, "note", { max: 500 });
  if (decision === "REJECT" && !note) throw new HrError("A reason is required to reject.", 400);
  return guarded(() => prisma.$transaction(async (tx) => {
    const a = await tx.hrAdvance.findUnique({ where: { id }, include: { employee: true } });
    if (!a || !inScope(await resolveScope(actor, tx), a.employee)) throw new HrError("Advance not found", 404);
    assertNotSelf(actor, a.employee, "decide an advance");
    // SIMPLE MODE: a single owner may decide their own request / act on their own record.
    if (!isSimpleMode() && (a.requestedBy === actor.id)) throw new HrError("You recorded this request; another approver must decide it.", 403, "SELF_ACTION");
    if (decision === "APPROVE") {
      await lock(tx, `advance:${a.employeeId}`);
      const c = await installmentCapCheck(tx, a.employeeId, a.amount, a.installmentCount, a.firstInstallmentMonth);
      if (!c.ok) throw capRefusal(c);
    }
    const r = await tx.hrAdvance.updateMany({ where: { id, status: "REQUESTED" }, data: { status: decision === "APPROVE" ? "APPROVED" : "REJECTED", decidedBy: actor.id, decidedAt: new Date(), decisionNote: note } });
    if (r.count !== 1) throw new HrError("Only a requested advance can be decided.", 409);
    await audit(tx, { action: `ADVANCE_${decision}`, entityType: "HrAdvance", entityId: id, employeeId: a.employeeId, reason: note, actorId: actor.id });
    return advanceDto(tx, id);
  }, TX));
}

export async function disburseAdvance(actor: HrActor, id: string, b: Record<string, unknown>) {
  assertCan(actor, "advances_disburse");
  // Re-test AUTH-D: a disbursement is a payment — it needs a recent step-up.
  assertFresh(actor);
  // Phase 1 lock: a disbursement moves money and posts a journal.
  await assertPayrollLive("ADVANCE_DISBURSE");
  if (!isDay(b.paidOn)) throw new HrError("paidOn must be a date.", 400);
  const paidOn = parseDay(b.paidOn);
  const reference = reqText(b.reference, "reference", 120);
  return guarded(() => prisma.$transaction(async (tx) => {
    await assertPayrollLive("ADVANCE_DISBURSE", tx); // F8: again inside the transaction
    const a = await tx.hrAdvance.findUnique({ where: { id }, include: { employee: true } });
    if (!a || !inScope(await resolveScope(actor, tx), a.employee)) throw new HrError("Advance not found", 404);
    assertNotSelf(actor, a.employee, "disburse an advance");
    // SIMPLE MODE: a single owner may decide their own request / act on their own record.
    if (!isSimpleMode() && (a.decidedBy === actor.id)) throw new HrError("The approver cannot also record the disbursement.", 403, "SELF_ACTION");
    await lock(tx, `advance:${a.employeeId}`);
    const r = await tx.hrAdvance.updateMany({ where: { id, status: "APPROVED" }, data: { status: "DISBURSED", disbursedBy: actor.id, disbursedAt: new Date(), disbursedOn: paidOn, disbursementRef: reference } });
    if (r.count !== 1) throw new HrError("Only an approved advance can be disbursed.", 409);
    for (const s of schedule(a.amount, a.installmentCount, a.firstInstallmentMonth)) await tx.hrAdvanceInstallment.create({ data: { advanceId: id, ...s } });
    const j = await postHrJournal(tx, {
      sourceType: "ADVANCE", sourceId: id, purpose: "DISBURSEMENT", date: paidOn, actorId: actor.id,
      description: `HR advance ${a.advanceNo} disbursed (${reference})`,
      lines: [
        { key: "ADVANCES_RECEIVABLE", debit: a.amount, description: `Advance ${a.advanceNo}` },
        { key: "PAYROLL_CASH", credit: a.amount, description: `Advance ${a.advanceNo}` },
      ],
    });
    await audit(tx, { action: "ADVANCE_DISBURSE", entityType: "HrAdvance", entityId: id, employeeId: a.employeeId, after: { paidOn: dayString(paidOn), reference, journalEntryId: j.journalEntryId, accountingSkipped: j.skipped }, actorId: actor.id });
    return { ...(await advanceDto(tx, id)), journalEntryId: j.journalEntryId, accountingSkipped: j.skipped };
  }, TX));
}

export async function repayAdvance(actor: HrActor, id: string, b: Record<string, unknown>) {
  assertCan(actor, "advances_manage");
  // Phase 1 lock: a repayment moves money and posts a journal.
  await assertPayrollLive("ADVANCE_REPAY");
  const amount = amountArg(b.amount);
  if (!isDay(b.paidOn)) throw new HrError("paidOn must be a date.", 400);
  const paidOn = parseDay(b.paidOn);
  const method = oneOf(b.method, "method", ["BANK_TRANSFER", "CASH", "CHEQUE"] as const);
  const reference = reqText(b.reference, "reference", 120);
  return guarded(() => prisma.$transaction(async (tx) => {
    await assertPayrollLive("ADVANCE_REPAY", tx); // F8: again inside the transaction
    const a0 = await tx.hrAdvance.findUnique({ where: { id }, include: { employee: true } });
    if (!a0 || !inScope(await resolveScope(actor, tx), a0.employee)) throw new HrError("Advance not found", 404);
    assertNotSelf(actor, a0.employee, "record a repayment");
    await lock(tx, `advance:${a0.employeeId}`);
    const o = await outstanding(tx, id);
    if (o.advance.status !== "DISBURSED") throw new HrError("Only a disbursed advance takes repayments.", 409);
    if (amount.greaterThan(o.unreserved)) throw new HrError(`At most ${o.unreserved.toFixed(2)} can be repaid now (${o.reserved.toFixed(2)} is reserved by a payroll run).`, 409, "OVER_REPAYMENT");
    const rep = await tx.hrAdvanceRepayment.create({ data: { advanceId: id, amount, paidOn, method, reference, recordedBy: actor.id } });
    // Cover scheduled installments from the END of the schedule (P-2: also installments HELD out
    // of payroll by an approved collection procedure — a repayment is how those are collected).
    let left = amount;
    const sched = o.advance.installments.filter((i) => i.status === "SCHEDULED" || i.status === "HELD").sort((x, y) => y.seq - x.seq);
    for (const i of sched) {
      if (left.lessThanOrEqualTo(0)) break;
      if (left.greaterThanOrEqualTo(i.amount)) {
        await tx.hrAdvanceInstallment.update({ where: { id: i.id }, data: { status: "COVERED" } });
        left = left.minus(i.amount);
      } else {
        await tx.hrAdvanceInstallment.update({ where: { id: i.id }, data: { amount: i.amount.minus(left) } });
        left = ZERO;
      }
    }
    // The repayment journal follows how the disbursement was booked (F2 / finding 9).
    const disbursed = await tx.hrJournalLink.findUnique({ where: { sourceType_sourceId_purpose: { sourceType: "ADVANCE", sourceId: id, purpose: "DISBURSEMENT" } } });
    const j = await postHrJournal(tx, {
      mode: disbursed ? "required" : "skip",
      sourceType: "ADVANCE_REPAYMENT", sourceId: rep.id, purpose: "REPAYMENT", date: paidOn, actorId: actor.id,
      description: `HR advance ${o.advance.advanceNo} repayment (${reference})`,
      lines: [
        { key: "PAYROLL_CASH", debit: amount, description: `Repayment ${o.advance.advanceNo}` },
        { key: "ADVANCES_RECEIVABLE", credit: amount, description: `Repayment ${o.advance.advanceNo}` },
      ],
    });
    await audit(tx, { action: "ADVANCE_REPAYMENT", entityType: "HrAdvance", entityId: id, employeeId: o.advance.employeeId, after: { amount: amount.toFixed(2), reference, journalEntryId: j.journalEntryId }, actorId: actor.id });
    await closeIfDone(tx, id, actor.id);
    return advanceDto(tx, id);
  }, TX));
}

/** Close when nothing is outstanding and nothing is reserved. Called after settlement and repayment. */
export async function closeIfDone(tx: Prisma.TransactionClient, id: string, actorId: string) {
  const o = await outstanding(tx, id);
  if (o.advance.status === "DISBURSED" && o.outstanding.lessThanOrEqualTo(0) && o.reserved.isZero()) {
    await tx.hrAdvance.update({ where: { id }, data: { status: "CLOSED", closedAt: new Date(), closedBy: actorId } });
    await audit(tx, { action: "ADVANCE_CLOSE", entityType: "HrAdvance", entityId: id, employeeId: o.advance.employeeId, actorId });
    return true;
  }
  return false;
}

export async function closeAdvance(actor: HrActor, id: string) {
  assertCan(actor, "advances_manage");
  return guarded(() => prisma.$transaction(async (tx) => {
    const a = await tx.hrAdvance.findUnique({ where: { id }, include: { employee: true } });
    if (!a || !inScope(await resolveScope(actor, tx), a.employee)) throw new HrError("Advance not found", 404);
    await lock(tx, `advance:${a.employeeId}`);
    const o = await outstanding(tx, id);
    if (o.outstanding.greaterThan(0) || o.reserved.greaterThan(0)) throw new HrError(`${o.outstanding.toFixed(2)} is still outstanding; it cannot be closed.`, 409);
    if (!(await closeIfDone(tx, id, actor.id))) throw new HrError(`An advance in status ${a.status} cannot be closed.`, 409);
    return advanceDto(tx, id);
  }, TX));
}

export async function cancelAdvance(actor: HrActor, id: string, b: Record<string, unknown>) {
  const reason = reqText(b.reason, "reason", 500, 3);
  return guarded(() => prisma.$transaction(async (tx) => {
    const a = await tx.hrAdvance.findUnique({ where: { id }, include: { employee: true } });
    if (!a) throw new HrError("Advance not found", 404);
    const own = a.employee.accountId === actor.id || a.requestedBy === actor.id;
    if (!own) {
      assertCan(actor, "advances_manage");
      if (!inScope(await resolveScope(actor, tx), a.employee)) throw new HrError("Advance not found", 404);
    }
    const r = await tx.hrAdvance.updateMany({ where: { id, status: { in: own && !can(actor, "advances_manage") ? ["REQUESTED"] : ["REQUESTED", "APPROVED"] } }, data: { status: "CANCELLED", cancelReason: reason } });
    if (r.count !== 1) throw new HrError("Only an advance that has not been disbursed can be cancelled.", 409);
    await audit(tx, { action: "ADVANCE_CANCEL", entityType: "HrAdvance", entityId: id, employeeId: a.employeeId, reason, actorId: actor.id });
    return advanceDto(tx, id);
  }, TX));
}

export async function listAdvances(actor: HrActor, q: { view?: string | null }) {
  if (!can(actor, "advances_manage") && !can(actor, "advances_approve") && !can(actor, "advances_disburse")) throw new HrError("Insufficient permissions", 403);
  const scope = await resolveScope(actor);
  const people = scope.all ? {} : { OR: [{ branchId: { in: scope.branchIds } }, { id: { in: scope.reportIds } }] };
  const status = q.view === "requested" ? ["REQUESTED"] : q.view === "approved" ? ["APPROVED"] : q.view === "open" ? ["DISBURSED"] : q.view === "closed" ? ["CLOSED", "REJECTED", "CANCELLED"] : undefined;
  const rows = await prisma.hrAdvance.findMany({ where: { employee: people, ...(status ? { status: { in: status as never } } : {}) }, include: { employee: { select: { id: true, fullNameAr: true, employeeNo: true, accountId: true } } }, orderBy: { createdAt: "desc" }, take: 200 });
  const names = await accountNames(prisma, rows.flatMap((r) => [r.requestedBy, r.decidedBy, r.disbursedBy]));
  return Promise.all(rows.map(async (r) => ({
    ...(await advanceDto(prisma, r.id)),
    employee: { id: r.employee.id, fullNameAr: r.employee.fullNameAr, employeeNo: r.employee.employeeNo },
    requestedByName: names.get(r.requestedBy) ?? null, decidedByName: r.decidedBy ? names.get(r.decidedBy) ?? null : null, disbursedByName: r.disbursedBy ? names.get(r.disbursedBy) ?? null : null,
    isSubject: r.employee.accountId === actor.id, isRequester: r.requestedBy === actor.id, isDecider: r.decidedBy === actor.id,
    isMine: r.employee.accountId === actor.id || r.requestedBy === actor.id,
  })));
}

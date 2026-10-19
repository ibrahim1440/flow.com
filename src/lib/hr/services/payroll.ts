// Native HR — payroll runs.
//
//   DRAFT ──submit──▶ REVIEW ──every line approved──▶ APPROVED ──payment = net──▶ PAID
//     │  ◀──return────┘                                 │
//     └──cancel──▶ CANCELLED ◀──cancel (journal reversed)┘
//
// • A DRAFT is (re)built from current inputs; building RESERVES what it uses: advance
//   installments (conditional update SCHEDULED → RESERVED), approved overtime (claimed by
//   run id) and commission periods (partial unique index). Rebuilding or cancelling
//   releases them. Two runs can never hold the same thing.
// • Approval is per line. Nobody approves a line of a run they prepared or a line that pays
//   themself; such a line waits for an independent approver. The run turns APPROVED only
//   when every line is approved (DB trigger re-checks), and the accrual journal posts then.
// • Lines and items are immutable once the run is APPROVED, PAID or CANCELLED (triggers).
// • Payment is RECORDED. The run becomes PAID when recorded payments equal the net total;
//   only then are installments and commission periods settled.
import { Prisma } from "@/generated/prisma/client";
import { prisma } from "@/lib/db";
import { HrError, type HrActor, type Db, TX, assertCan, assertAny, assertFresh, can, resolveScope, audit, lock, oneOf, reqText, text, mapDbError } from "../core";
import { dayString, isDay, isMonth, localDay, monthBounds, parseDay } from "../dates";
import { D as MD, parseAmount } from "../money";
import { reconcileRun, type Reconciliation } from "../reconcile";
import { assertVerifiedActor, personsOf, samePersonAsAny } from "../identity";
import { calculatePayroll, type Component, type EngineContribution, type EngineResult } from "../payroll-engine";
import { activePolicyFor } from "./policy";
import { unpaidLeaveDays } from "./leave";
import { payablePeriods, reservePeriod, releaseReservations, verifyReservations } from "./commission-bridge";
import { assertPostingReady, consolidate, postHrJournal, reverseHrJournal, type HrJournalLine } from "./accounting-bridge";
// P-2 controls (docs/hr/P2-CONTROLS.md): kept in their own modules; this file only calls them.
import { dedupeDays } from "../payroll-controls";
import { accrualDateOf, accrualPosting, assertSeparationEarningsApprovable, exportRows, lineControls, policyGate, separationEarningControls, separationPeopleOf } from "./payroll-controls";
import { assertJournalIntact, controlRefusal, externalAccountingTreatment, wasAudited } from "./journal-integrity";
// P-2 (agent B): deduction categories, deferral escalation, EOS misclassification refusal.
import { engineDeductionConfig } from "../deductions";
import { escalateDeferrals, escalatedAdvancesOf } from "./advance-recovery";
import { assertDuesPeriod, assertNotSettlementThroughPayroll, lockPeople } from "./final-settlement";
// P-2 review: closed adjustment categories (P1-B2) and attestation independence (P1-A1).
import { adjustmentPostingKey, looksLikeFinalSettlement, parseAdjustmentCategory, parseDuesEvidence } from "../adjustment-categories";
import { runApproverIds, runPreparerIds } from "./payroll-attest";
// P-2 rev3 item 2: proof of payment per employee (allocations, returns, bank result files).
import { assertPayrollLive } from "../payroll-lock";
import { isSimpleMode } from "@/lib/simple-mode";
import { isAuthorizedPayment, exportMarkerLine } from "../payroll-doc";
import { allocationsIn, bankRef, completeIfSettled, last4, parseBankResultCsv, proofAmount, reopenIfShort, runSettlement, settlementDto, sha256, usedReference, type AllocationIn } from "./payroll-proof";

type Tx = Prisma.TransactionClient;
const D = (v: string | number | Prisma.Decimal) => new Prisma.Decimal(v);
const ZERO = D(0);
const toPD = (v: { toString(): string }) => D(v.toString());

async function guarded<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    if (e instanceof HrError) throw e;
    mapDbError(e);
  }
}

// ── Segregation of duties (P-3, owner decision E4) ───────────────────────────────

/**
 * Everyone who PREPARED a run: who created it, rebuilt it, added an adjustment to it or
 * submitted it for approval. None of them may approve the run or record its payment. Read from
 * fields and audit rows that already exist (no schema change): `preparedBy`, `submittedBy`,
 * `HrPayrollAdjustment.createdBy`, and the actors of the run's preparation audit rows.
 */
export async function runPreparers(tx: Db, run: { id: string; preparedBy: string; submittedBy: string | null }): Promise<Set<string>> {
  return runPreparerIds(tx, run);
}

export const SOD_PREPARER = "SOD_PREPARER";
export const SOD_APPROVER = "SOD_APPROVER";
export const SOD_PAYEE = "SOD_PAYEE";

/** Who approved lines of the run (Q-1: none of them records its payment; Q-2: none cancels it after approval). */
export async function runApprovers(tx: Db, runId: string): Promise<Set<string>> {
  return runApproverIds(tx, runId);
}

/** Whether the actor is paid by a line of the run (Q-1: a payee never records the run's payment). */
async function isPayee(tx: Db, runId: string, actorId: string): Promise<boolean> {
  // SIMPLE MODE: a payee may record the run's payment (single owner).
  if (isSimpleMode()) return false;
  // The login linked now, OR the one linked when the line was built (QA P2-2)…
  if ((await tx.hrPayrollLine.count({ where: { runId, OR: [{ employee: { accountId: actorId } }, { snapshot: { path: ["payeeAccountId"], equals: actorId } }] } })) > 0) return true;
  // …OR the actor is (or was) the same PERSON as one of the run's payees (QA2 P2-2: a login once
  // linked to a payee cannot record that run's payment after being unlinked).
  const mine = await personsOf(tx, [actorId]);
  return mine.size > 0 && (await tx.hrPayrollLine.count({ where: { runId, employeeId: { in: [...mine] } } })) > 0;
}

/** Owner decision 1: separation by PERSON (see ../identity) — the login itself or the same person under another login. */
export async function involves(tx: Db, accounts: Set<string>, actorId: string): Promise<boolean> {
  return samePersonAsAny(tx, accounts, actorId);
}

/** Why the actor may not record this run's payment (Q-1), or null. Preparer first, then approver, then payee. */
async function payBlockOf(tx: Db, run: { id: string; preparedBy: string; submittedBy: string | null }, actorId: string): Promise<string | null> {
  if (await involves(tx, await runPreparers(tx, run), actorId)) return SOD_PREPARER;
  if (await involves(tx, await runApprovers(tx, run.id), actorId)) return SOD_APPROVER;
  if (await isPayee(tx, run.id, actorId)) return SOD_PAYEE;
  return null;
}

/** Why the actor may not cancel this APPROVED run (Q-2), or null. */
async function cancelBlockOf(tx: Db, run: { id: string; preparedBy: string; submittedBy: string | null }, actorId: string): Promise<string | null> {
  if (await involves(tx, await runPreparers(tx, run), actorId)) return SOD_PREPARER;
  if (await involves(tx, await runApprovers(tx, run.id), actorId)) return SOD_APPROVER;
  return null;
}

const SOD_MESSAGES: Record<string, Record<string, string>> = {
  PAY: {
    [SOD_PREPARER]: "You prepared this payroll run, so you cannot record its payment.",
    [SOD_APPROVER]: "You approved this payroll run, so you cannot record its payment.",
    [SOD_PAYEE]: "You are paid by this payroll run, so you cannot record its payment.",
  },
  CANCEL: {
    [SOD_PREPARER]: "You prepared this payroll run, so you cannot cancel it after approval.",
    [SOD_APPROVER]: "You approved this payroll run, so you cannot cancel it after approval.",
  },
};

/**
 * A refused segregation-of-duties attempt is kept in the audit trail. The refusal rolls its own
 * transaction back, so the row is written afterwards, in a write of its own.
 */
async function auditSodRefusal<T>(actor: HrActor, runId: string, step: "APPROVE" | "PAY" | "CANCEL", work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (e) {
    // Only the step and the reason code: no amounts, no payee or bank data, no credentials.
    // Segregation refusals and a missing duty (403 FORBIDDEN, QA P2-3) are both kept.
    if (e instanceof HrError && (e.code?.startsWith("SOD_") || e.code === "FORBIDDEN")) {
      await audit(prisma, { action: "PAYROLL_SOD_REFUSED", entityType: "HrPayrollRun", entityId: runId, after: { step, code: e.code }, actorId: actor.id }).catch(() => undefined);
    } else if (e instanceof HrError && e.code && P2_AUDITED_CODES.has(e.code) && !wasAudited(e)) {
      // P-2: control refusals at approve / pay / cancel are kept too (journal and policy refusals
      // are audited where they are raised; these are the ones raised here).
      await controlRefusal(e, { entityType: "HrPayrollRun", entityId: runId, step, actorId: actor.id });
    }
    throw e;
  }
}

/** P-2 control refusals raised in this file and audited by `auditSodRefusal`. */
const P2_AUDITED_CODES = new Set(["OVERPAYMENT", "IDEMPOTENCY_CONFLICT", "IDEMPOTENCY_REQUIRED", "PAYMENT_MODE", "RECONCILIATION", "BLOCKING", "ESCALATION_ACK", "EOS_MISCLASSIFIED", "SEPARATION_EARNING_REVIEW", "ATTESTER_CONFLICT",
  // P-2 rev3 item 2: proof of payment per employee.
  "DUPLICATE_BANK_REFERENCE", "PROOF_MISMATCH", "ALLOCATION_EXCEEDS_PAYMENT", "NOT_RETURNABLE"]);

/**
 * F2 / finding 10 (P-2 / E-1): payroll never runs on proposed values. Activation already refuses a
 * proposal; this also stops runs under an ACTIVE version activated before that rule existed, at
 * preparation, submission, approval AND payment. A correction of such a month needs an applied
 * second-person attestation (./payroll-controls `policyGate`).
 */
async function assertRunPolicyConfirmed(tx: Tx, run: { id: string; kind: string; correctsRunId: string | null; policyId: string }, step: string, actorId: string) {
  const policy = await tx.hrPayrollPolicy.findUniqueOrThrow({ where: { id: run.policyId }, select: { id: true, version: true, isProposal: true } });
  return policyGate(tx, { ...run, policy }, step, actorId);
}

async function assertBranchScope(actor: HrActor, tx: Tx, branchKey: string) {
  const scope = await resolveScope(actor, tx);
  if (branchKey === "COMPANY") {
    if (!scope.all) throw new HrError("A company-wide run needs the all-branches duty.", 403);
  } else if (!scope.all && !scope.branchIds.includes(branchKey)) throw new HrError("Payroll run not found", 404);
}

async function loadRun(tx: Tx, actor: HrActor, id: string) {
  const run = await tx.hrPayrollRun.findUnique({ where: { id } });
  if (!run) throw new HrError("Payroll run not found", 404);
  await assertBranchScope(actor, tx, run.branchKey);
  return run;
}

type RunRow = Awaited<ReturnType<typeof loadRun>>;

/**
 * Round-5 F1: the ONE lock order for everything that reads-then-changes a payroll run —
 * `payroll:<month>` → the people concerned (`lockPeople`, one global order) → the run row
 * (SELECT … FOR UPDATE) — and the run RE-READ under those locks. Every status check is made on
 * the returned row, never on a row read before the locks, so a run cannot change state between
 * the check and the change (a submitted run never takes another adjustment or rebuild). Used by
 * rebuild, adjustment entry, submit, return to draft, approve and pay; cancel takes the same order.
 */
async function lockRunForChange(tx: Tx, actor: HrActor, id: string, people: (run: RunRow) => Promise<string[]> | string[] = () => []): Promise<RunRow> {
  const peek = await loadRun(tx, actor, id);
  await lock(tx, `payroll:${peek.periodMonth}`);
  const who = await people(peek);
  if (who.length) await lockPeople(tx, who);
  await tx.$queryRaw`SELECT 1 FROM "HrPayrollRun" WHERE "id" = ${id} FOR UPDATE`;
  return tx.hrPayrollRun.findUniqueOrThrow({ where: { id } });
}

// ── Prepare / rebuild ─────────────────────────────────────────────────────────────

export async function prepareRun(actor: HrActor, b: Record<string, unknown>) {
  assertCan(actor, "payroll_prepare");
  await assertVerifiedActor(actor, "PAYROLL_PREPARE");
  // Phase 1 lock: preparing a DRAFT run is the allowed dry preparation (no journal, no money).
  const month = typeof b.month === "string" ? b.month : "";
  if (!isMonth(month)) throw new HrError("month must look like 2026-10.", 400);
  const branchKey = text(b.branchKey, "branchKey", { max: 40 }) ?? "COMPANY";
  const kind = oneOf(b.kind, "kind", ["REGULAR", "CORRECTION"] as const, "REGULAR");
  const { start, end } = monthBounds(month);
  return guarded(() => prisma.$transaction(async (tx) => {
    await assertBranchScope(actor, tx, branchKey);
    await lock(tx, `payroll:${month}`);
    // Review NEW-9: re-checked inside the transaction, after the lock.
    await assertVerifiedActor(actor, "PAYROLL_PREPARE", tx);
    let correctsRunId: string | null = null;
    if (kind === "REGULAR") {
      const clash = await tx.hrPayrollRun.findFirst({ where: { periodMonth: month, kind: "REGULAR", status: { not: "CANCELLED" }, ...(branchKey === "COMPANY" ? {} : { branchKey: { in: [branchKey, "COMPANY"] } }) } });
      if (clash) throw new HrError(`Run #${clash.runNo} already covers ${month} (${clash.branchKey}, ${clash.status}). Use a correction run to change a settled month.`, 409, "RUN_EXISTS");
    } else {
      correctsRunId = text(b.correctsRunId, "correctsRunId", { required: true, max: 40 });
      const orig = await tx.hrPayrollRun.findUnique({ where: { id: correctsRunId as string } });
      if (!orig || orig.periodMonth !== month || !["APPROVED", "PAID"].includes(orig.status)) throw new HrError("A correction run corrects an APPROVED or PAID run of the same month.", 400);
    }
    const policy = await activePolicyFor(tx, end);
    if (!policy) throw new HrError(`No ACTIVE payroll policy is in force on ${dayString(end)}. Activate one first (HR settings).`, 409, "NO_POLICY");
    const attestationId = await policyGate(tx, { kind, correctsRunId, policy }, "PREPARE", actor.id);
    // Review P1-A1: an attestation is bound to the ONE correction run that uses it (expires with it).
    const run = await tx.hrPayrollRun.create({ data: { periodMonth: month, periodStart: start, periodEnd: end, branchKey, kind, correctsRunId, policyId: policy.id, preparedBy: actor.id, controlAttestationId: attestationId } });
    await buildLines(tx, run.id, actor.id);
    await audit(tx, { action: "PAYROLL_PREPARE", entityType: "HrPayrollRun", entityId: run.id, after: { month, branchKey, kind, policyVersion: policy.version, ...(attestationId ? { proposalAttestationId: attestationId } : {}) }, actorId: actor.id });
    return runDto(tx, run.id, actor);
  }, TX));
}

export async function rebuildRun(actor: HrActor, id: string) {
  assertCan(actor, "payroll_prepare");
  await assertVerifiedActor(actor, "PAYROLL_REBUILD");
  return guarded(() => prisma.$transaction(async (tx) => {
    const run = await lockRunForChange(tx, actor, id);
    if (run.status !== "DRAFT") throw new HrError("Only a DRAFT run can be rebuilt.", 409);
    // Review NEW-9: re-checked inside the transaction, after the lock.
    await assertVerifiedActor(actor, "PAYROLL_REBUILD", tx);
    await buildLines(tx, id, actor.id);
    await tx.hrPayrollRun.update({ where: { id }, data: { version: { increment: 1 } } });
    await audit(tx, { action: "PAYROLL_REBUILD", entityType: "HrPayrollRun", entityId: id, actorId: actor.id });
    return runDto(tx, id, actor);
  }, TX));
}

async function releaseHolds(tx: Tx, runId: string) {
  await tx.hrAdvanceInstallment.updateMany({ where: { payrollRunId: runId, status: "RESERVED" }, data: { status: "SCHEDULED", payrollRunId: null, payrollLineId: null } });
  await tx.hrOvertime.updateMany({ where: { payrollRunId: runId }, data: { payrollRunId: null } });
  await releaseReservations(tx, runId);
}

async function buildLines(tx: Tx, runId: string, actorId: string) {
  const run = await tx.hrPayrollRun.findUniqueOrThrow({ where: { id: runId }, include: { policy: { include: { contributionRules: true } } } });
  await releaseHolds(tx, runId);
  await tx.hrPayrollLine.deleteMany({ where: { runId } });
  const p = run.policy;
  const enginePolicy = {
    id: p.id, version: p.version, dayBasis: p.dayBasis, isProposal: p.isProposal,
    standardDailyHours: MD(p.standardDailyHours.toString()), overtimeMultiplier: MD(p.overtimeMultiplier.toString()), maxDeductionPercent: MD(p.maxDeductionPercent.toString()),
    unpaidLeaveComponents: p.unpaidLeaveComponents as Component[], overtimeComponents: p.overtimeComponents as Component[],
    // P-2 findings 2/3: refused (409 DEDUCTION_POLICY_UNSET) while the accountant's values are unset.
    deductions: engineDeductionConfig(p),
  };
  const adjustments = await tx.hrPayrollAdjustment.findMany({ where: { runId } });
  const people = await tx.hrEmployee.findMany({
    where: {
      hireDate: { lte: run.periodEnd },
      OR: [{ separationDate: null }, { separationDate: { gte: run.periodStart } }],
      ...(run.branchKey === "COMPANY" ? {} : { branchId: run.branchKey }),
      ...(run.kind === "CORRECTION" ? { id: { in: [...new Set(adjustments.map((a) => a.employeeId))] } } : {}),
    },
    include: { private: { select: { contributionGroup: true } } },
    orderBy: { employeeNo: "asc" },
  });
  let tg = ZERO, td = ZERO, tn = ZERO, te = ZERO;
  for (const person of people) {
    if (run.kind === "REGULAR") {
      const other = await tx.hrPayrollLine.findFirst({ where: { employeeId: person.id, runId: { not: runId }, run: { periodMonth: run.periodMonth, kind: "REGULAR", status: { not: "CANCELLED" } } }, select: { run: { select: { runNo: true } } } });
      if (other) throw new HrError(`${person.fullNameAr} is already in run #${other.run.runNo} for ${run.periodMonth}.`, 409, "PERSON_IN_OTHER_RUN");
    }
    const adj = adjustments.filter((a) => a.employeeId === person.id).map((a) => ({ id: a.id, kind: a.kind as "EARNING" | "DEDUCTION", amount: MD(a.amount.toString()), reason: a.reason }));
    let calc: EngineResult;
    if (run.kind === "CORRECTION") {
      calc = calculatePayroll({
        // E-1: a correction run carries its policy's proposal flag like any run (and is refused under one).
        month: run.periodMonth, policy: enginePolicy, hireDate: run.periodStart, separationDate: null,
        compensations: [{ id: "correction", effectiveFrom: run.periodStart, effectiveTo: null, basic: MD(0), housing: MD(0), transport: MD(0), other: MD(0) }],
        unpaidLeaveDays: [], overtime: [], commissions: [], installments: [], adjustments: adj, contributions: [], contributionGroupMissing: false, absentDays: 0, openAttendanceDays: 0,
      });
      calc.items = calc.items.filter((i) => i.code.startsWith("ADJUSTMENT"));
      // E-1: the proposal notice stays visible on correction lines.
      calc.exceptions = calc.exceptions.filter((e) => e.code === "NEGATIVE_NET" || e.code === "POLICY_PROPOSAL");
      calc.payableDays = MD(0);
      // Review P1-B2: earnings for a separating person, on correction lines too.
      await separationEarningControls(tx, { run, employeeId: person.id, calc });
    } else {
      const comps = await tx.hrCompensation.findMany({ where: { employeeId: person.id, effectiveFrom: { lte: run.periodEnd }, OR: [{ effectiveTo: null }, { effectiveTo: { gte: run.periodStart } }] } });
      const group = person.private?.contributionGroup ?? null;
      const rules: EngineContribution[] = p.contributionRules.filter((r) => group && r.appliesToGroup === group).map((r) => ({ code: r.code, nameAr: r.nameAr, employeeRatePercent: MD(r.employeeRatePercent.toString()), employerRatePercent: MD(r.employerRatePercent.toString()), baseComponents: r.baseComponents as Component[], monthlyBaseCap: r.monthlyBaseCap ? MD(r.monthlyBaseCap.toString()) : null }));
      const overtime = await tx.hrOvertime.findMany({ where: { employeeId: person.id, status: "APPROVED", payrollRunId: null, workDate: { gte: run.periodStart, lte: run.periodEnd } } });
      const commissions = person.accountId ? await payablePeriods(tx, person.accountId, run.periodMonth) : [];
      const installments = await tx.hrAdvanceInstallment.findMany({ where: { status: "SCHEDULED", dueMonth: { lte: run.periodMonth }, advance: { employeeId: person.id, status: "DISBURSED" } }, include: { advance: { select: { advanceNo: true } } }, orderBy: [{ dueMonth: "asc" }, { seq: "asc" }] });
      const [absent, open] = await Promise.all([
        tx.hrAttendance.count({ where: { employeeId: person.id, status: "ABSENT", workDate: { gte: run.periodStart, lte: run.periodEnd } } }),
        tx.hrAttendance.count({ where: { employeeId: person.id, status: "OPEN", workDate: { gte: run.periodStart, lte: run.periodEnd } } }),
      ]);
      // A person under an initiated separation is paid up to the planned last working day,
      // not for the whole month; the final separation date is used once it is completed.
      const openSep = person.separationDate ? null : await tx.hrSeparation.findFirst({ where: { employeeId: person.id, status: "INITIATED" }, select: { lastWorkingDay: true } });
      calc = calculatePayroll({
        month: run.periodMonth, policy: enginePolicy, hireDate: person.hireDate, separationDate: person.separationDate ?? openSep?.lastWorkingDay ?? null,
        compensations: comps.map((c) => ({ id: c.id, effectiveFrom: c.effectiveFrom, effectiveTo: c.effectiveTo, basic: MD(c.basic.toString()), housing: MD(c.housing.toString()), transport: MD(c.transport.toString()), other: MD(c.otherAllowance.toString()) })),
        // P-2 finding 1: a day held by two approved leaves is passed once (and flagged below).
        unpaidLeaveDays: dedupeDays(await unpaidLeaveDays(tx, person.id, run.periodStart, run.periodEnd, p.weekendDays)),
        overtime: overtime.map((o) => ({ id: o.id, workDate: o.workDate, minutes: o.minutes })),
        commissions: commissions.map((c) => ({ reservationKey: `${person.accountId}|${c.periodStart.toISOString()}`, periodStart: c.periodStart, amount: MD(c.amount.toString()) })),
        installments: installments.map((i) => ({ id: i.id, advanceNo: i.advance.advanceNo, seq: i.seq, amount: MD(i.amount.toString()) })),
        adjustments: adj, contributions: rules,
        contributionGroupMissing: p.contributionRules.length > 0 && !group,
        absentDays: absent, openAttendanceDays: open,
      });
      if (!calc.employed) continue;
      // P-2 finding 1 / E-1: unpaid-leave guard and proposal leave types (exceptions only).
      await lineControls(tx, { month: run.periodMonth, employeeId: person.id, unpaidLeaveComponents: p.unpaidLeaveComponents as Component[], calc });
      // Review P1-B2: earnings for a separating person need an independent attestation.
      await separationEarningControls(tx, { run, employeeId: person.id, calc });
      calc.snapshot.commissions = commissions.map((c) => ({ periodStart: c.periodStart.toISOString(), amount: c.amount.toFixed(2) }));
      calc.snapshot.installments = installments.filter((i) => calc.includedInstallmentIds.includes(i.id)).map((i) => ({ id: i.id, advanceNo: i.advance.advanceNo, seq: i.seq, amount: i.amount.toFixed(2) }));
      calc.snapshot.contributionGroup = group;
      // QA P2-2: who this line pays, frozen with the line (lines never change once approved), so
      // unlinking the login afterwards does not make the payee eligible to record the payment.
      calc.snapshot.payeeAccountId = person.accountId ?? null;
      const line = await tx.hrPayrollLine.create({
        data: {
          runId, employeeId: person.id, snapshot: calc.snapshot as Prisma.InputJsonValue, payableDays: toPD(calc.payableDays),
          gross: toPD(calc.gross), deductions: toPD(calc.deductions), net: toPD(calc.net), employer: toPD(calc.employer),
          exceptions: calc.exceptions as unknown as Prisma.InputJsonValue, blocking: calc.blocking,
          items: { create: calc.items.map((i) => ({ code: i.code, kind: i.kind, amount: toPD(i.amount), quantity: i.quantity ? toPD(i.quantity) : null, rate: i.rate ? toPD(i.rate) : null, sourceType: i.sourceType ?? null, sourceId: i.sourceId ?? null, description: i.description, category: i.category ?? null, applyOrder: i.applyOrder ?? null })) },
        },
      });
      for (const iid of calc.includedInstallmentIds) {
        const r = await tx.hrAdvanceInstallment.updateMany({ where: { id: iid, status: "SCHEDULED" }, data: { status: "RESERVED", payrollRunId: runId, payrollLineId: line.id } });
        if (r.count !== 1) throw new HrError("An advance installment was reserved by another run meanwhile. Rebuild.", 409, "INSTALLMENT_TAKEN");
      }
      if (calc.usedOvertimeIds.length) {
        const r = await tx.hrOvertime.updateMany({ where: { id: { in: calc.usedOvertimeIds }, payrollRunId: null, status: "APPROVED" }, data: { payrollRunId: runId } });
        if (r.count !== calc.usedOvertimeIds.length) throw new HrError("Overtime was claimed by another run meanwhile. Rebuild.", 409, "OVERTIME_TAKEN");
      }
      for (const c of commissions) await reservePeriod(tx, { runId, lineId: line.id, accountId: person.accountId as string, periodStart: c.periodStart, amount: c.amount });
      tg = tg.plus(line.gross); td = td.plus(line.deductions); tn = tn.plus(line.net); te = te.plus(line.employer);
      continue;
    }
    // correction line
    const line = await tx.hrPayrollLine.create({
      data: {
        runId, employeeId: person.id, snapshot: { correction: true, correctsRunId: run.correctsRunId, policy: { id: p.id, version: p.version, isProposal: p.isProposal }, payeeAccountId: person.accountId ?? null, ...(calc.snapshot.controls ? { controls: calc.snapshot.controls } : {}) } as Prisma.InputJsonValue, payableDays: D(0),
        gross: toPD(calc.gross), deductions: toPD(calc.deductions), net: toPD(calc.net), employer: D(0),
        exceptions: calc.exceptions as unknown as Prisma.InputJsonValue, blocking: calc.blocking,
        items: { create: calc.items.map((i) => ({ code: i.code, kind: i.kind, amount: toPD(i.amount), sourceType: i.sourceType ?? null, sourceId: i.sourceId ?? null, description: i.description, category: i.category ?? null, applyOrder: i.applyOrder ?? null })) },
      },
    });
    tg = tg.plus(line.gross); td = td.plus(line.deductions); tn = tn.plus(line.net);
  }
  await tx.hrPayrollRun.update({ where: { id: runId }, data: { totalGross: tg, totalDeductions: td, totalNet: tn, totalEmployer: te } });
  // P-2 finding 2: advances deferred again by this run are escalated once they reach the policy's N.
  await escalateDeferrals(tx, { runId, actorId });
}

export async function addAdjustment(actor: HrActor, runId: string, b: Record<string, unknown>) {
  assertCan(actor, "payroll_prepare");
  await assertVerifiedActor(actor, "PAYROLL_ADJUSTMENT");
  const employeeId = reqText(b.employeeId, "employeeId", 40);
  const kind = oneOf(b.kind, "kind", ["EARNING", "DEDUCTION"] as const);
  let amount: Prisma.Decimal;
  try {
    amount = D(parseAmount(b.amount).toString());
  } catch (e) {
    throw new HrError(`amount: ${(e as Error).message}`, 400);
  }
  const reason = reqText(b.reason, "reason", 300, 3);
  // Review P1-B2: a category from the closed list is required; end of service / leave encashment /
  // final settlement are not on it (409 EOS_NOT_SALARY). The reason's wording no longer decides —
  // it only raises a warning for the approver (EOS_KEYWORD on the line).
  const category = parseAdjustmentCategory(kind, b.category, reason);
  // P-2 rev3 item 5: a prior-period due names its document and the earlier period it is owed for.
  const dues = parseDuesEvidence(category, b);
  return guarded(() => prisma.$transaction(async (tx) => {
    // Round-5 F1: month → person → run row, and the status re-read under those locks.
    const run = await lockRunForChange(tx, actor, runId, () => (kind === "EARNING" ? [employeeId] : []));
    if (run.status !== "DRAFT") throw new HrError("Adjustments are added to a DRAFT run.", 409);
    const person = await tx.hrEmployee.findUnique({ where: { id: employeeId } });
    if (!person || (run.branchKey !== "COMPANY" && person.branchId !== run.branchKey)) throw new HrError("This person is not in the run's scope.", 400);
    // SIMPLE MODE: the owner may adjust their own pay line.
    if (person.accountId === actor.id && !isSimpleMode()) throw new HrError("You cannot add an adjustment to your own pay.", 403, "SELF_ACTION");
    // Review NEW-9: re-checked inside the transaction, after the lock.
    await assertVerifiedActor(actor, "PAYROLL_ADJUSTMENT", tx);
    // Review P1-B2: never an end-of-service amount, whole or split, since the separation.
    // rev3 item 5: an evidenced prior-period due is owed for a period before the separation, and
    // COUNTS towards the end-of-service match like any earning (review rev8 P2-a: the dues route,
    // D-7i-5, is undecided — strict default); its attestation clears the review only.
    if (dues) await assertDuesPeriod(tx, employeeId, dues.relatedPeriod);
    await assertNotSettlementThroughPayroll(tx, employeeId, kind, amount);
    const a = await tx.hrPayrollAdjustment.create({ data: { runId, employeeId, kind, amount, reason, category, documentReference: dues?.documentReference ?? null, relatedPeriod: dues?.relatedPeriod ?? null, createdBy: actor.id } });
    await buildLines(tx, runId, actor.id);
    const warnings = looksLikeFinalSettlement(reason) ? ["EOS_KEYWORD"] : [];
    await audit(tx, { action: "PAYROLL_ADJUSTMENT", entityType: "HrPayrollRun", entityId: runId, employeeId, after: { kind, category, amount: amount.toFixed(2), reason, adjustmentId: a.id, warnings, ...(dues ?? {}) }, actorId: actor.id });
    return { ...(await runDto(tx, runId, actor)), warnings };
  }, TX));
}

// ── Reconciliation (F2 / finding 5) ─────────────────────────────────────────────

/** Items ↔ line ↔ run totals in exact halalas. Read only: reports, never corrects. */
export async function runReconciliation(db: Db, runId: string): Promise<Reconciliation> {
  const run = await db.hrPayrollRun.findUniqueOrThrow({ where: { id: runId }, include: { payments: { select: { amount: true } }, paymentReturns: { select: { amount: true } }, lines: { include: { items: { select: { kind: true, amount: true } }, employee: { select: { employeeNo: true } } } } } });
  const link = await db.hrJournalLink.findUnique({ where: { sourceType_sourceId_purpose: { sourceType: "PAYROLL_RUN", sourceId: runId, purpose: "ACCRUAL" } }, include: { journalEntry: { select: { totalDebit: true } } } });
  let journal: { expectedDebit: Prisma.Decimal; postedDebit: Prisma.Decimal } | null = null;
  if (link) {
    let expected: Prisma.Decimal | null = null;
    try { expected = consolidate(await accrualLines(db as Tx, runId)).reduce((s, l) => s.plus(l.debit ?? ZERO), ZERO); } catch { expected = null; }
    if (expected) journal = { expectedDebit: expected, postedDebit: link.journalEntry.totalDebit };
  }
  // P-2 rev3 item 2: paid = payments net of returns (a returned credit is owed again).
  const paid = run.payments.reduce((s, p) => s.plus(p.amount), ZERO).minus(run.paymentReturns.reduce((s, p) => s.plus(p.amount), ZERO));
  return reconcileRun({ ...run, lines: run.lines.map((l) => ({ ...l, label: l.employee.employeeNo })), paid, journal });
}

/** A run whose figures do not reconcile is never submitted or approved; nothing is altered to make it fit. */
async function assertReconciled(tx: Tx, runId: string) {
  const r = await runReconciliation(tx, runId);
  if (!r.ok) {
    const m = r.mismatches[0];
    throw new HrError(`The run's figures do not reconcile (${r.mismatches.length} difference(s); first: ${m.label ? `${m.label} ` : ""}${m.check} expected ${m.expected}, found ${m.actual}). Nothing was changed; rebuild the run or report it.`, 409, "RECONCILIATION");
  }
}

// ── Review & approval ─────────────────────────────────────────────────────────────

export async function submitRun(actor: HrActor, id: string, b: Record<string, unknown> = {}) {
  assertCan(actor, "payroll_prepare");
  await assertVerifiedActor(actor, "PAYROLL_SUBMIT");
  await assertPayrollLive("RUN_SUBMIT");
  // Review P2-B7 (S-3.5): the preparer acknowledges every escalated advance of the run's people.
  const acknowledged = Array.isArray(b.acknowledgeEscalations) ? (b.acknowledgeEscalations as unknown[]).filter((x): x is string => typeof x === "string") : [];
  return guarded(() => prisma.$transaction(async (tx) => {
    await assertPayrollLive("RUN_SUBMIT", tx); // F8: again inside the transaction
    // Round-5 F1: month → the run's separating people → run row; every check below reads the run
    // as it stands under those locks (no adjustment or rebuild can slip in until this commits).
    const run = await lockRunForChange(tx, actor, id, (r) => separationPeopleOf(tx, r.id));
    await assertVerifiedActor(actor, "PAYROLL_SUBMIT", tx);
    if (run.status !== "DRAFT") throw new HrError("Only a DRAFT run can be submitted.", 409);
    await assertRunPolicyConfirmed(tx, run, "SUBMIT", actor.id);
    const [lines, blocking] = await Promise.all([tx.hrPayrollLine.count({ where: { runId: id } }), tx.hrPayrollLine.count({ where: { runId: id, blocking: true } })]);
    if (lines === 0) throw new HrError("The run has no lines.", 409);
    if (blocking > 0) throw new HrError(`${blocking} line(s) have blocking exceptions. Resolve them and rebuild.`, 409, "BLOCKING");
    await assertReconciled(tx, id);
    // Re-review N1: the separation-earning rules on the data as it stands now (all runs and months).
    await assertSeparationEarningsApprovable(tx, run);
    const escalated = await escalatedAdvancesOf(tx, id);
    const missing = escalated.filter((e) => !acknowledged.includes(e.reviewItemId));
    if (missing.length) throw new HrError(`${missing.length} advance(s) of this run's people were escalated for repeated deferral (${missing.map((m) => `${m.advanceNo}: ${m.deferralCount} consecutive`).join(", ")}). Acknowledge each one (acknowledgeEscalations: its review item id) to submit; the approver sees them too.`, 409, "ESCALATION_ACK");
    // Round-4: conditional on DRAFT (kept as a second line of defence under the round-5 run lock).
    const moved = await tx.hrPayrollRun.updateMany({ where: { id, status: "DRAFT" }, data: { status: "REVIEW", submittedBy: actor.id, submittedAt: new Date() } });
    if (moved.count !== 1) throw new HrError("Only a DRAFT run can be submitted.", 409);
    await audit(tx, { action: "PAYROLL_SUBMIT", entityType: "HrPayrollRun", entityId: id, after: escalated.length ? { acknowledgedEscalations: escalated.map((e) => ({ reviewItemId: e.reviewItemId, advanceNo: e.advanceNo, deferralCount: e.deferralCount })) } : undefined, actorId: actor.id });
    return runDto(tx, id, actor);
  }, TX));
}

export async function returnToDraft(actor: HrActor, id: string, b: Record<string, unknown>) {
  assertAny(actor, ["payroll_prepare", "payroll_approve"]);
  await assertVerifiedActor(actor, "PAYROLL_RETURN");
  const reason = reqText(b.reason, "reason", 300, 3);
  return guarded(() => prisma.$transaction(async (tx) => {
    const run = await lockRunForChange(tx, actor, id);
    await assertVerifiedActor(actor, "PAYROLL_RETURN", tx);
    if (run.status !== "REVIEW") throw new HrError("Only a run in REVIEW can be returned.", 409);
    await tx.hrPayrollLine.updateMany({ where: { runId: id }, data: { approvedBy: null, approvedAt: null } });
    await tx.hrPayrollRun.update({ where: { id }, data: { status: "DRAFT" } });
    await audit(tx, { action: "PAYROLL_RETURN", entityType: "HrPayrollRun", entityId: id, reason, actorId: actor.id });
    return runDto(tx, id, actor);
  }, TX));
}

/**
 * Approve lines. Without lineIds: every pending line this actor may approve. Lines paying
 * the actor are skipped (they need an independent approver). When the last line is
 * approved the run becomes APPROVED and its accrual journal posts — in the same
 * transaction, so a refused posting (locked period, unmapped account) leaves nothing half done.
 */
export async function approveLines(actor: HrActor, id: string, b: Record<string, unknown>) {
  const lineIds = Array.isArray(b.lineIds) ? (b.lineIds as unknown[]).filter((x): x is string => typeof x === "string") : null;
  return auditSodRefusal(actor, id, "APPROVE", async () => { assertCan(actor, "payroll_approve"); assertFresh(actor); await assertVerifiedActor(actor, "PAYROLL_APPROVE"); await assertPayrollLive("RUN_APPROVE"); return guarded(() => prisma.$transaction(async (tx) => {
    await assertPayrollLive("RUN_APPROVE", tx); // F8: again inside the transaction
    // Round-5 F1: month → the run's separating people → run row, then every check on the re-read run.
    const run = await lockRunForChange(tx, actor, id, (r) => separationPeopleOf(tx, r.id));
    // P-3: nobody who prepared the run (created, rebuilt, adjusted or submitted it) approves it.
    if (await involves(tx, await runPreparers(tx, run), actor.id)) throw new HrError("You prepared this payroll run, so you cannot approve it.", 403, SOD_PREPARER);
    if (run.status !== "REVIEW") throw new HrError("Only a run in REVIEW can be approved.", 409);
    await assertRunPolicyConfirmed(tx, run, "APPROVE", actor.id);
    // Review NEW-9: re-checked inside the transaction, after the lock.
    await assertVerifiedActor(actor, "PAYROLL_APPROVE", tx);
    // F2 / finding 9 (P-2 / E-3): the accrual journal is part of approval. Check that it can post
    // BEFORE recording any line approval, so no approver signs lines of a run whose final approval
    // would be refused (the final posting re-checks inside this transaction). HR accounting off
    // is refused here (409 ACCOUNTING_REQUIRED, audited): a run is never approved without its journal.
    // P-2: a correction of a locked / closed month is routed to the current open period (explicit, audited).
    const posting = await accrualPosting(tx, run, localDay(new Date(), "Asia/Riyadh"));
    await assertPostingReady(tx, { date: posting.date, keys: (await accrualLines(tx, id)).map((l) => l.key), source: { sourceType: "PAYROLL_RUN", sourceId: id, purpose: "ACCRUAL" }, actorId: actor.id });
    await assertReconciled(tx, id);
    // Re-review N1 / N4: the cumulative end-of-service check is re-run at approval (across every run
    // and month since the separation), and the separation-earning attester never approves the run.
    await assertSeparationEarningsApprovable(tx, run, actor.id);
    const lines = await tx.hrPayrollLine.findMany({ where: { runId: id, approvedBy: null, ...(lineIds ? { id: { in: lineIds } } : {}) }, include: { employee: { select: { accountId: true, fullNameAr: true } } } });
    const own = lines.filter((l) => l.employee.accountId === actor.id);
    // SIMPLE MODE: the owner may approve their own pay line.
    if (lineIds && own.length && !isSimpleMode()) throw new HrError(`You cannot approve your own pay (${own.map((l) => l.employee.fullNameAr).join(", ")}). Another approver must.`, 403, "SELF_ACTION");
    // SIMPLE MODE: the owner's own line is approved with the rest (otherwise it is skipped for another approver).
    const mine = isSimpleMode() ? lines : lines.filter((l) => l.employee.accountId !== actor.id);
    if (mine.length) await tx.hrPayrollLine.updateMany({ where: { id: { in: mine.map((l) => l.id) }, approvedBy: null }, data: { approvedBy: actor.id, approvedAt: new Date() } });
    const remaining = await tx.hrPayrollLine.count({ where: { runId: id, approvedBy: null } });
    await audit(tx, { action: "PAYROLL_APPROVE_LINES", entityType: "HrPayrollRun", entityId: id, after: { approved: mine.length, skippedOwn: lines.length - mine.length, remaining }, actorId: actor.id });
    let finalized = false;
    let journal: { journalEntryId: string | null; skipped: boolean } | null = null;
    if (remaining === 0) {
      await verifyReservations(tx, id);
      journal = await postHrJournal(tx, { sourceType: "PAYROLL_RUN", sourceId: id, purpose: "ACCRUAL", date: posting.date, actorId: actor.id, description: `Payroll ${run.periodMonth} · run #${run.runNo}${run.kind === "CORRECTION" ? " (correction)" : ""}${posting.note ? ` · ${posting.note}` : ""}`, lines: await accrualLines(tx, id) });
      await tx.hrPayrollRun.update({ where: { id }, data: { status: "APPROVED", approvedAt: new Date(), accountingSkipped: journal.skipped } });
      await audit(tx, { action: "PAYROLL_APPROVED", entityType: "HrPayrollRun", entityId: id, after: { journalEntryId: journal.journalEntryId, accountingSkipped: journal.skipped, postingDate: dayString(posting.date), routedFromClosedPeriod: posting.routed, postingNote: posting.note }, actorId: actor.id });
      finalized = true;
    }
    return { ...(await runDto(tx, id, actor)), approvedNow: mine.length, skippedOwn: lines.length - mine.length, finalized, journalEntryId: journal?.journalEntryId ?? null };
  }, TX)); });
}

/** The accrual journal for a run, from its items. Balanced by construction (see PLAN.md §5). */
export async function accrualLines(tx: Tx, runId: string): Promise<HrJournalLine[]> {
  const run = await tx.hrPayrollRun.findUniqueOrThrow({ where: { id: runId } });
  const items = await tx.hrPayrollItem.groupBy({ by: ["code", "kind"], where: { line: { runId } }, _sum: { amount: true } });
  const out: HrJournalLine[] = [];
  const desc = `Payroll ${run.periodMonth}`;
  // Review P1-B2: adjustments post by their CATEGORY (src/lib/hr/adjustment-categories.ts).
  const adjItems = await tx.hrPayrollItem.findMany({ where: { line: { runId }, code: { in: ["ADJUSTMENT_EARNING", "ADJUSTMENT_DEDUCTION"] } }, select: { code: true, amount: true, sourceId: true } });
  const cats = new Map((await tx.hrPayrollAdjustment.findMany({ where: { id: { in: adjItems.map((i) => i.sourceId).filter((x): x is string => !!x) } }, select: { id: true, category: true } })).map((a) => [a.id, a.category]));
  for (const i of adjItems) {
    if (i.amount.isZero()) continue;
    const kind = i.code === "ADJUSTMENT_EARNING" ? "EARNING" : "DEDUCTION";
    const cat = (i.sourceId && cats.get(i.sourceId)) || "OTHER_WITH_MEMO";
    out.push(kind === "EARNING" ? { key: adjustmentPostingKey(kind, cat), debit: i.amount, description: `${desc} · ADJUSTMENT ${cat}` } : { key: adjustmentPostingKey(kind, cat), credit: i.amount, description: `${desc} · DEDUCTIONS ${cat}` });
  }
  for (const g of items) {
    const amt = g._sum.amount ?? ZERO;
    if (amt.isZero()) continue;
    const c = g.code;
    if (c === "ADJUSTMENT_EARNING" || c === "ADJUSTMENT_DEDUCTION") continue;
    if (c === "BASIC") out.push({ key: "SALARY_EXPENSE", debit: amt, description: `${desc} · ${c}` });
    else if (c === "HOUSING" || c === "TRANSPORT" || c === "OTHER_ALLOWANCE") out.push({ key: "ALLOWANCE_EXPENSE", debit: amt, description: `${desc} · ${c}` });
    else if (c === "OVERTIME") out.push({ key: "OVERTIME_EXPENSE", debit: amt, description: `${desc} · OVERTIME` });
    else if (c === "COMMISSION") out.push({ key: "COMMISSION_EXPENSE", debit: amt, description: `${desc} · COMMISSION` });
    else if (c === "UNPAID_LEAVE") out.push({ key: "SALARY_EXPENSE", credit: amt, description: `${desc} · UNPAID_LEAVE` });
    else if (c === "ADVANCE_INSTALLMENT") out.push({ key: "ADVANCES_RECEIVABLE", credit: amt, description: `${desc} · ADVANCES` });
    else if (c.startsWith("CONTRIB_EE:")) out.push({ key: "CONTRIB_PAYABLE", credit: amt, description: `${desc} · ${c}` });
    else if (c.startsWith("CONTRIB_ER:")) {
      out.push({ key: "EMPLOYER_CONTRIB_EXPENSE", debit: amt, description: `${desc} · ${c}` });
      out.push({ key: "CONTRIB_PAYABLE", credit: amt, description: `${desc} · ${c}` });
    } else throw new HrError(`No posting rule for payroll item ${c}.`, 500);
  }
  if (run.totalNet.greaterThan(0)) out.push({ key: "SALARIES_PAYABLE", credit: run.totalNet, description: `${desc} · NET` });
  return out;
}

/**
 * What the accrual journal WILL post when the last line is approved — read only, built from
 * the same posting rules (`accrualLines`) and the current account map, consolidated per
 * posting key and side. Nothing is written. Returns null when the rules cannot price the run
 * (an item without a posting rule); the real posting then refuses with its own error.
 */
async function previewAccrual(tx: Tx, runId: string) {
  let raw: HrJournalLine[];
  try { raw = await accrualLines(tx, runId); } catch { return null; }
  const by = new Map<string, { key: string; side: "D" | "C"; amount: Prisma.Decimal }>();
  for (const l of raw) {
    const side = l.debit && l.debit.greaterThan(0) ? "D" : "C";
    const amt = side === "D" ? l.debit! : l.credit ?? ZERO;
    const k = `${l.key}|${side}`;
    const cur = by.get(k);
    if (cur) cur.amount = cur.amount.plus(amt); else by.set(k, { key: l.key, side, amount: amt });
  }
  // Debits first, then credits; within a side the account-map order, with the net payable last.
  const ORDER = ["SALARY_EXPENSE", "ALLOWANCE_EXPENSE", "OVERTIME_EXPENSE", "COMMISSION_EXPENSE", "EMPLOYER_CONTRIB_EXPENSE", "ADVANCES_RECEIVABLE", "OTHER_DEDUCTIONS_PAYABLE", "CONTRIB_PAYABLE", "SALARIES_PAYABLE"];
  const rank = (r: { key: string; side: string }) => (r.side === "D" ? 0 : 100) + Math.max(0, ORDER.indexOf(r.key));
  const rows = [...by.values()].filter((r) => !r.amount.isZero()).sort((a, b) => rank(a) - rank(b));
  const map = await tx.hrAccountMap.findMany({ where: { key: { in: rows.map((r) => r.key) } }, include: { account: { select: { code: true, nameAr: true, nameEn: true } } } });
  const debit = rows.filter((r) => r.side === "D").reduce((s, r) => s.plus(r.amount), ZERO);
  const credit = rows.filter((r) => r.side === "C").reduce((s, r) => s.plus(r.amount), ZERO);
  return {
    lines: rows.map((r) => ({ key: r.key, side: r.side, amount: r.amount.toFixed(2), account: map.find((m) => m.key === r.key)?.account ?? null })),
    debit: debit.toFixed(2), credit: credit.toFixed(2),
  };
}

// ── Payment ───────────────────────────────────────────────────────────────────────

/**
 * QA P1-2: payment and post-approval cancellation of one run are serialised on the RUN ROW
 * (SELECT … FOR UPDATE), and each re-reads status and payments after taking it — so a payment
 * and a cancellation can never both succeed. Lock order everywhere: payroll:<month> advisory
 * lock (when taken) → run row → payroll-pay:<id>.
 */
async function lockRun(tx: Tx, actor: HrActor, id: string) {
  await loadRun(tx, actor, id);
  await tx.$queryRaw`SELECT 1 FROM "HrPayrollRun" WHERE "id" = ${id} FOR UPDATE`;
  return tx.hrPayrollRun.findUniqueOrThrow({ where: { id } });
}

export async function recordPayment(actor: HrActor, id: string, b: Record<string, unknown>) {
  if (!can(actor, "payroll_pay")) return auditSodRefusal(actor, id, "PAY", async () => assertCan(actor, "payroll_pay") as never);
  assertFresh(actor);
  await assertVerifiedActor(actor, "PAYROLL_PAY");
  await assertPayrollLive("PAYMENT_RECORD");
  let amount: Prisma.Decimal;
  try {
    amount = D(parseAmount(b.amount).toString());
  } catch (e) {
    throw new HrError(`amount: ${(e as Error).message}`, 400);
  }
  if (!isDay(b.paidOn)) throw new HrError("paidOn must be a date.", 400);
  const paidOn = parseDay(b.paidOn);
  const method = oneOf(b.method, "method", ["BANK_TRANSFER", "CASH", "CHEQUE"] as const);
  const reference = reqText(b.reference, "reference", 120);
  // P-2 / review P2-A2 (S-6.2.5, S-11): every payment request names an idempotency key, so a
  // retried request gets the payment already recorded and never records a second one. The pay
  // dialog generates one per opening; the database refuses a new payment without one.
  const idempotencyKey = text(b.idempotencyKey, "idempotencyKey", { max: 80 });
  // P-2: optional per-employee settlement — the payslip line this payment pays.
  const lineId = text(b.lineId, "lineId", { max: 40 });
  // P-2 rev3 item 2: a bulk payment may carry its per-employee proof at once (or later, by hand or
  // from the bank's result file). A per-line payment is its own proof: its reference is that credit.
  const allocations: AllocationIn[] | null = b.allocations === undefined || b.allocations === null ? null : allocationsIn(b.allocations);
  if (allocations && lineId) throw new HrError("A payment to one employee line is its own proof; allocations name the lines of a bulk payment.", 400);
  if (!idempotencyKey) return auditSodRefusal(actor, id, "PAY", async () => { throw new HrError("idempotencyKey is required: name the payment attempt (8 to 80 characters) so a retry can never record it twice.", 400, "IDEMPOTENCY_REQUIRED"); });
  if (idempotencyKey.length < 8) throw new HrError("idempotencyKey must be 8 to 80 characters.", 400);
  return auditSodRefusal(actor, id, "PAY", () => guarded(() => prisma.$transaction(async (tx) => {
    await assertPayrollLive("PAYMENT_RECORD", tx); // F8: again inside the transaction
    // Round-5: the same order as every run change — month, then the run row.
    const run = await lockRunForChange(tx, actor, id);
    const prior = await tx.hrPayrollPayment.findUnique({ where: { runId_idempotencyKey: { runId: id, idempotencyKey } } });
    if (prior) {
      const same = prior.recordedBy === actor.id && prior.amount.equals(amount) && dayString(prior.paidOn) === dayString(paidOn) && prior.method === method && prior.reference === reference && (prior.lineId ?? null) === lineId;
      if (!same) throw new HrError("This idempotency key was already used for a different payment of this run. Nothing was recorded.", 409, "IDEMPOTENCY_CONFLICT");
      return { ...(await runDto(tx, id, actor)), paymentId: prior.id, completed: run.status === "PAID", replayed: true };
    }
    if (run.status !== "APPROVED") throw new HrError("Payment is recorded against an APPROVED run.", 409);
    // P-3 / Q-1: execution only after approval, never by a preparer, an approver or a payee of the run.
    const block = await payBlockOf(tx, run, actor.id);
    if (block) throw new HrError(SOD_MESSAGES.PAY[block], 403, block);
    await lock(tx, `payroll-pay:${id}`);
    // Review NEW-9: re-checked inside the transaction, after the lock.
    await assertVerifiedActor(actor, "PAYROLL_PAY", tx);
    // P-2 / E-1: never paid under a proposal policy (an older approval included).
    await assertRunPolicyConfirmed(tx, run, "PAY", actor.id);
    // P-2 / E-3: no payment without the required journals. A run approved without its accrual
    // (accounting off, before this control) has no approved treatment → refused; otherwise the
    // accrual must be intact and equal to the run's approved items, and the payment journal must
    // be able to post (accounting on, keys mapped, period open) — all before anything is written.
    const accrualRef = { sourceType: "PAYROLL_RUN", sourceId: id, purpose: "ACCRUAL" };
    if (run.accountingSkipped) await externalAccountingTreatment({ ...accrualRef, purpose: "PAYMENT" }, actor.id);
    await assertPostingReady(tx, { date: paidOn, keys: ["SALARIES_PAYABLE", "PAYROLL_CASH"], source: { ...accrualRef, purpose: "PAYMENT" }, actorId: actor.id });
    await assertJournalIntact(tx, accrualRef, { expected: await accrualLines(tx, id), date: await accrualDateOf(tx, run), actorId: actor.id, step: "BEFORE_PAYMENT" });
    // P-2 rev3 item 2: what left the bank and stayed out (payments − returns) never exceeds the net.
    const before = await runSettlement(tx, id);
    // A run paid per line takes per-line payments only. A run paid as a whole takes a per-line
    // payment only for a line a return or rejection reopened; nothing else is ever paid twice.
    if (!lineId && (await tx.hrPayrollPayment.count({ where: { runId: id, lineId: { not: null } } }))) throw new HrError("This run is already being paid per employee line; record the rest the same way.", 409, "PAYMENT_MODE");
    if (lineId) {
      const line = await tx.hrPayrollLine.findFirst({ where: { id: lineId, runId: id } });
      if (!line) throw new HrError("This line is not part of the run.", 400);
      const ls = before.lines.get(lineId);
      const bulk = await tx.hrPayrollPayment.count({ where: { runId: id, lineId: null } });
      if (bulk && ls?.status !== "RETURNED") throw new HrError("This run is already being paid as a whole; record the rest the same way (a per-line payment is for a line reopened by a return).", 409, "PAYMENT_MODE");
      const settled = ls?.settled ?? ZERO;
      if (settled.plus(amount).greaterThan(line.net)) throw new HrError(`Payments to this employee would be ${settled.plus(amount).toFixed(2)}, more than the line's net ${line.net.toFixed(2)}.`, 409, "OVERPAYMENT");
      const used = await usedReference(tx, [reference]);
      if (used) throw new HrError(`Bank reference ${used} is already recorded for another credit; each employee credit has its own reference.`, 409, "DUPLICATE_BANK_REFERENCE");
    }
    if (allocations) await assertAllocations(tx, id, before, allocations, amount);
    if (before.cashOut.plus(amount).greaterThan(run.totalNet)) throw new HrError(`Recorded payments (net of returns) would be ${before.cashOut.plus(amount).toFixed(2)}, more than the net ${run.totalNet.toFixed(2)}.`, 409, "OVERPAYMENT");
    const pay = await tx.hrPayrollPayment.create({ data: { runId: id, amount, paidOn, method, reference, recordedBy: actor.id, idempotencyKey, lineId } });
    // The payment journal follows how the run was booked: posted accrual → payment must post;
    // run approved without journals → none for its payment either (F2 / finding 9).
    const j = await postHrJournal(tx, { mode: run.accountingSkipped ? "skip" : "required", sourceType: "PAYROLL_RUN", sourceId: id, purpose: `PAYMENT:${pay.id}`, date: paidOn, actorId: actor.id, description: `Payroll ${run.periodMonth} · payment ${reference}`, lines: [{ key: "SALARIES_PAYABLE", debit: amount, description: `Payroll ${run.periodMonth} paid` }, { key: "PAYROLL_CASH", credit: amount, description: `Payroll ${run.periodMonth} paid (${method})` }] });
    // P-2 rev3 item 2: the per-employee proof that comes with the payment.
    const payees = await payeesOf(tx, id);
    if (lineId) {
      const line = await tx.hrPayrollLine.findUniqueOrThrow({ where: { id: lineId }, select: { employeeId: true } });
      await tx.hrPayrollPaymentAllocation.create({ data: { paymentId: pay.id, runId: id, lineId, employeeId: line.employeeId, amount, bankReference: reference, payeeAccountLast4: payees.get(lineId) ?? null, source: "LINE_PAYMENT", confirmedOn: paidOn, confirmedBy: actor.id } });
    } else if (allocations) {
      await createAllocations(tx, { runId: id, paymentId: pay.id, allocations, confirmedOn: paidOn, actorId: actor.id, source: "MANUAL", idempotencyKey, payees });
    }
    // PAID only when every employee line is credited its net with proof (DB re-checks).
    const completed = await completeIfSettled(tx, run, actor.id);
    await audit(tx, { action: "PAYROLL_PAYMENT", entityType: "HrPayrollRun", entityId: id, after: { paymentId: pay.id, amount: amount.toFixed(2), reference, journalEntryId: j.journalEntryId, lineId, allocations: lineId ? 1 : allocations?.length ?? 0, completed }, actorId: actor.id });
    return { ...(await runDto(tx, id, actor)), paymentId: pay.id, completed };
  }, TX)));
}

// ── Proof of payment per employee (P-2 rev3 item 2) ──────────────────────────────────

/** lineId → last four characters of the payee's account on file now (never the full IBAN). */
async function payeesOf(tx: Tx, runId: string): Promise<Map<string, string | null>> {
  const lines = await tx.hrPayrollLine.findMany({ where: { runId }, select: { id: true, employee: { select: { private: { select: { iban: true } } } } } });
  return new Map(lines.map((l) => [l.id, last4(l.employee.private?.iban)]));
}

/**
 * Every allocation names a line of the run, never takes a line above its net (net of returns) and
 * never takes the payment above its amount; every bank reference is new. Refused as a whole.
 */
async function assertAllocations(tx: Tx, runId: string, st: Awaited<ReturnType<typeof runSettlement>>, allocations: AllocationIn[], paymentLeft: Prisma.Decimal) {
  const perLine = new Map<string, Prisma.Decimal>();
  let total = ZERO;
  for (const a of allocations) {
    const ls = st.lines.get(a.lineId);
    if (!ls) throw new HrError(`Line ${a.lineId} is not part of this run.`, 400);
    const sum = (perLine.get(a.lineId) ?? ZERO).plus(a.amount);
    perLine.set(a.lineId, sum);
    if (sum.greaterThan(ls.outstanding)) {
      const e = await tx.hrEmployee.findUnique({ where: { id: ls.employeeId }, select: { employeeNo: true } });
      throw new HrError(`${e?.employeeNo ?? a.lineId} would be credited ${ls.settled.plus(sum).toFixed(2)}, more than the line's net ${ls.net.toFixed(2)}. Each employee is credited their own net; nothing was recorded.`, 409, "OVERPAYMENT");
    }
    total = total.plus(a.amount);
  }
  if (total.greaterThan(paymentLeft)) throw new HrError(`The allocations total ${total.toFixed(2)}, more than the ${paymentLeft.toFixed(2)} of the payment still unallocated. Nothing was recorded.`, 409, "ALLOCATION_EXCEEDS_PAYMENT");
  const used = await usedReference(tx, allocations.map((a) => a.bankReference));
  if (used) throw new HrError(`Bank reference ${used} is already recorded for another credit; nothing was recorded.`, 409, "DUPLICATE_BANK_REFERENCE");
}

async function createAllocations(tx: Tx, a: { runId: string; paymentId: string; allocations: AllocationIn[]; confirmedOn: Date; actorId: string; source: "MANUAL" | "BANK_IMPORT"; idempotencyKey: string | null; importId?: string; payees: Map<string, string | null> }) {
  const lines = await tx.hrPayrollLine.findMany({ where: { runId: a.runId, id: { in: a.allocations.map((x) => x.lineId) } }, select: { id: true, employeeId: true } });
  const emp = new Map(lines.map((l) => [l.id, l.employeeId]));
  let i = 0;
  for (const x of a.allocations) {
    await tx.hrPayrollPaymentAllocation.create({ data: {
      paymentId: a.paymentId, runId: a.runId, lineId: x.lineId, employeeId: emp.get(x.lineId) as string, amount: x.amount, bankReference: x.bankReference,
      payeeAccountLast4: a.payees.get(x.lineId) ?? null, source: a.source, importId: a.importId ?? null,
      idempotencyKey: a.idempotencyKey ? `${a.idempotencyKey}#${i}` : null, confirmedOn: a.confirmedOn, confirmedBy: a.actorId,
    } });
    i++;
  }
}

/** Shared gate of the proof actions: duty, step-up, verified identity, then the run under its locks. */
async function proofGate(actor: HrActor, step: string) {
  if (!can(actor, "payroll_pay")) assertCan(actor, "payroll_pay");
  assertFresh(actor);
  await assertVerifiedActor(actor, step);
}

async function lockForProof(tx: Tx, actor: HrActor, id: string, step: string) {
  const run = await lockRunForChange(tx, actor, id);
  const block = await payBlockOf(tx, run, actor.id);
  if (block) throw new HrError(SOD_MESSAGES.PAY[block], 403, block);
  await lock(tx, `payroll-pay:${id}`);
  await assertVerifiedActor(actor, step, tx);
  return run;
}

function requiredKey(b: Record<string, unknown>): string {
  const k = text(b.idempotencyKey, "idempotencyKey", { max: 80 });
  if (!k || k.length < 8) throw new HrError("idempotencyKey is required (8 to 80 characters) so a retry can never record the proof twice.", 400, "IDEMPOTENCY_REQUIRED");
  return k;
}

/**
 * The bank's per-employee credits of a recorded (bulk) payment, entered by hand: each names the
 * employee line, the amount credited and the bank's reference of that credit. Partial credits are
 * allowed (the line stays PARTIAL); a line is never credited above its net and the payment never
 * allocated above its amount. A retry with the same key returns what was recorded.
 */
export async function confirmAllocations(actor: HrActor, id: string, b: Record<string, unknown>) {
  if (!can(actor, "payroll_pay")) return auditSodRefusal(actor, id, "PAY", async () => assertCan(actor, "payroll_pay") as never);
  await proofGate(actor, "PAYROLL_PAY");
  await assertPayrollLive("PAYMENT_PROOF");
  const key = requiredKey(b);
  const paymentId = reqText(b.paymentId, "paymentId", 40);
  if (!isDay(b.confirmedOn)) throw new HrError("confirmedOn must be the date the bank credited the employees.", 400);
  const confirmedOn = parseDay(b.confirmedOn);
  const allocations = allocationsIn(b.allocations);
  return auditSodRefusal(actor, id, "PAY", () => guarded(() => prisma.$transaction(async (tx) => {
    await assertPayrollLive("PAYMENT_PROOF", tx); // F8: again inside the transaction
    const run = await lockForProof(tx, actor, id, "PAYROLL_PAY");
    const prior = await tx.hrPayrollPaymentAllocation.findMany({ where: { runId: id, idempotencyKey: { startsWith: `${key}#` } } });
    if (prior.length) {
      const sig = (x: { lineId: string; amount: Prisma.Decimal; bankReference: string }) => `${x.lineId}|${x.amount.toFixed(2)}|${x.bankReference.toLowerCase()}`;
      const same = prior.every((p) => p.paymentId === paymentId) && prior.length === allocations.length && prior.map(sig).sort().join() === allocations.map(sig).sort().join();
      if (!same) throw new HrError("This idempotency key was already used for different proof of this run. Nothing was recorded.", 409, "IDEMPOTENCY_CONFLICT");
      return { ...(await runDto(tx, id, actor)), replayed: true, completed: run.status === "PAID" };
    }
    if (run.status !== "APPROVED") throw new HrError("Payment proof is recorded against an APPROVED run (a paid run is reopened only by a return).", 409);
    const pay = await tx.hrPayrollPayment.findFirst({ where: { id: paymentId, runId: id } });
    if (!pay) throw new HrError("paymentId must name a payment of this run.", 400);
    const st = await runSettlement(tx, id);
    const left = st.payments.find((p) => p.paymentId === paymentId)?.unallocated ?? ZERO;
    await assertAllocations(tx, id, st, allocations, left);
    await createAllocations(tx, { runId: id, paymentId, allocations, confirmedOn, actorId: actor.id, source: "MANUAL", idempotencyKey: key, payees: await payeesOf(tx, id) });
    const completed = await completeIfSettled(tx, run, actor.id);
    await audit(tx, { action: "PAYROLL_PAYMENT_PROOF", entityType: "HrPayrollRun", entityId: id, after: { paymentId, allocations: allocations.length, total: allocations.reduce((s, a) => s.plus(a.amount), ZERO).toFixed(2), completed }, actorId: actor.id });
    return { ...(await runDto(tx, id, actor)), completed };
  }, TX)));
}

/**
 * Import the bank's RESULT file for a recorded payment (never the file this system exported).
 * Every row must match: the employee has a line in the run; a PAID row credits exactly that line's
 * outstanding net; a REJECTED row is a part of the payment the bank never credited; a RETURNED row
 * names a credit already recorded (originalReference) and returns all of it. Any mismatch refuses
 * the whole file and lists the rows. The same file (SHA-256) imported again returns the first import.
 */
export async function importBankResults(actor: HrActor, id: string, b: Record<string, unknown>) {
  if (!can(actor, "payroll_pay")) return auditSodRefusal(actor, id, "PAY", async () => assertCan(actor, "payroll_pay") as never);
  await proofGate(actor, "PAYROLL_PAY");
  await assertPayrollLive("PAYMENT_BANK_RESULTS");
  const paymentId = reqText(b.paymentId, "paymentId", 40);
  const fileName = reqText(b.fileName, "fileName", 200, 3);
  if (typeof b.csv !== "string" || !b.csv.trim()) throw new HrError("csv must be the bank result file's text.", 400);
  const csv = b.csv as string;
  if (!isDay(b.valueDate)) throw new HrError("valueDate must be the bank's value date of the results.", 400);
  const valueDate = parseDay(b.valueDate);
  const rows = parseBankResultCsv(csv);
  const digest = sha256(csv);
  return auditSodRefusal(actor, id, "PAY", () => guarded(() => prisma.$transaction(async (tx) => {
    await assertPayrollLive("PAYMENT_BANK_RESULTS", tx); // F8: again inside the transaction
    const run = await lockForProof(tx, actor, id, "PAYROLL_PAY");
    const again = await tx.hrPayrollBankImport.findUnique({ where: { runId_sha256: { runId: id, sha256: digest } } });
    if (again) return { ...(await runDto(tx, id, actor)), importId: again.id, replayed: true, completed: run.status === "PAID" };
    if (!["APPROVED", "PAID"].includes(run.status)) throw new HrError("Bank results are imported for an APPROVED (or, for returns, PAID) run.", 409);
    const pay = await tx.hrPayrollPayment.findFirst({ where: { id: paymentId, runId: id } });
    if (!pay) throw new HrError("paymentId must name a payment of this run.", 400);
    const st = await runSettlement(tx, id);
    const lines = await tx.hrPayrollLine.findMany({ where: { runId: id }, select: { id: true, employee: { select: { employeeNo: true } } } });
    const lineOf = new Map(lines.map((l) => [l.employee.employeeNo, l.id]));
    const allocs = await tx.hrPayrollPaymentAllocation.findMany({ where: { runId: id }, include: { returns: { select: { id: true } } } });
    const problems: string[] = [];
    const pending = new Map<string, Prisma.Decimal>();
    let fromPayment = ZERO;
    const credits: AllocationIn[] = [];
    const rejections: { lineId: string; amount: Prisma.Decimal; bankReference: string; reason: string }[] = [];
    const returnsIn: { allocationId: string; lineId: string; amount: Prisma.Decimal; bankReference: string; reason: string }[] = [];
    for (const r of rows) {
      const lineId = lineOf.get(r.employeeNo);
      if (!lineId) { problems.push(`row ${r.row}: ${r.employeeNo} has no line in this run`); continue; }
      const ls = st.lines.get(lineId)!;
      if (r.status === "PAID") {
        const taken = (pending.get(lineId) ?? ZERO).plus(r.amount);
        pending.set(lineId, taken);
        if (!taken.equals(ls.outstanding)) problems.push(`row ${r.row}: ${r.employeeNo} credited ${r.amount.toFixed(2)}, but the line's outstanding net is ${ls.outstanding.toFixed(2)}`);
        fromPayment = fromPayment.plus(r.amount);
        credits.push({ lineId, amount: r.amount, bankReference: r.bankReference });
      } else if (r.status === "REJECTED") {
        if (r.amount.greaterThan(ls.outstanding)) problems.push(`row ${r.row}: ${r.employeeNo} rejected ${r.amount.toFixed(2)}, more than the line's outstanding net ${ls.outstanding.toFixed(2)}`);
        fromPayment = fromPayment.plus(r.amount);
        rejections.push({ lineId, amount: r.amount, bankReference: r.bankReference, reason: r.reason ?? "Rejected by the bank" });
      } else {
        const orig = allocs.find((a) => a.bankReference.toLowerCase() === (r.originalReference ?? "").toLowerCase());
        if (!orig || orig.lineId !== lineId) problems.push(`row ${r.row}: ${r.employeeNo} returns ${r.originalReference}, which is not a credit recorded for that line`);
        else if (orig.returns.length) problems.push(`row ${r.row}: credit ${orig.bankReference} is already returned`);
        else if (!orig.amount.equals(r.amount)) problems.push(`row ${r.row}: credit ${orig.bankReference} was ${orig.amount.toFixed(2)}, the return is ${r.amount.toFixed(2)}`);
        else if (orig.paymentId !== paymentId) problems.push(`row ${r.row}: credit ${orig.bankReference} belongs to another payment of this run; import its returns against that payment`);
        else returnsIn.push({ allocationId: orig.id, lineId, amount: r.amount, bankReference: r.bankReference, reason: r.reason ?? "Returned by the bank" });
      }
    }
    const left = st.payments.find((p) => p.paymentId === paymentId)?.unallocated ?? ZERO;
    if (fromPayment.greaterThan(left)) problems.push(`the file credits and rejects ${fromPayment.toFixed(2)}, more than the ${left.toFixed(2)} of the payment still unaccounted for`);
    if (run.status === "PAID" && (credits.length || rejections.length)) problems.push("the run is paid; only returns can be imported for it");
    if (problems.length) throw new HrError(`The bank result file does not match this run, so nothing was imported: ${problems.slice(0, 6).join("; ")}${problems.length > 6 ? ` (+${problems.length - 6} more)` : ""}.`, 409, "PROOF_MISMATCH");
    const used = await usedReference(tx, rows.map((r) => r.bankReference));
    if (used) throw new HrError(`Bank reference ${used} is already recorded; the same result cannot be imported twice. Nothing was imported.`, 409, "DUPLICATE_BANK_REFERENCE");
    const imp = await tx.hrPayrollBankImport.create({ data: { runId: id, paymentId, fileName, sha256: digest, content: csv, rowCount: rows.length, paidRows: credits.length, returnedRows: rejections.length + returnsIn.length, recordedBy: actor.id } });
    if (credits.length) await createAllocations(tx, { runId: id, paymentId, allocations: credits, confirmedOn: valueDate, actorId: actor.id, source: "BANK_IMPORT", idempotencyKey: null, importId: imp.id, payees: await payeesOf(tx, id) });
    for (const x of rejections) await createReturn(tx, run, actor.id, { kind: "REJECTED", paymentId, lineId: x.lineId, amount: x.amount, bankReference: x.bankReference, reason: x.reason, returnedOn: valueDate, importId: imp.id, idempotencyKey: null });
    for (const x of returnsIn) await createReturn(tx, run, actor.id, { kind: "RETURNED", paymentId, allocationId: x.allocationId, lineId: x.lineId, amount: x.amount, bankReference: x.bankReference, reason: x.reason, returnedOn: valueDate, importId: imp.id, idempotencyKey: null });
    const reopened = await reopenIfShort(tx, id);
    const completed = await completeIfSettled(tx, run, actor.id);
    await audit(tx, { action: "PAYROLL_BANK_RESULTS", entityType: "HrPayrollRun", entityId: id, after: { importId: imp.id, paymentId, fileName, sha256: digest, credited: credits.length, rejected: rejections.length, returned: returnsIn.length, reopened, completed }, actorId: actor.id });
    return { ...(await runDto(tx, id, actor)), importId: imp.id, completed, reopened };
  }, TX)));
}

type ReturnIn = { kind: "RETURNED" | "REJECTED"; paymentId: string; allocationId?: string; lineId: string; amount: Prisma.Decimal; bankReference: string; reason: string; returnedOn: Date; importId: string | null; idempotencyKey: string | null };

/** One return row and its journal RETURN:<id> (Dr PAYROLL_CASH / Cr SALARIES_PAYABLE): the money came back, the employee is owed again. */
async function createReturn(tx: Tx, run: { id: string; periodMonth: string; accountingSkipped: boolean }, actorId: string, x: ReturnIn) {
  const line = await tx.hrPayrollLine.findUniqueOrThrow({ where: { id: x.lineId }, select: { employeeId: true } });
  const ret = await tx.hrPayrollPaymentReturn.create({ data: { runId: run.id, paymentId: x.paymentId, allocationId: x.allocationId ?? null, lineId: x.lineId, employeeId: line.employeeId, kind: x.kind, amount: x.amount, bankReference: x.bankReference, reason: x.reason, returnedOn: x.returnedOn, importId: x.importId, idempotencyKey: x.idempotencyKey, recordedBy: actorId } });
  const j = await postHrJournal(tx, {
    mode: run.accountingSkipped ? "skip" : "required", sourceType: "PAYROLL_RUN", sourceId: run.id, purpose: `RETURN:${ret.id}`, date: x.returnedOn, actorId,
    description: `Payroll ${run.periodMonth} · ${x.kind === "RETURNED" ? "returned credit" : "rejected credit"} ${x.bankReference}`,
    lines: [{ key: "PAYROLL_CASH", debit: x.amount, description: `Payroll ${run.periodMonth} ${x.kind === "RETURNED" ? "returned" : "rejected"} by the bank` }, { key: "SALARIES_PAYABLE", credit: x.amount, description: `Payroll ${run.periodMonth} owed again` }],
  });
  await audit(tx, { action: "PAYROLL_PAYMENT_RETURN", entityType: "HrPayrollRun", entityId: run.id, employeeId: line.employeeId, after: { returnId: ret.id, kind: x.kind, allocationId: x.allocationId ?? null, amount: x.amount.toFixed(2), bankReference: x.bankReference, journalEntryId: j.journalEntryId }, reason: x.reason, actorId });
  return ret;
}

/**
 * Record by hand a credit the bank RETURNED (`allocationId`: all of it) or a part of a bulk payment
 * it REJECTED before crediting the employee (`paymentId`, `lineId`, `amount`). The line reopens; a
 * PAID run goes back to APPROVED; the employee is paid again by a new per-line payment.
 */
export async function recordPaymentReturn(actor: HrActor, id: string, b: Record<string, unknown>) {
  if (!can(actor, "payroll_pay")) return auditSodRefusal(actor, id, "PAY", async () => assertCan(actor, "payroll_pay") as never);
  await proofGate(actor, "PAYROLL_PAY");
  await assertPayrollLive("PAYMENT_RETURN");
  const key = requiredKey(b);
  const kind = oneOf(b.kind, "kind", ["RETURNED", "REJECTED"] as const);
  const bankReference = bankRef(b.bankReference, "bankReference");
  const reason = reqText(b.reason, "reason", 300, 3);
  if (!isDay(b.returnedOn)) throw new HrError("returnedOn must be the date the bank returned the money.", 400);
  const returnedOn = parseDay(b.returnedOn);
  return auditSodRefusal(actor, id, "PAY", () => guarded(() => prisma.$transaction(async (tx) => {
    await assertPayrollLive("PAYMENT_RETURN", tx); // F8: again inside the transaction
    const run = await lockForProof(tx, actor, id, "PAYROLL_PAY");
    const prior = await tx.hrPayrollPaymentReturn.findUnique({ where: { runId_idempotencyKey: { runId: id, idempotencyKey: key } } });
    if (prior) {
      if (prior.kind !== kind || prior.bankReference.toLowerCase() !== bankReference.toLowerCase()) throw new HrError("This idempotency key was already used for a different return of this run. Nothing was recorded.", 409, "IDEMPOTENCY_CONFLICT");
      return { ...(await runDto(tx, id, actor)), returnId: prior.id, replayed: true };
    }
    if (!["APPROVED", "PAID"].includes(run.status)) throw new HrError("A return is recorded against an APPROVED or PAID run.", 409);
    let x: ReturnIn;
    if (kind === "RETURNED") {
      const allocationId = reqText(b.allocationId, "allocationId", 40);
      const al = await tx.hrPayrollPaymentAllocation.findFirst({ where: { id: allocationId, runId: id }, include: { returns: { select: { id: true } } } });
      if (!al) throw new HrError("allocationId must name a recorded credit of this run.", 400);
      if (al.returns.length) throw new HrError("This credit is already returned.", 409, "NOT_RETURNABLE");
      x = { kind, paymentId: al.paymentId, allocationId, lineId: al.lineId, amount: al.amount, bankReference, reason, returnedOn, importId: null, idempotencyKey: key };
    } else {
      if (run.status === "PAID") throw new HrError("A paid run has no unaccounted payment left to reject; record a return of the credit instead.", 409, "NOT_RETURNABLE");
      const paymentId = reqText(b.paymentId, "paymentId", 40);
      const lineId = reqText(b.lineId, "lineId", 40);
      const amount = proofAmount(b.amount, "amount");
      const st = await runSettlement(tx, id);
      const ls = st.lines.get(lineId);
      if (!ls) throw new HrError("lineId must name a line of this run.", 400);
      const pa = st.payments.find((p) => p.paymentId === paymentId);
      if (!pa) throw new HrError("paymentId must name a payment of this run.", 400);
      if (amount.greaterThan(pa.unallocated)) throw new HrError(`Only ${pa.unallocated.toFixed(2)} of this payment is still unaccounted for; a rejection cannot exceed it.`, 409, "NOT_RETURNABLE");
      if (amount.greaterThan(ls.outstanding)) throw new HrError(`The line's outstanding net is ${ls.outstanding.toFixed(2)}; a rejection for it cannot exceed it.`, 409, "NOT_RETURNABLE");
      x = { kind, paymentId, lineId, amount, bankReference, reason, returnedOn, importId: null, idempotencyKey: key };
    }
    const used = await usedReference(tx, [bankReference]);
    if (used) throw new HrError(`Bank reference ${used} is already recorded; nothing was recorded.`, 409, "DUPLICATE_BANK_REFERENCE");
    const ret = await createReturn(tx, run, actor.id, x);
    const reopened = await reopenIfShort(tx, id);
    const completed = await completeIfSettled(tx, run, actor.id);
    return { ...(await runDto(tx, id, actor)), returnId: ret.id, reopened, completed };
  }, TX)));
}

// ── Cancel ────────────────────────────────────────────────────────────────────────

export async function cancelRun(actor: HrActor, id: string, b: Record<string, unknown>, today: Date) {
  if (!["payroll_prepare", "payroll_approve", "payroll_cancel_approved"].some((d) => can(actor, d as never))) {
    return auditSodRefusal(actor, id, "CANCEL", async () => assertAny(actor, ["payroll_prepare", "payroll_approve", "payroll_cancel_approved"]) as never);
  }
  await assertVerifiedActor(actor, "PAYROLL_CANCEL");
  const reason = reqText(b.reason, "reason", 300, 5);
  return auditSodRefusal(actor, id, "CANCEL", () => guarded(() => prisma.$transaction(async (tx) => {
    // Month lock first, then the run row (QA P1-2: the same row lock recordPayment takes), then
    // everything below re-reads the run's state under that lock.
    const peek = await loadRun(tx, actor, id);
    await lock(tx, `payroll:${peek.periodMonth}`);
    // Review NEW-9: re-checked inside the transaction, after the lock.
    await assertVerifiedActor(actor, "PAYROLL_CANCEL", tx);
    const run = await lockRun(tx, actor, id);
    if (run.status === "PAID") throw new HrError("A paid run is history. Prepare a correction run instead.", 409);
    if (run.status === "CANCELLED") throw new HrError("This run is already cancelled.", 409);
    if (run.status === "DRAFT" || run.status === "REVIEW") assertAny(actor, ["payroll_prepare", "payroll_approve"]);
    if (run.status === "APPROVED") {
      // Q-2: after approval only the separately authorized cancellation duty, held by someone who
      // neither prepared nor approved the run, and only while no payment is recorded.
      assertCan(actor, "payroll_cancel_approved");
      assertFresh(actor);
      const block = await cancelBlockOf(tx, run, actor.id);
      if (block) throw new HrError(SOD_MESSAGES.CANCEL[block], 403, block);
      const paid = await tx.hrPayrollPayment.count({ where: { runId: id } });
      if (paid > 0) throw new HrError("Payments are already recorded against this run; it cannot be cancelled.", 409, "PAYMENT_RECORDED");
      // Phase 1 lock: cancelling an APPROVED run posts the accrual's reversal journal.
      await assertPayrollLive("RUN_CANCEL_APPROVED", tx);
    }
    let reversal: { journalEntryId: string | null; skipped: boolean } | null = null;
    if (run.status === "APPROVED") reversal = await reverseHrJournal(tx, { sourceType: "PAYROLL_RUN", sourceId: id, purpose: "ACCRUAL", reversalPurpose: "REVERSAL", date: today, reason, actorId: actor.id });
    await releaseHolds(tx, id);
    await tx.hrPayrollRun.update({ where: { id }, data: { status: "CANCELLED", cancelledBy: actor.id, cancelledAt: new Date(), cancelReason: reason } });
    await audit(tx, { action: "PAYROLL_CANCEL", entityType: "HrPayrollRun", entityId: id, before: { status: run.status }, reason, after: { reversalJournalEntryId: reversal?.journalEntryId ?? null }, actorId: actor.id });
    return runDto(tx, id, actor);
  }, TX)));
}

// ── Read ──────────────────────────────────────────────────────────────────────────

function assertPayrollReader(actor: HrActor) {
  assertAny(actor, ["payroll_prepare", "payroll_approve", "payroll_pay", "payroll_cancel_approved"]);
}

export async function listRuns(actor: HrActor) {
  assertPayrollReader(actor);
  const scope = await resolveScope(actor);
  const rows = await prisma.hrPayrollRun.findMany({ where: scope.all ? {} : { branchKey: { in: scope.branchIds } }, orderBy: [{ periodMonth: "desc" }, { runNo: "desc" }], take: 60, include: { _count: { select: { lines: true } } } });
  return rows.map((r) => ({ id: r.id, runNo: r.runNo, periodMonth: r.periodMonth, branchKey: r.branchKey, kind: r.kind, status: r.status, totalGross: r.totalGross.toFixed(2), totalDeductions: r.totalDeductions.toFixed(2), totalNet: r.totalNet.toFixed(2), lines: r._count.lines, preparedAt: r.preparedAt }));
}

export async function getRun(actor: HrActor, id: string) {
  assertPayrollReader(actor);
  return prisma.$transaction(async (tx) => {
    await loadRun(tx, actor, id);
    return runDto(tx, id, actor);
  }, TX);
}

async function runDto(tx: Tx, id: string, actor: HrActor) {
  const run = await tx.hrPayrollRun.findUniqueOrThrow({ where: { id }, include: { policy: true, payments: { include: { allocations: true } }, paymentReturns: true, bankImports: { select: { id: true, paymentId: true, fileName: true, sha256: true, rowCount: true, createdAt: true } }, lines: { include: { items: true, employee: { select: { id: true, employeeNo: true, fullNameAr: true, accountId: true } } }, orderBy: { employee: { employeeNo: "asc" } } } } });
  // P-2 rev3 item 2: what stayed paid (payments − returns) and the proof per line and per payment.
  const proof = await runSettlement(tx, id);
  const people = await tx.employee.findMany({ where: { id: { in: [run.preparedBy, ...run.lines.map((l) => l.approvedBy).filter(Boolean) as string[]] } }, select: { id: true, name: true } });
  const name = (x: string | null) => (x ? people.find((p) => p.id === x)?.name ?? x : null);
  const links = await tx.hrJournalLink.findMany({ where: { sourceType: "PAYROLL_RUN", sourceId: id }, include: { journalEntry: { select: { entryNo: true, status: true, totalDebit: true, entryDate: true } } } });
  const paid = proof.cashOut;
  // P-3: the page shows exactly what the server allows, and the reason when it refuses.
  const preparer = await involves(tx, await runPreparers(tx, run), actor.id);
  const mayApprove = can(actor, "payroll_approve") && run.status === "REVIEW";
  const mayPay = can(actor, "payroll_pay") && run.status === "APPROVED" && (run.totalNet.greaterThan(paid) || !proof.complete);
  const payBlock = mayPay ? await payBlockOf(tx, run, actor.id) : null;
  // P-2 rev3 item 2: per-employee proof and returns, on APPROVED and PAID runs (same segregation as paying).
  const mayProve = can(actor, "payroll_pay") && (run.status === "APPROVED" || run.status === "PAID") && run.payments.length > 0;
  const canProve = mayProve && !(mayPay ? payBlock : await payBlockOf(tx, run, actor.id));
  const mayCancelApproved = can(actor, "payroll_cancel_approved") && run.status === "APPROVED" && run.payments.length === 0;
  const cancelBlock = mayCancelApproved ? await cancelBlockOf(tx, run, actor.id) : null;
  const reconciliation = await runReconciliation(tx, id);
  const journalPreview = links.length === 0 && (run.status === "DRAFT" || run.status === "REVIEW") && run.lines.length > 0 ? await previewAccrual(tx, id) : null;
  return {
    id: run.id, runNo: run.runNo, periodMonth: run.periodMonth, periodStart: dayString(run.periodStart), periodEnd: dayString(run.periodEnd), branchKey: run.branchKey, kind: run.kind, correctsRunId: run.correctsRunId,
    status: run.status, preparedBy: run.preparedBy, preparedByName: name(run.preparedBy), preparedAt: run.preparedAt, submittedAt: run.submittedAt, approvedAt: run.approvedAt, paidAt: run.paidAt,
    cancelledAt: run.cancelledAt, cancelReason: run.cancelReason, accountingSkipped: run.accountingSkipped,
    policy: { id: run.policy.id, version: run.policy.version, dayBasis: run.policy.dayBasis, isProposal: run.policy.isProposal },
    totals: { gross: run.totalGross.toFixed(2), deductions: run.totalDeductions.toFixed(2), net: run.totalNet.toFixed(2), employer: run.totalEmployer.toFixed(2), paid: paid.toFixed(2), unpaid: run.totalNet.minus(paid).toFixed(2) },
    payments: run.payments.map((p) => {
      const pa = proof.payments.find((x) => x.paymentId === p.id);
      return {
        id: p.id, amount: p.amount.toFixed(2), paidOn: dayString(p.paidOn), method: p.method, reference: p.reference, lineId: p.lineId,
        allocated: (pa?.allocated ?? ZERO).toFixed(2), rejected: (pa?.rejected ?? ZERO).toFixed(2), unallocated: (pa?.unallocated ?? ZERO).toFixed(2),
        allocations: p.allocations.map((a) => ({ id: a.id, lineId: a.lineId, amount: a.amount.toFixed(2), bankReference: a.bankReference, payeeAccountLast4: a.payeeAccountLast4, source: a.source, confirmedOn: dayString(a.confirmedOn) })),
      };
    }),
    returns: run.paymentReturns.map((x) => ({ id: x.id, kind: x.kind, paymentId: x.paymentId, allocationId: x.allocationId, lineId: x.lineId, amount: x.amount.toFixed(2), bankReference: x.bankReference, reason: x.reason, returnedOn: dayString(x.returnedOn) })),
    bankImports: run.bankImports.map((x) => ({ id: x.id, paymentId: x.paymentId, fileName: x.fileName, sha256: x.sha256, rows: x.rowCount, at: x.createdAt })),
    proof: { complete: proof.complete, unsettledLines: proof.unsettledLines, unallocated: proof.unallocated.toFixed(2), returned: proof.returnedTotal.toFixed(2) },
    journals: links.map((l) => ({ purpose: l.purpose, journalEntryId: l.journalEntryId, entryNo: l.journalEntry.entryNo, status: l.journalEntry.status, amount: l.journalEntry.totalDebit.toFixed(2), date: dayString(l.journalEntry.entryDate) })),
    journalPreview,
    reconciliation,
    // F2: the button appears only when approval can succeed (confirmed policy, figures reconcile).
    canApprove: mayApprove && !preparer && !run.policy.isProposal && reconciliation.ok,
    approveBlock: mayApprove && preparer ? SOD_PREPARER : null,
    canPay: mayPay && !payBlock,
    canProve,
    payBlock,
    // Q-2: the post-approval cancellation the server allows this actor, or why not.
    canCancelApproved: mayCancelApproved && !cancelBlock,
    cancelBlock,
    // P-2 review P2-B7: escalated advances of the run's people (the preparer acknowledges them on submit).
    escalations: run.status === "DRAFT" || run.status === "REVIEW" ? await escalatedAdvancesOf(tx, id) : [],
    isPreparer: preparer,
    lines: run.lines.map((l) => ({
      id: l.id, employee: { id: l.employee.id, employeeNo: l.employee.employeeNo, fullNameAr: l.employee.fullNameAr }, isMine: l.employee.accountId === actor.id,
      payableDays: l.payableDays.toString(), dayDetail: dayDetail(l.snapshot, l.payableDays), gross: l.gross.toFixed(2), deductions: l.deductions.toFixed(2), net: l.net.toFixed(2), employer: l.employer.toFixed(2),
      settlement: run.status === "APPROVED" || run.status === "PAID" ? settlementDto(proof.lines.get(l.id)) : null,
      exceptions: l.exceptions, blocking: l.blocking, approvedBy: l.approvedBy, approvedByName: name(l.approvedBy), approvedAt: l.approvedAt,
      items: l.items.map((i) => ({ code: i.code, kind: i.kind, amount: i.amount.toFixed(2), quantity: i.quantity?.toString() ?? null, description: i.description })),
    })),
  };
}

/**
 * Day breakdown of a line, read from the snapshot stored when the line was calculated — never
 * recomputed, so it explains the amount the line actually carries. `payable` is the stored
 * column; `basis` is the policy's month basis; `employed` the days on payroll in the month;
 * `unpaid` the approved unpaid-leave days deducted. Null for correction lines and old shapes.
 */
export function dayDetail(snapshot: unknown, payableDays: Prisma.Decimal) {
  const s = snapshot as { policy?: { basisDays?: number }; segments?: { days?: number }[]; unpaidLeaveDays?: string[]; employed?: { from?: string; to?: string } | null; month?: string; days?: Record<string, unknown> } | null;
  if (!s || typeof s.policy?.basisDays !== "number" || !Array.isArray(s.segments)) return null;
  const employed = s.segments.reduce((a, x) => a + (typeof x.days === "number" ? x.days : 0), 0);
  // P-2 rev3 item 6: the figures in one unit each, as stored with the line (lines built before rev3
  // have none — then only the older fields are shown).
  const d = s.days as { calendarServiceDays?: number; unpaidCalendarDays?: number; unpaidDeductedUnits?: number; payUnits?: number; payslipDays?: number; status?: string } | undefined;
  return {
    payable: payableDays.toString(), basis: s.policy.basisDays, employed,
    unpaid: Array.isArray(s.unpaidLeaveDays) ? s.unpaidLeaveDays.length : 0,
    employedFrom: s.employed?.from ?? null, employedTo: s.employed?.to ?? null,
    ...(d && typeof d.calendarServiceDays === "number" ? {
      calendarServiceDays: d.calendarServiceDays, unpaidCalendarDays: d.unpaidCalendarDays ?? 0, unpaidDeductedUnits: d.unpaidDeductedUnits ?? 0,
      payUnits: d.payUnits ?? 0, payslipDays: d.payslipDays ?? 0, status: d.status ?? "PAYABLE",
    } : {}),
  };
}

/**
 * A payslip. Payroll roles see any line in scope; a person sees their own once the run is APPROVED
 * or PAID — through the self-service route only (`self`: /api/hr/me/payslips/:id, which checks the
 * lock and ownership itself).
 */
export async function payslip(actor: HrActor, lineId: string, opts: { self?: boolean } = {}) {
  // Lock-module rule: the permission check comes first, so an account without the payroll duty
  // always gets 403 and never learns the lock state.
  if (!opts.self) assertPayrollReader(actor);
  // Owner (RC3.1): a payroll document never represents a LOCKED payroll run as an authorized
  // payment. While live payroll is off no payslip is produced at all — before any lookup, so the
  // refusal says nothing about which lines exist. (Unapproved runs while live: `authorized` below,
  // and the page's NOT-AN-AUTHORIZED-PAYMENT marking.)
  await assertPayrollLive("PAYSLIP");
  const line = await prisma.hrPayrollLine.findUnique({ where: { id: lineId }, include: { items: true, run: true, employee: { select: { id: true, employeeNo: true, fullNameAr: true, jobTitle: true, accountId: true, branchId: true } } } });
  if (!line) throw new HrError("Payslip not found", 404);
  // The self route has already matched the line to the caller's own person record.
  const own = opts.self === true || line.employee.accountId === actor.id;
  if (own) {
    if (!["APPROVED", "PAID"].includes(line.run.status)) throw new HrError("Payslip not found", 404);
  } else {
    await prisma.$transaction((tx) => loadRun(tx, actor, line.runId), TX);
  }
  return {
    id: line.id, runId: line.runId, runNo: line.run.runNo, kind: line.run.kind, periodMonth: line.run.periodMonth, status: line.run.status, employee: { employeeNo: line.employee.employeeNo, fullNameAr: line.employee.fullNameAr, jobTitle: line.employee.jobTitle },
    payableDays: line.payableDays.toString(), dayDetail: dayDetail(line.snapshot, line.payableDays), gross: line.gross.toFixed(2), deductions: line.deductions.toFixed(2), net: line.net.toFixed(2),
    items: line.items.filter((i) => i.kind !== "EMPLOYER").map((i) => ({ code: i.code, kind: i.kind, amount: i.amount.toFixed(2), quantity: i.quantity?.toString() ?? null, description: i.description })),
    final: ["APPROVED", "PAID"].includes(line.run.status),
    // An authorized payment only once the run is approved (or paid). Anything else is printed as
    // NOT AN AUTHORIZED PAYMENT, in both languages, on screen and on paper (../payroll-doc.ts).
    authorized: isAuthorizedPayment(line.run.status),
  };
}

/**
 * Generic CSV of a run (NOT a WPS/Mudad file). IBAN only for actors with private_view. While payroll
 * is LOCKED no variant is produced (409 PAYROLL_LOCKED: BANK_FILE with IBANs, PAYROLL_EXPORT
 * without). While live, a run that is not APPROVED / PAID starts with the bilingual
 * NOT-AN-AUTHORIZED-PAYMENT line (../payroll-doc.ts exportMarkerLine).
 */
export async function exportCsv(actor: HrActor, id: string): Promise<string> {
  assertPayrollReader(actor);
  const withIban = can(actor, "private_view");
  // The file WITH the payees' IBANs is the bank payment instruction (BANK_FILE); without IBANs it
  // is still a payroll document with every person's figures (PAYROLL_EXPORT). Both are locked.
  const action = withIban ? "BANK_FILE" : "PAYROLL_EXPORT";
  await assertPayrollLive(action);
  return prisma.$transaction(async (tx) => {
    await assertPayrollLive(action, tx); // F8: again inside the transaction
    const run = await loadRun(tx, actor, id);
    const lines = await tx.hrPayrollLine.findMany({ where: { runId: id }, include: { employee: { select: { employeeNo: true, fullNameAr: true, private: { select: { iban: true, bankName: true } } } } }, orderBy: { employee: { employeeNo: "asc" } } });
    const esc = (v: string) => (/[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
    const marker = exportMarkerLine(run.status);
    const rows = [...(marker ? [esc(marker)] : []), ["run", "month", "status", "employee_no", "name", "gross", "deductions", "net", "bank", "iban"].join(",")];
    // P-2 / E-4: built by the same function the reconciliation report checks against the run net.
    for (const r of exportRows(run, lines, withIban)) rows.push(r.map(esc).join(","));
    await audit(tx, { action: "PAYROLL_EXPORT", entityType: "HrPayrollRun", entityId: id, after: { lines: lines.length, withIban, authorized: !marker }, actorId: actor.id });
    return "﻿" + rows.join("\n") + "\n";
  }, TX);
}

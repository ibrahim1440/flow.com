// Native HR — payroll controls that need the database (P-2: E-1, E-3, E-4, findings 1, 5, 10).
// Kept apart from ./payroll so the run service changes only where it calls in here.
//
// • lineControls — per regular line, after the unchanged engine ran: the unpaid-leave guard
//   (whole period on unpaid leave yet pay left → BLOCKING; the same day on two leaves → BLOCKING;
//   a money-affecting leave type still a proposal → BLOCKING). A blocking line can never be
//   submitted or approved (service + DB trigger hr_payroll_run_guard).
// • policyGate — no run is prepared, submitted, approved or paid under a proposal policy. The
//   ONLY exception: a CORRECTION of an approved run whose month is under a proposal policy, and
//   only with an APPLIED second-person attestation (HrConfigChange PAYROLL_CONTROL_ATTEST /
//   PROPOSAL_CORRECTION, ./payroll-attest) bound to that run, that policy content and that pay
//   record, used by this correction run alone, from people who neither prepare, approve nor are
//   paid by it. No flag, no INFO-and-continue.
// • separationEarningControls — review P1-B2: any EARNING adjustment for a person whose separation
//   is initiated or completed by the run month is BLOCKING (SEPARATION_EARNING_REVIEW) until an
//   independent second person attests it; reaching an end-of-service / leave-encashment amount on
//   record, in total since the separation, is BLOCKING with no attestation (EOS_MISCLASSIFIED).
// • runControlReport / payrollControlsReport — read-only reconciliation of items, lines, run
//   totals, payslips, the CSV export, the accrual and payment journals and the payments, with the
//   single-rounding difference per line and the recorded explanations. Nothing is corrected.
// • recordReconNote — an explanation of a reported difference (append-only; never an amount).
import { Prisma } from "@/generated/prisma/client";
import { prisma } from "@/lib/db";
import { HrError, type HrActor, type Db, TX, assertAny, audit, reqText, resolveScope } from "../core";
import { dayString, monthBounds, parseDay } from "../dates";
import type { Component, EngineResult } from "../payroll-engine";
import { dayBreakdown, singleRoundingDifference, unpaidLeaveControls } from "../payroll-controls";
import { looksLikeFinalSettlement } from "../adjustment-categories";
import { controlRefusal, journalIntegrityReport, journalProblems, type PostedLine } from "./journal-integrity";
import { proposalCorrectionAttestation, separationEarningAttestation, separationEarningAttestationRow } from "./payroll-attest";
import { samePersonRecords, separationEarningContext } from "./final-settlement";
export const SAME_PERSON_CHECK_INCOMPLETE = "SAME_PERSON_CHECK_INCOMPLETE";
import { samePersonAsAny } from "../identity";

type Tx = Prisma.TransactionClient;
const ZERO = new Prisma.Decimal(0);
export const POLICY_PROPOSAL = "POLICY_PROPOSAL";

// ── Policy gate (E-1, finding 10) ───────────────────────────────────────────────────

/**
 * Refuse (409 POLICY_PROPOSAL, audited) unless the run's policy is confirmed, or the run is a
 * CORRECTION covered by an applied proposal-correction attestation. Returns that attestation id.
 */
export async function policyGate(db: Db, r: { id?: string; kind: string; correctsRunId: string | null; policy: { id: string; version: number; isProposal: boolean } }, step: string, actorId: string): Promise<string | null> {
  if (!r.policy.isProposal) return null;
  let why = "";
  if (r.kind === "CORRECTION" && r.correctsRunId) {
    const a = await proposalCorrectionAttestation(db, { correctsRunId: r.correctsRunId, policyId: r.policy.id, runId: r.id, actorId });
    if (a && "id" in a) return a.id;
    if (a && "refused" in a) why = ` The attestation on record cannot be used: ${a.refused}.`;
  }
  throw await controlRefusal(
    new HrError(`Payroll policy v${r.policy.version} is still a proposal, so payroll cannot be prepared, submitted, approved or paid under it. Confirm and activate a policy version first${r.kind === "CORRECTION" ? ", or obtain an approved second-person attestation for this correction" : ""}.${why}`, 409, POLICY_PROPOSAL),
    { entityType: "HrPayrollRun", entityId: r.id ?? r.correctsRunId ?? "-", step, actorId, detail: { policyVersion: r.policy.version } },
  );
}

// ── Accrual posting date (corrections of a closed month) ────────────────────────────

/**
 * Where a run's accrual journal posts. A REGULAR run posts on its period end (a closed or locked
 * period refuses it). A CORRECTION posts on its period end only while that fiscal period is OPEN;
 * once it is locked or closed, the correction is ROUTED to the approval day in the current period,
 * naming the original period — explicit in the journal description and the approval audit.
 */
export async function accrualPosting(db: Db, run: { kind: string; periodEnd: Date; periodMonth: string }, today: Date): Promise<{ date: Date; routed: boolean; note: string | null }> {
  if (run.kind !== "CORRECTION") return { date: run.periodEnd, routed: false, note: null };
  const p = await db.fiscalPeriod.findFirst({ where: { startDate: { lte: run.periodEnd }, endDate: { gte: run.periodEnd } } });
  if (p && p.status === "OPEN") return { date: run.periodEnd, routed: false, note: null };
  return { date: today, routed: true, note: `corrects ${run.periodMonth}; original period ${p ? `${p.year}/${p.periodNo} ${p.status}` : "none"}, posted ${dayString(today)}` };
}

/** The date a run's accrual was posted on, as approval recorded it (for verification before payment). */
export async function accrualDateOf(db: Db, run: { id: string; kind: string; periodEnd: Date }): Promise<Date> {
  if (run.kind !== "CORRECTION") return run.periodEnd;
  const a = await db.hrAuditLog.findFirst({ where: { action: "PAYROLL_APPROVED", entityType: "HrPayrollRun", entityId: run.id }, orderBy: { createdAt: "desc" } });
  const d = (a?.after as { postingDate?: string } | null)?.postingDate;
  return d ? parseDay(d) : run.periodEnd;
}

// ── Line controls (finding 1, E-1 leave types) ──────────────────────────────────────

/** Adds the unpaid-leave and proposal-leave-type exceptions to an engine result (amounts untouched). */
export async function lineControls(tx: Tx, a: { month: string; employeeId: string; unpaidLeaveComponents: Component[]; calc: EngineResult }) {
  const { start, end } = monthBounds(a.month);
  const leaves = await tx.hrLeaveRequest.findMany({ where: { employeeId: a.employeeId, status: "APPROVED", leaveType: { paid: false }, startDate: { lte: end }, endDate: { gte: start } }, include: { leaveType: { select: { code: true, isProposal: true } } } });
  const employed = (a.calc.snapshot.employed as { from: string; to: string } | undefined) ?? null;
  // Review P1-A1: no attestation is consulted — nothing in the run releases a whole unpaid period.
  const r = unpaidLeaveControls({
    month: a.month, employed, unpaidLeaveComponents: a.unpaidLeaveComponents,
    leaves: leaves.map((l) => ({ id: l.id, startDate: l.startDate, endDate: l.endDate, leaveTypeCode: l.leaveType.code, leaveTypeProposal: l.leaveType.isProposal })),
    items: a.calc.items.map((i) => ({ code: i.code, kind: i.kind, amount: i.amount })),
  });
  if (r.exceptions.length) {
    a.calc.exceptions.push(...r.exceptions);
    a.calc.blocking = a.calc.exceptions.some((e) => e.severity === "BLOCKING");
  }
  a.calc.snapshot.controls = { ...((a.calc.snapshot.controls as object) ?? {}), unpaidFullPeriod: r.fullPeriod, unpaidRemainder: r.remainder.toFixed(2), unpaidOverlapDays: r.overlapDays, proposalLeaveTypes: r.proposalLeaveTypes };
  // P-2 rev3 item 6: the day figures, each in one unit (display only — no amount changes). The
  // payslip figure is 0 for a whole period of unpaid leave: such a line shows no payable days.
  if (employed) {
    const policy = a.calc.snapshot.policy as { dayBasis: string; basisDays: number };
    const segments = (a.calc.snapshot.segments as { days: number }[] | undefined) ?? [];
    const days = dayBreakdown({
      basis: policy.dayBasis, basisUnits: policy.basisDays, employed, serviceUnits: segments.reduce((t, s) => t + s.days, 0),
      leaves: leaves.map((l) => ({ startDate: l.startDate, endDate: l.endDate })),
      unpaidDeductedUnits: ((a.calc.snapshot.unpaidLeaveDays as string[] | undefined) ?? []).length, fullPeriod: r.fullPeriod, remainder: r.remainder,
    });
    a.calc.snapshot.days = days;
    a.calc.payableDays = new Prisma.Decimal(days.payslipDays);
  }
}

/**
 * Review P1-B2 / round-3 — earnings for a separating person (regular and correction lines).
 * Exceptions only; amounts untouched. Decided now (the line is not approved yet), never by when an
 * adjustment was entered — see `separationEarningContext`:
 *   · the person (any record of the same human) has any separation or final-settlement record,
 *     whatever its status, and this line carries EARNING adjustments:
 *       – the earnings in scope reaching an end-of-service / leave-encashment amount on record →
 *         BLOCKING EOS_MISCLASSIFIED (no attestation: paid by the final settlement only);
 *       – otherwise → BLOCKING SEPARATION_EARNING_REVIEW, INFO once an independent second person
 *         (not a preparer or approver of the run, not the payee) attested exactly these
 *         adjustments (PAYROLL_CONTROL_ATTEST / SEPARATION_EARNING);
 *   · the line carries EARNING adjustments and its employee record has no identity number →
 *     WARNING SAME_PERSON_CHECK_INCOMPLETE (another record of the same human cannot be matched);
 *   · reasons worded like end of service / leave encashment → INFO EOS_KEYWORD (a warning only).
 */
export async function separationEarningControls(tx: Tx, a: { run: { id: string; periodMonth: string; preparedBy: string; submittedBy: string | null }; employeeId: string; calc: EngineResult }) {
  const earnings = await tx.hrPayrollAdjustment.findMany({ where: { runId: a.run.id, employeeId: a.employeeId, kind: "EARNING" }, select: { id: true, amount: true, reason: true, category: true } });
  const ex = a.calc.exceptions;
  const words = (await tx.hrPayrollAdjustment.findMany({ where: { runId: a.run.id, employeeId: a.employeeId }, select: { reason: true } })).filter((x) => looksLikeFinalSettlement(x.reason));
  if (words.length) ex.push({ code: "EOS_KEYWORD", severity: "INFO", message: `${words.length} تسوية بصياغة تشبه مكافأة نهاية الخدمة أو بدل الإجازة. تُصرف هذه من التسوية النهائية لا من الراتب: تحقّق من الفئة قبل الاعتماد.` });
  const c = earnings.length ? await separationEarningContext(tx, a.employeeId) : null;
  if (earnings.length && (c?.group.idMissing ?? (await samePersonRecords(tx, a.employeeId)).idMissing)) {
    ex.push({ code: SAME_PERSON_CHECK_INCOMPLETE, severity: "WARNING", message: "سجل الموظف بلا رقم هوية، فلا يمكن ربطه بسجل آخر للشخص نفسه: فحص إنهاء الخدمة والتسوية النهائية ناقص لهذا السطر. أكمل رقم الهوية قبل تفعيل الرواتب." });
  }
  if (earnings.length && c) {
    const total = c.cumulative.toFixed(2);
    if (c.reached.length) {
      ex.push({ code: "EOS_MISCLASSIFIED", severity: "BLOCKING", message: `مجموع التسويات الإضافية منذ إنهاء الخدمة ${total} يبلغ مبلغ تسوية نهائية مسجّلًا (${c.reached.map((r) => `${r.label} ${r.amount.toFixed(2)}`).join("، ")}). يُصرف من التسوية النهائية فقط ولا يُقبل بإقرار.` });
    } else if (c.reviewRequired) {
      const att = await separationEarningAttestation(tx, a.run, a.employeeId);
      ex.push(att
        ? { code: "SEPARATION_EARNING_REVIEW", severity: "INFO", message: `تسوية إضافية لموظف منتهية خدمته (مجموعها منذ الإنهاء ${total}) أقرّها شخص مستقل (${att}).` }
        : { code: "SEPARATION_EARNING_REVIEW", severity: "BLOCKING", message: `تسوية إضافية لموظف بدأ إنهاء خدمته أو اكتمل (مجموعها منذ الإنهاء ${total}). لا تُعتمد حتى يقرّها شخص مستقل ليس من أعدّ المسير ولا من يعتمده ولا المستفيد.` });
    }
    a.calc.snapshot.controls = { ...((a.calc.snapshot.controls as object) ?? {}), separationEarning: { separationId: c.separation?.id ?? null, records: c.group.ids, scopes: c.scopes, reviewRequired: c.reviewRequired, sinceMonth: c.sinceMonth, cumulative: total, amountsOnRecord: c.amounts.map((x) => ({ label: x.label, amount: x.amount.toFixed(2) })), adjustments: earnings.map((e) => ({ id: e.id, amount: e.amount.toFixed(2), category: e.category })) } };
  }
  a.calc.blocking = ex.some((e) => e.severity === "BLOCKING");
}

/**
 * Round-3 / re-review N1 / N4 — the separation rules, re-decided at submission and at every
 * approval on the data as it stands then, for every line NOT YET APPROVED that carries EARNING
 * adjustments (whenever they were entered, and whatever the line exceptions said when it was
 * built). The caller has locked these people (`separationPeopleOf`) once, up front, after the
 * month lock and before the run row (payroll.ts `lockRunForChange`, round-5 F1):
 *   · earnings in scope reaching an end-of-service / leave-encashment amount on record →
 *     409 EOS_MISCLASSIFIED;
 *   · no valid independent attestation → 409 SEPARATION_EARNING_REVIEW;
 *   · the person acting (`approverId`) gave or requested that attestation → 403 ATTESTER_CONFLICT.
 * A line approved BEFORE any separation existed is out of scope: its figures are frozen (DB), and
 * its earnings count in the cumulative only if its run was approved after the earliest separation.
 */
/** The people of a run the separation rules look at: EARNING adjustments on lines not yet approved. */
export async function separationPeopleOf(tx: Tx, runId: string): Promise<string[]> {
  const pendingLines = await tx.hrPayrollLine.findMany({ where: { runId, approvedBy: null }, select: { employeeId: true } });
  const pending = new Set(pendingLines.map((l) => l.employeeId));
  const adj = await tx.hrPayrollAdjustment.findMany({ where: { runId, kind: "EARNING" }, select: { employeeId: true } });
  return [...new Set(adj.map((x) => x.employeeId))].filter((e) => pending.has(e)).sort();
}

export async function assertSeparationEarningsApprovable(tx: Tx, run: { id: string; periodMonth: string; preparedBy: string; submittedBy: string | null }, approverId?: string) {
  const people = await separationPeopleOf(tx, run.id);
  for (const employeeId of people) {
    const c = await separationEarningContext(tx, employeeId);
    if (!c) continue;
    if (c.reached.length) {
      throw new HrError(`Earning adjustments since this person's separation total ${c.cumulative.toFixed(2)}, reaching the end-of-service / leave-encashment amount on record (${c.reached.map((r) => `${r.label} ${r.amount.toFixed(2)}`).join(", ")}). It is never paid through payroll, in one adjustment or several; use the final settlement.`, 409, "EOS_MISCLASSIFIED");
    }
    // rev3 item 5: a rehire (a new relationship) is reviewed only while the old one is unsettled (D-7i-3).
    if (!c.reviewRequired) continue;
    const att = await separationEarningAttestationRow(tx, run, employeeId);
    if (!att) throw new HrError("An earning adjustment for a person whose separation has begun has no valid independent attestation. Request one (not from the preparer, the approver or the payee) and rebuild the run.", 409, "SEPARATION_EARNING_REVIEW");
    if (approverId && (await samePersonAsAny(tx, [att.attester, att.requester], approverId))) {
      throw new HrError("You attested or requested the separation-earning attestation this run relies on, so you cannot approve the run. Another approver must.", 403, "ATTESTER_CONFLICT");
    }
  }
}

// ── Reconciliation report (finding 5 / E-4) ─────────────────────────────────────────

type Check = { check: string; lineId: string | null; label: string | null; expected: string; actual: string; differenceHalalas: number; explanation: string | null };
const halalas = (v: Prisma.Decimal) => v.times(100).toNumber();

/** The run's generic CSV export rows (the same builder exportCsv uses). */
export function exportRows(run: { runNo: number; periodMonth: string; status: string }, lines: { gross: Prisma.Decimal; deductions: Prisma.Decimal; net: Prisma.Decimal; employee: { employeeNo: string; fullNameAr: string; private?: { iban: string | null; bankName: string | null } | null } }[], withIban: boolean): string[][] {
  return lines.map((l) => [String(run.runNo), run.periodMonth, run.status, l.employee.employeeNo, l.employee.fullNameAr, l.gross.toFixed(2), l.deductions.toFixed(2), l.net.toFixed(2), withIban ? l.employee.private?.bankName ?? "" : "", withIban ? l.employee.private?.iban ?? "" : ""]);
}

/**
 * Every figure of one run, compared in halalas. Read only — never writes, never rounds anything
 * itself beyond reading stored 2-decimal amounts. Differences are listed with their recorded
 * explanation (HrPayrollReconNote) if any; `unexplained` counts the rest.
 */
export async function runControlReport(db: Db, runId: string) {
  const run = await db.hrPayrollRun.findUniqueOrThrow({ where: { id: runId }, include: { payments: true, paymentReturns: true, paymentAllocations: true, reconNotes: true, lines: { include: { items: true, employee: { select: { employeeNo: true, fullNameAr: true } } }, orderBy: { employee: { employeeNo: "asc" } } } } });
  const checks: Check[] = [];
  const note = (check: string, lineId: string | null, diff: number) => run.reconNotes.find((n) => n.check === check && (n.lineId ?? null) === lineId && n.differenceHalalas === diff)?.explanation ?? null;
  const cmp = (check: string, line: { id: string; employee: { employeeNo: string } } | null, expected: Prisma.Decimal, actual: Prisma.Decimal) => {
    if (expected.equals(actual)) return;
    const diff = halalas(actual.minus(expected));
    checks.push({ check, lineId: line?.id ?? null, label: line?.employee.employeeNo ?? null, expected: expected.toFixed(2), actual: actual.toFixed(2), differenceHalalas: diff, explanation: note(check, line?.id ?? null, diff) });
  };
  let g = ZERO, dd = ZERO, n = ZERO, e = ZERO;
  const rounding: { lineId: string; label: string; perComponent: string; singleRounded: string; differenceHalalas: number; explanation: string | null }[] = [];
  for (const l of run.lines) {
    const by = (k: string) => l.items.filter((i) => i.kind === k).reduce((s, i) => s.plus(i.amount), ZERO);
    cmp("EARNING_ITEMS = GROSS", l, by("EARNING"), l.gross);
    cmp("DEDUCTION_ITEMS = DEDUCTIONS", l, by("DEDUCTION"), l.deductions);
    cmp("GROSS - DEDUCTIONS = NET", l, l.gross.minus(l.deductions), l.net);
    cmp("EMPLOYER_ITEMS = EMPLOYER", l, by("EMPLOYER"), l.employer);
    // The payslip shows the line's stored gross / deductions / net and its non-employer items.
    const slip = l.items.filter((i) => i.kind !== "EMPLOYER");
    cmp("PAYSLIP_ITEMS = PAYSLIP_NET", l, slip.filter((i) => i.kind === "EARNING").reduce((s, i) => s.plus(i.amount), ZERO).minus(slip.filter((i) => i.kind === "DEDUCTION").reduce((s, i) => s.plus(i.amount), ZERO)), l.net);
    const sr = singleRoundingDifference(l.snapshot, l.items);
    if (sr && sr.differenceHalalas !== 0) rounding.push({ lineId: l.id, label: l.employee.employeeNo, ...sr, explanation: note("SINGLE_ROUNDING", l.id, sr.differenceHalalas) });
    g = g.plus(l.gross); dd = dd.plus(l.deductions); n = n.plus(l.net); e = e.plus(l.employer);
  }
  cmp("LINES_GROSS = RUN_GROSS", null, g, run.totalGross);
  cmp("LINES_DEDUCTIONS = RUN_DEDUCTIONS", null, dd, run.totalDeductions);
  cmp("LINES_NET = RUN_NET", null, n, run.totalNet);
  cmp("LINES_EMPLOYER = RUN_EMPLOYER", null, e, run.totalEmployer);
  const csvNet = exportRows(run, run.lines, false).reduce((s, r) => s.plus(new Prisma.Decimal(r[7])), ZERO);
  cmp("EXPORT_NET = RUN_NET", null, run.totalNet, csvNet);
  // P-2 rev3 item 2: what stayed paid = payments − returns (returned and rejected credits).
  const gross = run.payments.reduce((s, p) => s.plus(p.amount), ZERO);
  const returned = run.paymentReturns.reduce((s, p) => s.plus(p.amount), ZERO);
  const paid = gross.minus(returned);
  if (paid.greaterThan(run.totalNet)) cmp("PAYMENTS <= NET", null, run.totalNet, paid);
  if (run.status === "PAID") cmp("PAYMENTS = NET (PAID)", null, run.totalNet, paid);
  // Per employee (the proof): credited − returned never above the line's net; equal to it when PAID.
  for (const l of run.lines) {
    const credited = run.paymentAllocations.filter((a) => a.lineId === l.id).reduce((s, a) => s.plus(a.amount), ZERO)
      .minus(run.paymentReturns.filter((x) => x.lineId === l.id && x.kind === "RETURNED").reduce((s, x) => s.plus(x.amount), ZERO));
    if (credited.greaterThan(l.net)) cmp("LINE_CREDITS <= LINE_NET", l, l.net, credited);
    if (run.status === "PAID") cmp("LINE_CREDITS = LINE_NET (PAID)", l, l.net, credited);
  }
  // Each payment is accounted for by its credits and rejections, never more.
  for (const p of run.payments) {
    const acc = run.paymentAllocations.filter((a) => a.paymentId === p.id).reduce((s, a) => s.plus(a.amount), ZERO)
      .plus(run.paymentReturns.filter((x) => x.paymentId === p.id && x.kind === "REJECTED").reduce((s, x) => s.plus(x.amount), ZERO));
    if (acc.greaterThan(p.amount) || (run.status === "PAID" && !acc.equals(p.amount))) cmp(`PAYMENT_ACCOUNTED (${p.reference})`, null, p.amount, acc);
  }
  // Journals: the accrual's net payable credit is the run's net; each payment journal is its payment.
  const links = await db.hrJournalLink.findMany({ where: { sourceType: "PAYROLL_RUN", sourceId: runId } });
  const credit = (purpose: string, key: string, side: "D" | "C") => {
    const pl = links.find((x) => x.purpose === purpose)?.postedLines as unknown as PostedLine[] | null | undefined;
    return Array.isArray(pl) ? pl.filter((x) => x.key === key && x.side === side).reduce((s, x) => s.plus(new Prisma.Decimal(x.amount)), ZERO) : null;
  };
  const accrualPayable = credit("ACCRUAL", "SALARIES_PAYABLE", "C");
  if (accrualPayable !== null) cmp("ACCRUAL_SALARIES_PAYABLE = RUN_NET", null, run.totalNet, accrualPayable);
  let paidJournals = ZERO, paidJournalsKnown = true;
  for (const p of run.payments) {
    const v = credit(`PAYMENT:${p.id}`, "SALARIES_PAYABLE", "D");
    if (v === null) paidJournalsKnown = false; else paidJournals = paidJournals.plus(v);
  }
  if (paidJournalsKnown && run.payments.length) cmp("PAYMENT_JOURNALS = PAYMENTS", null, gross, paidJournals);
  let retJournals = ZERO, retJournalsKnown = true;
  for (const x of run.paymentReturns) {
    const v = credit(`RETURN:${x.id}`, "SALARIES_PAYABLE", "C");
    if (v === null) retJournalsKnown = false; else retJournals = retJournals.plus(v);
  }
  if (retJournalsKnown && run.paymentReturns.length) cmp("RETURN_JOURNALS = RETURNS", null, returned, retJournals);
  const journals = [];
  for (const purpose of ["ACCRUAL", "REVERSAL", ...run.payments.map((p) => `PAYMENT:${p.id}`), ...run.paymentReturns.map((x) => `RETURN:${x.id}`)]) {
    if (!links.some((x) => x.purpose === purpose) && purpose === "REVERSAL") continue;
    const problems = await journalProblems(db, { sourceType: "PAYROLL_RUN", sourceId: runId, purpose }, { reversed: purpose === "ACCRUAL" && run.status === "CANCELLED" });
    if (["APPROVED", "PAID", "CANCELLED"].includes(run.status) || problems[0]?.code !== "MISSING") journals.push({ purpose, ok: problems.length === 0, problems });
  }
  return {
    runId, runNo: run.runNo, periodMonth: run.periodMonth, status: run.status,
    totals: { gross: run.totalGross.toFixed(2), deductions: run.totalDeductions.toFixed(2), net: run.totalNet.toFixed(2), employer: run.totalEmployer.toFixed(2), paid: paid.toFixed(2) },
    ok: checks.length === 0 && journals.every((j) => j.ok || (run.status !== "APPROVED" && run.status !== "PAID" && j.problems[0]?.code === "MISSING")),
    checks, unexplained: checks.filter((c) => !c.explanation).length,
    singleRounding: rounding,
    journals,
    notes: run.reconNotes.map((x) => ({ id: x.id, check: x.check, lineId: x.lineId, differenceHalalas: x.differenceHalalas, explanation: x.explanation, recordedBy: x.recordedBy, createdAt: x.createdAt })),
  };
}

async function assertControlsReader(actor: HrActor, db: Db = prisma) {
  assertAny(actor, ["payroll_approve", "policy_manage"]);
  // Journals and runs are company records: the all-branches duty is required (like the integrity report).
  if (!(await resolveScope(actor, db)).all) throw new HrError("The payroll controls report needs the all-branches duty.", 403);
}

export async function getRunControls(actor: HrActor, runId: string) {
  await assertControlsReader(actor);
  if (!(await prisma.hrPayrollRun.findUnique({ where: { id: runId }, select: { id: true } }))) throw new HrError("Payroll run not found", 404);
  return runControlReport(prisma, runId);
}

/** Company-wide, read only: journal integrity plus each approved / paid / cancelled run's reconciliation. */
export async function payrollControlsReport(actor: HrActor) {
  await assertControlsReader(actor);
  const journals = await journalIntegrityReport(prisma);
  const runs = await prisma.hrPayrollRun.findMany({ where: { status: { in: ["APPROVED", "PAID", "CANCELLED"] } }, orderBy: { runNo: "desc" }, take: 120, select: { id: true } });
  const reports = [];
  for (const r of runs) {
    const x = await runControlReport(prisma, r.id);
    reports.push({ runNo: x.runNo, periodMonth: x.periodMonth, status: x.status, ok: x.ok, differences: x.checks.length, unexplained: x.unexplained, singleRoundingLines: x.singleRounding.length });
  }
  return { ok: journals.ok && reports.every((r) => r.ok), journals, runs: reports };
}

/**
 * Explain a difference the report shows: (check, line, difference in halalas) must match one it
 * lists now. The note is append-only (DB trigger) and never changes an amount.
 */
export async function recordReconNote(actor: HrActor, runId: string, b: Record<string, unknown>) {
  await assertControlsReader(actor);
  const check = reqText(b.check, "check", 80, 3);
  const lineId = typeof b.lineId === "string" && b.lineId ? b.lineId : null;
  const explanation = reqText(b.explanation, "explanation", 1000, 10);
  const diff = Number(b.differenceHalalas);
  if (!Number.isInteger(diff) || diff === 0) throw new HrError("differenceHalalas must be the non-zero whole number of halalas the report shows.", 400);
  return prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT 1 FROM "HrPayrollRun" WHERE "id" = ${runId} FOR UPDATE`;
    const rep = await runControlReport(tx, runId);
    const listed = check === "SINGLE_ROUNDING"
      ? rep.singleRounding.some((r) => r.lineId === lineId && r.differenceHalalas === diff)
      : rep.checks.some((c) => c.check === check && c.lineId === lineId && c.differenceHalalas === diff);
    if (!listed) throw new HrError("The report does not show this difference now, so there is nothing to explain.", 409, "NO_SUCH_DIFFERENCE");
    const row = await tx.hrPayrollReconNote.create({ data: { runId, lineId, check, differenceHalalas: diff, explanation, recordedBy: actor.id } });
    await audit(tx, { action: "PAYROLL_RECON_NOTE", entityType: "HrPayrollRun", entityId: runId, after: { noteId: row.id, check, lineId, differenceHalalas: diff }, reason: explanation, actorId: actor.id });
    return { id: row.id, check, lineId, differenceHalalas: diff, explanation };
  }, TX);
}

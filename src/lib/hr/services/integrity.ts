// Native HR — payroll and advance integrity report (F2 / E-3, E-4, E-5). READ ONLY: it lists
// what an accountant must look at and changes nothing.
//
// • approved / paid runs without an accrual journal (accounting explicitly off, or missing);
// • payments of a booked run without their payment journal;
// • disbursed advances without a disbursement journal;
// • runs whose figures do not reconcile (items = lines = run totals = journal; payments ≤ net);
// • advance installments still SCHEDULED after their due month — deferred by the deduction cap
//   or never reserved — grouped per advance.
import { Prisma } from "@/generated/prisma/client";
import { prisma } from "@/lib/db";
import { HrError, type HrActor, assertAny, resolveScope } from "../core";
import { monthOf } from "../dates";
import { runReconciliation } from "./payroll";
// P-2 / E-3: a link is not enough — every linked journal is verified (posted, not reversed outside
// HR, unchanged, right source and date), and unlinked HR journals are listed.
import { journalIntegrityReport } from "./journal-integrity";

export async function payrollIntegrity(actor: HrActor, today: Date) {
  assertAny(actor, ["payroll_approve", "policy_manage"]);
  // Company-wide by nature (journals are company records): the all-branches duty is required.
  if (!(await resolveScope(actor)).all) throw new HrError("The integrity report needs the all-branches duty.", 403);

  const runs = await prisma.hrPayrollRun.findMany({ where: { status: { in: ["APPROVED", "PAID"] } }, include: { payments: true }, orderBy: { runNo: "desc" }, take: 500 });
  const links = await prisma.hrJournalLink.findMany({ where: { OR: [{ sourceType: "PAYROLL_RUN", sourceId: { in: runs.map((r) => r.id) } }, { sourceType: "ADVANCE" }] }, select: { sourceType: true, sourceId: true, purpose: true } });
  const has = (t: string, id: string, purpose: string) => links.some((l) => l.sourceType === t && l.sourceId === id && l.purpose === purpose);

  const runsWithoutJournal = runs
    .filter((r) => !has("PAYROLL_RUN", r.id, "ACCRUAL"))
    .map((r) => ({ runId: r.id, runNo: r.runNo, periodMonth: r.periodMonth, status: r.status, net: r.totalNet.toFixed(2), reason: r.accountingSkipped ? "ACCOUNTING_OFF" : "MISSING_JOURNAL" }));
  const paymentsWithoutJournal = runs
    .filter((r) => !r.accountingSkipped)
    .flatMap((r) => r.payments.filter((p) => !has("PAYROLL_RUN", r.id, `PAYMENT:${p.id}`)).map((p) => ({ runNo: r.runNo, paymentId: p.id, amount: p.amount.toFixed(2), paidOn: p.paidOn })));

  const advances = await prisma.hrAdvance.findMany({ where: { status: { in: ["DISBURSED", "CLOSED"] } }, include: { employee: { select: { employeeNo: true } }, installments: true } });
  const advancesWithoutJournal = advances
    .filter((a) => !has("ADVANCE", a.id, "DISBURSEMENT"))
    .map((a) => ({ advanceNo: a.advanceNo, employeeNo: a.employee.employeeNo, amount: a.amount.toFixed(2), disbursedOn: a.disbursedOn }));

  const reconciliation = [];
  for (const r of runs.slice(0, 120)) {
    const rec = await runReconciliation(prisma, r.id);
    if (!rec.ok) reconciliation.push({ runNo: r.runNo, periodMonth: r.periodMonth, status: r.status, mismatches: rec.mismatches });
  }

  const thisMonth = monthOf(today);
  const deferredInstallments = advances
    .filter((a) => a.status === "DISBURSED")
    .map((a) => {
      const late = a.installments.filter((i) => i.status === "SCHEDULED" && i.dueMonth < thisMonth).sort((x, y) => x.dueMonth.localeCompare(y.dueMonth));
      return late.length ? { advanceNo: a.advanceNo, employeeNo: a.employee.employeeNo, overdueInstallments: late.length, oldestDueMonth: late[0].dueMonth, overdueAmount: late.reduce((s, i) => s.plus(i.amount), new Prisma.Decimal(0)).toFixed(2) } : null;
    })
    .filter((x): x is NonNullable<typeof x> => x !== null);

  const journals = await journalIntegrityReport(prisma);
  return {
    asOfMonth: thisMonth,
    ok: !runsWithoutJournal.length && !paymentsWithoutJournal.length && !advancesWithoutJournal.length && !reconciliation.length && !deferredInstallments.length && journals.ok,
    runsWithoutJournal, paymentsWithoutJournal, advancesWithoutJournal, reconciliation, deferredInstallments,
    brokenJournals: journals.broken, unlinkedJournals: journals.unlinkedJournals, missingJournals: journals.missing,
  };
}

// Native HR — what each HR journal SHOULD post, from its approved source (review P2-A4).
//
// The integrity report compares every linked journal with this, per posting key and side, for
// every link — new links through their frozen posted lines, legacy links through their baseline
// (./journal-integrity). Read only. The rules are the same ones the posting services use; a source
// with no rule is reported (NO_EXPECTED), never silently passed.
import { Prisma } from "@/generated/prisma/client";
import type { Db } from "../core";
import type { HrJournalLine } from "./accounting-bridge";
import type { JournalProblem, JournalRef } from "./journal-integrity";

type Tx = Prisma.TransactionClient;
const two = (key: HrJournalLine["key"], debitKey: boolean, amount: Prisma.Decimal, description: string): HrJournalLine =>
  debitKey ? { key, debit: amount, description } : { key, credit: amount, description };
const swap = (lines: HrJournalLine[]): HrJournalLine[] => lines.map((l) => ({ key: l.key, debit: l.credit, credit: l.debit, description: l.description }));

/** The lines the source of `ref` calls for, or a problem saying why they cannot be known. */
export async function expectedLinesFor(db: Db, ref: JournalRef): Promise<{ expected: HrJournalLine[] } | { problem: JournalProblem }> {
  const none = (detail: string) => ({ problem: { code: "NO_EXPECTED", detail } });
  try {
    if (ref.sourceType === "PAYROLL_RUN") {
      const { accrualLines } = await import("./payroll");
      if (ref.purpose === "ACCRUAL") return { expected: await accrualLines(db as Tx, ref.sourceId) };
      if (ref.purpose === "REVERSAL") return { expected: swap(await accrualLines(db as Tx, ref.sourceId)) };
      if (ref.purpose.startsWith("PAYMENT:")) {
        const p = await db.hrPayrollPayment.findUnique({ where: { id: ref.purpose.slice("PAYMENT:".length) } });
        if (!p || p.runId !== ref.sourceId) return none("the payment this journal names does not exist on the run");
        return { expected: [two("SALARIES_PAYABLE", true, p.amount, "payment"), two("PAYROLL_CASH", false, p.amount, "payment")] };
      }
      // P-2 rev3 item 2: a returned / rejected credit — the money came back, the employee is owed again.
      if (ref.purpose.startsWith("RETURN:")) {
        const x = await db.hrPayrollPaymentReturn.findUnique({ where: { id: ref.purpose.slice("RETURN:".length) } });
        if (!x || x.runId !== ref.sourceId) return none("the payment return this journal names does not exist on the run");
        return { expected: [two("PAYROLL_CASH", true, x.amount, "return"), two("SALARIES_PAYABLE", false, x.amount, "return")] };
      }
    }
    if (ref.sourceType === "ADVANCE" && ref.purpose === "DISBURSEMENT") {
      const a = await db.hrAdvance.findUniqueOrThrow({ where: { id: ref.sourceId } });
      return { expected: [two("ADVANCES_RECEIVABLE", true, a.amount, "advance"), two("PAYROLL_CASH", false, a.amount, "advance")] };
    }
    if (ref.sourceType === "ADVANCE_REPAYMENT" && ref.purpose === "REPAYMENT") {
      const r = await db.hrAdvanceRepayment.findUniqueOrThrow({ where: { id: ref.sourceId } });
      return { expected: [two("PAYROLL_CASH", true, r.amount, "repayment"), two("ADVANCES_RECEIVABLE", false, r.amount, "repayment")] };
    }
    if (ref.sourceType === "FINAL_SETTLEMENT") {
      const s = await db.hrFinalSettlement.findUniqueOrThrow({ where: { id: ref.sourceId } });
      if (!s.totalAmount || !s.eosAmount || !s.leaveEncashmentAmount) return none("the settlement carries no calculated amounts");
      const { settlementAccrualLines } = await import("./final-settlement");
      if (ref.purpose === "ACCRUAL") return { expected: settlementAccrualLines({ settlementNo: s.settlementNo, eosAmount: s.eosAmount, leaveEncashmentAmount: s.leaveEncashmentAmount, eosProvisionAmount: s.eosProvisionAmount, leaveProvisionAmount: s.leaveProvisionAmount }) };
      if (ref.purpose === "PAYMENT") return { expected: [two("FINAL_SETTLEMENT_PAYABLE", true, s.totalAmount, "settlement"), two("PAYROLL_CASH", false, s.totalAmount, "settlement")] };
    }
    if (ref.sourceType === "GOSI_SETTLEMENT" && ref.purpose === "ADJUSTMENT") {
      const g = await db.hrGosiSettlement.findUniqueOrThrow({ where: { id: ref.sourceId }, include: { adjustment: true } });
      // P-2 rev3 item 3: booked under an enabled treatment → the keys recorded on the adjustment.
      if (g.adjustment?.treatmentCase && g.adjustment.debitKey && g.adjustment.creditKey) {
        const { caseLines } = await import("../gosi-treatments");
        const side = caseLines(g.adjustment.treatmentCase as never, g.adjustment.debitKey, g.adjustment.creditKey, g.difference.toNumber());
        return { expected: [two(side.debit as HrJournalLine["key"], true, g.difference.abs(), "gosi"), two(side.credit as HrJournalLine["key"], false, g.difference.abs(), "gosi")] };
      }
      const more = g.difference.greaterThan(0), amt = g.difference.abs();
      return { expected: [two(more ? "EMPLOYER_CONTRIB_EXPENSE" : "CONTRIB_PAYABLE", true, amt, "gosi"), two(more ? "CONTRIB_PAYABLE" : "EMPLOYER_CONTRIB_EXPENSE", false, amt, "gosi")] };
    }
    if (ref.sourceType === "GOSI_INVOICE" && ref.purpose.startsWith("PAYMENT:")) {
      const p = await db.hrGosiInvoicePayment.findUnique({ where: { id: ref.purpose.slice("PAYMENT:".length) } });
      if (!p || p.invoiceId !== ref.sourceId) return none("the GOSI payment this journal names does not exist on the invoice");
      return { expected: [two("CONTRIB_PAYABLE", true, p.amount, "gosi payment"), two("PAYROLL_CASH", false, p.amount, "gosi payment")] };
    }
    if (ref.sourceType === "GOSI_INVOICE" && ref.purpose === "PAYMENT") {
      const i = await db.hrGosiInvoice.findUniqueOrThrow({ where: { id: ref.sourceId } });
      if (!i.paidAmount) return none("the invoice records no paid amount");
      return { expected: [two("CONTRIB_PAYABLE", true, i.paidAmount, "gosi payment"), two("PAYROLL_CASH", false, i.paidAmount, "gosi payment")] };
    }
  } catch (e) {
    return none(`the source cannot be priced: ${(e as Error).message}`);
  }
  return none(`no posting rule is known for ${ref.sourceType} ${ref.purpose}`);
}

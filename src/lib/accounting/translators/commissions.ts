// Commission ledger movement → journal entry. The commission engine's amounts are used as
// they are; nothing is recalculated here (docs/accounting/EVENT_JOURNAL_MAP.md).
//   ACCRUAL / REVERSAL / ADJUSTMENT, amount > 0 : Dr commission expense  / Cr commissions payable
//                                    amount < 0 : Dr commissions payable / Cr commission expense
//   PAYOUT (recorded positive)                  : Dr commissions payable / Cr commission payments clearing
// The payable line carries the employee as party, so the control account reconciles to the
// commission ledger per person.
import type { Prisma } from "@/generated/prisma/client";
import { accountingDateOf } from "../dates";
import { dec } from "../money";
import type { EngineLine } from "../posting";
import type { Translation } from "./types";

type Payload = {
  ledgerEntryId: string; type: "ACCRUAL" | "REVERSAL" | "ADJUSTMENT" | "PAYOUT"; employeeId: string;
  amount: string; planVersionId: string | null; collectionEventId: string | null; reason: string | null;
};

export async function translateCommission(
  tx: Prisma.TransactionClient,
  ev: { id: string; occurredAt: Date; payload: Prisma.JsonValue },
): Promise<Translation> {
  const p = ev.payload as unknown as Payload;
  const amount = dec(p.amount);
  if (amount.isZero()) return { skip: "The commission movement is zero; there is nothing to post." };

  const employee = await tx.employee.findUnique({ where: { id: p.employeeId }, select: { name: true } });
  const unapproved: string[] = [];
  let planLabel = "";
  if (p.planVersionId) {
    const pv = await tx.commissionPlanVersion.findUnique({
      where: { id: p.planVersionId },
      select: { version: true, accountingApproval: true, plan: { select: { code: true } } },
    });
    planLabel = pv ? ` · ${pv.plan.code} v${pv.version}` : "";
    if (!pv) unapproved.push("the commission plan version no longer exists");
    else if (pv.accountingApproval !== "APPROVED") unapproved.push(`commission plan ${pv.plan.code} v${pv.version} is not approved for accounting`);
  } else if (p.type === "ACCRUAL" || p.type === "REVERSAL") {
    unapproved.push("the movement does not record which plan version produced it");
  }

  const abs = amount.abs();
  const party = { partyType: "EMPLOYEE" as const, partyId: p.employeeId };
  const who = employee?.name ?? p.employeeId;
  let lines: EngineLine[];
  if (p.type === "PAYOUT") {
    lines = amount.isPositive()
      ? [{ role: "COMMISSION_PAYABLE", debit: abs, ...party }, { role: "COMMISSION_PAYMENT_CLEARING", credit: abs }]
      : [{ role: "COMMISSION_PAYMENT_CLEARING", debit: abs }, { role: "COMMISSION_PAYABLE", credit: abs, ...party }];
  } else {
    lines = amount.isPositive()
      ? [{ role: "COMMISSION_EXPENSE", debit: abs }, { role: "COMMISSION_PAYABLE", credit: abs, ...party }]
      : [{ role: "COMMISSION_PAYABLE", debit: abs, ...party }, { role: "COMMISSION_EXPENSE", credit: abs }];
  }
  const label = { ACCRUAL: "Commission accrual", REVERSAL: "Commission reversal", ADJUSTMENT: "Commission adjustment", PAYOUT: "Commission payout" }[p.type];
  return {
    entryDate: accountingDateOf(ev.occurredAt),
    description: `${label} — ${who}${planLabel}${p.reason ? ` — ${p.reason}` : ""}`,
    sourceModule: "commissions",
    sourceDocumentId: p.ledgerEntryId,
    lines: lines.map((l) => ({ ...l, description: label })),
    alsoUnapproved: unapproved,
  };
}

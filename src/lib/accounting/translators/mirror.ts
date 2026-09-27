// Mirror of an engine-posted journal: every debit becomes a credit and vice versa, same
// accounts, parties and dimensions. Used when the source document is reversed or voided, so
// the reversal is exact whatever mapping changes happened in between.
import type { Prisma } from "@/generated/prisma/client";
import type { EngineLine } from "../posting";

export async function mirrorOfJournal(tx: Prisma.TransactionClient, journalEntryId: string, description: string): Promise<EngineLine[]> {
  const lines = await tx.journalEntryLine.findMany({ where: { journalEntryId }, orderBy: { lineNo: "asc" } });
  return lines.map((l) => ({
    accountId: l.accountId,
    debit: l.credit,
    credit: l.debit,
    description,
    partyType: (l.partyType ?? undefined) as EngineLine["partyType"],
    partyId: l.partyId ?? undefined,
    branchId: l.branchId,
    costCenterId: l.costCenterId,
  }));
}

/** The journal an earlier event produced, or null when that event did not post. */
export async function journalOfEvent(tx: Prisma.TransactionClient, idempotencyKey: string) {
  const ev = await tx.accountingEvent.findUnique({ where: { idempotencyKey }, select: { status: true, journalEntryId: true } });
  return ev?.status === "TRANSLATED" ? ev.journalEntryId : null;
}

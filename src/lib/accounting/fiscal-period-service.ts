import { prisma } from "@/lib/db";
import { AccountingError } from "./errors";

export async function findPeriodForDate(date: Date) {
  return prisma.fiscalPeriod.findFirst({
    where: { startDate: { lte: date }, endDate: { gte: date } },
  });
}

export async function lockFiscalPeriod(id: string, userId: string) {
  return prisma.$transaction(async (tx) => {
    const period = await tx.fiscalPeriod.findUnique({ where: { id } });
    if (!period) throw new AccountingError("Fiscal period not found.", 404);
    if (period.status !== "OPEN") {
      throw new AccountingError(`Cannot lock a period that is ${period.status}.`, 409);
    }
    return tx.fiscalPeriod.update({
      where: { id },
      data: { status: "LOCKED", lockedAt: new Date(), lockedBy: userId },
    });
  });
}

// Period reopen is explicitly excluded from S0 — the spec requires top-level role
// restriction plus an admin-wide alert on every reopen, neither of which exist yet.
export async function closeFiscalPeriod(id: string, userId: string) {
  return prisma.$transaction(async (tx) => {
    const period = await tx.fiscalPeriod.findUnique({ where: { id } });
    if (!period) throw new AccountingError("Fiscal period not found.", 404);
    if (period.status !== "LOCKED") {
      throw new AccountingError("A period must be Locked before it can be Closed.", 409);
    }
    const pendingCount = await tx.journalEntry.count({
      where: { fiscalPeriodId: id, status: { in: ["DRAFT", "SUBMITTED", "APPROVED"] } },
    });
    if (pendingCount > 0) {
      throw new AccountingError(
        `Cannot close period: ${pendingCount} journal entr${pendingCount === 1 ? "y" : "ies"} still pending (Draft/Submitted/Approved).`,
        409,
      );
    }
    return tx.fiscalPeriod.update({
      where: { id },
      data: { status: "CLOSED", closedAt: new Date(), closedBy: userId },
    });
  });
}

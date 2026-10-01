import { prisma } from "@/lib/db";
import { accountingRoute, body } from "@/lib/accounting/http";
import { AccountingError } from "@/lib/accounting/errors";
import { createFiscalYear } from "@/lib/accounting/fiscal-period-service";

export const GET = accountingRoute(null, async () => {
  const periods = await prisma.fiscalPeriod.findMany({ orderBy: [{ startDate: "desc" }], take: 240 });
  const counts = await prisma.journalEntry.groupBy({ by: ["fiscalPeriodId", "status"], _count: { _all: true } });
  // Who locked / closed each period, by name (ids are what the ledger stores).
  const ids = [...new Set(periods.flatMap((p) => [p.lockedBy, p.closedBy]).filter((x): x is string => !!x))];
  const names = new Map((await prisma.employee.findMany({ where: { id: { in: ids } }, select: { id: true, name: true } })).map((e) => [e.id, e.name]));
  return periods.map((p) => ({
    ...p,
    lockedByName: p.lockedBy ? names.get(p.lockedBy) ?? null : null,
    closedByName: p.closedBy ? names.get(p.closedBy) ?? null : null,
    entries: Object.fromEntries(counts.filter((c) => c.fiscalPeriodId === p.id).map((c) => [c.status, c._count._all])),
  }));
});

// Creates a fiscal year of twelve monthly periods: { year, startMonth }.
export const POST = accountingRoute("settings_manage", async ({ user, request }) => {
  const b = await body(request);
  const year = Number(b.year);
  const startMonth = b.startMonth === undefined ? 1 : Number(b.startMonth);
  if (!Number.isInteger(year)) throw new AccountingError("year must be a whole number.", 400);
  return createFiscalYear(year, startMonth, user.id);
}, 201);

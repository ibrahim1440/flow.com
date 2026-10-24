import { NextResponse } from "@/lib/api-response";
import { prisma } from "@/lib/db";
import { requireModule, requireSub } from "@/lib/auth-server";
import { acctError, jsonBody } from "@/lib/accounting/http";
import { createFiscalYear } from "@/lib/accounting/fiscal-years";
import { auditFromRequest } from "@/lib/accounting/audit";
import { refuse } from "@/lib/accounting/refusals";

export async function GET() {
  const { error } = await requireModule("accounting");
  if (error) return error;
  try {
    const years = await prisma.fiscalYear.findMany({ orderBy: { year: "desc" }, include: { periods: { orderBy: { periodNo: "asc" } } } });
    const counts = await prisma.journalEntry.groupBy({ by: ["fiscalPeriodId", "status"], _count: { _all: true } });
    const byPeriod = new Map<string, Record<string, number>>();
    for (const c of counts) byPeriod.set(c.fiscalPeriodId, { ...(byPeriod.get(c.fiscalPeriodId) ?? {}), [c.status]: c._count._all });
    return NextResponse.json(years.map((y) => ({ ...y, periods: y.periods.map((p) => ({ ...p, entries: byPeriod.get(p.id) ?? {} })) })));
  } catch (err) {
    return acctError(err);
  }
}

/** A Gregorian year with its twelve OPEN monthly periods. */
export async function POST(request: Request) {
  const { user, error } = await requireSub("accounting", "settings_manage");
  if (error) return error;
  try {
    const body = await jsonBody(request);
    const year = Number(body.year);
    if (!Number.isInteger(year) || year < 2000 || year > 2200) throw refuse("BAD_INPUT", "year is a whole number 2000–2200.");
    return NextResponse.json(await createFiscalYear(year, auditFromRequest(request, user.id)), { status: 201 });
  } catch (err) {
    return acctError(err);
  }
}

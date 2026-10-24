import { NextResponse } from "@/lib/api-response";
import { prisma } from "@/lib/db";
import { requireModule } from "@/lib/auth-server";
import { acctError, qp } from "@/lib/accounting/http";

const ENTITIES = new Set(["Account", "AccountRole", "FiscalYear", "FiscalPeriod", "AccountingSettings", "JournalEntry", "OpeningBalanceLine"]);

/** The accounting audit trail (who, when, what, before / after, IP, device), newest first. */
export async function GET(request: Request) {
  const { error } = await requireModule("accounting");
  if (error) return error;
  try {
    const entityType = qp(request, "entityType");
    const entityId = qp(request, "entityId");
    const take = Math.min(Math.max(Number(qp(request, "take")) || 100, 1), 500);
    const rows = await prisma.accountingAuditLog.findMany({
      where: { ...(entityType && ENTITIES.has(entityType) ? { entityType } : {}), ...(entityId ? { entityId } : {}) },
      orderBy: { at: "desc" }, take,
    });
    const people = await prisma.employee.findMany({ where: { id: { in: [...new Set(rows.map((r) => r.actorId).filter((x): x is string => !!x))] } }, select: { id: true, name: true } });
    return NextResponse.json({ items: rows, people: Object.fromEntries(people.map((p) => [p.id, p.name])) });
  } catch (err) {
    return acctError(err);
  }
}

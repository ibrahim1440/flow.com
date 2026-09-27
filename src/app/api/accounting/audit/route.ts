import { prisma } from "@/lib/db";
import { accountingRoute, query } from "@/lib/accounting/http";

// Accounting decisions from the append-only FinAuditLog, newest first.
export const GET = accountingRoute(null, async ({ request }) => {
  const q = query(request);
  const entityId = q.get("entityId");
  const rows = await prisma.finAuditLog.findMany({
    where: { entityType: { startsWith: "accounting." }, ...(entityId ? { entityId } : {}) },
    orderBy: { createdAt: "desc" },
    take: 200,
  });
  const ids = [...new Set(rows.map((r) => r.userId).filter((x): x is string => !!x))];
  const names = new Map((await prisma.employee.findMany({ where: { id: { in: ids } }, select: { id: true, name: true } })).map((e) => [e.id, e.name]));
  return rows.map((r) => ({ ...r, userName: r.userId ? names.get(r.userId) ?? r.userId : null }));
});

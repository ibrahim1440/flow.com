import type { AccountingEventStatus } from "@/generated/prisma/client";
import { prisma } from "@/lib/db";
import { accountingRoute, query } from "@/lib/accounting/http";

const STATUSES = new Set(["PENDING", "TRANSLATED", "FAILED", "BLOCKED", "SKIPPED"]);

export const GET = accountingRoute(null, async ({ request }) => {
  const q = query(request);
  const status = q.get("status");
  const page = Math.max(Number(q.get("page")) || 1, 1);
  const pageSize = Math.min(Math.max(Number(q.get("pageSize")) || 50, 10), 200);
  const where = status && STATUSES.has(status) ? { status: status as AccountingEventStatus } : {};
  const [rows, total, counts] = await Promise.all([
    prisma.accountingEvent.findMany({
      where, orderBy: [{ occurredAt: "desc" }, { id: "desc" }], skip: (page - 1) * pageSize, take: pageSize,
      include: { journalEntry: { select: { id: true, entryNo: true, isProvisional: true } } },
    }),
    prisma.accountingEvent.count({ where }),
    prisma.accountingEvent.groupBy({ by: ["status"], _count: { _all: true } }),
  ]);
  return { rows, total, page, pageSize, counts: Object.fromEntries(counts.map((c) => [c.status, c._count._all])) };
});

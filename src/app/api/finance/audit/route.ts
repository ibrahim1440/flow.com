import { financeHandler } from "@/lib/finance/server/http";
import { prisma } from "@/lib/db";
import { scopeWhere } from "@/lib/finance/server/context";

export const GET = financeHandler(undefined, ({ scope, query }) => prisma.finAuditLog.findMany({
    where: { ...(scope.all ? {} : { branchKey: scopeWhere(scope).branchKey }), ...(query.get("entityId") ? { entityId: query.get("entityId")! } : {}), ...(query.get("entityType") ? { entityType: query.get("entityType")! } : {}) },
    orderBy: { createdAt: "desc" }, take: 100,
  }));

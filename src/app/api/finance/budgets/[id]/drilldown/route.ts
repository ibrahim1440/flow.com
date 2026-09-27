import { financeHandler } from "@/lib/finance/server/http";
import { prisma } from "@/lib/db";
import { drillDown } from "@/lib/finance/server/budgets";

export const GET = financeHandler(undefined, ({ scope, params, query }) => drillDown(prisma, scope, params.id, query.get("lineKey") ?? "", query.get("date") ?? undefined));

import { financeHandler } from "@/lib/finance/server/http";
import { prisma } from "@/lib/db";
import { budgetReport } from "@/lib/finance/server/budgets";

export const GET = financeHandler(undefined, ({ scope, params, query }) => budgetReport(prisma, scope, params.id, query.get("date") ?? undefined));

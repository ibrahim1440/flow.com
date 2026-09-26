import { financeHandler } from "@/lib/finance/server/http";
import { prisma } from "@/lib/db";
import { readJson } from "@/lib/finance/server/context";
import { listCategories, createCategory } from "@/lib/finance/server/allocation";
import { isMonthString } from "@/lib/finance/dates";

export const GET = financeHandler(undefined, ({ scope, query }) => listCategories(prisma, scope, isMonthString(query.get("month")) ? query.get("month")! : undefined));

export const POST = financeHandler("budget_prepare", async ({ actor, scope, request }) => createCategory(actor, scope, await readJson(request)), 201);

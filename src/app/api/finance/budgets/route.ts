import { financeHandler } from "@/lib/finance/server/http";
import { prisma } from "@/lib/db";
import { readJson } from "@/lib/finance/server/context";
import { listBudgets, createBudget } from "@/lib/finance/server/budgets";

export const GET = financeHandler(undefined, ({ scope }) => listBudgets(prisma, scope));

export const POST = financeHandler("budget_prepare", async ({ actor, scope, request }) => createBudget(actor, scope, await readJson(request)), 201);

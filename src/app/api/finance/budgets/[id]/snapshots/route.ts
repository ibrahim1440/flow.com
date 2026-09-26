import { financeHandler } from "@/lib/finance/server/http";
import { prisma } from "@/lib/db";
import { readJson, str } from "@/lib/finance/server/context";
import { listSnapshots, saveForecastSnapshot } from "@/lib/finance/server/budgets";

export const GET = financeHandler(undefined, ({ scope, params }) => listSnapshots(prisma, scope, params.id));

export const POST = financeHandler("budget_prepare", async ({ actor, scope, request, params }) => saveForecastSnapshot(actor, scope, params.id, str((await readJson(request)).date, 10) ?? undefined), 201);

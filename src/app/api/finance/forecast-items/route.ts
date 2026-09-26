import { financeHandler } from "@/lib/finance/server/http";
import { prisma } from "@/lib/db";
import { readJson } from "@/lib/finance/server/context";
import { listForecastItems, createForecastItem } from "@/lib/finance/server/obligations";

export const GET = financeHandler(undefined, ({ scope, query }) => listForecastItems(prisma, scope, { from: query.get("from") ?? undefined, to: query.get("to") ?? undefined }));

export const POST = financeHandler("budget_prepare", async ({ actor, scope, request }) => createForecastItem(actor, scope, await readJson(request)), 201);

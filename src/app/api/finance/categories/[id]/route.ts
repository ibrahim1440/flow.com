import { financeHandler } from "@/lib/finance/server/http";
import { prisma } from "@/lib/db";
import { readJson } from "@/lib/finance/server/context";
import { updateCategory, categoryEntries } from "@/lib/finance/server/allocation";

export const GET = financeHandler(undefined, ({ scope, params, query }) => categoryEntries(prisma, scope, params.id, Number(query.get("page") ?? 0) || 0));

export const PATCH = financeHandler("budget_prepare", async ({ actor, scope, request, params }) => updateCategory(actor, scope, params.id, await readJson(request)));

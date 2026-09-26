import { financeHandler } from "@/lib/finance/server/http";
import { readJson } from "@/lib/finance/server/context";
import { addVarianceNote } from "@/lib/finance/server/budgets";

export const POST = financeHandler("budget_prepare", async ({ actor, scope, request, params }) => addVarianceNote(actor, scope, params.id, await readJson(request)), 201);

import { financeHandler } from "@/lib/finance/server/http";
import { readJson, reqStr } from "@/lib/finance/server/context";
import { startRevision } from "@/lib/finance/server/budgets";

export const POST = financeHandler("budget_prepare", async ({ actor, scope, request, params }) => startRevision(actor, scope, params.id, reqStr((await readJson(request)).reason, "Reason", 500)), 201);

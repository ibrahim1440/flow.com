import { financeHandler } from "@/lib/finance/server/http";
import { readJson } from "@/lib/finance/server/context";
import { supersedeObligation } from "@/lib/finance/server/obligations";

export const POST = financeHandler("budget_prepare", async ({ actor, scope, request, params }) => supersedeObligation(actor, scope, params.id, await readJson(request)), 201);

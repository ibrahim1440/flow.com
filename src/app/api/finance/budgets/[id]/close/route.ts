import { financeHandler } from "@/lib/finance/server/http";
import { readJson, str } from "@/lib/finance/server/context";
import { closeBudget } from "@/lib/finance/server/budgets";

export const POST = financeHandler("period_close", async ({ actor, scope, request, params }) => closeBudget(actor, scope, params.id, str((await readJson(request)).reason, 500)));

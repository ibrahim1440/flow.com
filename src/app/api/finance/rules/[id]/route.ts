import { financeHandler } from "@/lib/finance/server/http";
import { readJson } from "@/lib/finance/server/context";
import { saveRuleDraft } from "@/lib/finance/server/allocation";

export const PUT = financeHandler("budget_prepare", async ({ actor, scope, request, params }) => saveRuleDraft(actor, scope, await readJson(request), params.id));

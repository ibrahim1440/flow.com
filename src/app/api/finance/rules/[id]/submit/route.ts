import { financeHandler } from "@/lib/finance/server/http";
import { readJson, str } from "@/lib/finance/server/context";
import { submitRuleVersion } from "@/lib/finance/server/allocation";

export const POST = financeHandler("budget_prepare", async ({ actor, scope, request, params }) => submitRuleVersion(actor, scope, params.id, str((await readJson(request)).reason, 500)), 201);

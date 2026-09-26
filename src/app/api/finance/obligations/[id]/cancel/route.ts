import { financeHandler } from "@/lib/finance/server/http";
import { readJson, reqStr } from "@/lib/finance/server/context";
import { cancelObligation } from "@/lib/finance/server/obligations";

export const POST = financeHandler("budget_prepare", async ({ actor, scope, request, params }) => cancelObligation(actor, scope, params.id, reqStr((await readJson(request)).reason, "Reason", 500)));

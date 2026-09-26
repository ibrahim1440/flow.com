import { financeHandler } from "@/lib/finance/server/http";
import { readJson, reqStr } from "@/lib/finance/server/context";
import { sweepCategory } from "@/lib/finance/server/allocation";

export const POST = financeHandler("period_close", async ({ actor, scope, request, params }) => sweepCategory(actor, scope, params.id, reqStr((await readJson(request)).reason, "Reason", 500)));

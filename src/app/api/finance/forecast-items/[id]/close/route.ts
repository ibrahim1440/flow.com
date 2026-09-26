import { financeHandler } from "@/lib/finance/server/http";
import { readJson } from "@/lib/finance/server/context";
import { closeForecastItem } from "@/lib/finance/server/obligations";

export const POST = financeHandler("budget_prepare", async ({ actor, scope, request, params }) => closeForecastItem(actor, scope, params.id, await readJson(request)));

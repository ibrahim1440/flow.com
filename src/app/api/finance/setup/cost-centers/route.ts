import { financeHandler } from "@/lib/finance/server/http";
import { readJson } from "@/lib/finance/server/context";
import { createCostCenter } from "@/lib/finance/server/setup";

export const POST = financeHandler("settings_manage", async ({ actor, scope, request }) => createCostCenter(actor, scope, await readJson(request)), 201);

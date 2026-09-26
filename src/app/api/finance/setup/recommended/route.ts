import { financeHandler } from "@/lib/finance/server/http";
import { readJson, str } from "@/lib/finance/server/context";
import { installRecommended } from "@/lib/finance/server/setup";
import { COMPANY } from "@/lib/finance/server/context";

export const POST = financeHandler("settings_manage", async ({ actor, scope, request }) => installRecommended(actor, scope, str((await readJson(request)).branchKey, 60) ?? COMPANY), 201);

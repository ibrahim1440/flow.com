import { financeHandler } from "@/lib/finance/server/http";
import { readJson } from "@/lib/finance/server/context";
import { setBranchAccess } from "@/lib/finance/server/setup";

export const POST = financeHandler("settings_manage", async ({ actor, request }) => setBranchAccess(actor, await readJson(request)));

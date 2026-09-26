import { financeHandler } from "@/lib/finance/server/http";
import { readJson } from "@/lib/finance/server/context";
import { updateSettings } from "@/lib/finance/server/setup";

export const PATCH = financeHandler("settings_manage", async ({ actor, request }) => updateSettings(actor, await readJson(request)));

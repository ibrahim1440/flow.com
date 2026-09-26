import { financeHandler } from "@/lib/finance/server/http";
import { readJson } from "@/lib/finance/server/context";
import { createFinCategory } from "@/lib/finance/server/setup";

export const POST = financeHandler("settings_manage", async ({ actor, request }) => createFinCategory(actor, await readJson(request)), 201);

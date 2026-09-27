import { financeHandler } from "@/lib/finance/server/http";
import { readJson } from "@/lib/finance/server/context";
import { previewAllocation } from "@/lib/finance/server/allocation";

export const POST = financeHandler(undefined, async ({ actor, scope, request }) => previewAllocation(actor, scope, await readJson(request)));

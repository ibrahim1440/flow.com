import { financeHandler } from "@/lib/finance/server/http";
import { readJson } from "@/lib/finance/server/context";
import { recordCategoryPayment } from "@/lib/finance/server/allocation";

export const POST = financeHandler("allocate", async ({ actor, scope, request }) => recordCategoryPayment(actor, scope, await readJson(request)), 201);

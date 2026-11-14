import { financeHandler } from "@/lib/finance/server/http";
import { readJson } from "@/lib/finance/server/context";
import { createTransfer } from "@/lib/finance/server/transactions";
import { withIdempotency } from "@/lib/idempotency";

// R1-b (owner 1-أ/1-ب): one transfer (its two bank lines) per submission — a double click or a retry gets the first back.
export const POST = financeHandler("txn_enter", async ({ actor, scope, request }) => {
  const body = await readJson(request);
  return withIdempotency(request, { scope: "finance.transfer", actorId: actor.id, intent: body }, async (tx) => ({ status: 201, body: await createTransfer(actor, scope, body, tx) }));
}, 201);

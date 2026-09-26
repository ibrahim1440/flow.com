import { financeHandler } from "@/lib/finance/server/http";
import { FinanceError } from "@/lib/finance/server/context";
import { addAttachment } from "@/lib/finance/server/transactions";

export const POST = financeHandler("txn_enter", async ({ actor, scope, request, params }) => {
    const form = await request.formData().catch(() => null);
    const file = form?.get("file");
    if (!(file instanceof File)) throw new FinanceError("Attach a file in the 'file' field.", 400);
    return addAttachment(actor, scope, params.id, file);
  }, 201);

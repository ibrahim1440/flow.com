import { hrHandler } from "@/lib/hr/http";
import { HrError, readJson } from "@/lib/hr/core";
import { approveGosiInvoice, closeGosiInvoice, decideGosiVoid, payGosiInvoice, reconcileGosiInvoice, withdrawGosiVoid } from "@/lib/hr/services/gosi";

// P-2 review P2-B4: one step of a GOSI invoice's lifecycle. Each step's duty, independence and
// evidence are checked by its service function (and by the database); the route only dispatches.
export const POST = hrHandler(async ({ actor, request, params }) => {
  const b = await readJson(request).catch(() => ({}) as Record<string, unknown>);
  switch (params.step) {
    case "reconcile": return reconcileGosiInvoice(actor, params.id);
    case "approve": return approveGosiInvoice(actor, params.id, b);
    case "pay": return payGosiInvoice(actor, params.id, b);
    case "close": return closeGosiInvoice(actor, params.id);
    case "void-decide": return decideGosiVoid(actor, params.id, b);
    case "void-withdraw": return withdrawGosiVoid(actor, params.id);
    default: throw new HrError("Unknown GOSI invoice step.", 404);
  }
});

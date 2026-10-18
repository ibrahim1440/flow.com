import { hrHandler } from "@/lib/hr/http";
import { HrError, readJson } from "@/lib/hr/core";
import { approveSettlement, calculateSettlement, cancelSettlement, closeSettlement, paySettlement, postSettlement, returnSettlement, reviewSettlement } from "@/lib/hr/services/final-settlement";
import { requestProvisionShortfall } from "@/lib/hr/services/provisions";

// P-2 finding 8: one step of the settlement. Each step's duty, independence and evidence are
// checked by its service function (and by the database); the route only dispatches.
export const POST = hrHandler(async ({ actor, request, params, today }) => {
  const b = await readJson(request);
  switch (params.step) {
    case "calculate": return calculateSettlement(actor, params.id, b);
    case "review": return reviewSettlement(actor, params.id, b);
    case "return": return returnSettlement(actor, params.id, b);
    case "approve": return approveSettlement(actor, params.id, b);
    case "post": return postSettlement(actor, params.id, b, today);
    case "pay": return paySettlement(actor, params.id, b);
    case "close": return closeSettlement(actor, params.id, b);
    case "cancel": return cancelSettlement(actor, params.id, b);
    // P-2 rev3 item 4 (D-7g): request the accountant's decision on a provision shortfall.
    case "shortfall": return requestProvisionShortfall(actor, params.id, b);
    default: throw new HrError("Unknown settlement step.", 404);
  }
});

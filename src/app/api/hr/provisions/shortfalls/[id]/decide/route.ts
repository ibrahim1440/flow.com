import { hrHandler } from "@/lib/hr/http";
import { readJson } from "@/lib/hr/core";
import { decideProvisionShortfall } from "@/lib/hr/services/provisions";

// P-2 rev3 item 4 (D-7g): a second person records the accountant's decision on a provision shortfall.
export const POST = hrHandler(async ({ actor, request, params }) => decideProvisionShortfall(actor, params.id, await readJson(request)));

import { hrHandler } from "@/lib/hr/http";
import { readJson } from "@/lib/hr/core";
import { resolveGosiSettlement } from "@/lib/hr/services/gosi";

// P-2 review P2-B4: an approved decision other than EMPLOYER_EXPENSE stays open until it is linked
// to its correction run, or to the dispute outcome / written acceptance.
export const POST = hrHandler(async ({ actor, request, params }) => resolveGosiSettlement(actor, params.id, await readJson(request)));

import { hrHandler } from "@/lib/hr/http";
import { readJson } from "@/lib/hr/core";
import { submitRun } from "@/lib/hr/services/payroll";

// P-2 review P2-B7: the body may name the escalated advances the preparer acknowledges
// (acknowledgeEscalations); an empty body is accepted when there are none.
export const POST = hrHandler(async ({ actor, request, params }) => submitRun(actor, params.id, await readJson(request).catch(() => ({}))));

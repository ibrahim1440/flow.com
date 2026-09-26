import { financeHandler } from "@/lib/finance/server/http";
import { readJson, reqStr } from "@/lib/finance/server/context";
import { releaseReservation } from "@/lib/finance/server/allocation";

export const POST = financeHandler("allocate", async ({ actor, scope, request, params }) => releaseReservation(actor, scope, params.id, reqStr((await readJson(request)).reason, "Reason", 500)));

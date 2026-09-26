import { financeHandler } from "@/lib/finance/server/http";
import { readJson } from "@/lib/finance/server/context";
import { executeReservation } from "@/lib/finance/server/allocation";

export const POST = financeHandler("allocate", async ({ actor, scope, request, params }) => executeReservation(actor, scope, params.id, await readJson(request)));

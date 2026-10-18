import { hrHandler } from "@/lib/hr/http";
import { readJson } from "@/lib/hr/core";
import { withdrawRecovery } from "@/lib/hr/services/advance-recovery";

export const POST = hrHandler(async ({ actor, request, params }) => withdrawRecovery(actor, params.id, await readJson(request)));

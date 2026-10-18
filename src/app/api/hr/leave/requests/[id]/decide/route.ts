import { hrHandler } from "@/lib/hr/http";
import { readJson } from "@/lib/hr/core";
import { decideLeave } from "@/lib/hr/services/leave";

export const POST = hrHandler(async ({ actor, request, params }) => decideLeave(actor, params.id, await readJson(request)));

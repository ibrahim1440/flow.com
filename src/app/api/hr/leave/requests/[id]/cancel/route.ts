import { hrHandler } from "@/lib/hr/http";
import { readJson } from "@/lib/hr/core";
import { cancelLeave } from "@/lib/hr/services/leave";

export const POST = hrHandler(async ({ actor, request, params, today }) => cancelLeave(actor, params.id, await readJson(request), today));

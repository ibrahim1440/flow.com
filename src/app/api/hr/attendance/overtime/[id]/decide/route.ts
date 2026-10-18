import { hrHandler } from "@/lib/hr/http";
import { readJson } from "@/lib/hr/core";
import { decideOvertime } from "@/lib/hr/services/attendance";

export const POST = hrHandler(async ({ actor, request, params }) => decideOvertime(actor, params.id, await readJson(request)));

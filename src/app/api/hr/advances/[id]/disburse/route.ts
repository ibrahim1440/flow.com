import { hrHandler } from "@/lib/hr/http";
import { readJson } from "@/lib/hr/core";
import { disburseAdvance } from "@/lib/hr/services/advances";

export const POST = hrHandler(async ({ actor, request, params }) => disburseAdvance(actor, params.id, await readJson(request)));

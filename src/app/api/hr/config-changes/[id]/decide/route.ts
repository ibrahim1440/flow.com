import { hrHandler } from "@/lib/hr/http";
import { readJson } from "@/lib/hr/core";
import { decideConfigChange } from "@/lib/hr/services/config-change";

export const POST = hrHandler(async ({ actor, request, params }) => decideConfigChange(actor, params.id, await readJson(request)));

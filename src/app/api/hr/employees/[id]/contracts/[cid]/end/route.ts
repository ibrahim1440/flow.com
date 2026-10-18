import { hrHandler } from "@/lib/hr/http";
import { readJson } from "@/lib/hr/core";
import { endContract } from "@/lib/hr/services/contracts";

export const POST = hrHandler(async ({ actor, request, params }) => endContract(actor, params.id, params.cid, await readJson(request)));

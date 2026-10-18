import { hrHandler } from "@/lib/hr/http";
import { readJson } from "@/lib/hr/core";
import { setStatus } from "@/lib/hr/services/people";

export const POST = hrHandler(async ({ actor, request, params }) => setStatus(actor, params.id, await readJson(request)));

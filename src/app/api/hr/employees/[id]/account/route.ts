import { hrHandler } from "@/lib/hr/http";
import { readJson } from "@/lib/hr/core";
import { linkAccount } from "@/lib/hr/services/people";

export const POST = hrHandler(async ({ actor, request, params }) => linkAccount(actor, params.id, await readJson(request)));

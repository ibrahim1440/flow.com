import { hrHandler } from "@/lib/hr/http";
import { readJson } from "@/lib/hr/core";
import { getPrivate, updatePrivate } from "@/lib/hr/services/people";

export const GET = hrHandler(async ({ actor, params }) => getPrivate(actor, params.id));
export const PUT = hrHandler(async ({ actor, request, params }) => updatePrivate(actor, params.id, await readJson(request)));

import { hrHandler } from "@/lib/hr/http";
import { readJson } from "@/lib/hr/core";
import { getProfile, updatePerson } from "@/lib/hr/services/people";

export const GET = hrHandler(async ({ actor, params, today }) => getProfile(actor, params.id, today));
export const PATCH = hrHandler(async ({ actor, request, params }) => updatePerson(actor, params.id, await readJson(request)));

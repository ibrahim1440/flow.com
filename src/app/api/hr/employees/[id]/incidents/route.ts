import { hrHandler } from "@/lib/hr/http";
import { readJson } from "@/lib/hr/core";
import { addIncident } from "@/lib/hr/services/workforce";

export const POST = hrHandler(async ({ actor, request, params }) => addIncident(actor, params.id, await readJson(request)), { status: 201 });

import { hrHandler } from "@/lib/hr/http";
import { readJson } from "@/lib/hr/core";
import { initiateSeparation, openSeparationFor } from "@/lib/hr/services/workforce";

export const GET = hrHandler(async ({ actor, params }) => openSeparationFor(actor, params.id));
export const POST = hrHandler(async ({ actor, request, params }) => initiateSeparation(actor, params.id, await readJson(request)), { status: 201 });

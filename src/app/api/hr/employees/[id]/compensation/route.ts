import { hrHandler } from "@/lib/hr/http";
import { readJson } from "@/lib/hr/core";
import { addCompensation } from "@/lib/hr/services/contracts";

export const POST = hrHandler(async ({ actor, request, params }) => addCompensation(actor, params.id, await readJson(request)), { status: 201 });

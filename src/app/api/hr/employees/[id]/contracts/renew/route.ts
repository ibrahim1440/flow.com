import { hrHandler } from "@/lib/hr/http";
import { readJson } from "@/lib/hr/core";
import { renewContract } from "@/lib/hr/services/contracts";

export const POST = hrHandler(async ({ actor, request, params }) => renewContract(actor, params.id, await readJson(request)), { status: 201 });

import { hrHandler } from "@/lib/hr/http";
import { readJson } from "@/lib/hr/core";
import { createContract } from "@/lib/hr/services/contracts";

export const POST = hrHandler(async ({ actor, request, params }) => createContract(actor, params.id, await readJson(request)), { status: 201 });

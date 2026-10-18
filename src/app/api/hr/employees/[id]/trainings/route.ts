import { hrHandler } from "@/lib/hr/http";
import { readJson } from "@/lib/hr/core";
import { addTraining } from "@/lib/hr/services/workforce";

export const POST = hrHandler(async ({ actor, request, params }) => addTraining(actor, params.id, await readJson(request)), { status: 201 });

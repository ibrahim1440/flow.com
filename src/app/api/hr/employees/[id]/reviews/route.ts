import { hrHandler } from "@/lib/hr/http";
import { readJson } from "@/lib/hr/core";
import { addReview } from "@/lib/hr/services/workforce";

export const POST = hrHandler(async ({ actor, request, params }) => addReview(actor, params.id, await readJson(request)), { status: 201 });

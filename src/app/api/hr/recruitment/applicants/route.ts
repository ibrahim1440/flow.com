import { hrHandler } from "@/lib/hr/http";
import { readJson } from "@/lib/hr/core";
import { createApplicant, listApplicants } from "@/lib/hr/services/recruitment";

export const GET = hrHandler(async ({ actor, query }) => listApplicants(actor, { stage: query.get("stage") }));
export const POST = hrHandler(async ({ actor, request }) => createApplicant(actor, await readJson(request)), { status: 201 });

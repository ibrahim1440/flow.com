import { hrHandler } from "@/lib/hr/http";
import { readJson } from "@/lib/hr/core";
import { listRequests, requestLeave } from "@/lib/hr/services/leave";

export const GET = hrHandler(async ({ actor, query }) => listRequests(actor, { view: query.get("view") }));
export const POST = hrHandler(async ({ actor, request }) => requestLeave(actor, await readJson(request)), { status: 201 });

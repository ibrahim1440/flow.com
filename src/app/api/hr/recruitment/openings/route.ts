import { hrHandler } from "@/lib/hr/http";
import { readJson } from "@/lib/hr/core";
import { createOpening, listOpenings } from "@/lib/hr/services/recruitment";

export const GET = hrHandler(async ({ actor }) => listOpenings(actor));
export const POST = hrHandler(async ({ actor, request }) => createOpening(actor, await readJson(request)), { status: 201 });

import { hrHandler } from "@/lib/hr/http";
import { readJson } from "@/lib/hr/core";
import { addInterview } from "@/lib/hr/services/recruitment";

export const POST = hrHandler(async ({ actor, request, params }) => addInterview(actor, params.id, await readJson(request)), { status: 201 });

import { hrHandler } from "@/lib/hr/http";
import { readJson } from "@/lib/hr/core";
import { setStage } from "@/lib/hr/services/recruitment";

export const POST = hrHandler(async ({ actor, request, params }) => setStage(actor, params.id, await readJson(request)));

import { hrHandler } from "@/lib/hr/http";
import { readJson } from "@/lib/hr/core";
import { setOpeningStatus } from "@/lib/hr/services/recruitment";

export const POST = hrHandler(async ({ actor, request, params }) => setOpeningStatus(actor, params.id, await readJson(request)));

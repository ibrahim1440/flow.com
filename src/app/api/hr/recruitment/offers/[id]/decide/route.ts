import { hrHandler } from "@/lib/hr/http";
import { readJson } from "@/lib/hr/core";
import { decideOffer } from "@/lib/hr/services/recruitment";

export const POST = hrHandler(async ({ actor, request, params }) => decideOffer(actor, params.id, await readJson(request)));

import { hrHandler } from "@/lib/hr/http";
import { readJson } from "@/lib/hr/core";
import { returnAsset } from "@/lib/hr/services/workforce";

export const POST = hrHandler(async ({ actor, request, params }) => returnAsset(actor, params.id, await readJson(request)));

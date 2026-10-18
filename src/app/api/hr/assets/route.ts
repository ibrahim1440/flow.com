import { hrHandler } from "@/lib/hr/http";
import { readJson } from "@/lib/hr/core";
import { createAsset, listAssets } from "@/lib/hr/services/workforce";

export const GET = hrHandler(async ({ actor }) => listAssets(actor));
export const POST = hrHandler(async ({ actor, request }) => createAsset(actor, await readJson(request)), { status: 201 });

import { hrHandler } from "@/lib/hr/http";
import { readJson } from "@/lib/hr/core";
import { resolveReviewItem } from "@/lib/hr/services/advance-recovery";

export const POST = hrHandler(async ({ actor, request, params }) => resolveReviewItem(actor, params.id, await readJson(request)));

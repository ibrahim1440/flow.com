import { hrHandler } from "@/lib/hr/http";
import { readJson } from "@/lib/hr/core";
import { decideProvisionEntry } from "@/lib/hr/services/provisions";

// P-2 rev3 item 4: a second person approves or rejects a provision attribution / adjustment.
export const POST = hrHandler(async ({ actor, request, params }) => decideProvisionEntry(actor, params.id, await readJson(request)));

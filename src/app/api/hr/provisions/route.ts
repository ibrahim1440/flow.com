import { hrHandler } from "@/lib/hr/http";
import { readJson } from "@/lib/hr/core";
import { provisionReconciliation, requestProvisionEntry } from "@/lib/hr/services/provisions";

// P-2 rev3 item 4 (D-7g): the per-employee provision subledger and its reconciliation to the GL.
export const GET = hrHandler(async ({ actor }) => provisionReconciliation(actor));
export const POST = hrHandler(async ({ actor, request }) => requestProvisionEntry(actor, await readJson(request)), { status: 201 });

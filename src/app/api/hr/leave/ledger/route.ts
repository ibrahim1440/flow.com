import { hrHandler } from "@/lib/hr/http";
import { readJson } from "@/lib/hr/core";
import { ledger, ledgerEntry } from "@/lib/hr/services/leave";

export const GET = hrHandler(async ({ actor, query }) => ledger(actor, query.get("employeeId") ?? "", query.get("leaveTypeId") ?? ""));
export const POST = hrHandler(async ({ actor, request }) => ledgerEntry(actor, await readJson(request)), { status: 201 });

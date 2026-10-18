import { hrHandler } from "@/lib/hr/http";
import { readJson } from "@/lib/hr/core";
import { recordReconNote } from "@/lib/hr/services/payroll-controls";

// P-2 / E-4: explain a difference the report lists (append-only; never changes an amount).
export const POST = hrHandler(async ({ actor, request, params }) => recordReconNote(actor, params.id, await readJson(request)), { status: 201 });

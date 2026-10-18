import { hrHandler } from "@/lib/hr/http";
import { readJson } from "@/lib/hr/core";
import { enterGosiInvoice, listGosiInvoices } from "@/lib/hr/services/gosi";

// P-2 finding 4: GOSI invoices as received (manual lines or CSV). No rate is entered here.
export const GET = hrHandler(async ({ actor }) => listGosiInvoices(actor));
export const POST = hrHandler(async ({ actor, request }) => enterGosiInvoice(actor, await readJson(request)), { status: 201 });

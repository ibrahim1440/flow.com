import { accountingRoute, body } from "@/lib/accounting/http";
import { generateEInvoice } from "@/lib/accounting/einvoice/service";

// Generate, or retry generating, the e-invoice of a posted sales document (idempotent).
export const POST = accountingRoute("einv_generate", async ({ user, request }) => generateEInvoice(String((await body(request)).salesInvoiceId ?? ""), user.id));

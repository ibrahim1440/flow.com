import { accountingRoute } from "@/lib/accounting/http";
import { eInvoiceDetail } from "@/lib/accounting/einvoice/service";

// The stored XML as a file (for inspection or validation with the official SDK outside this system).
export const GET = accountingRoute(null, async ({ params }) => {
  const e = await eInvoiceDetail(params.id);
  return new Response(e.xml, { headers: { "Content-Type": "application/xml; charset=utf-8", "Content-Disposition": `attachment; filename="${e.doc}-ICV${e.icv}.xml"` } });
});

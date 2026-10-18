import { hrHandler } from "@/lib/hr/http";
import { exportCsv } from "@/lib/hr/services/payroll";

/** Generic CSV of a run. NOT a WPS/Mudad file; IBAN only for callers with private_view. */
export const GET = hrHandler(async ({ actor, params }) => {
  const csv = await exportCsv(actor, params.id);
  return new Response(csv, { headers: { "Content-Type": "text/csv; charset=utf-8", "Content-Disposition": `attachment; filename="payroll-${params.id}.csv"`, "Cache-Control": "private, no-store" } });
});

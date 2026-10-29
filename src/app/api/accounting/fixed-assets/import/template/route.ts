import { requireFaRead } from "@/lib/accounting/fixed-assets/http";
import { importTemplateCsv } from "@/lib/accounting/fixed-assets/import";

/** The CSV template (UTF-8 with a BOM, the header keys and one example row). */
export async function GET() {
  const { error } = await requireFaRead();
  if (error) return error;
  return new Response(importTemplateCsv(), { headers: { "Content-Type": "text/csv; charset=utf-8", "Content-Disposition": 'attachment; filename="fixed-assets-import-template.csv"', "Cache-Control": "no-store" } });
}

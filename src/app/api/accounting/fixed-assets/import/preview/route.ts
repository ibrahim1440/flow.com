import { NextResponse } from "@/lib/api-response";
import { acctError, jsonBody } from "@/lib/accounting/http";
import { requireFaImport } from "@/lib/accounting/fixed-assets/http";
import { previewImport } from "@/lib/accounting/fixed-assets/import";

/** «معاينة» of a Qoyod asset file: every row checked, nothing written (fixed_assets + opening_balance). */
export async function POST(request: Request) {
  const { error } = await requireFaImport({ stepUp: false });
  if (error) return error;
  try {
    return NextResponse.json(await previewImport(await jsonBody(request)));
  } catch (err) {
    return acctError(err);
  }
}

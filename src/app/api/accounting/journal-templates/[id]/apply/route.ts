import { NextResponse } from "@/lib/api-response";
import { requireSub } from "@/lib/auth-server";
import { acctError, jsonBody } from "@/lib/accounting/http";
import { applyTemplateById } from "@/lib/accounting/recurring/templates";

type Params = { params: Promise<{ id: string }> };

/**
 * «استخدام القالب»: the journal lines of a template for a total (`{ total }`, PERCENT templates; half-up to the halala, the
 * remainder on each side's last line). Writes nothing — the manual journal form is prefilled with the answer and the
 * journal is saved through POST /api/accounting/journals (every journal rule). accounting › journal_create.
 */
export async function POST(request: Request, { params }: Params) {
  const { error } = await requireSub("accounting", "journal_create");
  if (error) return error;
  const { id } = await params;
  try {
    const body = await jsonBody(request);
    return NextResponse.json(await applyTemplateById(id, body.total));
  } catch (err) {
    return acctError(err);
  }
}

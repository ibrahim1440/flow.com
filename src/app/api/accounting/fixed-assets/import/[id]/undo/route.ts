import { NextResponse } from "@/lib/api-response";
import { acctError, jsonBody } from "@/lib/accounting/http";
import { auditFromRequest } from "@/lib/accounting/audit";
import { requireFaImport } from "@/lib/accounting/fixed-assets/http";
import { undoImport } from "@/lib/accounting/fixed-assets/import";

/** «إلغاء الاستيراد» — only before the opening is posted (fixed_assets + opening_balance, step-up; a reason). */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { user, error } = await requireFaImport({ stepUp: true });
  if (error) return error;
  try {
    const { id } = await params;
    const body = await jsonBody(request);
    const reason = typeof body.reason === "string" ? body.reason.trim().slice(0, 500) : "";
    return NextResponse.json(await undoImport(id, reason || null, auditFromRequest(request, user.id, reason || "undo fixed-asset import")));
  } catch (err) {
    return acctError(err);
  }
}

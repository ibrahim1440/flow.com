import { NextResponse } from "@/lib/api-response";
import { requirePrivilegedAction, requireSub } from "@/lib/auth-server";
import { acctError, jsonBody } from "@/lib/accounting/http";
import { auditFromRequest } from "@/lib/accounting/audit";
import { requireApRead } from "@/lib/accounting/ops/http";
import { listCategories, saveCategory } from "@/lib/accounting/ops/ap";

/** Expense categories (non-stock bills) → their accounts. */
export async function GET() {
  const { error } = await requireApRead();
  if (error) return error;
  try {
    return NextResponse.json(await listCategories());
  } catch (err) {
    return acctError(err);
  }
}

/** Create or change a category. accounting › settings_manage (step-up). */
export async function POST(request: Request) {
  const { user, error } = await requireSub("accounting", "settings_manage");
  if (error) return error;
  const refused = await requirePrivilegedAction(user, "accounting.expense_categories", { stepUp: true });
  if (refused) return refused;
  try {
    const b = await jsonBody(request);
    return NextResponse.json(await saveCategory(b as never, auditFromRequest(request, user.id, "expense category")), { status: b.id ? 200 : 201 });
  } catch (err) {
    return acctError(err);
  }
}

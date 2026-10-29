import { NextResponse } from "@/lib/api-response";
import { requireRegisterWrite } from "@/lib/accounting/register-access";
import { requireModule } from "@/lib/auth-server";
import { acctError, jsonBody, qp } from "@/lib/accounting/http";
import { auditFromRequest } from "@/lib/accounting/audit";
import { listTemplates, saveTemplate } from "@/lib/accounting/recurring/templates";

/**
 * «القيود السهلة» — journal templates (20261120090000_recurring_journals). GET: the accounting module (`archived=1` adds the
 * archived ones, `q` searches name / description). POST: a new template — accounting › recurring.
 */
export async function GET(request: Request) {
  const { error } = await requireModule("accounting");
  if (error) return error;
  try {
    return NextResponse.json({ items: await listTemplates({ includeArchived: qp(request, "archived") === "1", q: qp(request, "q") }) });
  } catch (err) {
    return acctError(err);
  }
}

export async function POST(request: Request) {
  const { user, error } = await requireRegisterWrite("recurring");
  if (error) return error;
  try {
    return NextResponse.json(await saveTemplate(await jsonBody(request), null, auditFromRequest(request, user.id)), { status: 201 });
  } catch (err) {
    return acctError(err);
  }
}

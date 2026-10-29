import { NextResponse } from "@/lib/api-response";
import { requireModule } from "@/lib/auth-server";
import { requireRegisterWrite } from "@/lib/accounting/register-access";
import { hasSubPrivilege } from "@/lib/auth-shared";
import { acctError, jsonBody } from "@/lib/accounting/http";
import { auditFromRequest } from "@/lib/accounting/audit";
import { deleteDraftBudget, getBudget, saveBudget } from "@/lib/accounting/budgets";

type Params = { params: Promise<{ id: string }> };

/** One budget: header, grid, the accounts it may carry, its versions, and what the viewer may do. */
export async function GET(_request: Request, { params }: Params) {
  const { user, error } = await requireModule("accounting");
  if (error) return error;
  const { id } = await params;
  try {
    const can = (sub: string) => hasSubPrivilege(user.permissions, "accounting", sub);
    return NextResponse.json({ ...(await getBudget(id)), can: { prepare: can("budgets"), approve: can("journal_approve") }, viewer: { id: user.id } });
  } catch (err) {
    return acctError(err);
  }
}

/** Save a DRAFT (name, notes, the whole grid). An approved budget is locked (the database refuses it too). */
export async function PUT(request: Request, { params }: Params) {
  const { user, error } = await requireRegisterWrite("budgets");
  if (error) return error;
  const { id } = await params;
  try {
    return NextResponse.json(await saveBudget(id, await jsonBody(request), auditFromRequest(request, user.id)));
  } catch (err) {
    return acctError(err);
  }
}

/** Delete a DRAFT. */
export async function DELETE(request: Request, { params }: Params) {
  const { user, error } = await requireRegisterWrite("budgets");
  if (error) return error;
  const { id } = await params;
  try {
    return NextResponse.json(await deleteDraftBudget(id, auditFromRequest(request, user.id)));
  } catch (err) {
    return acctError(err);
  }
}

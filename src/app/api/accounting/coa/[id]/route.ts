import { NextResponse } from "@/lib/api-response";
import { prisma } from "@/lib/db";
import { requireModule, requireSub } from "@/lib/auth-server";
import { acctError, jsonBody } from "@/lib/accounting/http";
import { deleteAccount, updateAccount } from "@/lib/accounting/chart";
import { auditFromRequest } from "@/lib/accounting/audit";
import { refuse } from "@/lib/accounting/refusals";

type Params = { params: Promise<{ id: string }> };

export async function GET(_request: Request, { params }: Params) {
  const { error } = await requireModule("accounting");
  if (error) return error;
  const { id } = await params;
  try {
    const account = await prisma.account.findUnique({ where: { id }, include: { roles: { select: { role: true } }, _count: { select: { journalEntryLines: true, children: true } } } });
    if (!account) throw refuse("NOT_FOUND");
    return NextResponse.json(account);
  } catch (err) {
    return acctError(err);
  }
}

/** Edit an account. Once it has journal lines its code, type and normal balance are fixed (the database insists). */
export async function PATCH(request: Request, { params }: Params) {
  const { user, error } = await requireSub("accounting", "coa_manage");
  if (error) return error;
  const { id } = await params;
  try {
    return NextResponse.json(await updateAccount(id, await jsonBody(request), auditFromRequest(request, user.id)));
  } catch (err) {
    return acctError(err);
  }
}

/** Remove an account nothing refers to; otherwise deactivate it. */
export async function DELETE(request: Request, { params }: Params) {
  const { user, error } = await requireSub("accounting", "coa_manage");
  if (error) return error;
  const { id } = await params;
  try {
    return NextResponse.json(await deleteAccount(id, auditFromRequest(request, user.id)));
  } catch (err) {
    return acctError(err);
  }
}

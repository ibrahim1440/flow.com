import { NextResponse } from "@/lib/api-response";
import { prisma } from "@/lib/db";
import { requireAuth, requireEdit } from "@/lib/auth-server";
import { handleDomainError } from "@/lib/api-error";
import { mayChangeAccountOwner } from "@/lib/services/customers/account-guard";
import { assignCustomersOwner } from "@/lib/services/customers/assign-owner";

/**
 * GET /api/customers/assign-owner — whether the viewer may assign customers to a rep, and the people offered (the same
 * roster as the customer details dialog «المسؤول»: active employees).
 */
export async function GET() {
  const { user, error } = await requireAuth();
  if (error) return error;
  const can = mayChangeAccountOwner(user);
  const owners = can ? await prisma.employee.findMany({ where: { active: true }, select: { id: true, name: true }, orderBy: { name: "asc" } }) : [];
  return NextResponse.json({ can, owners }, { headers: { "Cache-Control": "no-store" } });
}

/**
 * POST /api/customers/assign-owner { customerIds, ownerId | null } — «إسناد العملاء لمندوب». customers › edit and the
 * account-owner duty (mayChangeAccountOwner: the sales manager, a commission manager, the administrator), exactly as
 * the single change; each changed customer is audited before / after; the new rep is notified once.
 */
export async function POST(request: Request) {
  const { user, error } = await requireEdit("customers");
  if (error) return error;
  try {
    const body = await request.json().catch(() => null);
    const r = await prisma.$transaction((tx) => assignCustomersOwner(tx, user, body));
    return NextResponse.json(r);
  } catch (err) {
    return handleDomainError(err);
  }
}

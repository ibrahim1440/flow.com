import { NextResponse } from "@/lib/api-response";
import { prisma } from "@/lib/db";
import { requireAuth, adminRoleGate, privilegedGate } from "@/lib/auth-server";
import { hasSubPrivilege } from "@/lib/auth-shared";
import { handleDomainError } from "@/lib/api-error";
import { managesNewClientExclusion, seesAllSales } from "@/lib/services/sales/scope";

type Params = { params: Promise<{ id: string }> };

/**
 * PATCH /api/customers/[id]/commission-exclusion — «مستثنى من عمولة العميل الجديد».
 *
 * The commission policy excludes a client that was in the active base or already in negotiation
 * before the salesperson started. Nothing in the system recorded that (no flag on the customer or
 * on deal assignment), so it is this manual decision, with a reason, by a sales manager / admin /
 * plan manager (managesNewClientExclusion) — never by a rep. While set, the order-sequence
 * component pays the plan's existing-client rate on this client's orders; the change reaches a
 * month at its next recomputation (collection, monthly run), never a figure already approved.
 */
export async function PATCH(request: Request, { params }: Params) {
  const { user, error } = await requireAuth();
  if (error) return error;
  if (!managesNewClientExclusion(user.permissions, user.role)) {
    return NextResponse.json({ error: "Insufficient permissions" }, { status: 403 });
  }
  // A sales manager (`lead_assign`, operational) acts as such. Reached only through the admin role or
  // a privileged commissions sub, the action-time gate of that path applies (verified individual).
  if (!seesAllSales(user.permissions)) {
    const refused = user.role === "admin"
      ? await adminRoleGate(user, "customers.new_client_exclusion")
      : hasSubPrivilege(user.permissions, "commissions", "manage_settings")
        ? await privilegedGate(user, "commissions", "manage_settings")
        : await privilegedGate(user, "commissions", "manage_plans");
    if (refused) return refused;
  }
  const { id } = await params;
  let b: Record<string, unknown>;
  try {
    b = ((await request.json()) ?? {}) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }
  if (typeof b.excluded !== "boolean") return NextResponse.json({ error: "excluded must be true or false." }, { status: 400 });
  const reason = typeof b.reason === "string" ? b.reason.trim() : "";
  if (b.excluded && reason.length < 3) {
    return NextResponse.json({ error: "Excluding a client from the new-client commission needs a reason." }, { status: 400 });
  }
  try {
    const exists = await prisma.customer.findUnique({ where: { id }, select: { id: true, newClientCommissionExcluded: true, newClientExclusionReason: true } });
    if (!exists) return NextResponse.json({ error: "Not found." }, { status: 404 });
    // Logged like every opening change (CommissionAuditLog, kind EXCLUSION).
    const log = prisma.commissionAuditLog.create({
      data: {
        kind: "EXCLUSION", customerId: id, source: "CUSTOMER_FILE", actorId: user.id, reason: reason || null,
        before: { excluded: exists.newClientCommissionExcluded, reason: exists.newClientExclusionReason },
        after: { excluded: b.excluded, reason: b.excluded ? reason : null },
      },
    });
    const update = prisma.customer.update({
      where: { id },
      data: b.excluded
        ? { newClientCommissionExcluded: true, newClientExclusionReason: reason.slice(0, 500), newClientExclusionById: user.id, newClientExclusionAt: new Date() }
        : { newClientCommissionExcluded: false, newClientExclusionReason: null, newClientExclusionById: user.id, newClientExclusionAt: new Date() },
      select: { id: true, newClientCommissionExcluded: true, newClientExclusionReason: true, newClientExclusionAt: true, newClientExclusionById: true },
    });
    const [, updated] = await prisma.$transaction([log, update]);
    return NextResponse.json({ customer: updated });
  } catch (err) {
    return handleDomainError(err);
  }
}

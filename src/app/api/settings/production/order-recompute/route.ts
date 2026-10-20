import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { forbidden, requireAdminAction, requireAuth } from "@/lib/auth-server";
import { handleDomainError } from "@/lib/api-error";
import { writeSettingsAudit } from "@/lib/services/settings/audit";
import { applyOrderStatusRecompute, planOrderStatusRecompute } from "@/lib/services/orders/status-recompute";

/**
 * Settings › Production & roasting «إعادة حساب حالات الطلبات» — the one-time recompute of orders
 * created before the automatic preparation existed (small-fixes batch), the same service as
 * scripts/release/prod-simplify-recompute.ts (services/orders/status-recompute.ts).
 *
 * GET: the dry run — how many open orders are delivered in full and would close, and how many the
 * automatic preparation would run on. Writes nothing. The admin role only.
 * POST: apply. The admin role, by a verified individual after a recent step-up (the gate of the
 * other settings writes). Idempotent: a second run closes nothing and changes nothing. Every run is
 * appended to SettingsAuditLog (section "production", ORDER_STATUS_RECOMPUTED, migration
 * 20261024090000_small_fixes), and each order it closes carries its own ORDER_COMPLETED activity.
 */
export async function GET() {
  const { user, error } = await requireAuth();
  if (error) return error;
  if (user.role !== "admin") return forbidden();
  try {
    const plan = await planOrderStatusRecompute();
    return NextResponse.json({ ...plan, can: { apply: true } });
  } catch (err) {
    return handleDomainError(err);
  }
}

export async function POST() {
  const { user, error } = await requireAuth();
  if (error) return error;
  const refused = await requireAdminAction(user, "settings.production_order_recompute", { stepUp: true });
  if (refused) return refused;
  try {
    const before = await planOrderStatusRecompute();
    const result = await applyOrderStatusRecompute({ id: user.id, name: user.name }, { prepare: true });
    await writeSettingsAudit(prisma, {
      section: "production",
      action: "ORDER_STATUS_RECOMPUTED",
      entityType: "Order",
      entityId: "status-recompute",
      changed: result.closed.length > 0 || result.prepared.length > 0 ? ["status"] : [],
      before: {
        open: before.open,
        wouldClose: before.wouldClose.map((o) => o.orderNumber),
        wouldStayOpen: before.wouldStayOpen.map((o) => o.orderNumber),
        wouldPrepare: before.wouldPrepare.length,
      },
      after: {
        closed: result.closed.map((o) => o.orderNumber),
        leftOpen: result.leftOpen.map((o) => o.orderNumber),
        prepared: result.prepared.map((o) => ({ orderNumber: o.orderNumber, from: o.from, to: o.to })),
        preparedChecked: result.preparedChecked,
      },
      actor: { id: user.id, name: user.name },
    });
    return NextResponse.json(result);
  } catch (err) {
    return handleDomainError(err);
  }
}

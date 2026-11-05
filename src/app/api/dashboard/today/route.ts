import { NextResponse } from "@/lib/api-response";
import { requireModule } from "@/lib/auth-server";
import { loadToday } from "@/lib/services/dashboard/today";
import { canSeeCustomerDetail } from "@/lib/auth/customer-detail";
import { orderVisibilityWhere } from "@/lib/services/sales/scope";

// The operations dashboard («اليوم»). Read-only; the same gate as /api/analytics, which the
// previous dashboard read: the «dashboard» module.
export async function GET() {
  const { user, error } = await requireModule("dashboard");
  if (error) return error;
  // Owner decision F4: customer names and order numbers only with the customer-detail permission
  // (the GET /api/customers gate); every other dashboard user gets aggregates.
  const customerDetail = canSeeCustomerDetail(user.permissions);
  // Gate L3 (soon batch round 2): a sales-scoped viewer sees their own book only, exactly as /api/dashboard/stats.
  return NextResponse.json(await loadToday(new Date(), { customerDetail, orderScope: orderVisibilityWhere(user) }), { headers: { "Cache-Control": "no-store" } });
}

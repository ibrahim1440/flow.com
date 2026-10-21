import { NextResponse } from "@/lib/api-response";
import { requireModule } from "@/lib/auth-server";
import { loadToday } from "@/lib/services/dashboard/today";
import { canSeeCustomerDetail } from "@/lib/auth/customer-detail";

// The operations dashboard («اليوم»). Read-only; the same gate as /api/analytics, which the
// previous dashboard read: the «dashboard» module.
export async function GET() {
  const { user, error } = await requireModule("dashboard");
  if (error) return error;
  // Owner decision F4: customer names and order numbers only with the customer-detail permission
  // (the GET /api/customers gate); every other dashboard user gets aggregates.
  const customerDetail = canSeeCustomerDetail(user.permissions);
  return NextResponse.json(await loadToday(new Date(), { customerDetail }), { headers: { "Cache-Control": "no-store" } });
}

// «بيع مباشر» step 2 — POST {customerId, lines}: the server's price (list price × units, VAT 15 %) for the screen to show.
// Read-only; «إرسال» prices again on the server and never takes these figures back from the client.
import { NextResponse } from "@/lib/api-response";
import { prisma } from "@/lib/db";
import { requireAuth, forbidden } from "@/lib/auth-server";
import { handleDomainError } from "@/lib/api-error";
import { discountThreshold } from "@/lib/services/sales/quote-settings";
import { assertDirectSaleCustomer, mayApproveDiscount, mayDirectSell, parseDiscount, priceDirectSale } from "@/lib/services/sales/direct-sale";

export async function POST(request: Request) {
  const { user, error } = await requireAuth();
  if (error) return error;
  if (!mayDirectSell(user.permissions)) return forbidden();
  let body: Record<string, unknown>;
  try { body = await request.json(); } catch { return NextResponse.json({ error: "طلب غير صالح.", errorEn: "Invalid JSON body.", code: "BAD_INPUT" }, { status: 400 }); }
  try {
    await assertDirectSaleCustomer(prisma, user, body.customerId);
    // The discount is read as the sale reads it: above the threshold without the right, the sale will wait for a supervisor.
    const d = parseDiscount(body.discountPercent, await discountThreshold(prisma), mayApproveDiscount(user.permissions));
    return NextResponse.json({ ...(await priceDirectSale(prisma, body.lines, d.percent)), needsApproval: d.needsApproval });
  } catch (err) {
    return handleDomainError(err);
  }
}

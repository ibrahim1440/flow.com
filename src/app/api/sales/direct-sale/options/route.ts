// «بيع مباشر» steps 1–2 — GET ?q=: the customers the caller may sell to (a scoped rep: their own book, never the pool —
// owner decision 5) and the sellable products (active, with a list price). Plus what the caller may do.
import { NextResponse } from "@/lib/api-response";
import { requireAuth, forbidden } from "@/lib/auth-server";
import { canEdit, hasSubPrivilege } from "@/lib/auth-shared";
import { handleDomainError } from "@/lib/api-error";
import { directSaleOptions, mayDirectSell } from "@/lib/services/sales/direct-sale";

export async function GET(request: Request) {
  const { user, error } = await requireAuth();
  if (error) return error;
  if (!mayDirectSell(user.permissions)) return forbidden();
  try {
    const sp = new URL(request.url).searchParams;
    const r = await directSaleOptions(user, sp.get("q") ?? "", sp.get("customerId"));
    const createCustomer = canEdit(user.permissions, "customers") || hasSubPrivilege(user.permissions, "sales", "lead_write") || hasSubPrivilege(user.permissions, "sales", "lead_convert");
    return NextResponse.json({ ...r, can: { ...r.can, createCustomer } });
  } catch (err) {
    return handleDomainError(err);
  }
}

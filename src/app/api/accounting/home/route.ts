import { NextResponse } from "@/lib/api-response";
import { requireModule } from "@/lib/auth-server";
import { hasModuleAccess } from "@/lib/auth-shared";
import { acctError } from "@/lib/accounting/http";
import { accountantHome, parseRange } from "@/lib/accounting/accountant-home";
import { canViewInvoices } from "@/lib/services/invoicing/access";
import { scopedCustomerIds } from "@/lib/services/invoicing/http";
import { canReadCost } from "@/lib/services/transfer-shortfall-gate";

/**
 * GET /api/accounting/home?from=YYYY-MM-DD&to=YYYY-MM-DD[&location=<id>…] — «لوحة المتابعة» of the accountant
 * workspace (src/lib/accounting/accountant-home.ts lists each widget's source report). The accounting module; each
 * widget then keeps the gate of the report it comes from (a widget the viewer may not read comes back null).
 */
export async function GET(request: Request) {
  const { user, error } = await requireModule("accounting");
  if (error) return error;
  try {
    const q = new URL(request.url).searchParams;
    const { from, to } = parseRange(q.get("from"), q.get("to"));
    const p = user.permissions;
    const ar = canViewInvoices(p);
    const stock = ["inventory", "packaging", "production", "purchases"].some((m) => hasModuleAccess(p, m));
    const body = await accountantHome({
      from, to,
      locationIds: q.getAll("location").filter((x) => /^[\w-]{1,64}$/.test(x)).slice(0, 50),
      can: { ar, arScope: ar ? await scopedCustomerIds(user) : null, ap: true, gl: true, stock, cost: canReadCost(p) },
    });
    return NextResponse.json(body);
  } catch (err) {
    return acctError(err);
  }
}

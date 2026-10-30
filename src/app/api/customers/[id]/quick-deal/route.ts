import { NextResponse } from "@/lib/api-response";
import { prisma, TX_OPTS } from "@/lib/db";
import { requireSub } from "@/lib/auth-server";
import { handleDomainError } from "@/lib/api-error";
import { hasModuleAccess, hasSubPrivilege } from "@/lib/auth-shared";
import { NOT_FOUND_MESSAGE } from "@/lib/services/sales/scope";
import { customerInScope } from "@/lib/services/sales/customer-access";
import { actsForAccountOwner, resolveQuickDeal, type QuickPurpose } from "@/lib/services/sales/quick-deal";

type Params = { params: Promise<{ id: string }> };

/**
 * POST /api/customers/[id]/quick-deal { purpose: "quote" | "sample" } — the deal behind the customer
 * page's one-tap «عرض سعر» and «عيّنة» (services/sales/quick-deal.ts):
 *   200 { kind: "use" | "created", opportunityId } — go straight to the quotation editor / the sample request;
 *   200 { kind: "pick", deals }                   — several of the caller's open deals: the page asks which;
 *   200 { kind: "none" }                          — no open deal and the caller may not open one;
 *   200 { kind: "new" }                           — `preview: true` only: nothing written; a deal WOULD be opened. The
 *                                                   sample dialog asks for it with `preview` and opens the deal on submit
 *                                                   (POST /api/sales/samples { customerId }), never on opening.
 * The privilege is the action's own (quote → sales › quote_write, sample → sales › lead_write); opening a
 * deal additionally needs sales › lead_convert, as POST /api/customers/[id]/deals. A customer outside the
 * caller's book is 404, as everywhere; a customer in the book whose account owner is somebody else is 403 unless
 * the caller is a team-view manager — and then the deal is the ACCOUNT OWNER's, never the manager's (H1).
 */
export async function POST(request: Request, { params }: Params) {
  let body: Record<string, unknown> = {};
  try { body = ((await request.json()) ?? {}) as Record<string, unknown>; } catch { /* empty body: refused below */ }
  const purpose: QuickPurpose | null = body.purpose === "quote" || body.purpose === "sample" ? body.purpose : null;
  if (!purpose) return NextResponse.json({ error: "اختر عرض سعر أو عيّنة.", errorEn: "purpose must be quote or sample." }, { status: 400 });
  const { user, error } = await requireSub("sales", purpose === "quote" ? "quote_write" : "lead_write");
  if (error) return error;
  if (!hasModuleAccess(user.permissions, "customers")) return NextResponse.json({ error: "Insufficient permissions" }, { status: 403 });
  const { id } = await params;
  if (!(await customerInScope(user, id))) return NextResponse.json({ error: NOT_FOUND_MESSAGE }, { status: 404 });
  try {
    const canOpenDeal = hasSubPrivilege(user.permissions, "sales", "lead_convert");
    const teamView = actsForAccountOwner(user);
    const preview = body.preview === true;
    const result = await prisma.$transaction((tx) => resolveQuickDeal(tx, { id: user.id, canOpenDeal, teamView }, id, purpose, new Date(), { preview }), TX_OPTS);
    if (result.kind === "forbidden") {
      return NextResponse.json({ error: "هذا العميل له مندوب آخر — اطلب من مديرك أو من مندوبه.", errorEn: "This customer belongs to another rep.", code: "NOT_ACCOUNT_OWNER" }, { status: 403 });
    }
    return NextResponse.json(result, { status: result.kind === "created" ? 201 : 200 });
  } catch (err) {
    return handleDomainError(err);
  }
}

import { NextResponse } from "@/lib/api-response";
import { prisma } from "@/lib/db";
import { forbidden, requireAuth } from "@/lib/auth-server";
import { hasModuleAccess } from "@/lib/auth-shared";
import { handleDomainError } from "@/lib/api-error";
import { canSeeCustomerContact } from "@/lib/auth/customer-detail";
import { isScopedSalesRep } from "@/lib/services/orders/owner-access";
import { NOT_FOUND_MESSAGE } from "@/lib/services/sales/scope";
import { documentPrintGate } from "@/lib/print/server/auth";
import { DocumentNotFound, deliveryNoteFacts, documentSeller } from "@/lib/print/server/documents";

export const dynamic = "force-dynamic";

const ID = /^[A-Za-z0-9_-]{1,64}$/;
/** One dispatch is one row per order line; an order with more lines than this is not a delivery note. */
const MAX_NOTE_DELIVERIES = 50; // stated in the refusal below

const notFound = () => NextResponse.json({ error: NOT_FOUND_MESSAGE, errorAr: "غير موجود.", code: "NOT_FOUND" }, { status: 404 });

/**
 * GET /api/print/documents/delivery-note?ids=<deliveryId>,<deliveryId>…
 *
 * The data of the printed delivery note «إشعار التسليم» (feat/print-docs): the deliveries given (all
 * of one order), the order's lines with what each had delivered so far, and every delivery of the
 * order for that count. Quantities only, no prices. Read-only.
 *
 * Who: the dispatch module (the screen that records deliveries) or the orders module (the order
 * page shows them). A sales rep who sees only their own customers (the sales module without
 * lead_assign, services/orders/owner-access.ts) and does not hold dispatch reads only an order they
 * own or whose customer account they own — anything else is 404, as the sales endpoints answer.
 * The customer's phone, address, city and first contact are included only for holders of the
 * customer contact right (the customers module, owner policy F4); everyone else gets the name.
 *
 * Order of checks: 401 → 403 (neither module) → 409 DOCUMENT_PRINTING_DISABLED → 400 (ids) → 404.
 */
export async function GET(request: Request) {
  const { user, error } = await requireAuth();
  if (error) return error;
  const p = user.permissions;
  const dispatch = hasModuleAccess(p, "dispatch");
  const orders = hasModuleAccess(p, "orders");
  if (!dispatch && !orders) return forbidden();
  const gated = documentPrintGate();
  if (gated) return gated;

  const raw = new URL(request.url).searchParams.get("ids") ?? "";
  const ids = [...new Set(raw.split(",").map((s) => s.trim()).filter(Boolean))];
  if (ids.length === 0 || ids.length > MAX_NOTE_DELIVERIES || ids.some((id) => !ID.test(id))) {
    return NextResponse.json({ error: "Give 1 to 50 delivery ids (ids=a,b).", errorAr: "حدد من 1 إلى 50 تسليمًا للطباعة.", code: "INVALID_IDS" }, { status: 400 });
  }

  try {
    const facts = await deliveryNoteFacts(prisma, ids, canSeeCustomerContact(p));
    if (!facts) {
      return NextResponse.json({ error: "The deliveries belong to more than one order.", errorAr: "التسليمات المحددة لأكثر من طلب.", code: "MIXED_ORDERS" }, { status: 400 });
    }
    if (!dispatch && isScopedSalesRep(p) && facts.order.ownerId !== user.id && facts.order.customerAccountOwnerId !== user.id) return notFound();
    const { ownerId: _o, customerAccountOwnerId: _c, ...order } = facts.order;
    void _o; void _c;
    return NextResponse.json(
      { order, customer: facts.customer, items: facts.items, history: facts.history, noteIds: ids, seller: await documentSeller(prisma) },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (err) {
    if (err instanceof DocumentNotFound) return notFound();
    return handleDomainError(err);
  }
}

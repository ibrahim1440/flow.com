import { NextResponse } from "@/lib/api-response";
import { prisma, TX_OPTS } from "@/lib/db";
import { forbidden, privilegedGate, requireAuth, requireSub } from "@/lib/auth-server";
import { canQuoteWithoutDeal } from "@/lib/services/sales/quote-access";
import { handleDomainError } from "@/lib/api-error";
import { hasSubPrivilege } from "@/lib/auth-shared";
import { seesAllSales, NOT_FOUND_MESSAGE } from "@/lib/services/sales/scope";
import { createOrderFromQuote, prepareConvertedOrder } from "@/lib/services/sales/quote-to-order";
import { emitAutomationEvent } from "@/lib/automation/emit";

type Params = { params: Promise<{ id: string }> };

/**
 * POST /api/sales/quotes/[id]/create-order — raise the order an accepted quotation entitles
 * the customer to.
 *
 * ── Two privileges, not one ──
 * `orders:create` is the gate, because this creates a real order in the operational system
 * and a CRM privilege must not be a way around the order module's own permissions. The
 * caller must also be able to see the quotation, which the sales scope decides. Someone who
 * may raise orders but may not see this deal gets the same 404 as anybody else.
 *
 * ── Idempotent ──
 * The service keys the link row on the quotation, so the second click returns the first
 * order. The response says which happened; a rep who clicks twice should be told "that
 * order already exists" rather than left wondering whether they have made two.
 */
export async function POST(request: Request, { params }: Params) {
  const { id } = await params;
  // «مسار المحاسب»: an accepted quotation with no deal (channel ACCOUNTING) is turned into an order by the accounting
  // section (accounting › quotes_issue) as well as by orders › create; nothing to scope by deal.
  const auth = await requireAuth();
  if (auth.error) return auth.error;
  if (!hasSubPrivilege(auth.user.permissions, "orders", "create") && canQuoteWithoutDeal(auth.user.permissions)) {
    const q = await prisma.quote.findUnique({ where: { id }, select: { channel: true } });
    if (!q) return NextResponse.json({ error: NOT_FOUND_MESSAGE }, { status: 404 });
    if (q.channel !== "ACCOUNTING") return forbidden();
    const refused = await privilegedGate(auth.user, "accounting", "quotes_issue");
    if (refused) return refused;
    return convert(request, id, auth.user);
  }
  const { user, error } = await requireSub("orders", "create");
  if (error) return error;

  // Read access to the sales module as well, so this endpoint cannot be used to reach a
  // quotation the caller could not otherwise open.
  if (!hasSubPrivilege(user.permissions, "sales", "quote_write") && !seesAllSales(user.permissions)) {
    const readable = await prisma.quote.findFirst({
      where: { id, opportunity: { ownerId: user.id } },
      select: { id: true },
    });
    if (!readable) return NextResponse.json({ error: NOT_FOUND_MESSAGE }, { status: 404 });
  }

  return convert(request, id, user, { scoped: !seesAllSales(user.permissions) });
}

async function convert(request: Request, id: string, user: { id: string; name: string }, opts: { scoped?: boolean } = {}) {
  let body: unknown = {};
  try {
    body = await request.json();
  } catch {
    // An empty body is the ordinary case: the quotation already says everything needed.
  }
  const b = (body ?? {}) as Record<string, unknown>;

  try {
    const visible = await prisma.quote.findFirst({
      where: { id, ...(opts.scoped ? { opportunity: { ownerId: user.id } } : {}) },
      select: { id: true },
    });
    if (!visible) return NextResponse.json({ error: NOT_FOUND_MESSAGE }, { status: 404 });

    const result = await prisma.$transaction(
      async (tx) => {
        const created = await createOrderFromQuote(tx, {
          quoteId: id,
          actorId: user.id,
          requestKey: typeof b.requestKey === "string" ? b.requestKey : null,
          notes: typeof b.notes === "string" ? b.notes : null,
        });
        if (!created.replayed) {
          await emitAutomationEvent(tx, { eventType: "order.created", subjectType: "Order", subjectId: created.orderId, actorId: user.id });
        }
        return created;
      },
      TX_OPTS,
    );
    // Quote → order triggers preparation (handoff §6.8), after the order committed.
    await prepareConvertedOrder(result, { id: user.id, name: user.name });

    return NextResponse.json(
      {
        ...result,
        // P1 ERR-05: the Arabic screen shows `message`; `messageEn` for the English one.
        message: result.replayed
          ? `الطلب رقم ${result.orderNumber} انعمل من هالعرض من قبل.`
          : `انعمل الطلب رقم ${result.orderNumber}.`,
        messageEn: result.replayed
          ? `Order #${result.orderNumber} was already raised from this quotation.`
          : `Order #${result.orderNumber} created.`,
      },
      { status: result.replayed ? 200 : 201 },
    );
  } catch (err) {
    return handleDomainError(err);
  }
}

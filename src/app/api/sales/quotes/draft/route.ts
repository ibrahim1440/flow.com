import { NextResponse } from "@/lib/api-response";
import { prisma } from "@/lib/db";
import { requireQuoteWrite } from "@/lib/services/sales/quote-guard";
import { canQuoteWithoutDeal, canWriteQuotes, quotesSeeAll, writesViaAccounting } from "@/lib/services/sales/quote-access";
import { prefillLines } from "@/lib/services/sales/quote-prefill";
import { parseLineInputs, priceQuote, validateLines, type SkuFacts } from "@/lib/services/sales/quotes";
import { hasSubPrivilege } from "@/lib/auth-shared";
import { handleDomainError } from "@/lib/api-error";
import { actsForAccountOwner, resolveQuickDeal } from "@/lib/services/sales/quick-deal";
import { customerInScope } from "@/lib/services/sales/customer-access";
import { NOT_FOUND_MESSAGE } from "@/lib/services/sales/scope";
import { readQuoteSettings } from "@/lib/services/sales/quote-settings";
import { assertSalesAllowed } from "@/lib/services/customers/credit-db";

/**
 * GET /api/sales/quotes/draft?opportunityId= — P2 ب4 (owner decision, 13 Nov): «عرض سعر جديد» opens an UNSAVED quotation
 * for the deal: no row, no number. The editor fills it, and its first save (POST /api/sales/quotes with the lines) is what
 * creates the quotation and takes its number — an abandoned «عرض سعر جديد» leaves no numbered draft behind.
 * The same shape as GET /api/sales/quotes/[id] (id "draft", no number), read-only: nothing is written.
 *
 * P2 gate (ب4 on every entry point):
 *   · ?customerId= — the accountant's quotation WITHOUT a deal (accounting › quotes_issue), unsaved the same way (Q18);
 *   · ?customerId=&openDeal=1 — a rep's «عرض سعر» on a customer with no open deal (Abu Fahd R2 M3): the deal is opened
 *     at the first save with lines (POST /api/sales/quotes { customerId, openDeal }), never on opening;
 *   · &from=customer — opened from the customer page: the editor starts with the customer's usual items (the same
 *     prefill the customer page used to save at once), still unsaved (A1).
 */
export async function GET(request: Request) {
  const { user, error } = await requireQuoteWrite();
  if (error) return error;
  const sp = new URL(request.url).searchParams;
  const opportunityId = sp.get("opportunityId") ?? "";
  const customerOnly = !opportunityId ? sp.get("customerId") ?? "" : "";
  if (!opportunityId && !customerOnly) return NextResponse.json({ error: "A quotation belongs to a deal.", errorAr: "عرض السعر يتبع صفقة." }, { status: 400 });
  // Abu Fahd R2 (M3): a customer with no open deal — the deal is opened at the first save (POST … openDeal), not now.
  const openDeal = !!customerOnly && sp.get("openDeal") === "1";
  if (openDeal) {
    if (!(await customerInScope(user, customerOnly))) return NextResponse.json({ error: NOT_FOUND_MESSAGE, errorAr: NOT_FOUND_MESSAGE }, { status: 404 });
    const peek = await prisma.$transaction((tx) => resolveQuickDeal(tx, { id: user.id, canOpenDeal: hasSubPrivilege(user.permissions, "sales", "lead_convert"), teamView: actsForAccountOwner(user) }, customerOnly, "quote", new Date(), { preview: true }));
    // An open deal exists after all (opened meanwhile): the editor goes to it.
    if ((peek.kind === "use") && peek.opportunityId) return NextResponse.json({ error: "This customer has an open deal.", errorAr: "للعميل صفقة مفتوحة.", code: "DEAL_EXISTS", opportunityId: peek.opportunityId }, { status: 409 });
    if (peek.kind !== "new") return NextResponse.json({ error: "You may not open a deal for this customer.", errorAr: "ما عندك صلاحية تفتح صفقة لهذا العميل. كلّم مديرك.", code: peek.kind === "pick" ? "PICK_DEAL" : "DEAL_REQUIRED" }, { status: peek.kind === "pick" ? 409 : 403 });
  } else if (customerOnly && !canQuoteWithoutDeal(user.permissions)) {
    return NextResponse.json({ error: "A quotation without a deal is issued from the accounting section only.", errorAr: "عرض السعر بدون صفقة من قسم المحاسبة فقط.", code: "DEAL_REQUIRED" }, { status: 403 });
  }
  try {
    const customerSelect = { id: true, name: true, nameAr: true, phone: true, email: true, address: true, city: true, vatNumber: true, commercialRegNo: true } as const;
    const loneCustomer = customerOnly ? await prisma.customer.findUnique({ where: { id: customerOnly }, select: customerSelect }) : null;
    if (customerOnly && !loneCustomer) return NextResponse.json({ error: "Customer not found.", errorAr: "العميل غير موجود." }, { status: 404 });
    const deal = customerOnly ? null : await prisma.opportunity.findFirst({
      where: { id: opportunityId, ...(quotesSeeAll(user.permissions) ? {} : { ownerId: user.id }) },
      select: {
        id: true, title: true, outcome: true, customerId: true, owner: { select: { id: true, name: true } },
        customer: { select: customerSelect },
      },
    });
    if (!customerOnly && !deal) return NextResponse.json({ error: "Deal not found.", errorAr: "الصفقة غير موجودة." }, { status: 404 });
    if (deal?.outcome === "LOST") return NextResponse.json({ error: "This deal is lost. Reopen it before quoting again.", errorAr: "الصفقة خسرانة — افتحها من جديد قبل عرض سعر." }, { status: 409 });
    const customerId = customerOnly || deal?.customerId || null;
    if (customerId) await assertSalesAllowed(prisma as never, customerId);
    // From the customer page: its usual items, as the save would have taken them (a prefill a line rule refuses is dropped).
    // The SAME line shape as GET /api/sales/quotes/[id] (priced figures, position, the product) — the editor and its
    // summary read every field of a line; a partial row crashed the page (P2-B gate, b24-access Alt+Q).
    type SkuRef = { id: string; skuCode: string; name: string | null; nameAr: string | null; unitOfMeasure: string; price: number };
    let prefill: { id: null; productSkuId: string | null; description: string | null; quantity: string; unit: string; unitPrice: string; discountPercent: string; taxRatePercent: string;
      lineSubtotal: string; lineTax: string; lineTotal: string; position: number; productSku: SkuRef | null }[] = [];
    let totals = { subtotal: "0", discountTotal: "0", taxTotal: "0", grandTotal: "0" };
    if ((deal || openDeal) && sp.get("from") === "customer" && customerId) {
      const pre = parseLineInputs(await prefillLines(prisma as never, customerId));
      const ids = pre.map((l) => l.productSkuId).filter((x): x is string => !!x);
      const skuRows = ids.length ? await prisma.productSKU.findMany({ where: { id: { in: ids } }, select: { id: true, isActive: true, unitOfMeasure: true, skuCode: true, name: true, nameAr: true, price: true } }) : [];
      if (pre.length && validateLines(pre, new Map(skuRows.map((r) => [r.id, r as unknown as SkuFacts]))).length === 0) {
        const priced = priceQuote(pre);
        const byId = new Map(skuRows.map((r) => [r.id, r]));
        prefill = pre.map((l, i) => {
          const sku = l.productSkuId ? byId.get(l.productSkuId) : undefined;
          return {
            id: null, productSkuId: l.productSkuId ?? null, description: l.description ?? null, quantity: String(l.quantity), unit: String(l.unit),
            unitPrice: String(l.unitPrice), discountPercent: String(l.discountPercent ?? "0"), taxRatePercent: String(l.taxRatePercent),
            lineSubtotal: priced.lines[i].lineSubtotal.toFixed(2), lineTax: priced.lines[i].lineTax.toFixed(2), lineTotal: priced.lines[i].lineTotal.toFixed(2),
            position: i + 1,
            productSku: sku ? { id: sku.id, skuCode: sku.skuCode, name: sku.name, nameAr: sku.nameAr, unitOfMeasure: sku.unitOfMeasure, price: Number(sku.price) } : null,
          };
        });
        totals = { subtotal: priced.subtotal.toFixed(2), discountTotal: priced.discountTotal.toFixed(2), taxTotal: priced.taxTotal.toFixed(2), grandTotal: priced.grandTotal.toFixed(2) };
      }
    }
    const settings = await readQuoteSettings(prisma);
    const validUntil = new Date(Date.now() + 30 * 86400_000);
    return NextResponse.json({
      quote: {
        id: "draft", quoteNumber: "", revision: 1, status: "DRAFT", currency: "SAR", validUntil: validUntil.toISOString(),
        ...totals, issuedAt: null, issuedSnapshot: null, acceptedAt: null,
        rejectedAt: null, rejectionNote: null, discountApprovedById: null, discountApprovedAt: null, approvalRequired: false,
        approvalBasisPercent: null, discountApprovedPercent: null, discountRejectedById: null, discountRejectedAt: null,
        discountRejectionNote: null, customerNotes: null, createdById: user.id, supersedesId: null, createdAt: null, updatedAt: null,
        commissionDecision: null, commissionReason: null, commissionDecidedAt: null, commissionRep: null,
        commissionDecidedBy: null, supersededBy: null, supersedes: null, customer: deal ? deal.customer : loneCustomer,
        opportunity: deal ? { id: deal.id, title: deal.title, outcome: deal.outcome, customerId: deal.customerId, owner: deal.owner } : null,
        channel: deal || openDeal ? "SALES" : "ACCOUNTING", opensDeal: openDeal,
        lines: prefill, orderLinks: [], unsaved: true,
      },
      state: { editable: true, revisable: false, expired: false, orderable: false, noDeal: !deal && !openDeal, order: null },
      can: {
        write: canWriteQuotes(user.permissions), viaAccounting: writesViaAccounting(user.permissions),
        approveDiscount: false, approveThisDiscount: false,
        close: hasSubPrivilege(user.permissions, "sales", "deal_close"), createOrder: false, decideCommission: false,
      },
      issuer: null,
      discount: { state: "NOT_NEEDED", basisPercent: null, customLine: false, approvedBy: null, rejectedBy: null },
      discountThresholdPercent: settings.effectiveThresholdPercent,
      liveDocument: null,
    });
  } catch (err) {
    return handleDomainError(err);
  }
}

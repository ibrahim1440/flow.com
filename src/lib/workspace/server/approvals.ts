// «بانتظار اعتمادي» — one inbox over the departments' own approval queues. READ ONLY.
//
// Each source is read with the department's own query and permission rule, and lists only what this
// person may decide now (the duty, the scope, never their own request — SIMPLE MODE aside, exactly as the
// department decides). The decision is NOT taken here: each item names the department's own decide
// endpoint (`decide.url`), which re-checks the duty, the scope, the state, four eyes and — for a discount —
// the figures the approver was shown (`decide.expected`), under its own lock, and runs the department's
// effects (the leave ledger, the advance cap re-check, the quotation audit, the finance effect …).
// A source the person holds no duty for is simply absent; a source that fails is reported as unavailable,
// never as "nothing waiting".
import { prisma } from "@/lib/db";
import { hasModuleAccess, hasSubPrivilege } from "@/lib/auth-shared";
import { approvesMove, isGeneralManager } from "@/lib/services/sales/stage-move";
import { isSimpleMode } from "@/lib/simple-mode";
import { can as hrCan, resolveScope as hrScope, type HrActor } from "@/lib/hr/core";
import { listRequests, assessLeave } from "@/lib/hr/services/leave";
import { listAdvances } from "@/lib/hr/services/advances";
import { discountThreshold } from "@/lib/services/sales/quote-settings";
import { discountApprovalState, priceQuote } from "@/lib/services/sales/quotes";
import { ownedCustomerWhere, seesAllSales } from "@/lib/services/sales/scope";
import { Prisma } from "@/generated/prisma/client";
import { priceDirectSale } from "@/lib/services/sales/direct-sale";
import { approvesSamples } from "@/lib/services/sales/sample-rules";
import { approvalQueue } from "@/lib/finance/server/approvals";
import { leaveTypeName } from "@/lib/i18n/hr";
import { resolveScope as finScope } from "@/lib/finance/server/context";
import { listApprovals as mktList } from "@/lib/marketing/server/approvals";
import { parseDay } from "@/lib/hr/dates";
import type { WsActor } from "./context";

export type ApprovalType = "LEAVE" | "ADVANCE" | "DISCOUNT" | "SAMPLE" | "STAGE_MOVE" | "FINANCE" | "MARKETING";

export type ApprovalItem = {
  key: string;
  type: ApprovalType;
  id: string;
  title: string;
  /** The title in English (the Arabic `title` stays as it was for the Arabic screen). */
  titleEn?: string;
  requester: string | null;
  subject: string | null;
  /** The subject in English where it differs (a person's English name, a type label). */
  subjectEn?: string | null;
  createdAt: string;
  /** Type-specific facts for the decision pane. */
  facts: Record<string, unknown>;
  /** Problems the approver should see before deciding (overlaps, a balance going negative …). */
  warnings: { ar: string; en: string }[];
  decide: { url: string; rejectNeedsReason: true; expected?: Record<string, string>; stepUp?: boolean };
  /** The original document in its department. */
  openUrl: string;
  /** Approval ≠ the act: what approving does NOT do (advance: not paid out; discount: not issued). */
  notice?: { ar: string; en: string };
};

const iso = (d: Date | string) => new Date(d).toISOString();

async function leaveItems(actor: WsActor): Promise<ApprovalItem[]> {
  const hr: HrActor = { id: actor.id, role: actor.role, permissions: actor.permissions, authTime: actor.authTime };
  if (!hrCan(hr, "leave_approve")) return [];
  const rows = await listRequests(hr, { view: "mine" });
  const scope = await hrScope(hr);
  const out: ApprovalItem[] = [];
  for (const r of rows) {
    const person = await prisma.hrEmployee.findUnique({ where: { id: r.employee.id }, select: { id: true, status: true, hireDate: true, departmentId: true, managerId: true, accountId: true } });
    if (!person) continue;
    // Four eyes, as decideLeave (SIMPLE MODE: the single owner may decide their own).
    if (!isSimpleMode() && (person.accountId === actor.id || r.requestedBy === actor.id)) continue;
    const start = parseDay(r.startDate), end = parseDay(r.endDate);
    const a = await assessLeave(prisma, { person, leaveTypeId: r.leaveTypeId, startDate: start, endDate: end, exceptRequestId: r.id });
    // Overlapping leave of colleagues the approver may see: same department or same manager.
    const peers = await prisma.hrLeaveRequest.findMany({
      where: {
        id: { not: r.id }, status: { in: ["APPROVED", "PENDING"] }, startDate: { lte: end }, endDate: { gte: start },
        employee: {
          id: { not: person.id },
          OR: [...(person.departmentId ? [{ departmentId: person.departmentId }] : []), ...(person.managerId ? [{ managerId: person.managerId }] : [])],
          ...(scope.all ? {} : { AND: [{ OR: [{ branchId: { in: scope.branchIds } }, { id: { in: scope.reportIds } }] }] }),
        },
      },
      select: { status: true, startDate: true, endDate: true, employee: { select: { fullNameAr: true } } },
      take: 10,
    });
    const warnings: ApprovalItem["warnings"] = [];
    for (const p of a.problems) warnings.push({ ar: p.message, en: p.message });
    if (peers.length) warnings.push({ ar: `${peers.length} من الزملاء في إجازة خلال الفترة نفسها`, en: `${peers.length} colleague(s) on leave in the same period` });
    out.push({
      key: `LEAVE:${r.id}`, type: "LEAVE", id: r.id,
      title: `${r.leaveType.nameAr} · ${Number(r.days)} يوم`, titleEn: `${leaveTypeName(r.leaveType, "en")} · ${Number(r.days)} ${Number(r.days) === 1 ? "day" : "days"}`,
      requester: r.requestedByName, subject: r.employee.fullNameAr,
      createdAt: iso(r.createdAt),
      facts: {
        leaveType: r.leaveType.nameAr, paid: r.leaveType.paid, startDate: r.startDate, endDate: r.endDate, days: r.days, reason: r.reason,
        employeeNo: r.employee.employeeNo, tracksBalance: a.tracksBalance, balance: a.balance, pending: a.pending, available: a.available, after: a.after,
        overlaps: peers.map((p) => ({ name: p.employee.fullNameAr, status: p.status, startDate: iso(p.startDate).slice(0, 10), endDate: iso(p.endDate).slice(0, 10) })),
      },
      warnings,
      decide: { url: `/api/hr/leave/requests/${encodeURIComponent(r.id)}/decide`, rejectNeedsReason: true },
      openUrl: `/dashboard/hr/leave?request=${encodeURIComponent(r.id)}`,
    });
  }
  return out;
}

async function advanceItems(actor: WsActor): Promise<ApprovalItem[]> {
  const hr: HrActor = { id: actor.id, role: actor.role, permissions: actor.permissions, authTime: actor.authTime };
  if (!hrCan(hr, "advances_approve")) return [];
  const rows = await listAdvances(hr, { view: "requested" });
  return rows
    .filter((r) => isSimpleMode() || (!r.isSubject && !r.isRequester))
    .map((r) => {
      const amount = Number(r.amount), n = Number(r.installmentCount) || 1;
      return {
        key: `ADVANCE:${r.id}`, type: "ADVANCE" as const, id: r.id,
        title: `سلفة ${r.advanceNo}`, titleEn: `Advance ${r.advanceNo}`, requester: r.requestedByName, subject: r.employee.fullNameAr, createdAt: iso(r.createdAt),
        facts: { advanceNo: r.advanceNo, amount: r.amount, installmentCount: n, installment: (amount / n).toFixed(2), firstInstallmentMonth: r.firstInstallmentMonth, reason: r.reason, employeeNo: r.employee.employeeNo },
        warnings: [],
        decide: { url: `/api/hr/advances/${encodeURIComponent(r.id)}/decide`, rejectNeedsReason: true as const },
        openUrl: `/dashboard/hr/advances?advance=${encodeURIComponent(r.id)}`,
        notice: { ar: "اعتماد السلفة لا يعني صرفها. الصرف إجراء مستقل في الموارد البشرية، وجدول الاستقطاع يُنشأ عند الصرف.", en: "Approving does not pay the advance out. Disbursement is a separate HR step; the deduction schedule is created then." },
      };
    });
}

async function discountItems(actor: WsActor): Promise<ApprovalItem[]> {
  if (!hasSubPrivilege(actor.permissions, "sales", "quote_approve_discount")) return [];
  const threshold = await discountThreshold(prisma);
  const scopeAll = seesAllSales(actor.permissions);
  const drafts = await prisma.quote.findMany({
    where: { status: "DRAFT", subtotal: { gt: 0 }, discountApprovedById: null, discountRejectedAt: null, ...(scopeAll ? {} : { opportunity: { ownerId: actor.id } }) },
    orderBy: { updatedAt: "desc" }, take: 200,
    select: {
      id: true, quoteNumber: true, revision: true, status: true, subtotal: true, discountTotal: true, grandTotal: true, currency: true, createdAt: true, updatedAt: true, createdById: true,
      discountApprovedById: true, discountApprovedPercent: true, discountRejectedAt: true,
      customer: { select: { name: true } }, opportunity: { select: { title: true, owner: { select: { name: true } } } },
      lines: { select: { quantity: true, unitPrice: true, discountPercent: true, taxRatePercent: true } },
    },
  });
  const creators = new Map((await prisma.employee.findMany({ where: { id: { in: [...new Set(drafts.map((d) => d.createdById).filter((x): x is string => !!x))] } }, select: { id: true, name: true } })).map((p) => [p.id, p.name]));
  const out: ApprovalItem[] = [];
  for (const q of drafts) {
    if (discountApprovalState(q, threshold) !== "PENDING" || q.lines.length === 0) continue;
    // «مسار المحاسب»: a quotation with no deal needs no discount approval by Sales.
    if (!q.opportunity) continue;
    if (!isSimpleMode() && q.createdById === actor.id) continue;
    const priced = priceQuote(q.lines.map((l) => ({ quantity: l.quantity, unitPrice: l.unitPrice, discountPercent: l.discountPercent, taxRatePercent: l.taxRatePercent })));
    const pct = priced.effectiveDiscountPercent.toDecimalPlaces(2).toString();
    const grand = priced.grandTotal.toFixed(2);
    out.push({
      key: `DISCOUNT:${q.id}`, type: "DISCOUNT", id: q.id,
      title: `خصم ${pct}% · عرض ${q.quoteNumber}`, titleEn: `Discount ${pct}% · quotation ${q.quoteNumber}`, requester: q.createdById ? creators.get(q.createdById) ?? null : null, subject: q.customer?.name ?? q.opportunity.title,
      createdAt: iso(q.updatedAt),
      facts: {
        quoteNumber: q.quoteNumber, revision: q.revision, customer: q.customer?.name ?? null, deal: q.opportunity.title, dealOwner: q.opportunity.owner?.name ?? null,
        discountPercent: pct, thresholdPercent: threshold.toString(), subtotal: priced.subtotal.toFixed(2), discountTotal: priced.discountTotal.toFixed(2), grandTotal: grand, currency: q.currency,
      },
      warnings: [],
      decide: { url: `/api/sales/quotes/${encodeURIComponent(q.id)}/discount-approval`, rejectNeedsReason: true, expected: { effectiveDiscountPercent: pct, grandTotal: grand }, stepUp: true },
      openUrl: `/dashboard/sales/quotes/${encodeURIComponent(q.id)}`,
      notice: { ar: "اعتماد الخصم لا يُصدر العرض ولا يتم البيع؛ يبقى العرض مسودة لدى البائع حتى يصدره.", en: "Approving the discount neither issues the quotation nor makes the sale; it stays a draft until the rep issues it." },
    });
  }
  return out;
}

/** «بيع مباشر» waiting for its discount (20261222090000_direct_sale_discount_approval) — the same approvers and the same
 *  rules as a quotation's discount, decided at POST /api/sales/direct-sale/[orderId]/discount-approval. */
async function directSaleDiscountItems(actor: WsActor): Promise<ApprovalItem[]> {
  if (!hasSubPrivilege(actor.permissions, "sales", "quote_approve_discount")) return [];
  const threshold = await discountThreshold(prisma);
  const scopeAll = seesAllSales(actor.permissions);
  const orders = await prisma.order.findMany({
    where: { discountApprovalStatus: "PENDING", status: { notIn: ["Cancelled", "Rejected"] }, ...(scopeAll ? {} : { customer: ownedCustomerWhere(actor.id) }) },
    orderBy: { createdAt: "asc" }, take: 200,
    select: { id: true, orderNumber: true, ownerId: true, createdAt: true, requestedDiscountPercent: true, customer: { select: { name: true, nameAr: true } }, owner: { select: { name: true } },
      items: { select: { productSkuId: true, quantityUnits: true } } },
  });
  // How each sale will be paid (its own audit row, written at «إرسال») — the card names it (أبو فهد, D20).
  const created = orders.length ? await prisma.hrAuditLog.findMany({ where: { action: "DIRECT_SALE_CREATED", entityType: "Order", entityId: { in: orders.map((o) => o.id) } }, select: { entityId: true, after: true } }) : [];
  const paymentOf = new Map(created.map((r) => [r.entityId, ((r.after ?? {}) as { payment?: string }).payment ?? null]));
  const out: ApprovalItem[] = [];
  for (const o of orders) {
    if (!isSimpleMode() && o.ownerId === actor.id) continue;
    const pct = new Prisma.Decimal((o.requestedDiscountPercent ?? 0).toString());
    // Gate L4: a sale whose price cannot be computed now (a SKU deactivated or unpriced since) stays in the inbox with a
    // warning — never silently dropped; approving it is refused by the service until the price is fixed.
    let priced: Awaited<ReturnType<typeof priceDirectSale>> | null = null;
    let priceProblem: string | null = null;
    try { priced = await priceDirectSale(prisma, o.items.filter((i) => i.productSkuId && i.quantityUnits).map((i) => ({ productSkuId: i.productSkuId!, quantityUnits: i.quantityUnits! })), pct); }
    catch (e) { priceProblem = (e as { errorAr?: string })?.errorAr ?? "تعذّر حساب السعر."; }
    const p = pct.toDecimalPlaces(2).toString();
    out.push({
      key: `DISCOUNT:order:${o.id}`, type: "DISCOUNT", id: o.id,
      title: `خصم ${p}% · بيع مباشر · طلب ${o.orderNumber}`, titleEn: `Discount ${p}% · direct sale · order ${o.orderNumber}`,
      requester: o.owner?.name ?? null, subject: o.customer.nameAr || o.customer.name, subjectEn: o.customer.name,
      createdAt: iso(o.createdAt),
      facts: {
        orderNumber: o.orderNumber, customer: o.customer.nameAr || o.customer.name, dealOwner: o.owner?.name ?? null,
        discountPercent: p, thresholdPercent: threshold.toString(), subtotal: priced?.subtotal ?? null, discountTotal: priced?.discount ?? null, grandTotal: priced?.gross ?? null, currency: "SAR",
        payment: paymentOf.get(o.id) ?? null,
      },
      warnings: priceProblem ? [{ ar: `ما ينحسب سعر الطلب الحين: ${priceProblem} — صحّح الصنف أو ارفض الخصم.`, en: "The order cannot be priced now (a product is unavailable or unpriced) — fix the product or refuse the discount." }] : [],
      decide: { url: `/api/sales/direct-sale/${encodeURIComponent(o.id)}/discount-approval`, rejectNeedsReason: true, expected: { discountPercent: p, ...(priced ? { grandTotal: priced.gross } : {}) }, stepUp: true },
      openUrl: `/dashboard/orders?order=${o.orderNumber}`,
      notice: { ar: "اعتماد الخصم يكمّل البيع: تنقفل الصفقة رابحة وتروح الفاتورة للمحاسب يصدرها.", en: "Approving completes the sale: the deal is won and the invoice goes to the accountant to issue." },
    });
  }
  return out;
}

// «للعميل من كل محصول عيّنة واحدة» (20261205090000_sample_approval): a customer's second sample of a coffee product
// waits for the sales manager or the administrator (approvesSamples). Decided at POST /api/sales/samples/[id]/approval
// (APPROVE, or REJECT = decline with the reason), which re-checks the duty and the state under the sample's lock.
async function sampleItems(actor: WsActor): Promise<ApprovalItem[]> {
  if (!approvesSamples(actor.permissions)) return [];
  const rows = await prisma.sampleShipment.findMany({
    where: { approvalRequired: true, approvedAt: null, declinedAt: null, status: "REQUESTED" },
    orderBy: { createdAt: "asc" }, take: 200,
    select: {
      id: true, quantity: true, createdAt: true, createdById: true,
      productSku: { select: { skuCode: true, name: true, nameAr: true } },
      opportunity: { select: { id: true, title: true, customer: { select: { name: true, nameAr: true } }, owner: { select: { name: true } } } },
    },
  });
  const creators = new Map((await prisma.employee.findMany({ where: { id: { in: [...new Set(rows.map((r) => r.createdById).filter((x): x is string => !!x))] } }, select: { id: true, name: true } })).map((p) => [p.id, p.name]));
  return rows.map((r) => {
    // FOLLOWUPS sales UI bug 4: the Arabic screen names the product (and the customer) in Arabic.
    const product = r.productSku?.name ?? r.productSku?.skuCode ?? "—";
    const productAr = r.productSku?.nameAr ?? product;
    return {
      key: `SAMPLE:${r.id}`, type: "SAMPLE" as const, id: r.id,
      title: `عيّنة ثانية · ${productAr}`, titleEn: `Second sample · ${product}`,
      requester: r.createdById ? creators.get(r.createdById) ?? null : null,
      subject: r.opportunity.customer?.nameAr ?? r.opportunity.customer?.name ?? r.opportunity.title,
      subjectEn: r.opportunity.customer?.name ?? r.opportunity.title,
      createdAt: iso(r.createdAt),
      facts: { customer: r.opportunity.customer?.name ?? null, customerAr: r.opportunity.customer?.nameAr ?? null, deal: r.opportunity.title, dealOwner: r.opportunity.owner?.name ?? null, product, productAr, units: Number(r.quantity) },
      warnings: [{ ar: "سبق إرسال عيّنة من هذا المحصول لهذا العميل.", en: "This customer has already had a sample of this product." }],
      decide: { url: `/api/sales/samples/${encodeURIComponent(r.id)}/approval`, rejectNeedsReason: true as const },
      openUrl: `/dashboard/sales/deals/${encodeURIComponent(r.opportunity.id)}`,
      notice: { ar: "الموافقة تُرسل الطلب إلى قسم الشحن ولا تُخرج المخزون؛ يُصرف عند صرف الشحن له. الرفض يلغي الطلب.", en: "Approving sends the request to dispatch; stock leaves only when dispatch issues it. Declining cancels the request." },
    };
  });
}

// Pipeline v2 (owner decision 3): a rep's manual stage move waits for a supervisor or manager — lead_assign (whose
// scope is every deal), the administrator, or a «مدير عام» member (stage-move.ts `approvesMove`; deal_stage_move alone
// never approves), and never the requester. ONE item per deal (one PENDING request per deal, a partial unique index),
// so it shows once. Decided at POST /api/sales/stage-move-requests/[id].
async function stageMoveItems(actor: WsActor): Promise<ApprovalItem[]> {
  if (!approvesMove({ id: actor.id, permissions: actor.permissions, generalManager: await isGeneralManager(prisma, actor.id) })) return [];
  const rows = await prisma.stageMoveRequest.findMany({
    where: { status: "PENDING", ...(isSimpleMode() ? {} : { requestedById: { not: actor.id } }) },
    orderBy: { createdAt: "asc" }, take: 200,
    select: {
      id: true, fromStageId: true, toStageId: true, reason: true, requestedById: true, createdAt: true,
      opportunity: { select: { id: true, title: true, amount: true, customer: { select: { name: true, nameAr: true } }, owner: { select: { name: true } } } },
    },
  });
  const stageIds = [...new Set(rows.flatMap((r) => [r.fromStageId, r.toStageId]))];
  const stages = new Map((await prisma.pipelineStage.findMany({ where: { id: { in: stageIds } }, select: { id: true, nameAr: true, nameEn: true } })).map((x) => [x.id, x]));
  const people = new Map((await prisma.employee.findMany({ where: { id: { in: [...new Set(rows.map((r) => r.requestedById))] } }, select: { id: true, name: true } })).map((p) => [p.id, p.name]));
  return rows.map((r) => {
    const from = stages.get(r.fromStageId), to = stages.get(r.toStageId);
    return {
      key: `STAGE_MOVE:${r.opportunity.id}`, type: "STAGE_MOVE" as const, id: r.id,
      title: `نقل صفقة إلى «${to?.nameAr ?? "—"}»`, titleEn: `Move a deal to “${to?.nameEn ?? "—"}”`,
      requester: people.get(r.requestedById) ?? null,
      subject: r.opportunity.customer?.nameAr ?? r.opportunity.customer?.name ?? r.opportunity.title,
      subjectEn: r.opportunity.customer?.name ?? r.opportunity.title,
      createdAt: iso(r.createdAt),
      facts: { deal: r.opportunity.title, dealOwner: r.opportunity.owner?.name ?? null, from: from?.nameAr ?? null, fromEn: from?.nameEn ?? null, to: to?.nameAr ?? null, toEn: to?.nameEn ?? null, reason: r.reason, amount: r.opportunity.amount.toFixed(2) },
      warnings: [],
      decide: { url: `/api/sales/stage-move-requests/${encodeURIComponent(r.id)}`, rejectNeedsReason: true as const },
      openUrl: `/dashboard/sales/deals/${encodeURIComponent(r.opportunity.id)}`,
      notice: { ar: "الاعتماد ينقل الصفقة إلى المرحلة المطلوبة ويسجّل ذلك في تاريخها؛ الرفض يبقيها حيث هي ويُبلغ المندوب بالسبب.", en: "Approving moves the deal to the requested stage and records it in its history; rejecting keeps it where it is and tells the rep why." },
    };
  });
}

const FIN_TYPE_AR: Record<string, string> = { BUDGET_APPROVAL: "اعتماد ميزانية", ALLOCATION_RULES: "قواعد التوزيع", CATEGORY_TRANSFER: "تحويل بين البنود", SPEND_OVERRIDE: "تجاوز حد الصرف", PERIOD_REOPEN: "إعادة فتح فترة" };
const FIN_TYPE_EN: Record<string, string> = { BUDGET_APPROVAL: "Budget approval", ALLOCATION_RULES: "Allocation rules", CATEGORY_TRANSFER: "Transfer between categories", SPEND_OVERRIDE: "Spending limit override", PERIOD_REOPEN: "Reopen a period" };
/** The marketing request's subject type, in both languages (the screen showed the raw code). */
const MKT_SUBJECT: Record<string, { ar: string; en: string }> = {
  POST: { ar: "منشور", en: "Post" }, CAMPAIGN: { ar: "حملة", en: "Campaign" }, MESSAGE_CAMPAIGN: { ar: "حملة رسائل واتساب", en: "WhatsApp message campaign" },
  JOURNEY: { ar: "رحلة عملاء آلية", en: "Automated customer journey" }, BUDGET_CHANGE: { ar: "تغيير ميزانية", en: "Budget change" }, AD_CHANGE: { ar: "تعديل إعلان", en: "Ad change" },
  TRACKING_CHANGE: { ar: "إعداد تتبع", en: "Tracking setup" }, SENSITIVE_REPLY: { ar: "رد حساس", en: "Sensitive reply" },
};

async function financeItems(actor: WsActor): Promise<ApprovalItem[]> {
  if (!hasModuleAccess(actor.permissions, "finance")) return [];
  const fa = { id: actor.id, role: actor.role, permissions: actor.permissions };
  const scope = await finScope(fa as never);
  const q = await approvalQueue(prisma, fa as never, scope as never);
  const names = new Map(q.people.map((p) => [p.id, p.name]));
  return q.toDecide.map((r) => ({
    key: `FINANCE:${r.id}`, type: "FINANCE" as const, id: r.id,
    title: FIN_TYPE_AR[r.type] ?? r.type, titleEn: FIN_TYPE_EN[r.type] ?? r.type, requester: names.get(r.requestedBy) ?? null, subject: r.summary ?? null, createdAt: iso(r.requestedAt),
    facts: { type: r.type, summary: r.summary, entityType: r.entityType },
    warnings: [],
    decide: { url: `/api/finance/approvals/${encodeURIComponent(r.id)}/decide`, rejectNeedsReason: true as const, stepUp: true },
    openUrl: "/dashboard/finance/approvals",
  }));
}

async function marketingItems(actor: WsActor): Promise<ApprovalItem[]> {
  if (!hasSubPrivilege(actor.permissions, "marketing", "approve")) return [];
  const rows = await mktList({ status: "PENDING" }, { id: actor.id, name: actor.name ?? "", permissions: actor.permissions, role: actor.role });
  return rows.filter((r) => r.canDecide).map((r) => ({
    key: `MARKETING:${r.id}`, type: "MARKETING" as const, id: r.id,
    title: r.subjectTitle ?? MKT_SUBJECT[r.subjectType]?.ar ?? r.subjectType, titleEn: r.subjectTitle ?? MKT_SUBJECT[r.subjectType]?.en ?? r.subjectType,
    requester: r.requestedByName, subject: MKT_SUBJECT[r.subjectType]?.ar ?? r.subjectType, subjectEn: MKT_SUBJECT[r.subjectType]?.en ?? r.subjectType, createdAt: iso(r.createdAt),
    facts: { subjectType: r.subjectType, action: r.action, note: r.requestNote },
    warnings: [],
    decide: { url: `/api/marketing/approvals/${encodeURIComponent(r.id)}`, rejectNeedsReason: true as const },
    openUrl: "/dashboard/marketing/approvals",
  }));
}

const SOURCES: [ApprovalType, (a: WsActor) => Promise<ApprovalItem[]>][] = [
  ["LEAVE", leaveItems], ["ADVANCE", advanceItems], ["DISCOUNT", async (a: WsActor) => [...(await discountItems(a)), ...(await directSaleDiscountItems(a))]], ["SAMPLE", sampleItems], ["STAGE_MOVE", stageMoveItems], ["FINANCE", financeItems], ["MARKETING", marketingItems],
];

export async function myApprovals(actor: WsActor, only?: ApprovalType | null) {
  const results = await Promise.all(SOURCES.filter(([t]) => !only || t === only).map(async ([t, fn]) => {
    try {
      return { t, items: await fn(actor), ok: true };
    } catch (e) {
      // 403 from a source = no duty there: absent, not an error.
      const status = (e as { status?: number; _appCode?: number })?.status ?? (e as { _appCode?: number })?._appCode;
      if (status === 403) return { t, items: [], ok: true };
      console.error(`[workspace] approvals source ${t} failed:`, (e as Error)?.name ?? "error");
      return { t, items: [], ok: false };
    }
  }));
  const items = results.flatMap((r) => r.items).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  const counts = Object.fromEntries(results.map((r) => [r.t, r.items.length])) as Record<ApprovalType, number>;
  return { items, counts, total: items.length, unavailable: results.filter((r) => !r.ok).map((r) => r.t) };
}

/** Only the count (the Today strip and the sidebar badge). */
// The badge's count, kept a minute per person and instance: the inbox itself always reads fresh.
const counted = new Map<string, { n: number; at: number }>();
export async function myApprovalCount(actor: WsActor, now = Date.now()): Promise<number> {
  const hit = counted.get(actor.id);
  if (hit && now - hit.at < 60_000) return hit.n;
  const n = (await myApprovals(actor)).total;
  if (counted.size > 5000) counted.clear();
  counted.set(actor.id, { n, at: now });
  return n;
}

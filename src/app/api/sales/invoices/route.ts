import { NextResponse } from "@/lib/api-response";
import { prisma } from "@/lib/db";
import type { Prisma } from "@/generated/prisma/client";
import { forbidden, requireAuth, requireSub } from "@/lib/auth-server";
import { auditFromRequest } from "@/lib/accounting/audit";
import { jsonBody } from "@/lib/accounting/http";
import { abilities, canSellAssets, canViewInvoices } from "@/lib/services/invoicing/access";
import { scopedCustomerIds, inScope } from "@/lib/services/invoicing/http";
import { createDraft } from "@/lib/services/invoicing/service";
import { saveAndIssue } from "@/lib/services/invoicing/requests";
import { zatcaAfterIssue } from "@/lib/services/invoicing/issue-http";
import { accountingErrorJson } from "@/lib/accounting/errors";
import { invError, refuseInv } from "@/lib/services/invoicing/refusals";
import { m2 } from "@/lib/services/invoicing/pricing";
import { branchWhere, parseBranchFilter } from "@/lib/accounting/locations";

const DAY = /^\d{4}-\d{2}-\d{2}$/;
const day = (d: Date | null) => (d ? d.toISOString().slice(0, 10) : null);

/**
 * GET /api/sales/invoices — the sales invoices («فواتير المبيعات») or the credit / debit notes (?tab=notes), newest
 * first. Filters: status, family, customerId, orderId, from / to (issue day), q (number or customer name), take ≤ 200,
 * skip. A rep (sales without lead_assign) sees only the invoices of the customers they own.
 * Who: sales › invoices_view or accounting › ar.
 */
export async function GET(request: Request) {
  const { user, error } = await requireAuth();
  if (error) return error;
  if (!canViewInvoices(user.permissions)) return forbidden();
  try {
    const q = new URL(request.url).searchParams;
    const scope = await scopedCustomerIds(user);
    const where: Prisma.SalesInvoiceWhereInput = { kind: q.get("tab") === "notes" ? { in: ["CREDIT_NOTE", "DEBIT_NOTE"] } : "INVOICE" };
    if (scope) where.customerId = { in: scope };
    const status = q.get("status");
    if (status && ["DRAFT", "ISSUED", "CANCELLED"].includes(status)) where.status = status;
    const family = q.get("family");
    if (family && ["STANDARD", "SIMPLIFIED"].includes(family)) where.family = family;
    const customerId = q.get("customerId");
    if (customerId) where.AND = [{ customerId }];
    const orderId = q.get("orderId");
    if (orderId) where.orderId = orderId;
    // «الموقع» (WP-B): branches=a,b,none («غير محدد»).
    const bf = parseBranchFilter(q);
    if (bf) where.AND = [...(Array.isArray(where.AND) ? where.AND : where.AND ? [where.AND] : []), branchWhere(bf)];
    const from = q.get("from"), to = q.get("to");
    if ((from && !DAY.test(from)) || (to && !DAY.test(to))) throw refuseInv("BAD_INPUT", "from / to are YYYY-MM-DD.", "التاريخ بصيغة YYYY-MM-DD.");
    if (from || to) where.issueDate = { ...(from ? { gte: new Date(`${from}T00:00:00Z`) } : {}), ...(to ? { lte: new Date(`${to}T00:00:00Z`) } : {}) };
    const text = (q.get("q") ?? "").trim().slice(0, 80);
    if (text) {
      const custs = await prisma.customer.findMany({ where: { OR: [{ name: { contains: text, mode: "insensitive" } }, { nameAr: { contains: text } }] }, select: { id: true }, take: 200 });
      where.OR = [{ number: { contains: text.toUpperCase() } }, { customerId: { in: custs.map((c) => c.id) } }];
    }
    const take = Math.min(Math.max(Number(q.get("take")) || 50, 1), 200);
    const skip = Math.max(Number(q.get("skip")) || 0, 0);
    const [rows, total, counts] = await Promise.all([
      prisma.salesInvoice.findMany({
        where, orderBy: [{ createdAt: "desc" }], take, skip,
        select: {
          id: true, kind: true, family: true, status: true, number: true, customerId: true, orderId: true, issueDate: true, dueDate: true, grandTotal: true, taxTotal: true,
          createdAt: true, source: true, buyer: true, originalInvoice: { select: { id: true, number: true } }, branchId: true,
          applications: { where: { status: "APPLIED" }, select: { amount: true } },
          creditApplications: { where: { status: "APPLIED" }, select: { amount: true } },
        },
      }),
      prisma.salesInvoice.count({ where }),
      prisma.salesInvoice.groupBy({ by: ["status"], where: { ...where, status: undefined }, _count: { _all: true } }),
    ]);
    const orders = await prisma.order.findMany({ where: { id: { in: rows.map((r) => r.orderId).filter((x): x is string => !!x) } }, select: { id: true, orderNumber: true } });
    const today = new Date().toISOString().slice(0, 10);
    return NextResponse.json({
      items: rows.map((r) => {
        const paid = r.applications.reduce((s, a) => s + Number(a.amount), 0);
        const open = r.status === "ISSUED" && r.kind !== "CREDIT_NOTE" ? Math.max(Number(r.grandTotal) - paid, 0) : null;
        const buyer = r.buyer as { name?: string } | null;
        return {
          id: r.id, kind: r.kind, family: r.family, status: r.status, number: r.number, customerId: r.customerId, customerName: buyer?.name ?? "",
          orderId: r.orderId, orderNumber: orders.find((o) => o.id === r.orderId)?.orderNumber ?? null, source: r.source, branchId: r.branchId,
          issueDate: day(r.issueDate), dueDate: day(r.dueDate), grandTotal: m2(r.grandTotal), taxTotal: m2(r.taxTotal), createdAt: r.createdAt,
          original: r.originalInvoice, open: open === null ? null : open.toFixed(2),
          payment: open === null ? null : open <= 0.0001 ? "PAID" : paid > 0 ? "PARTIAL" : "UNPAID",
          overdue: open !== null && open > 0 && !!r.dueDate && day(r.dueDate)! < today,
        };
      }),
      total, take, skip,
      byStatus: Object.fromEntries(counts.map((c) => [c.status, c._count._all])),
      can: abilities(user.permissions),
    });
  } catch (err) {
    return invError(err);
  }
}

/**
 * POST /api/sales/invoices — a manual invoice DRAFT (ZT-14). sales › invoices_create.
 * {…, issue: true, requestKey} — «حفظ وإصدار» (council ruling, BATCH 22 WP-C): for a holder of sales › invoices_issue only
 * (privileged + step-up, the issue's own gate): the draft is created under its request key and issued in the same
 * request (two transactions). 201 ISSUED; 409 NOT_READY keeps the draft and answers its id and problems (the screen
 * opens it with them listed); a replay of the same key answers the same invoice.
 */
export const maxDuration = 60;

export async function POST(request: Request) {
  const auth = await requireAuth();
  if (auth.error) return auth.error;
  let body: Record<string, unknown>;
  try { body = await jsonBody(request); } catch (err) { return invError(err); }
  const issueNow = body.issue === true;
  const { user, error } = issueNow ? await requireSub("sales", "invoices_issue") : await requireSub("sales", "invoices_create");
  if (error) return error;
  try {
    const customerId = typeof body.customerId === "string" ? body.customerId : "";
    if (!customerId) throw refuseInv("BAD_INPUT", "customerId.", "اختر العميل.");
    if (!(await inScope(user, customerId))) return NextResponse.json({ error: "غير موجود.", errorEn: "Not found.", code: "NOT_FOUND" }, { status: 404 });
    const requestKey = typeof body.requestKey === "string" && /^[A-Za-z0-9:_-]{8,80}$/.test(body.requestKey) ? `client:${user.id}:${body.requestKey}` : null;
    const input = {
      customerId, family: body.family === "SIMPLIFIED" ? "SIMPLIFIED" as const : "STANDARD" as const, lines: body.lines, buyer: body.buyer, supplyDate: body.supplyDate,
      supplyEndDate: body.supplyEndDate, paymentTermsDays: body.paymentTermsDays, notes: body.notes, requestKey,
      // A4: an invoice for an order of an external source (e.g. the Salla web shop, later): idempotent per order.
      channel: body.channel as string | null | undefined, externalOrderRef: body.externalOrderRef as string | null | undefined,
      // «الموقع» (WP-B): absent = the order's / the requester's default.
      branchId: body.branchId,
      canSellAssets: canSellAssets(user.permissions),
    };
    if (issueNow) {
      if (!requestKey) throw refuseInv("REQUEST_KEY_REQUIRED");
      const r = await saveAndIssue({ ...input, requestKey }, auditFromRequest(request, user.id, "save and issue"));
      if (r.state === "NOT_READY") {
        return NextResponse.json({ ...accountingErrorJson(refuseInv("NOT_READY")), id: r.id, kept: true, problems: r.problems }, { status: 409 });
      }
      const submission = await zatcaAfterIssue(r.issue, user.id);
      return NextResponse.json({ ...r.issue, id: r.id, replayed: r.replayed, zatcaSubmission: submission }, { status: r.replayed ? 200 : 201 });
    }
    const r = await createDraft(input, auditFromRequest(request, user.id, "invoice draft"));
    return NextResponse.json(r, { status: r.replayed ? 200 : 201 });
  } catch (err) {
    return invError(err);
  }
}

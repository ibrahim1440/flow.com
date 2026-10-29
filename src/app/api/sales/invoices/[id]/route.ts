import { NextResponse } from "@/lib/api-response";
import { prisma } from "@/lib/db";
import { forbidden, requireAuth, requireSub } from "@/lib/auth-server";
import { auditFromRequest } from "@/lib/accounting/audit";
import { jsonBody } from "@/lib/accounting/http";
import { postingRef } from "@/lib/accounting/posting-engine";
import { abilities, canCreditNote, canIssueInvoices, canSellAssets, canViewInvoices } from "@/lib/services/invoicing/access";
import { requestHistory } from "@/lib/services/invoicing/requests";
import { creditBadges } from "@/lib/services/customers/credit-db";
import { documentJson, inScope } from "@/lib/services/invoicing/http";
import { draftProblems, loadDocument, updateDraft } from "@/lib/services/invoicing/service";
import { invError } from "@/lib/services/invoicing/refusals";

type Ctx = { params: Promise<{ id: string }> };
const notFound = () => NextResponse.json({ error: "غير موجود.", errorEn: "Not found.", code: "NOT_FOUND" }, { status: 404 });

/** GET /api/sales/invoices/:id — the document, its lines, notes, AR applications and ledger entries. */
export async function GET(_request: Request, { params }: Ctx) {
  const { user, error } = await requireAuth();
  if (error) return error;
  if (!canViewInvoices(user.permissions)) return forbidden();
  try {
    const { id } = await params;
    const doc = await loadDocument(prisma, id);
    if (!doc || !(await inScope(user, doc.customerId))) return notFound();
    const entries = await prisma.journalEntry.findMany({
      where: { sourceModule: "sales", sourceId: id }, orderBy: { createdAt: "asc" },
      select: { id: true, postingYear: true, postingSeq: true, sourceEvent: true, status: true },
    });
    const [customer, order] = await Promise.all([
      prisma.customer.findUnique({ where: { id: doc.customerId }, select: { id: true, name: true, nameAr: true, accountOwnerId: true } }),
      doc.orderId ? prisma.order.findUnique({ where: { id: doc.orderId }, select: { id: true, orderNumber: true } }) : Promise.resolve(null),
    ]);
    const people = await prisma.employee.findMany({ where: { id: { in: [doc.createdById, doc.issuedById, doc.requestedById].filter((x): x is string => !!x) } }, select: { id: true, name: true } });
    const can = abilities(user.permissions);
    const history = await requestHistory(id);
    // «مراجعة وإصدار»: the issuer sees the customer's credit flags on the issue screen (issue never blocks on credit:
    // the supply has happened and the invoice is a legal duty).
    const credit = doc.status === "DRAFT" && can.issue ? (await creditBadges(prisma, [doc.customerId], new Date()))[doc.customerId] ?? null : null;
    return NextResponse.json({
      ...documentJson(doc, { entries: entries.map((e) => ({ id: e.id, ref: postingRef(e), event: e.sourceEvent, status: String(e.status) })) }),
      customer, order, people, history, credit,
      // What would stop the issue now (a draft only): warnings on a request, the list «حفظ وإصدار» lands on (NOT_READY).
      problems: doc.status === "DRAFT" ? await draftProblems(prisma, doc) : [],
      can: { ...can, self: doc.createdById === user.id, requester: doc.requestedById === user.id },
    });
  } catch (err) {
    return invError(err);
  }
}

/** PATCH /api/sales/invoices/:id — save a DRAFT (header and / or lines). An invoice: invoices_create; a note: invoices_credit_note. */
export async function PATCH(request: Request, { params }: Ctx) {
  const { id } = await params;
  const auth = await requireAuth();
  if (auth.error) return auth.error;
  const head = await prisma.salesInvoice.findUnique({ where: { id }, select: { kind: true, customerId: true, requestedAt: true } });
  if (!head) return notFound();
  // «طلب فاتورة ضريبية» (Q-F3): a requested draft is corrected by the issuer only (compliance fields; step-up like the
  // issue), never by its requester (REQUEST_LOCKED: withdraw it first).
  const requested = !!head.requestedAt;
  const { user, error } = head.kind !== "INVOICE" ? await requireSub("sales", "invoices_credit_note")
    : requested && canIssueInvoices(auth.user.permissions) ? await requireSub("sales", "invoices_issue") : await requireSub("sales", "invoices_create");
  if (error) return error;
  if (!(await inScope(user, head.customerId))) return notFound();
  try {
    const body = await jsonBody(request);
    const canIssue = head.kind === "INVOICE" ? canIssueInvoices(user.permissions) : canCreditNote(user.permissions);
    return NextResponse.json(await updateDraft(id, body, auditFromRequest(request, user.id, requested ? "accountant correction" : "edit draft"), { canIssue: requested && canIssue, canSellAssets: canSellAssets(user.permissions) }));
  } catch (err) {
    return invError(err);
  }
}

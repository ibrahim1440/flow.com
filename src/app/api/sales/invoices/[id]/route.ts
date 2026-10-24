import { NextResponse } from "@/lib/api-response";
import { prisma } from "@/lib/db";
import { forbidden, requireAuth, requireSub } from "@/lib/auth-server";
import { auditFromRequest } from "@/lib/accounting/audit";
import { jsonBody } from "@/lib/accounting/http";
import { postingRef } from "@/lib/accounting/posting-engine";
import { abilities, canViewInvoices } from "@/lib/services/invoicing/access";
import { documentJson, inScope } from "@/lib/services/invoicing/http";
import { loadDocument, updateDraft } from "@/lib/services/invoicing/service";
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
    const people = await prisma.employee.findMany({ where: { id: { in: [doc.createdById, doc.issuedById].filter((x): x is string => !!x) } }, select: { id: true, name: true } });
    return NextResponse.json({
      ...documentJson(doc, { entries: entries.map((e) => ({ id: e.id, ref: postingRef(e), event: e.sourceEvent, status: String(e.status) })) }),
      customer, order, people, can: { ...abilities(user.permissions), self: doc.createdById === user.id },
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
  const head = await prisma.salesInvoice.findUnique({ where: { id }, select: { kind: true, customerId: true } });
  if (!head) return notFound();
  const { user, error } = head.kind === "INVOICE" ? await requireSub("sales", "invoices_create") : await requireSub("sales", "invoices_credit_note");
  if (error) return error;
  if (!(await inScope(user, head.customerId))) return notFound();
  try {
    const body = await jsonBody(request);
    return NextResponse.json(await updateDraft(id, body, auditFromRequest(request, user.id, "edit draft")));
  } catch (err) {
    return invError(err);
  }
}

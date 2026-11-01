import { NextResponse } from "@/lib/api-response";
import { prisma } from "@/lib/db";
import { forbidden, requireAuth } from "@/lib/auth-server";
import { canAr, canIssueInvoices, canViewInvoices } from "@/lib/services/invoicing/access";
import { inScope } from "@/lib/services/invoicing/http";
import { invError } from "@/lib/services/invoicing/refusals";
import { QOYOD_PDF_MAX_BYTES, isInternalCopy, pilotActive } from "@/lib/services/invoicing/qoyod-math";
import { qoyodCopyView, qoyodPilotUntil, uploadQoyodCopy } from "@/lib/services/invoicing/qoyod-copy";
import { riyadhDay } from "@/lib/services/sales/quick-deal";

type Ctx = { params: Promise<{ id: string }> };
const notFound = () => NextResponse.json({ error: "غير موجود.", errorEn: "Not found.", code: "NOT_FOUND" }, { status: 404 });
/** Who attaches Qoyod's PDF: the issuer (sales › invoices_issue) or the AR accountant (accounting › ar). */
const canAttach = (p: Parameters<typeof canAr>[0]) => canIssueInvoices(p) || canAr(p);

/**
 * GET /api/sales/invoices/:id/qoyod — «فاتورة قيود» of the document (never the bytes), the pilot state, and what the
 * viewer may do. Who: the document's viewers, in their customer scope.
 */
export async function GET(_request: Request, { params }: Ctx) {
  const { user, error } = await requireAuth();
  if (error) return error;
  if (!canViewInvoices(user.permissions)) return forbidden();
  try {
    const { id } = await params;
    const doc = await prisma.salesInvoice.findUnique({ where: { id }, select: { id: true, status: true, issueDate: true, customerId: true } });
    if (!doc || !(await inScope(user, doc.customerId))) return notFound();
    const until = await qoyodPilotUntil();
    return NextResponse.json({
      pilot: { until: until ? until.toISOString().slice(0, 10) : null, active: pilotActive(until, riyadhDay(new Date())), internalCopy: isInternalCopy(doc, until) },
      copy: await qoyodCopyView(prisma, id),
      can: { attach: canAttach(user.permissions) && doc.status === "ISSUED", send: doc.status === "ISSUED" },
    }, { headers: { "Cache-Control": "no-store" } });
  } catch (err) {
    return invError(err);
  }
}

/** POST /api/sales/invoices/:id/qoyod — multipart: `file` (Qoyod's PDF) and `qoyodNumber`. Attach or replace. */
export async function POST(request: Request, { params }: Ctx) {
  const { user, error } = await requireAuth();
  if (error) return error;
  if (!canAttach(user.permissions)) return forbidden();
  try {
    const { id } = await params;
    const head = await prisma.salesInvoice.findUnique({ where: { id }, select: { customerId: true } });
    if (!head || !(await inScope(user, head.customerId))) return notFound();
    const form = await request.formData().catch(() => null);
    const file = form?.get("file");
    if (!form || !(file instanceof File)) return NextResponse.json({ error: "أرفق ملف PDF.", errorEn: "Attach the PDF in the `file` field.", code: "NO_FILE" }, { status: 400 });
    if (file.size > QOYOD_PDF_MAX_BYTES) return NextResponse.json({ error: "حجم الملف أكبر من 5 ميغابايت.", errorEn: "The file is larger than 5 MB.", code: "TOO_LARGE" }, { status: 413 });
    const bytes = Buffer.from(await file.arrayBuffer());
    const r = await prisma.$transaction((tx) => uploadQoyodCopy(tx, { invoiceId: id, qoyodNumber: form.get("qoyodNumber"), fileName: file.name, bytes, actorId: user.id }));
    return NextResponse.json(r, { status: r.replayed ? 200 : 201 });
  } catch (err) {
    return invError(err);
  }
}

import { NextResponse } from "@/lib/api-response";
import { prisma } from "@/lib/db";
import { forbidden, requireAuth } from "@/lib/auth-server";
import { documentPrintGate } from "@/lib/print/server/auth";
import { canViewInvoices } from "@/lib/services/invoicing/access";
import { documentJson, inScope } from "@/lib/services/invoicing/http";
import { loadDocument } from "@/lib/services/invoicing/service";
import { sellerSnapshot } from "@/lib/services/invoicing/settings";
import { astTimestamp, phase1QrPayload } from "@/lib/services/invoicing/qr";
import { invError } from "@/lib/services/invoicing/refusals";

export const dynamic = "force-dynamic";
const ID = /^[A-Za-z0-9_-]{1,64}$/;
const notFound = () => NextResponse.json({ error: "Not found.", errorAr: "غير موجود.", code: "NOT_FOUND" }, { status: 404 });

/**
 * GET /api/print/documents/invoice?id=<invoice id> — the data of the printed tax invoice / credit / debit note (ZT-04,
 * ZT-05, ZT-06a/b). An ISSUED document prints its frozen snapshot (E-4) with a Phase-1 QR (tags 1–5) computed from
 * it — A4 replaces it with the Phase-2 QR; a DRAFT prints as «معاينة · ليست فاتورة» (ZT-02): no number, no QR, the
 * seller as it stands. Who: invoices viewers, in their customer scope. The document gate (PRINT_DOCUMENTS_ENABLED)
 * applies as for every A4 document. Order: 401 → 403 → 409 DOCUMENT_PRINTING_DISABLED → 400 → 404.
 */
export async function GET(request: Request) {
  const { user, error } = await requireAuth();
  if (error) return error;
  if (!canViewInvoices(user.permissions)) return forbidden();
  const gated = documentPrintGate();
  if (gated) return gated;
  const id = new URL(request.url).searchParams.get("id") ?? "";
  if (!ID.test(id)) return NextResponse.json({ error: "حدد الفاتورة.", errorEn: "Give the invoice id.", code: "INVALID_ID" }, { status: 400 });
  try {
    const doc = await loadDocument(prisma, id);
    if (!doc || !(await inScope(user, doc.customerId))) return notFound();
    const json = documentJson(doc);
    const seller = (doc.seller as Record<string, unknown> | null) ?? (await sellerSnapshot(prisma));
    let qr: string | null = null;
    // A4 — an e-invoice prints its Phase-2 QR (tags 1–9; a standard document's once CLEARED, from ZATCA's cleared
    // copy). A standard document that is not cleared yet is not for the customer: no QR, and the page says so. A
    // sandbox / simulation document prints as a test copy («نسخة اختبار · غير صالحة للعميل», ZT-03).
    const ze = doc.zatcaXmlRef ? await prisma.zatcaDocument.findUnique({ where: { id: doc.zatcaXmlRef }, select: { environment: true, status: true, flow: true, icv: true } }) : null;
    const cleared = !!ze && ["CLEARED", "CLEARED_WITH_WARNINGS"].includes(ze.status);
    const notShareable = !!ze && ze.flow === "CLEARANCE" && !cleared;
    if (doc.status === "ISSUED" && doc.issueDate && doc.issueTime && !notShareable) {
      qr = doc.zatcaQr ?? phase1QrPayload({
        sellerName: String(seller.name ?? ""), vatNumber: String(seller.vatNumber ?? ""),
        timestamp: astTimestamp(json.issueDate!, doc.issueTime), total: json.totals.grand, vat: json.totals.tax,
      });
    }
    const order = doc.orderId ? await prisma.order.findUnique({ where: { id: doc.orderId }, select: { orderNumber: true } }) : null;
    const zatca = ze ? { environment: ze.environment, status: ze.status, flow: ze.flow, icv: ze.icv.toString(), cleared, notShareable, testCopy: ze.environment !== "PRODUCTION" } : null;
    return NextResponse.json({ ...json, seller, qr, qrPhase: doc.zatcaQr && !notShareable ? 2 : qr ? 1 : null, zatca, orderNumber: order?.orderNumber ?? null }, { headers: { "Cache-Control": "no-store" } });
  } catch (err) {
    return invError(err);
  }
}

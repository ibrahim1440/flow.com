import { NextResponse } from "@/lib/api-response";
import { forbidden, requireAuth } from "@/lib/auth-server";
import { prisma } from "@/lib/db";
import { canViewInvoices } from "@/lib/services/invoicing/access";
import { inScope } from "@/lib/services/invoicing/http";
import { canZatcaXml } from "@/lib/zatca/access";
import { zatcaError } from "@/lib/zatca/refusals";

export const dynamic = "force-dynamic";
type Ctx = { params: Promise<{ id: string }> };

/**
 * GET /api/sales/invoices/:id/zatca/xml?kind=signed|cleared — the e-invoice file exactly as stored (the signed bytes,
 * or the cleared XML as ZATCA returned it), as an attachment. accounting › zatca_xml AND the invoice in the viewer's
 * scope. Never re-serialized.
 */
export async function GET(request: Request, { params }: Ctx) {
  const { id } = await params;
  const { user, error } = await requireAuth();
  if (error) return error;
  if (!canZatcaXml(user.permissions) || !canViewInvoices(user.permissions)) return forbidden();
  try {
    const kind = new URL(request.url).searchParams.get("kind") === "cleared" ? "cleared" : "signed";
    const inv = await prisma.salesInvoice.findUnique({ where: { id }, select: { customerId: true, number: true, zatcaXmlRef: true } });
    if (!inv || !inv.zatcaXmlRef || !(await inScope(user, inv.customerId))) return NextResponse.json({ error: "غير موجود.", errorEn: "Not found.", code: "NOT_FOUND" }, { status: 404 });
    const d = await prisma.zatcaDocument.findUnique({ where: { id: inv.zatcaXmlRef }, select: { signedXml: true, clearedXml: true, signedXmlSha256: true, clearedXmlSha256: true } });
    const bytes = kind === "cleared" ? d?.clearedXml : d?.signedXml;
    if (!bytes) return NextResponse.json({ error: "لا توجد نسخة معتمدة من الهيئة لهذا المستند.", errorEn: "No cleared copy for this document.", code: "NOT_FOUND" }, { status: 404 });
    const name = `${(inv.number ?? id).replace(/[^A-Za-z0-9_-]/g, "_")}-${kind}.xml`;
    return new Response(Buffer.from(bytes), {
      status: 200,
      headers: {
        "Content-Type": "application/xml; charset=utf-8", "Content-Disposition": `attachment; filename="${name}"`, "Cache-Control": "no-store",
        "X-Content-SHA256": (kind === "cleared" ? d?.clearedXmlSha256 : d?.signedXmlSha256) ?? "",
      },
    });
  } catch (err) {
    return zatcaError(err);
  }
}

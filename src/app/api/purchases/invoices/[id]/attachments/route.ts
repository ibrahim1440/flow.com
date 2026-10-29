import { NextResponse } from "@/lib/api-response";
import { prisma } from "@/lib/db";
import { acctError } from "@/lib/accounting/http";
import { requireApRead, requireDraftWriter } from "@/lib/accounting/ops/http";
import { addInvoiceAttachment, cleanAttachment, invoiceAttachments } from "@/lib/accounting/ops/attachments";
import { opsRefuse } from "@/lib/accounting/ops/refusals";
import { logPurchaseActivity } from "@/lib/accounting/ops/purchase-activity";
import { auditFromRequest } from "@/lib/accounting/audit";

type Params = { params: Promise<{ id: string }> };

/** «المرفقات» of a purchase invoice (WP-H): GET the list (metadata; the AP read gate). */
export async function GET(_request: Request, { params }: Params) {
  const { error } = await requireApRead();
  if (error) return error;
  try {
    const id = (await params).id;
    if (!(await prisma.supplierInvoice.count({ where: { id } }))) throw opsRefuse("OPS_NOT_FOUND");
    return NextResponse.json({ attachments: await invoiceAttachments(prisma, id) });
  } catch (err) {
    return acctError(err);
  }
}

/** POST multipart { file } — attach a receipt (JPEG / PNG / PDF ≤ 10 MB, by its signature). The draft writer gate; any state but cancelled. */
export async function POST(request: Request, { params }: Params) {
  const { user, error } = await requireDraftWriter();
  if (error) return error;
  try {
    const id = (await params).id;
    let form: FormData;
    try { form = await request.formData(); } catch { throw opsRefuse("SIMPLE_ATTACHMENT"); }
    const f = form.get("file");
    const file = f && typeof f === "object" && "arrayBuffer" in f ? { bytes: new Uint8Array(await (f as File).arrayBuffer()), fileName: (f as File).name } : null;
    const a = cleanAttachment(file);
    const ctx = auditFromRequest(request, user.id, "purchase invoice attachment");
    const row = await prisma.$transaction(async (tx) => {
      const inv = await tx.supplierInvoice.findUnique({ where: { id }, select: { status: true } });
      if (!inv) throw opsRefuse("OPS_NOT_FOUND");
      if (inv.status === "CANCELLED") throw opsRefuse("INVOICE_STATE");
      const r = await addInvoiceAttachment(tx, id, a, user.id);
      await logPurchaseActivity(tx, ctx, "PURCHASE_INVOICE_SAVED", id, { attachment: { id: r.id, fileName: a.fileName, sizeBytes: a.sizeBytes, sha256: a.sha256 } });
      return r;
    });
    return NextResponse.json(row, { status: 201 });
  } catch (err) {
    return acctError(err);
  }
}

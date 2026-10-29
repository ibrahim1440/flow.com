import { NextResponse } from "@/lib/api-response";
import { acctError } from "@/lib/accounting/http";
import { auditFromRequest } from "@/lib/accounting/audit";
import { requireApRead, requireDraftWriter } from "@/lib/accounting/ops/http";
import { invoiceAttachment, removeInvoiceAttachment } from "@/lib/accounting/ops/attachments";

type Params = { params: Promise<{ id: string; attachmentId: string }> };

/** The attachment's bytes (the AP read gate), never cached; the type is the one its signature proved at upload. */
export async function GET(_request: Request, { params }: Params) {
  const { error } = await requireApRead();
  if (error) return error;
  try {
    const { id, attachmentId } = await params;
    const a = await invoiceAttachment(id, attachmentId);
    return new NextResponse(new Uint8Array(a.content), { headers: {
      "Content-Type": a.contentType, "Content-Length": String(a.sizeBytes), "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff",
      "Content-Disposition": `inline; filename*=UTF-8''${encodeURIComponent(a.fileName)}`,
    } });
  } catch (err) {
    return acctError(err);
  }
}

/** Remove an attachment of an invoice that is not posted (a simple invoice keeps one). The draft writer gate. */
export async function DELETE(request: Request, { params }: Params) {
  const { user, error } = await requireDraftWriter();
  if (error) return error;
  try {
    const { id, attachmentId } = await params;
    return NextResponse.json(await removeInvoiceAttachment(id, attachmentId, auditFromRequest(request, user.id, "remove invoice attachment")));
  } catch (err) {
    return acctError(err);
  }
}

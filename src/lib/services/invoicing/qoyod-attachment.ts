// «فاتورة قيود» — the senders' read of a queued message's PDF (WhatsApp file, e-mail attachment), at send time: only
// while the copy is still the message's own document's and that document is still issued. Kept apart from the service
// (qoyod-copy.ts imports the e-mail queue, which imports this).
import { prisma } from "@/lib/db";

/** For the senders: the PDF of a queued message, only while it is still this document's and the document is issued. */
export async function qoyodAttachmentFor(refId: string | null, subjectType: string | null, subjectId: string | null) {
  if (!refId || subjectType !== "SalesInvoice" || !subjectId) return null;
  const c = await prisma.salesInvoiceQoyod.findUnique({
    where: { id: refId },
    select: { invoiceId: true, filename: true, mimeType: true, checksum: true, content: true, invoice: { select: { customerId: true, status: true } } },
  });
  if (!c || c.invoiceId !== subjectId || c.invoice.status !== "ISSUED") return null;
  return { content: Buffer.from(c.content), filename: c.filename, mimeType: c.mimeType, checksum: c.checksum, customerId: c.invoice.customerId };
}


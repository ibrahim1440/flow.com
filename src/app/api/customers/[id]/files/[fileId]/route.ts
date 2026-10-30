import { NextResponse } from "@/lib/api-response";
import { prisma } from "@/lib/db";
import { requireEdit, requireModule } from "@/lib/auth-server";
import { handleDomainError } from "@/lib/api-error";
import { customerFileHeaders, deleteCustomerFileBlobs, openCustomerFile } from "@/lib/services/customers/files";
import { editableCustomer } from "@/lib/services/customers/direct-upload";
import { customerInScope } from "@/lib/services/sales/customer-access";

type Params = { params: Promise<{ id: string; fileId: string }> };

/**
 * GET /api/customers/[id]/files/[fileId] — the document itself, the only route that returns the
 * bytes. The file is matched against its customer in the same query (an id from another
 * customer returns nothing), and served `attachment`, `nosniff`, sandboxed and `no-store`. Bytes in
 * the row, or the private blob STREAMED through here (the browser never gets a Blob URL); a blob
 * that cannot be read is a clear Arabic 502, reported as a storage incident.
 */
export async function GET(_req: Request, { params }: Params) {
  const { user, error } = await requireModule("customers");
  if (error) return error;
  const { id, fileId } = await params;
  // A scoped sales rep reaches only the customers in their own book (services/sales/scope.ts) — 404 otherwise.
  if (!(await customerInScope(user, id))) return NextResponse.json({ error: "Not found" }, { status: 404 });
  try {
    const row = await prisma.customerFile.findFirst({
      where: { id: fileId, customerId: id },
      select: { fileName: true, mimeType: true, sizeBytes: true, content: true, blobPathname: true },
    });
    if (!row) return NextResponse.json({ error: "الملف غير موجود.", errorEn: "Not found" }, { status: 404 });
    const opened = await openCustomerFile(prisma, row);
    if (!opened.ok) return NextResponse.json({ error: opened.error, errorEn: opened.errorEn, code: opened.code }, { status: opened.status });
    return new Response(opened.body, { status: 200, headers: customerFileHeaders(row) });
  } catch (err) {
    return handleDomainError(err);
  }
}

/** DELETE /api/customers/[id]/files/[fileId] — remove a document (customers at edit; a scoped rep only on their own customer). */
export async function DELETE(_req: Request, { params }: Params) {
  const { user, error } = await requireEdit("customers");
  if (error) return error;
  const { id, fileId } = await params;
  try {
    // The same ownership scope as the uploads: a scoped sales rep only on a customer they own (404).
    const may = await editableCustomer(prisma, user, id);
    if (!may.ok) return NextResponse.json({ error: may.problem.error, errorEn: may.problem.errorEn, code: may.problem.code }, { status: may.problem.status });
    const row = await prisma.customerFile.findFirst({ where: { id: fileId, customerId: id }, select: { id: true, blobPathname: true } });
    const gone = row ? await prisma.customerFile.deleteMany({ where: { id: row.id, customerId: id } }) : { count: 0 };
    if (!row || gone.count === 0) return NextResponse.json({ error: "الملف غير موجود.", errorEn: "Not found" }, { status: 404 });
    // The blob after the row: a failed delete leaves an unreachable private blob (and an alert).
    await deleteCustomerFileBlobs(prisma, [row.blobPathname]);
    return NextResponse.json({ deleted: true });
  } catch (err) {
    return handleDomainError(err);
  }
}

import { NextResponse } from "@/lib/api-response";
import { prisma } from "@/lib/db";
import { requireEdit, requireModule } from "@/lib/auth-server";
import { handleDomainError } from "@/lib/api-error";
import { customerFileHeaders } from "@/lib/services/customers/files";

type Params = { params: Promise<{ id: string; fileId: string }> };

/**
 * GET /api/customers/[id]/files/[fileId] — the document itself, the only route that returns the
 * bytes. The file is matched against its customer in the same query (an id from another
 * customer returns nothing), and served `attachment`, `nosniff`, sandboxed and `no-store`.
 */
export async function GET(_req: Request, { params }: Params) {
  const { error } = await requireModule("customers");
  if (error) return error;
  const { id, fileId } = await params;
  try {
    const row = await prisma.customerFile.findFirst({
      where: { id: fileId, customerId: id },
      select: { fileName: true, mimeType: true, sizeBytes: true, content: true },
    });
    if (!row) return NextResponse.json({ error: "الملف غير موجود.", errorEn: "Not found" }, { status: 404 });
    return new Response(new Uint8Array(row.content), { status: 200, headers: customerFileHeaders(row) });
  } catch (err) {
    return handleDomainError(err);
  }
}

/** DELETE /api/customers/[id]/files/[fileId] — remove a document (customers at edit). */
export async function DELETE(_req: Request, { params }: Params) {
  const { error } = await requireEdit("customers");
  if (error) return error;
  const { id, fileId } = await params;
  try {
    const gone = await prisma.customerFile.deleteMany({ where: { id: fileId, customerId: id } });
    if (gone.count === 0) return NextResponse.json({ error: "الملف غير موجود.", errorEn: "Not found" }, { status: 404 });
    return NextResponse.json({ deleted: true });
  } catch (err) {
    return handleDomainError(err);
  }
}

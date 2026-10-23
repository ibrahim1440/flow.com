import { after } from "next/server";
import { NextResponse } from "@/lib/api-response";
import { prisma } from "@/lib/db";
import { requireEdit } from "@/lib/auth-server";
import { handleDomainError } from "@/lib/api-error";
import { editableCustomer, maybeSweepOrphans, prepareDirectUpload } from "@/lib/services/customers/direct-upload";

type Params = { params: Promise<{ id: string }> };

/**
 * POST /api/customers/[id]/files/direct — step 1 of a direct browser-to-Blob upload (a file over
 * 4 MB, up to 20 MB): JSON `{ fileName, size, contentType, category, title }` → one upload slot
 * `{ uploadId, pathname, contentType, maxBytes, handleUploadUrl }` (services/customers/direct-upload*).
 * Customers at edit, the rep ownership scope, never a station. The pathname is a private store's
 * key, not a URL anyone can download from; downloads still stream through …/files/[fileId].
 */
export async function POST(request: Request, { params }: Params) {
  const { user, error } = await requireEdit("customers");
  if (error) return error;
  const { id } = await params;
  try {
    const may = await editableCustomer(prisma, user, id);
    if (!may.ok) return NextResponse.json({ error: may.problem.error, errorEn: may.problem.errorEn, code: may.problem.code }, { status: may.problem.status });
    const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
    if (!body || typeof body !== "object") return NextResponse.json({ error: "طلب غير صالح.", errorEn: "Invalid request." }, { status: 400 });
    const r = await prepareDirectUpload(prisma, {
      customerId: id, fileCount: may.customer.fileCount, userId: user.id,
      fileName: body.fileName, size: body.size, contentType: body.contentType, category: body.category, title: body.title,
    });
    after(() => maybeSweepOrphans(prisma));
    if (!r.ok) return NextResponse.json({ error: r.problem.error, errorEn: r.problem.errorEn, code: r.problem.code }, { status: r.problem.status });
    return NextResponse.json({ ...r.slot, handleUploadUrl: `/api/customers/${encodeURIComponent(id)}/files/direct/token` }, { status: 201 });
  } catch (err) {
    return handleDomainError(err);
  }
}

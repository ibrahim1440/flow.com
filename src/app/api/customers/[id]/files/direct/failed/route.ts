import { NextResponse } from "@/lib/api-response";
import { prisma } from "@/lib/db";
import { requireEdit } from "@/lib/auth-server";
import { handleDomainError } from "@/lib/api-error";
import { editableCustomer, reportDirectUploadFailure } from "@/lib/services/customers/direct-upload";
import { FAILURE_REASONS, type FailureReason } from "@/lib/services/customers/direct-upload-rules";

type Params = { params: Promise<{ id: string }> };

/**
 * POST /api/customers/[id]/files/direct/failed — `{ uploadId, reason }` when the browser's upload to
 * Blob failed. The server checks the store itself before believing an outage: the store does not
 * answer → the existing storage incident (UPLOAD_FAILED, refused — services/system/storage-alerts)
 * and 503 STORAGE_UNAVAILABLE in Arabic (no database fallback over 4 MB); it answers and the blob is
 * there → 200 `{ uploaded: true }` (finalize it); it answers and the blob is not → 409 NETWORK.
 */
export async function POST(request: Request, { params }: Params) {
  const { user, error } = await requireEdit("customers");
  if (error) return error;
  const { id } = await params;
  try {
    const may = await editableCustomer(prisma, user, id);
    if (!may.ok) return NextResponse.json({ error: may.problem.error, errorEn: may.problem.errorEn, code: may.problem.code }, { status: may.problem.status });
    const body = (await request.json().catch(() => null)) as { uploadId?: unknown; reason?: unknown } | null;
    const uploadId = typeof body?.uploadId === "string" ? body.uploadId : "";
    const reason = (FAILURE_REASONS as readonly string[]).includes(String(body?.reason)) ? (body!.reason as FailureReason) : "OTHER";
    if (!/^cf[0-9a-f]{24}$/.test(uploadId)) return NextResponse.json({ error: "طلب غير صالح.", errorEn: "Invalid request." }, { status: 400 });
    const r = await reportDirectUploadFailure(prisma, { customerId: id, uploadId, actorId: user.id, reason });
    if (!r.ok) return NextResponse.json({ error: r.problem.error, errorEn: r.problem.errorEn, code: r.problem.code }, { status: r.problem.status });
    return NextResponse.json({ uploaded: true });
  } catch (err) {
    return handleDomainError(err);
  }
}

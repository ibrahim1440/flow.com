import { after } from "next/server";
import { NextResponse } from "@/lib/api-response";
import { prisma } from "@/lib/db";
import { requireEdit } from "@/lib/auth-server";
import { handleDomainError } from "@/lib/api-error";
import { editableCustomer, finalizeDirectUpload, maybeSweepOrphans } from "@/lib/services/customers/direct-upload";

type Params = { params: Promise<{ id: string }> };

/**
 * POST /api/customers/[id]/files/direct/finalize — `{ uploadId }` after the browser's upload. The
 * server checks the blob with its own credentials (head: exists, ≤ 20 MB, the declared size, an
 * allowed type), reads it once (SHA-256 + magic bytes — the type is the bytes'), and creates the
 * CustomerFile row; a blob that fails is deleted and refused. Idempotent: the same upload never makes
 * two rows — a repeat answers 200 with the row already made (`duplicate: true`). Same gates as the
 * upload; the response never carries the pathname or a Blob URL.
 */
export async function POST(request: Request, { params }: Params) {
  const { user, error } = await requireEdit("customers");
  if (error) return error;
  const { id } = await params;
  try {
    const may = await editableCustomer(prisma, user, id);
    if (!may.ok) return NextResponse.json({ error: may.problem.error, errorEn: may.problem.errorEn, code: may.problem.code }, { status: may.problem.status });
    const body = (await request.json().catch(() => null)) as { uploadId?: unknown } | null;
    const uploadId = typeof body?.uploadId === "string" ? body.uploadId : "";
    if (!/^cf[0-9a-f]{24}$/.test(uploadId)) return NextResponse.json({ error: "طلب غير صالح.", errorEn: "Invalid request." }, { status: 400 });
    const r = await finalizeDirectUpload(prisma, { customerId: id, uploadId, actorId: user.id });
    after(() => maybeSweepOrphans(prisma));
    if (!r.ok) return NextResponse.json({ error: r.problem.error, errorEn: r.problem.errorEn, code: r.problem.code }, { status: r.problem.status });
    return NextResponse.json({ ...r.row, storage: "blob", fallback: false, duplicate: r.duplicate }, { status: r.duplicate ? 200 : 201 });
  } catch (err) {
    return handleDomainError(err);
  }
}

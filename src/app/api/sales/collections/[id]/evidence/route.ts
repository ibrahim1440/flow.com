import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { requireModule, requireAnyModule } from "@/lib/auth-server";
import { handleDomainError } from "@/lib/api-error";
import { collectionWhere } from "@/lib/services/sales/scope";
import {
  validateEvidence, MAX_EVIDENCE_BYTES, ALLOWED_EVIDENCE_LABEL,
} from "@/lib/services/sales/evidence";

type Params = { params: Promise<{ id: string }> };

/**
 * Evidence for a collection: the list, and uploading one.
 *
 * Visibility is the collection's own. There is no separate "can read evidence" check that
 * could be granted without it, because that combination — reading the proof of a receipt
 * you are not allowed to see — has no use and one obvious abuse.
 *
 * There is no public URL for any of this, here or anywhere: the bytes come back only from
 * the download route below, only to a caller who passes the same visibility check, and
 * never with a cacheable response.
 */

/** GET — the metadata only. Never the bytes; those have their own route and their own headers. */
export async function GET(_request: Request, { params }: Params) {
  // Finance holds no sales module, and cannot verify a receipt they cannot open.
  const { user, error } = await requireAnyModule("sales", "commissions");
  if (error) return error;

  const { id } = await params;

  try {
    const collection = await prisma.salesCollection.findFirst({
      where: { id, ...collectionWhere(user.permissions, user.id) },
      select: {
        id: true,
        evidence: {
          orderBy: { uploadedAt: "asc" },
          select: {
            id: true, filename: true, mimeType: true, byteSize: true, checksum: true,
            uploadedAt: true, uploadedBy: { select: { id: true, name: true } },
          },
        },
      },
    });
    // 404 rather than 403: confirming the collection exists tells an unauthorised caller
    // that somebody recorded money against a deal they cannot see.
    if (!collection) return NextResponse.json({ error: "Not found." }, { status: 404 });

    return NextResponse.json({ evidence: collection.evidence });
  } catch (err) {
    return handleDomainError(err);
  }
}

/**
 * POST — attach a file.
 *
 * Only to a collection still awaiting verification, and only by the person who submitted
 * it. Evidence added after Finance has decided would change what a decision was made
 * against, which is the one thing an audit trail exists to prevent.
 */
export async function POST(request: Request, { params }: Params) {
  const { user, error } = await requireModule("sales");
  if (error) return error;

  const { id } = await params;

  try {
    const collection = await prisma.salesCollection.findFirst({
      where: { id, ...collectionWhere(user.permissions, user.id) },
      select: { id: true, status: true, submittedById: true },
    });
    if (!collection) return NextResponse.json({ error: "Not found." }, { status: 404 });

    if (collection.submittedById !== user.id) {
      return NextResponse.json(
        { error: "Only the person who recorded this collection can attach evidence to it." },
        { status: 403 },
      );
    }
    if (collection.status !== "PENDING_VERIFICATION") {
      return NextResponse.json(
        {
          error:
            "This collection has already been decided. Evidence cannot be added to it, " +
            "because that would change what the decision was made against.",
        },
        { status: 409 },
      );
    }

    const form = await request.formData().catch(() => null);
    const file = form?.get("file");
    if (!form || !(file instanceof File)) {
      return NextResponse.json({ error: "Attach a file in the `file` field." }, { status: 400 });
    }
    // Checked before reading the whole thing into memory. A declared length is not proof,
    // but refusing an obviously oversized upload early is cheaper than buffering it.
    if (file.size > MAX_EVIDENCE_BYTES) {
      return NextResponse.json(
        { error: `Evidence is limited to ${MAX_EVIDENCE_BYTES / (1024 * 1024)} MB.` },
        { status: 413 },
      );
    }

    const bytes = new Uint8Array(await file.arrayBuffer());
    const checked = validateEvidence(bytes, file.name);
    if (!checked.ok) {
      return NextResponse.json(
        { error: checked.problem.message, allowed: ALLOWED_EVIDENCE_LABEL },
        { status: checked.problem.code === "TOO_LARGE" ? 413 : 415 },
      );
    }

    const saved = await prisma.collectionEvidence.create({
      data: {
        collectionId: collection.id,
        filename: checked.value.filename,
        mimeType: checked.value.mimeType,
        byteSize: checked.value.byteSize,
        checksum: checked.value.checksum,
        content: new Uint8Array(checked.value.content),
        uploadedById: user.id,
      },
      // Never the content. This response is logged by things we do not control.
      select: { id: true, filename: true, mimeType: true, byteSize: true, uploadedAt: true },
    });

    return NextResponse.json({ evidence: saved }, { status: 201 });
  } catch (err) {
    return handleDomainError(err);
  }
}

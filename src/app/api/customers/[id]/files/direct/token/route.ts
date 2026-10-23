import { generateKeyPairSync } from "node:crypto";
import { handleUploadPresigned, type HandleUploadPresignedBody } from "@vercel/blob/client";
import { NextResponse } from "@/lib/api-response";
import { prisma } from "@/lib/db";
import { requireEdit } from "@/lib/auth-server";
import { handleDomainError } from "@/lib/api-error";
import { editableCustomer, finalizeDirectUpload, issueDirectUploadToken } from "@/lib/services/customers/direct-upload";

type Params = { params: Promise<{ id: string }> };

// handleUploadPresigned refuses to run without a webhook public key, even to issue a URL. Off Vercel
// (local builds, the mock store) there is none: a throwaway key whose private half is never kept, so
// no callback can ever verify against it.
let throwaway: string | null = null;
const webhookKey = () => process.env.BLOB_WEBHOOK_PUBLIC_KEY?.trim()
  || (throwaway ??= generateKeyPairSync("ed25519").publicKey.export({ type: "spki", format: "pem" }).toString());
/** The upload-completed callback is requested only where Vercel can reach us and sign it. */
const wantsCallback = () => process.env.VERCEL === "1" && !!process.env.BLOB_WEBHOOK_PUBLIC_KEY?.trim();

/**
 * POST /api/customers/[id]/files/direct/token — the @vercel/blob/client `uploadPresigned()`
 * handleUploadUrl (@vercel/blob 2.8.2 handleUploadPresigned).
 *
 *   blob.generate-presigned-url  a presigned PUT for ONE live upload slot's exact pathname, issued
 *                                with the server's OIDC credentials (issueSignedToken): put only,
 *                                PDF / JPEG / PNG, ≤ 20 MB, valid ≤ 10 minutes, no random suffix, no
 *                                overwrite. Customers at edit, the rep ownership scope, the slot's
 *                                own requester; never a station session.
 *   blob.upload-completed        Vercel's callback, verified with BLOB_WEBHOOK_PUBLIC_KEY (Ed25519)
 *                                by the SDK — no session; it runs the same idempotent finalize. The
 *                                browser's own finalize call stays the source of truth.
 */
export async function POST(request: Request, { params }: Params) {
  const { id } = await params;
  const body = (await request.json().catch(() => null)) as HandleUploadPresignedBody | null;
  if (!body || typeof body !== "object" || typeof body.type !== "string") {
    return NextResponse.json({ error: "طلب غير صالح.", errorEn: "Invalid request." }, { status: 400 });
  }
  try {
    if (body.type === "blob.upload-completed") {
      // The SDK calls onUploadCompleted only once the signature verified; anything thrown before that is a refusal.
      let verified = false;
      const r = await handleUploadPresigned({
        body, request, webhookPublicKey: webhookKey(),
        getSignedToken: async () => { throw new Error("not a token request"); },
        onUploadCompleted: async ({ tokenPayload }) => {
          verified = true;
          if (tokenPayload) await finalizeDirectUpload(prisma, { customerId: id, uploadId: tokenPayload, actorId: null });
        },
      }).catch((e) => { if (verified) throw e; return null; });
      if (!r) return NextResponse.json({ error: "توقيع الإشعار غير صالح.", errorEn: "Invalid callback signature." }, { status: 401 });
      return NextResponse.json(r);
    }
    if (body.type !== "blob.generate-presigned-url") return NextResponse.json({ error: "طلب غير صالح.", errorEn: "Invalid request." }, { status: 400 });

    const { user, error } = await requireEdit("customers");
    if (error) return error;
    const may = await editableCustomer(prisma, user, id);
    if (!may.ok) return NextResponse.json({ error: may.problem.error, errorEn: may.problem.errorEn, code: may.problem.code }, { status: may.problem.status });
    if (body.payload?.multipart) return NextResponse.json({ error: "طلب غير صالح.", errorEn: "Multipart uploads are not offered." }, { status: 400 });
    const issued = await issueDirectUploadToken(prisma, { customerId: id, userId: user.id, pathname: String(body.payload?.pathname ?? "") });
    if (!issued.ok) return NextResponse.json({ error: issued.problem.error, errorEn: issued.problem.errorEn, code: issued.problem.code }, { status: issued.problem.status });
    const callback = wantsCallback();
    const r = await handleUploadPresigned({
      body, request, webhookPublicKey: webhookKey(),
      getSignedToken: async () => ({ token: issued.token, urlOptions: { ...issued.urlOptions, ...(callback ? { tokenPayload: issued.slotId } : {}) } }),
      ...(callback ? { onUploadCompleted: async () => undefined } : {}),
    });
    return NextResponse.json(r);
  } catch (err) {
    return handleDomainError(err);
  }
}

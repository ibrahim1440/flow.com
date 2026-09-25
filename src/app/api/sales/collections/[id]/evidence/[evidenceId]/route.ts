import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { requireModule } from "@/lib/auth-server";
import { handleDomainError } from "@/lib/api-error";
import { collectionWhere } from "@/lib/services/sales/scope";
import { evidenceHeaders } from "@/lib/services/sales/evidence";

type Params = { params: Promise<{ id: string; evidenceId: string }> };

/**
 * GET — the evidence file itself.
 *
 * The only route that returns the bytes, and the reason there is no public URL for them.
 * Three things make that true and all three are load-bearing:
 *
 *   The caller is authenticated, and scoped by the SAME rule as the collection list. A file
 *   is never reachable by anyone who could not already see the collection it belongs to.
 *
 *   The evidence id is matched against its collection in the same query. Guessing an id
 *   from another collection returns nothing, rather than returning somebody else's receipt
 *   because the id happened to be valid.
 *
 *   The response is `attachment`, `nosniff`, sandboxed and `no-store`. A PDF rendered inline
 *   in a tab that is logged into the ERP is a document the browser will let script at, and
 *   a cached copy in a shared proxy is a receipt with no access control in front of it.
 */
export async function GET(_request: Request, { params }: Params) {
  const { user, error } = await requireModule("sales");
  if (error) return error;

  const { id, evidenceId } = await params;

  try {
    // One query, both conditions: the evidence must belong to this collection AND the
    // collection must be one this caller may see.
    const row = await prisma.collectionEvidence.findFirst({
      where: {
        id: evidenceId,
        collectionId: id,
        collection: collectionWhere(user.permissions, user.id),
      },
      select: { filename: true, mimeType: true, byteSize: true, content: true },
    });
    if (!row) return NextResponse.json({ error: "Not found." }, { status: 404 });

    const body = new Uint8Array(row.content);
    return new Response(body, {
      status: 200,
      headers: evidenceHeaders({
        filename: row.filename,
        mimeType: row.mimeType,
        byteSize: row.byteSize,
      }),
    });
  } catch (err) {
    return handleDomainError(err);
  }
}

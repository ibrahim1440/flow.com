import { NextResponse } from "@/lib/api-response";
import { requireSub } from "@/lib/auth-server";
import { prisma } from "@/lib/db";
import { zatcaError } from "@/lib/zatca/refusals";

export const dynamic = "force-dynamic";
const ID = /^[A-Za-z0-9_-]{1,64}$/;

/** GET /api/accounting/zatca/log?egsId=&documentId= — the Fatoora log (already redacted). accounting › zatca_view. */
export async function GET(request: Request) {
  const { error } = await requireSub("accounting", "zatca_view");
  if (error) return error;
  try {
    const q = new URL(request.url).searchParams;
    const egsId = q.get("egsId"), documentId = q.get("documentId");
    const rows = await prisma.zatcaLog.findMany({
      where: { ...(egsId && ID.test(egsId) ? { egsId } : {}), ...(documentId && ID.test(documentId) ? { documentId } : {}) },
      orderBy: { at: "desc" }, take: 200,
    });
    return NextResponse.json({ log: rows }, { headers: { "Cache-Control": "no-store" } });
  } catch (err) {
    return zatcaError(err);
  }
}

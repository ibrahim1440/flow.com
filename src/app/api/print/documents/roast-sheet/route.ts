import { NextResponse } from "@/lib/api-response";
import { prisma } from "@/lib/db";
import { requireModule } from "@/lib/auth-server";
import { handleDomainError } from "@/lib/api-error";
import { documentPrintGate } from "@/lib/print/server/auth";
import { DocumentNotFound, documentSeller, roastSheetForBatch, roastSheetForDay } from "@/lib/print/server/documents";
import { dayParam } from "@/lib/services/schedule/http";

export const dynamic = "force-dynamic";

const ID = /^[A-Za-z0-9_-]{1,64}$/;

/**
 * GET /api/print/documents/roast-sheet?date=YYYY-MM-DD[&roasterId=…] | ?batchId=…
 *
 * The data of the printed roast sheet «ورقة التحميص» (feat/print-docs): a day of the roasting schedule
 * (every production roaster, or one), or one recorded batch. Read-only.
 *
 * Order of checks: authentication (401) → the production module (403; the audience of «جدول التحميص»
 * and of Production → Batches) → the document-printing gate (409 DOCUMENT_PRINTING_DISABLED while
 * PRINT_DOCUMENTS_ENABLED / PRINT_CERTIFIED are not "true") → the query (400) → the record (404).
 */
export async function GET(request: Request) {
  const { error } = await requireModule("production");
  if (error) return error;
  const gated = documentPrintGate();
  if (gated) return gated;

  const q = new URL(request.url).searchParams;
  const batchId = q.get("batchId");
  const roasterId = q.get("roasterId");
  if (batchId !== null && (q.has("date") || roasterId !== null)) {
    return NextResponse.json({ error: "Give either batchId, or date (and roasterId) — not both.", errorAr: "اطلب دفعة واحدة أو يومًا، لا الاثنين.", code: "INVALID_QUERY" }, { status: 400 });
  }
  if ((batchId !== null && !ID.test(batchId)) || (roasterId !== null && !ID.test(roasterId))) {
    return NextResponse.json({ error: "Invalid id.", errorAr: "معرّف غير صالح.", code: "INVALID_ID" }, { status: 400 });
  }
  const day = batchId === null ? dayParam(q.get("date")) : null;
  if (batchId === null && !day) return NextResponse.json({ error: "Invalid date.", errorAr: "تاريخ غير صالح.", code: "INVALID_DATE" }, { status: 400 });

  try {
    const sheet = batchId !== null ? await roastSheetForBatch(prisma, batchId) : await roastSheetForDay(prisma, day!, roasterId);
    return NextResponse.json({ ...sheet, seller: await documentSeller(prisma) }, { headers: { "Cache-Control": "no-store" } });
  } catch (err) {
    if (err instanceof DocumentNotFound) return NextResponse.json({ error: "Not found.", errorAr: "غير موجود.", code: "NOT_FOUND" }, { status: 404 });
    return handleDomainError(err);
  }
}

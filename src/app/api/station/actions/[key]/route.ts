import { NextResponse } from "@/lib/api-response";
import { prisma } from "@/lib/db";
import { requireStation } from "@/lib/services/station/http";

/**
 * GET /api/station/actions/[key] — S6 recovery: what happened to the caller's own action sent with
 * this Idempotency-Key, asked BEFORE anything is sent again. A roast answers with its batch; a
 * station action with its log row. `found: false` means it never reached the database, so it may be
 * sent once more with the same key. Another person's key reads as not found.
 */
export async function GET(_request: Request, { params }: { params: Promise<{ key: string }> }) {
  const { user, error } = await requireStation();
  if (error) return error;
  const { key } = await params;
  const batch = await prisma.roastingBatch.findUnique({ where: { requestKey: key }, select: { id: true, batchNumber: true, status: true, createdAt: true, greenBeanQuantity: true, roastedBeanQuantity: true, wasteQuantity: true } });
  if (batch) {
    // The person who recorded it is on its ledger row (the batch itself names nobody).
    const mine = await prisma.inventoryMovement.findFirst({ where: { sourceDocType: "ROASTING_BATCH", sourceDocId: batch.id, userId: user.id }, select: { id: true } });
    if (mine) return NextResponse.json({ found: true, kind: "ROAST", status: "SUCCESS", batch }, { headers: { "Cache-Control": "no-store" } });
  }
  const log = await prisma.workstationActionLog.findUnique({ where: { idempotencyKey: key } });
  if (log && log.employeeId === user.id) {
    return NextResponse.json({ found: true, kind: log.action, status: log.status, toState: log.toState, createdAt: log.createdAt }, { headers: { "Cache-Control": "no-store" } });
  }
  return NextResponse.json({ found: false }, { headers: { "Cache-Control": "no-store" } });
}

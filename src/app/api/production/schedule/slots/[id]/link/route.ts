import { NextResponse } from "@/lib/api-response";
import { forbidden } from "@/lib/auth-server";
import { prisma, TX_OPTS } from "@/lib/db";
import { linkBatchToSlot, linkCandidates } from "@/lib/services/schedule/schedule-db";
import { readJson, requireScheduleView, scheduleError } from "@/lib/services/schedule/http";

type Params = { params: Promise<{ id: string }> };

/** GET /api/production/schedule/slots/[id]/link — the recorded, unlinked batches of the slot's coffee from its day on («ربط بدفعة»). */
export async function GET(_request: Request, { params }: Params) {
  const { error } = await requireScheduleView();
  if (error) return error;
  const { id } = await params;
  try {
    return NextResponse.json({ batches: await linkCandidates(prisma, id) });
  } catch (err) {
    return scheduleError(err);
  }
}

/**
 * POST /api/production/schedule/slots/[id]/link — { batchId }: the slot becomes RECORDED with the batch it
 * was roasted as (planned green stays on the slot, measured weights on the batch). The slot's operator
 * (production › start_batch) or a holder of production › manage_schedule. Same coffee only; one batch per
 * slot. The roast POST will do this itself after the station merge (linkBatchToSlot).
 */
export async function POST(request: Request, { params }: Params) {
  const { user, can, error } = await requireScheduleView();
  if (error) return error;
  const { id } = await params;
  const body = await readJson(request);
  if (body instanceof NextResponse) return body;
  if (typeof body.batchId !== "string" || !body.batchId) return NextResponse.json({ error: "اختر الدفعة.", errorEn: "Give batchId.", code: "INVALID_BODY" }, { status: 400 });
  try {
    if (!can.manage) {
      const s = await prisma.scheduledSlot.findUnique({ where: { id }, select: { operatorId: true } });
      if (!s) return NextResponse.json({ error: "الخانة غير موجودة.", errorEn: "Slot not found.", code: "NOT_FOUND" }, { status: 404 });
      if (!(can.startBatch && s.operatorId === user.id)) return forbidden();
    }
    const out = await prisma.$transaction((tx) => linkBatchToSlot(tx, { slotId: id, batchId: body.batchId as string, actor: { id: user.id, name: user.name } }), TX_OPTS);
    return NextResponse.json({ slot: { id: out.slot.id, status: out.slot.status }, batch: { id: out.batch.id, batchNumber: out.batch.batchNumber } });
  } catch (err) {
    return scheduleError(err);
  }
}

import { NextResponse } from "@/lib/api-response";
import { prisma, TX_OPTS } from "@/lib/db";
import { startSlot } from "@/lib/services/schedule/schedule-db";
import { actorOf, requireScheduleView, scheduleError } from "@/lib/services/schedule/http";

type Params = { params: Promise<{ id: string }> };

/**
 * POST /api/production/schedule/slots/[id]/start — «بدء» (ROASTERS.md §4): today's planned slot becomes
 * IN_PROGRESS. Its operator (production › start_batch) or a holder of production › manage_schedule. No
 * stock moves and no batch is created: the batch is recorded after the roast with its measured weights.
 */
export async function POST(_request: Request, { params }: Params) {
  const { user, can, error } = await requireScheduleView();
  if (error) return error;
  const { id } = await params;
  try {
    const row = await prisma.$transaction((tx) => startSlot(tx, id, actorOf(user, can)), TX_OPTS);
    return NextResponse.json({ slot: { id: row.id, status: row.status, startedAt: row.startedAt?.toISOString() ?? null } });
  } catch (err) {
    return scheduleError(err);
  }
}

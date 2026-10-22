import { NextResponse } from "@/lib/api-response";
import { prisma, TX_OPTS } from "@/lib/db";
import { requireSub } from "@/lib/auth-server";
import { cancelSlot } from "@/lib/services/schedule/schedule-db";
import { readJson, scheduleError } from "@/lib/services/schedule/http";

type Params = { params: Promise<{ id: string }> };

/** POST /api/production/schedule/slots/[id]/cancel — { reason } (required). production › manage_schedule. A recorded slot is never cancelled. */
export async function POST(request: Request, { params }: Params) {
  const { user, error } = await requireSub("production", "manage_schedule");
  if (error) return error;
  const { id } = await params;
  const body = await readJson(request);
  if (body instanceof NextResponse) return body;
  const reason = typeof body.reason === "string" ? body.reason.trim() : "";
  if (!reason || reason.length > 300) return NextResponse.json({ error: "السبب مطلوب (حتى 300 حرف).", errorEn: "A reason is required (up to 300 characters).", code: "REASON_REQUIRED" }, { status: 400 });
  try {
    const row = await prisma.$transaction((tx) => cancelSlot(tx, id, reason, { id: user.id, name: user.name }), TX_OPTS);
    return NextResponse.json({ slot: { id: row.id, status: row.status } });
  } catch (err) {
    return scheduleError(err);
  }
}

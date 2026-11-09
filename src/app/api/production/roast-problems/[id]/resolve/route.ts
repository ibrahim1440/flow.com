import { requireAnySub } from "@/lib/auth-server";
import { requiredKey } from "@/lib/services/station/http";
import { actorOf, v2Body, v2Run } from "@/lib/services/station/roast-v2-http";
import { fail, resumeProblemV2 } from "@/lib/services/station/roast-v2";
import { prisma } from "@/lib/db";

type Params = { params: Promise<{ id: string }> };
/**
 * POST {cause, fix} + Idempotency-Key — D16 «إنهاء البلاغ» from the ERP page: the same service call as the station's, as
 * the signed-in supervisor (production › manage_roasters or manage_schedule). Cause and fix are required (≤ 500 each).
 */
export async function POST(request: Request, { params }: Params) {
  const { user, error } = await requireAnySub("production", ["manage_roasters", "manage_schedule"]);
  if (error) return error;
  const k = requiredKey(request);
  if (k.error) return k.error;
  const { id } = await params;
  const body = await v2Body(request);
  return v2Run(async () => {
    const p = await prisma.roastStationEvent.findUnique({ where: { id }, select: { roasterId: true } });
    if (!p) throw fail(404, "PROBLEM_NOT_FOUND", "البلاغ غير موجود.", "Report not found.");
    // The desk supervisor, as the station's own actor (no device roaster: any roaster's report).
    return resumeProblemV2({ ...actorOf(user), stationRoasterId: null }, p.roasterId, id, body, k.key);
  });
}

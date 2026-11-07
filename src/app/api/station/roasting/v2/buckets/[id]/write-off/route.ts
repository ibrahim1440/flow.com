import { requireStation } from "@/lib/services/station/http";
import { v2Body, v2Run, v2Supervisor } from "@/lib/services/station/roast-v2-http";
import { writeOffBucket } from "@/lib/services/station/roast-v2";

type Params = { params: Promise<{ id: string }> };
/** POST {reason} — a spilled bucket written off at staging (a supervisor: production › manage_schedule). */
export async function POST(request: Request, { params }: Params) {
  const { user, error, station } = await requireStation();
  if (error) return error;
  const g = v2Supervisor(user, "manage_schedule", station);
  if (g.error) return g.error;
  const { id } = await params;
  const body = await v2Body(request);
  return v2Run(() => writeOffBucket(g.ctx.actor, id, body));
}

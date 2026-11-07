import { requireStation } from "@/lib/services/station/http";
import { v2Body, v2Run, v2Supervisor } from "@/lib/services/station/roast-v2-http";
import { reviewDiscard } from "@/lib/services/station/roast-v2";

type Params = { params: Promise<{ id: string }> };
/** POST {note?} — a supervisor reviews a discard (production › manage_schedule; never the discarding operator: 403 SELF_REVIEW). */
export async function POST(request: Request, { params }: Params) {
  const { user, error, station } = await requireStation();
  if (error) return error;
  const g = v2Supervisor(user, "manage_schedule", station);
  if (g.error) return g.error;
  const { id } = await params;
  const body = await v2Body(request);
  return v2Run(() => reviewDiscard(g.ctx.actor, id, body));
}

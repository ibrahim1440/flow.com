import { requireStation } from "@/lib/services/station/http";
import { v2Body, v2Floor, v2Key, v2Run } from "@/lib/services/station/roast-v2-http";
import { undoRun } from "@/lib/services/station/roast-v2";

type Params = { params: Promise<{ id: string }> };
/**
 * POST {expect: "DROP" | "CHARGE"} + Idempotency-Key — undo the step the screen showed, within the undo window (server
 * time); nothing posted is ever undone. 409 STEP_CHANGED when the roast is no longer at that step; a replay answers 200.
 */
export async function POST(request: Request, { params }: Params) {
  const { user, error, station } = await requireStation();
  if (error) return error;
  const g = { ctx: v2Floor(user, station) };
  const { id } = await params;
  const body = await v2Body(request);
  return v2Run(() => undoRun(g.ctx.actor, id, body, v2Key(request)));
}

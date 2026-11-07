import { requireStation } from "@/lib/services/station/http";
import { v2Body, v2Floor, v2Run } from "@/lib/services/station/roast-v2-http";
import { openPrepSession } from "@/lib/services/station/roast-v2";

/** POST {sourceLocationId?, note?} — open a weighing session (green from a site to «منطقة التحميص»). */
export async function POST(request: Request) {
  const { user, error, station } = await requireStation();
  if (error) return error;
  const g = { ctx: v2Floor(user, station) };
  const body = await v2Body(request);
  return v2Run(() => openPrepSession(g.ctx.actor, body), 201);
}

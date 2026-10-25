import { wsRoute } from "@/lib/workspace/server/http";
import { conflicts } from "@/lib/workspace/server/appointments";
import { wsError } from "@/lib/workspace/server/context";

/** POST { participantIds[], startAt, endAt, exceptId? } — clashes of the caller and the participants. */
export const POST = wsRoute(({ actor, body }) => {
  const s = new Date(String(body.startAt ?? "")), e = new Date(String(body.endAt ?? ""));
  if (Number.isNaN(s.getTime()) || Number.isNaN(e.getTime()) || e <= s) throw wsError(400, "الوقت غير صالح.", "Invalid time.", "TIME_INVALID");
  const ids = Array.isArray(body.participantIds) ? body.participantIds.filter((x): x is string => typeof x === "string").slice(0, 30) : [];
  return conflicts(actor, [actor.id, ...ids], s, e, typeof body.exceptId === "string" ? body.exceptId : null).then((items) => ({ items }));
});

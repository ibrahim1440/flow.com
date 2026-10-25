import { wsRoute } from "@/lib/workspace/server/http";
import { calendar, type CalendarLayer } from "@/lib/workspace/server/views";
import { wsError } from "@/lib/workspace/server/context";

const LAYERS = ["mine", "tasks", "team", "occasions", "leave"];

/** GET ?from=ISO&to=ISO&layers=mine,tasks,team,occasions,leave (at most 62 days). */
export const GET = wsRoute(({ actor, query }) => {
  const from = new Date(query.get("from") ?? ""), to = new Date(query.get("to") ?? "");
  if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime()) || to <= from) throw wsError(400, "نطاق التاريخ غير صالح.", "Invalid range.", "RANGE_INVALID");
  const layers = (query.get("layers") ?? "mine,tasks,leave,occasions").split(",").filter((l) => LAYERS.includes(l)) as CalendarLayer[];
  return calendar(actor, from, to, layers);
});

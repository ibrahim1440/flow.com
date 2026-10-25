import { wsRoute } from "@/lib/workspace/server/http";
import { getAppointment, updateAppointment } from "@/lib/workspace/server/appointments";

export const GET = wsRoute(({ actor, params }) => getAppointment(actor, params.id));
/** PATCH — the organiser reschedules / edits (version required); participants are told. */
export const PATCH = wsRoute(({ actor, params, body }) => updateAppointment(actor, params.id, body));

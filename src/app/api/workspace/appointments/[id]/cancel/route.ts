import { wsRoute } from "@/lib/workspace/server/http";
import { cancelAppointment } from "@/lib/workspace/server/appointments";

/** POST { reason? } — the organiser cancels; reminders stop; participants are told. */
export const POST = wsRoute(({ actor, params, body }) => cancelAppointment(actor, params.id, body));

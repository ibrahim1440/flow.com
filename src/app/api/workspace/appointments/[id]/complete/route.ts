import { wsRoute } from "@/lib/workspace/server/http";
import { completeAppointment } from "@/lib/workspace/server/appointments";

/** POST { outcome?, note? } — it happened; a linked one records its outcome on the CRM timeline. */
export const POST = wsRoute(({ actor, params, body }) => completeAppointment(actor, params.id, body));

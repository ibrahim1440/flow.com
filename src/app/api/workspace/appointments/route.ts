import { wsRoute } from "@/lib/workspace/server/http";
import { createAppointment } from "@/lib/workspace/server/appointments";

/** POST — a meeting, visit or call: { kind, title, startAt, endAt, participantIds[], location?, meetingUrl?, links, remindBeforeMinutes?, recurRule? }. */
export const POST = wsRoute(({ actor, body }) => createAppointment(actor, body), { status: 201 });

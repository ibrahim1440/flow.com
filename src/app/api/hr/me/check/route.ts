import { hrHandler } from "@/lib/hr/http";
import { HrError, readJson } from "@/lib/hr/core";
import { selfPerson } from "@/lib/hr/services/self";
import { checkIn, checkOut } from "@/lib/hr/services/attendance";

/** Self check-in/out. The time is the server's clock, never a value the client sends. */
export const POST = hrHandler(async ({ actor, request, now }) => {
  const p = await selfPerson(actor);
  const action = (await readJson(request)).action;
  if (action === "in") return checkIn(actor, p.id, now, "SELF", { self: true });
  if (action === "out") return checkOut(actor, p.id, now, { self: true });
  throw new HrError("action must be in or out.", 400);
}, { self: true });

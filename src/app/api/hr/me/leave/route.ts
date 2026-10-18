import { hrHandler } from "@/lib/hr/http";
import { readJson } from "@/lib/hr/core";
import { selfPerson } from "@/lib/hr/services/self";
import { requestLeave } from "@/lib/hr/services/leave";

export const POST = hrHandler(async ({ actor, request }) => {
  const p = await selfPerson(actor);
  const b = await readJson(request);
  delete b.employeeId;
  return requestLeave(actor, b, { selfEmployeeId: p.id });
}, { self: true, status: 201 });

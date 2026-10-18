import { hrHandler } from "@/lib/hr/http";
import { readJson } from "@/lib/hr/core";
import { selfPerson } from "@/lib/hr/services/self";
import { requestAdvance } from "@/lib/hr/services/advances";

export const POST = hrHandler(async ({ actor, request, today }) => {
  const p = await selfPerson(actor);
  const b = await readJson(request);
  delete b.employeeId;
  return requestAdvance(actor, b, { selfEmployeeId: p.id, today });
}, { self: true, status: 201 });
